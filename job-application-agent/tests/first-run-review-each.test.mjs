// First-time review-each users hit three validation errors on normal steps (#240):
// `profile check` before any profile exists, a non-integer `fitScore` at `review stage`,
// and an omitted `approval` at `ledger add`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withTestReview } from './support/review-approval.mjs';
import { createSecretStore, isProfileMissingError, PROFILE_MISSING_MESSAGE } from '../scripts/secret-store.mjs';
import { normalizeFitScore, validateStageInput } from '../scripts/review-batch.mjs';
import { defaultLedgerApproval, telemetryErrorCategory, telemetryErrorCode, telemetryErrorFieldLabel, validateLedgerEntry } from '../scripts/job-application.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

function isolatedEnv(directory) {
  return {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
}

function runCli(args, input, env, runtimeArgs = []) {
  input = withTestReview(env, args, input);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...runtimeArgs, script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

async function stateDir(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  return directory;
}

// A synthetic Linux Secret Service: `lookup` exits 1 with empty stderr (nothing stored) or with a
// stderr line (a locked keyring). Never touches the developer's real keyring.
function linuxPreload(lookup) {
  const body = lookup === 'locked'
    ? "const e = new Error('lookup failed'); e.status = 1; e.stderr = 'Cannot unlock the keyring'; throw e;"
    : "const e = new Error('lookup failed'); e.status = 1; e.stderr = ''; throw e;";
  const preload = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; Object.defineProperty(process, 'platform', { value: 'linux' }); cp.execFileSync = (file, args) => { if (file === 'secret-tool' && args[0] === 'lookup') { ${body} } throw new Error('Unexpected secret operation'); }; syncBuiltinESMExports();`;
  return ['--import', `data:text/javascript,${encodeURIComponent(preload)}`];
}

test('every store tags "nothing stored yet" so callers can tell it from a failed read', async () => {
  const notFound = () => { const error = new Error('not found'); error.status = 1; error.stderr = ''; throw error; };
  const linux = createSecretStore({ platform: 'linux', execFileSync: notFound });
  const darwin = createSecretStore({ platform: 'darwin', execFileSync: notFound });
  const windows = createSecretStore({
    platform: 'win32',
    stateDir: tmpdir(),
    execFileSync: () => { const error = new Error('helper failed'); error.stderr = 'Windows profile storage failed: missing.'; throw error; },
  });
  for (const store of [linux, darwin, windows]) {
    assert.throws(() => store.readProfile(), (error) => isProfileMissingError(error) && error.message === PROFILE_MISSING_MESSAGE);
  }
  const locked = createSecretStore({ platform: 'linux', execFileSync: () => { const error = new Error('x'); error.status = 1; error.stderr = 'locked'; throw error; } });
  assert.throws(() => locked.readProfile(), (error) => !isProfileMissingError(error) && /Secret Service could not read/.test(error.message));
});

test('profile check on a first run reports "not configured" instead of failing', async (t) => {
  const directory = await stateDir(t, 'job-agent-first-run-profile-');
  const first = await runCli(['profile', 'check'], undefined, isolatedEnv(directory), linuxPreload('missing'));
  assert.equal(first.code, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.configured, false);
  assert.equal(result.stored, false);
  assert.ok(result.missing.length > 0);
  assert.deepEqual(result.missing, result.required);
  assert.match(result.nextStep, /profile set --stdin/);
  assert.doesNotMatch(first.stderr, /missing or unreadable/);
});

test('profile check still fails when the keyring cannot be read', async (t) => {
  const directory = await stateDir(t, 'job-agent-first-run-locked-');
  const locked = await runCli(['profile', 'check'], undefined, isolatedEnv(directory), linuxPreload('locked'));
  assert.equal(locked.code, 1);
  assert.match(locked.stderr, /Secret Service could not read the profile/);
});

test('fitScore accepts the score command value in the shapes a model hands it over', () => {
  assert.equal(normalizeFitScore(86), 86);
  assert.equal(normalizeFitScore(0), 0);
  assert.equal(normalizeFitScore(100), 100);
  assert.equal(normalizeFitScore(1), 1);
  assert.equal(normalizeFitScore(86.4), 86);
  assert.equal(normalizeFitScore(85.5), 86);
  assert.equal(normalizeFitScore('86'), 86);
  assert.equal(normalizeFitScore(' 72.0 '), 72);
  for (const bad of [null, undefined, '', 'high', '86%', '-5', -1, 100.5, 101, Number.NaN, Number.POSITIVE_INFINITY, true, [86], { score: 86 }]) {
    assert.throws(() => normalizeFitScore(bad, 'items[0].fitScore'), /items\[0\]\.fitScore must be an integer from 0 to 100: copy the integer "score"/, String(bad));
  }
  for (const fraction of [0.86, '0.86', 0.5]) {
    assert.throws(() => normalizeFitScore(fraction, 'items[0].fitScore'), /must be an integer from 0 to 100, not a 0-1 fraction/);
  }
});

test('review stage stores the rounded integer fitScore', () => {
  const item = { type: 'application', applicationId: 'acme-1', company: 'Acme', role: 'Engineer', url: 'https://job-boards.greenhouse.io/acme/jobs/1', ats: 'greenhouse', answers: {} };
  assert.equal(validateStageInput({ items: [{ ...item, fitScore: '86' }] }).items[0].fitScore, 86);
  assert.equal(validateStageInput({ items: [{ ...item, fitScore: 79.6 }] }).items[0].fitScore, 80);
  assert.throws(() => validateStageInput({ items: [{ ...item, fitScore: 0.86 }] }), /0-1 fraction/);
});

test('fitScore errors keep their telemetry classification', () => {
  for (const value of [null, 0.86]) {
    let error;
    try { normalizeFitScore(value, 'items[0].fitScore'); } catch (caught) { error = caught; }
    assert.equal(telemetryErrorCategory(error), telemetryErrorCategory(new Error('items[0].fitScore must be an integer from 0 to 100.')));
    assert.equal(telemetryErrorCode(error), 'invalid_input');
  }
});

const entry = {
  id: 'acme-engineer-2026-10', company: 'Acme', role: 'Engineer', url: 'https://job-boards.greenhouse.io/acme/jobs/1',
  source: 'greenhouse', score: 86, status: 'submitted', submittedAt: '2026-10-30T16:15:00.000Z', answers: { 'Why Acme?': 'filled' },
};

test('an omitted approval defaults to APPROVE SUBMIT only for a review-each send', () => {
  assert.deepEqual(defaultLedgerApproval(entry), { input: { ...entry, approval: 'APPROVE SUBMIT' }, defaulted: true });
  assert.equal(defaultLedgerApproval({ ...entry, approval: '  ' }).input.approval, 'APPROVE SUBMIT');
  assert.equal(defaultLedgerApproval({ ...entry, approval: 'STANDING AUTHORIZATION' }).defaulted, false);
  assert.equal(defaultLedgerApproval(entry, { routineAuto: true }).defaulted, false);
  assert.equal(defaultLedgerApproval({ ...entry, thinSubmissionOverride: {} }).defaulted, false);
  assert.equal(defaultLedgerApproval({ ...entry, jobApprovalMode: 'review-each' }).defaulted, false);
  assert.equal(validateLedgerEntry(defaultLedgerApproval(entry).input).approval, 'APPROVE SUBMIT');
});

test('a missing or wrong approval names the allowed values and keeps its telemetry classification', () => {
  let missing;
  try { validateLedgerEntry(entry); } catch (error) { missing = error; }
  assert.match(missing.message, /^entry\.approval must be a non-empty string no longer than 80 characters\. Use "APPROVE SUBMIT" for a review-each batch of one, or "STANDING AUTHORIZATION"/);
  assert.equal(telemetryErrorCategory(missing), 'submission');
  assert.equal(telemetryErrorCode(missing), 'invalid_input');
  assert.equal(telemetryErrorFieldLabel(missing), 'entry.approval');
  assert.throws(() => validateLedgerEntry({ ...entry, approval: 'yes' }), /^Error: entry\.approval is invalid\. Use "APPROVE SUBMIT"/);
});

test('ledger add without approval records a review-each submit', async (t) => {
  const directory = await stateDir(t, 'job-agent-first-run-approval-');
  const env = isolatedEnv(directory);
  const added = await runCli(['ledger', 'add', '--stdin'], {
    ...entry,
    telemetry: { fieldsFilled: 8, resumeUploaded: true, resumeFieldPresent: true, durationBucket: '2-5m' },
  }, env);
  assert.equal(added.code, 0, added.stderr);
  const result = JSON.parse(added.stdout);
  assert.equal(result.recorded, entry.id);
  assert.equal(result.approvalDefaulted, 'APPROVE SUBMIT');
  const rows = (await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.at(-1).approval, 'APPROVE SUBMIT');
});

test('ledger add without approval is refused under an explicit thin-submission override', async (t) => {
  const directory = await stateDir(t, 'job-agent-first-run-thin-');
  const refused = await runCli(['ledger', 'add', '--stdin'], {
    ...entry,
    id: 'acme-thin', url: 'https://job-boards.greenhouse.io/acme/jobs/2', answers: {},
    telemetry: { fieldsFilled: 0, resumeUploaded: false, resumeFieldPresent: false, durationBucket: 'under-1s' },
    thinSubmissionOverride: { acknowledgment: 'THIN SUBMISSION ACKNOWLEDGED', candidateConfirmation: 'Candidate confirmed this empty accept for Acme in chat' },
  }, isolatedEnv(directory));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /entry\.approval must be a non-empty string/);
});
