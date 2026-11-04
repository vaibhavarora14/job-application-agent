// #241: `ledger add` with no telemetry timing and no `application_started` time for the job hash
// sent `durationBucket: "unknown"`. It now measures from the earliest local `score` time for the
// job. The fallback is read-only (no start is emitted or recorded) and adds no telemetry property.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assessmentJobKey } from '../scripts/assessment-guard.mjs';
import { earliestLocalStartAt, noteReviewStarted } from '../scripts/started-without-outcome.mjs';
import { telemetryApplicationSubmitted } from '../scripts/job-application.mjs';
import { jobIdentity } from '../scripts/telemetry-schema.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
const T0 = '2026-10-30T16:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const URL_A = 'https://job-boards.greenhouse.io/acme/jobs/241';

test('earliestLocalStartAt picks the earliest score time for the job, by URL first, else company + role', () => {
  let started = noteReviewStarted({ version: 1, jobs: {} }, { url: URL_A, company: 'Acme', title: 'Engineer' }, at(5));
  started = noteReviewStarted(started, { url: URL_A, company: 'Acme', title: 'Engineer' }, at(9));
  const decisions = { version: 1, jobs: { [assessmentJobKey({ url: URL_A })]: { decision: 'review', score: 86, at: at(9) } } };
  assert.equal(earliestLocalStartAt({ started, decisions, url: URL_A, company: 'Acme', role: 'Engineer', endedAt: at(12) }), at(5));
  // Only a decision record (job_assessed was sent, application_started was not): its time is used.
  assert.equal(earliestLocalStartAt({ decisions, url: URL_A, company: 'Acme', role: 'Engineer', endedAt: at(12) }), at(9));
  // A job scored without a URL is matched by company + role.
  const byName = noteReviewStarted({ version: 1, jobs: {} }, { company: 'Acme', title: 'Engineer' }, at(2));
  assert.equal(earliestLocalStartAt({ started: byName, url: URL_A, company: 'Acme', role: 'Engineer', endedAt: at(12) }), at(2));
  // When the URL has its own record, an older same-title job scored without a URL is not used.
  const both = noteReviewStarted(started, { company: 'Acme', title: 'Engineer' }, at(-60));
  assert.equal(earliestLocalStartAt({ started: both, decisions, url: URL_A, company: 'Acme', role: 'Engineer', endedAt: at(12) }), at(5));
  // Even when the URL record has no usable time, the name record is not borrowed.
  assert.equal(earliestLocalStartAt({ started: both, url: URL_A, company: 'Acme', role: 'Engineer', endedAt: at(1) }), null);
});

test('earliestLocalStartAt returns null when no usable local time exists', () => {
  const started = noteReviewStarted({ version: 1, jobs: {} }, { url: URL_A, company: 'Acme', title: 'Engineer' }, at(30));
  // Another job's times never count.
  assert.equal(earliestLocalStartAt({ started, url: 'https://job-boards.greenhouse.io/acme/jobs/999', company: 'Other', role: 'Designer', endedAt: at(60) }), null);
  // Times after the submit are ignored.
  assert.equal(earliestLocalStartAt({ started, url: URL_A, company: 'Acme', role: 'Engineer', endedAt: at(10) }), null);
  // Missing or malformed files.
  assert.equal(earliestLocalStartAt({ url: URL_A, company: 'Acme', role: 'Engineer' }), null);
  assert.equal(earliestLocalStartAt({ started: { jobs: { [assessmentJobKey({ url: URL_A })]: { scoredAt: ['not a date', 42] } } }, decisions: { jobs: { [assessmentJobKey({ url: URL_A })]: { at: null } } }, url: URL_A }), null);
  assert.equal(earliestLocalStartAt({ started, url: URL_A, endedAt: 'not a date' }), null);
});

const entry = {
  id: 'acme-engineer-241', company: 'Acme', role: 'Engineer', url: URL_A, source: 'greenhouse', score: 86,
  status: 'submitted', submittedAt: '2026-10-30T16:15:00.000Z', approval: 'APPROVE SUBMIT', answers: { 'Why Acme?': 'filled' },
};

test('telemetryApplicationSubmitted buckets an inferred start and keeps the same property set', async () => {
  const withStart = await telemetryApplicationSubmitted(entry, { telemetrySupplied: true, fillMetricsSource: 'telemetry', fieldsFilled: 8, resumeUploaded: true, lifecycleStartedAt: at(0), endedAt: at(3) });
  const without = await telemetryApplicationSubmitted(entry, { telemetrySupplied: true, fillMetricsSource: 'telemetry', fieldsFilled: 8, resumeUploaded: true });
  assert.equal(withStart.properties.durationBucket, '2-5m');
  assert.equal(without.properties.durationBucket, 'unknown');
  assert.deepEqual(Object.keys(withStart.properties).sort(), Object.keys(without.properties).sort());
});

async function relay(t) {
  const captured = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    try { captured.push(JSON.parse(raw)); } catch { /* not JSON */ }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { captured, url: `http://127.0.0.1:${server.address().port}` };
}

const telemetryConfig = (enabled) => JSON.stringify({ version: 1, enabled, disclosed: true, graceConsumed: true, installationEventPending: false, identityEnabled: false, installationId: '00000000-0000-4000-8000-000000000241', token: 'synthetic-token', tokenExpiresAt: '2099-01-01T00:00:00Z' });

