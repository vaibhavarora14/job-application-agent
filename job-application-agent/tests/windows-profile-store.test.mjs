// Runs the real windows-profile-store.ps1. On Windows it uses powershell.exe (the
// same invocation secret-store.mjs uses) and also does a full set/get round trip
// through Credential Manager and DPAPI. Elsewhere it uses pwsh when installed and
// checks only request validation, which happens before any Windows API call.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSecretStore, DEFAULT_SECRET_SERVICE, isAllowedWindowsService, PROFILE_ACCOUNT, WINDOWS_PROFILE_SCRIPT } from '../scripts/secret-store.mjs';

const isWindows = process.platform === 'win32';
function findShell() {
  if (isWindows) return 'powershell.exe';
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  return probe.status === 0 ? 'pwsh' : null;
}
const shell = findShell();
const shellArgs = isWindows
  ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_PROFILE_SCRIPT]
  : ['-NoProfile', '-NonInteractive', '-File', WINDOWS_PROFILE_SCRIPT];
const testService = `${DEFAULT_SECRET_SERVICE}.test-${process.pid}-${Date.now()}`;

function request(stateDir, meta, plaintext = 'payload') {
  const result = spawnSync(shell, shellArgs, {
    input: `${JSON.stringify(meta)}\n${plaintext}`,
    encoding: 'utf8',
    env: { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: stateDir },
    windowsHide: true,
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

test('isAllowedWindowsService accepts only the fixed service name or its dotted sub-names', () => {
  assert.equal(isAllowedWindowsService(DEFAULT_SECRET_SERVICE), true);
  assert.equal(isAllowedWindowsService(`${DEFAULT_SECRET_SERVICE}.test-1`), true);
  assert.equal(isAllowedWindowsService(`${DEFAULT_SECRET_SERVICE}X`), false);
  assert.equal(isAllowedWindowsService('job-application-agent-test-1'), false);
  assert.equal(isAllowedWindowsService('Microsoft_Office16_Data'), false);
  assert.equal(isAllowedWindowsService(`${DEFAULT_SECRET_SERVICE}.a b`), false);
  assert.equal(isAllowedWindowsService(undefined), false);
});

test('the win32 store refuses a foreign service name before starting PowerShell', () => {
  let spawned = false;
  const store = createSecretStore({
    platform: 'win32',
    service: 'Microsoft_Office16_Data',
    stateDir: join(tmpdir(), 'unused'),
    execFileSync: () => { spawned = true; return ''; },
  });
  assert.throws(() => store.writeProfile('{}'), /only uses the com\.vaibhavarora\.job-application-agent service name/);
  assert.equal(spawned, false);
});

test('the win32 store surfaces a script rejection reason without profile data', () => {
  const store = createSecretStore({
    platform: 'win32',
    stateDir: join(tmpdir(), 'unused'),
    execFileSync: () => { throw Object.assign(new Error('exit 1'), { stderr: 'Windows profile storage rejected the request: profile path is outside the state folder.\n' }); },
  });
  assert.throws(() => store.writeProfile('{"name":"secret"}'), (error) => /outside the state folder/.test(error.message) && !/secret/.test(error.message));
});

test('windows-profile-store.ps1 rejects requests outside its fixed service and state folder', { skip: shell ? false : 'PowerShell is not installed' }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jaa-win-store-'));
  const good = { op: 'set', service: testService, account: PROFILE_ACCOUNT, path: join(stateDir, 'profile.dat') };
  const cases = [
    [{ ...good, service: 'Microsoft_Office16_Data' }, /service name lacks the job-application-agent prefix/],
    [{ ...good, service: `${DEFAULT_SECRET_SERVICE}X` }, /service name lacks the job-application-agent prefix/],
    [{ ...good, path: join(tmpdir(), 'elsewhere', 'profile.dat') }, /outside the state folder/],
    [{ ...good, path: join(stateDir, '..', 'escape', 'profile.dat') }, /outside the state folder/],
    [{ ...good, path: stateDir }, /outside the state folder/],
    [{ ...good, path: join(stateDir, 'profile.txt') }, /must be a \.dat file/],
    [{ ...good, path: 'profile.dat' }, /not absolute/],
    [{ ...good, account: 'bad account' }, /account name is invalid/],
    [{ ...good, op: 'delete' }, /unsupported operation/],
  ];
  if (!isWindows) {
    const outside = await mkdtemp(join(tmpdir(), 'jaa-win-outside-'));
    await symlink(outside, join(stateDir, 'link'));
    cases.push([{ ...good, path: join(stateDir, 'link', 'profile.dat') }, /passes through a link/]);
  }
  for (const [meta, expected] of cases) {
    const result = request(stateDir, meta);
    assert.equal(result.status, 1, JSON.stringify(meta));
    assert.match(result.stderr, expected, JSON.stringify(meta));
    assert.doesNotMatch(result.stderr, /payload/);
  }
  // A valid request passes validation (on non-Windows it then fails at the Windows API).
  const valid = request(stateDir, good);
  assert.doesNotMatch(valid.stderr, /rejected the request/);
  if (!isWindows) {
    // The helper names the failing step instead of one generic line (#228).
    assert.match(valid.stderr, /Windows profile storage failed: [a-z-]+(?: \([A-Za-z0-9_.; ]+\))?\./);
    assert.doesNotMatch(valid.stderr, /payload|jaa-win-store/);
  }
});

test('windows-profile-store.ps1 round-trips a profile through Credential Manager and DPAPI', { skip: isWindows ? false : 'Windows only' }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jaa-win-store-'));
  await mkdir(stateDir, { recursive: true });
  const profile = JSON.stringify({ name: 'Test Candidate', notes: 'ünïcödé ✓', padding: 'x'.repeat(4000) });
  const store = createSecretStore({ platform: 'win32', service: testService, stateDir, env: { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: stateDir }, execFileSync: (command, args, options) => execFileSync(command, args, { ...options, env: { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: stateDir } }) });
  store.writeProfile(profile);
  const sealed = await readFile(join(stateDir, 'profile.dat'));
  assert.ok(!sealed.includes(Buffer.from('Test Candidate')));
  assert.equal(store.readProfile(), profile);
});

function failingStore(stderr, extra = {}) {
  return createSecretStore({
    platform: 'win32',
    stateDir: join(tmpdir(), 'unused'),
    execFileSync: () => { throw Object.assign(new Error('exit 1'), { stderr, ...extra }); },
  });
}

test('the win32 store keeps the failing step and only files Credential Manager failures as authentication_required (#228)', () => {
  const cases = [
    ['Windows profile storage failed: credential-write (win32 1312).\n', /credential-write, win32 1312\).*Sign in to Windows interactively/, 'authentication_required'],
    ['Windows profile storage failed: credential-read (win32 5).\n', /credential-read, win32 5\)/, 'authentication_required'],
    ['Windows profile storage failed: add-type (System.InvalidOperationException).\n', /add-type, System\.InvalidOperationException\).*Constrained Language Mode/, 'internal_error'],
    ['Windows profile storage failed: dpapi (System.Security.Cryptography.CryptographicException).\n', /\(dpapi, System\.Security\.Cryptography\.CryptographicException\)/, 'internal_error'],
    ['Windows profile storage failed: file-write (System.UnauthorizedAccessException).\n', /file-write.*OneDrive/, 'internal_error'],
    ['Windows profile storage failed: path-check (System.IO.IOException).\n', /path-check.*JOB_APPLICATION_AGENT_STATE_DIR/, 'internal_error'],
    ['Windows profile storage failed.\n', /unknown step/, 'internal_error'],
    ['', /unknown step/, 'internal_error'],
  ];
  for (const [stderr, message, code] of cases) {
    assert.throws(() => failingStore(stderr).writeProfile('{"name":"secret"}'), (error) => {
      assert.match(error.message, message, stderr);
      assert.match(error.message, /no profile data was logged/i);
      assert.doesNotMatch(error.message, /secret/);
      assert.equal(error.telemetryErrorCode, code, stderr);
      return true;
    });
  }
  assert.throws(() => failingStore('', { code: 'ENOENT' }).writeProfile('{}'), (error) => /powershell\.exe was not found/.test(error.message) && error.telemetryErrorCode === 'internal_error');
  assert.throws(() => failingStore('Windows profile storage failed: missing.\n').readProfile(), /The stored profile is missing or unreadable\. Run profile set again\./);
});

test('a non-Credential-Manager Windows storage failure is not misfiled as authentication_required in telemetry (#228)', async () => {
  const { telemetryErrorCode } = await import('../scripts/job-application.mjs');
  assert.throws(() => failingStore('Windows profile storage failed: dpapi (System.Security.Cryptography.CryptographicException).\n').writeProfile('{}'), (error) => telemetryErrorCode(error) === 'internal_error');
  assert.throws(() => failingStore('Windows profile storage failed: credential-write (win32 1312).\n').writeProfile('{}'), (error) => telemetryErrorCode(error) === 'authentication_required');
});
