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