async function telemetryEnv(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jaa-submit-start-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { captured, url } = await relay(t);
  await writeFile(join(directory, 'telemetry.json'), telemetryConfig(true));
  const env = {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_NO_BROWSER: '1',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    JOB_APPLICATION_AGENT_TELEMETRY_URL: url,
  };
  return { directory, captured, env };
}

function runCli(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

const events = (captured, name) => captured.filter((body) => body.event === name);
const fill = { fieldsFilled: 8, resumeUploaded: true, resumeFieldPresent: true };

async function ledgerAdd(env, extra = {}) {
  const added = await runCli(['ledger', 'add', '--stdin'], { ...entry, telemetry: fill, ...extra }, env);
  assert.equal(added.code, 0, added.stderr);
  return JSON.parse(added.stdout);
}

test('ledger add with no application_started measures from the local score time and emits no start', async (t) => {
  const { directory, captured, env } = await telemetryEnv(t);
  // The Oct 30 case: the job was scored (job_assessed) but application_started never went out.
  const started = noteReviewStarted({ version: 1, jobs: {} }, { url: URL_A, company: 'Acme', title: 'Engineer' }, ago(3));
  await writeFile(join(directory, 'review-started.json'), JSON.stringify(started), { mode: 0o600 });
  await writeFile(join(directory, 'assessment-decisions.json'), JSON.stringify({ version: 1, jobs: { [assessmentJobKey({ url: URL_A })]: { decision: 'review', autoEligible: false, score: 86, at: ago(3) } } }), { mode: 0o600 });
  await ledgerAdd(env);
  const [submitted] = events(captured, 'application_submitted');
  assert.equal(submitted.properties.durationBucket, '2-5m');
  assert.equal(events(captured, 'application_started').length, 0, 'the fallback never emits a start');
  assert.doesNotMatch(JSON.stringify(captured), /startSource|startInferred|review-started|assessment-decisions/);
});

test('ledger add with no start time anywhere still sends durationBucket "unknown"', async (t) => {
  const { captured, env } = await telemetryEnv(t);
  await ledgerAdd(env);
  assert.equal(events(captured, 'application_submitted')[0].properties.durationBucket, 'unknown');
  assert.equal(events(captured, 'application_started').length, 0);
});

test('telemetry timing and the application_started time still win over the local fallback', async (t) => {
  const { directory, captured, env } = await telemetryEnv(t);
  const started = noteReviewStarted({ version: 1, jobs: {} }, { url: URL_A, company: 'Acme', title: 'Engineer' }, ago(10));
  await writeFile(join(directory, 'review-started.json'), JSON.stringify(started), { mode: 0o600 });
  // Telemetry timing first.
  await ledgerAdd(env, { telemetry: { ...fill, durationMs: 20_000 } });
  assert.equal(events(captured, 'application_submitted')[0].properties.durationBucket, '5-30s');

  // Then the remembered application_started time for the job hash.
  const second = await telemetryEnv(t);
  await writeFile(join(second.directory, 'review-started.json'), JSON.stringify(started), { mode: 0o600 });
  const { jobHash } = await jobIdentity(URL_A);
  await writeFile(join(second.directory, 'telemetry-attempt-dedupe.json'), JSON.stringify({ keys: [`application_started:${jobHash}`], startedAtByJobHash: { [jobHash]: new Date(Date.now() - 45_000).toISOString() } }), { mode: 0o600 });
  await ledgerAdd(second.env);
  assert.equal(events(second.captured, 'application_submitted')[0].properties.durationBucket, '30-60s');
});

const target = {
  name: 'Test Candidate', email: 'candidate@example.com', phone: '+1 555 0100', location: 'Toronto, Canada',
  workAuthorization: 'Canada', roleFamilies: ['product-engineering'], seniority: ['senior', 'staff'],
  skills: ['TypeScript'], targetLocations: ['Canada', 'Remote'], workModes: ['remote'],
  submissionMode: 'review-each', yearsExperience: 10, autoSubmitMinScore: 80, manualReviewMinScore: 70, minMustHaveCoverage: 70,
};
const posting = {
  title: 'Engineer', company: 'Acme', description: 'Build products with TypeScript.',
  source: 'greenhouse', eligibility: 'eligible', postingStatus: 'active', roleFamily: 'product-engineering',
  seniority: 'senior', workMode: 'remote', remote: true, locations: ['Remote'], url: URL_A,
  mustHaves: [{ requirement: 'TypeScript', status: 'met', evidence: 'Resume skills' }], target,
};

async function score(env) {
  const scored = await runCli(['score', '--stdin'], posting, env);
  assert.equal(scored.code, 0, scored.stderr);
  assert.equal(JSON.parse(scored.stdout).decision, 'review');
}

test('a job scored while application_started did not go out gets a duration and no late start', async (t) => {
  const { directory, captured, env } = await telemetryEnv(t);
  // Scored while analytics were off, so no application_started went out for the job.
  await writeFile(join(directory, 'telemetry.json'), telemetryConfig(false));
  await score(env);
  await writeFile(join(directory, 'telemetry.json'), telemetryConfig(true));
  await ledgerAdd(env);
  assert.notEqual(events(captured, 'application_submitted')[0].properties.durationBucket, 'unknown');
  assert.equal(events(captured, 'application_started').length, 0);
});

test('score then ledger add still counts the job as started exactly once', async (t) => {
  const { captured, env } = await telemetryEnv(t);
  await score(env);
  assert.equal(events(captured, 'application_started').length, 1);
  await ledgerAdd(env);
  assert.notEqual(events(captured, 'application_submitted')[0].properties.durationBucket, 'unknown');
  assert.equal(events(captured, 'application_started').length, 1);
});
