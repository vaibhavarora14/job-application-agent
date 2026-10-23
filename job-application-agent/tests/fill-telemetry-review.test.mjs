import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withTestReview } from './support/review-approval.mjs';
import {
  FILL_TELEMETRY_REVIEW_REASON,
  FILL_TELEMETRY_REVIEW_WINDOW_MS,
  fillTelemetryFingerprint,
  rapidFireFillTelemetryMatches,
} from '../scripts/job-application.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

function isolatedCliEnv(directory) {
  return {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
}

function runCli(args, input, env) {
  input = withTestReview(env, args, input);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input ?? {}));
  });
}

async function relay(t) {
  const captured = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    captured.push(JSON.parse(raw));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { captured, url: `http://127.0.0.1:${server.address().port}` };
}

async function telemetryEnv(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { captured, url } = await relay(t);
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: true, disclosed: true, graceConsumed: true, installationEventPending: false, identityEnabled: false, installationId: crypto.randomUUID(), token: 'synthetic-token', tokenExpiresAt: '2099-01-01T00:00:00Z' }));
  return { directory, captured, env: { ...isolatedCliEnv(directory), JOB_APPLICATION_AGENT_TELEMETRY_URL: url } };
}

const entry = (slug, extra) => ({
  id: `rapid-${slug}`, company: `Rapid ${slug}`, role: 'Engineer', url: `https://www.linkedin.com/jobs/view/${1000 + slug.length}${slug.charCodeAt(0)}`,
  source: 'linkedin', score: 80, status: 'submitted', submittedAt: '2026-10-22T04:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, ...extra,
});

const readRows = async (file) => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('fillTelemetryFingerprint is stable across key order and ignores unknown and null keys', () => {
  const a = fillTelemetryFingerprint({ durationBucket: '2-5m', fieldsFilled: 6, resumeUploaded: false });
  const b = fillTelemetryFingerprint({ resumeUploaded: false, fieldsFilled: 6, durationBucket: '2-5m', resumeFieldPresent: null, bogus: 1 });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, fillTelemetryFingerprint({ durationBucket: '2-5m', fieldsFilled: 7, resumeUploaded: false }));
  assert.notEqual(a, fillTelemetryFingerprint({ durationBucket: '2-5m', fieldsFilled: 6, resumeUploaded: false, resumeFieldPresent: false }));
  for (const empty of [undefined, null, {}, [], 'x', { bogus: 1 }, { fieldsFilled: null }]) assert.equal(fillTelemetryFingerprint(empty), null);
});

test('rapidFireFillTelemetryMatches only matches the same fingerprint inside the window', () => {
  const nowMs = Date.parse('2026-10-22T10:00:10.000Z');
  const rows = [
    { applicationId: 'a', fingerprint: 'f1', recordedAt: '2026-10-22T10:00:06.000Z' },
    { applicationId: 'b', fingerprint: 'f1', recordedAt: '2026-10-22T10:00:02.000Z' },
    { applicationId: 'b', fingerprint: 'f1', recordedAt: '2026-10-22T10:00:03.000Z' },
    { applicationId: 'old', fingerprint: 'f1', recordedAt: new Date(nowMs - FILL_TELEMETRY_REVIEW_WINDOW_MS - 1).toISOString() },
    { applicationId: 'other', fingerprint: 'f2', recordedAt: '2026-10-22T10:00:09.000Z' },
    { applicationId: 'self', fingerprint: 'f1', recordedAt: '2026-10-22T10:00:09.000Z' },
    { applicationId: 'bad-date', fingerprint: 'f1', recordedAt: 'not a date' },
    null,
  ];
  assert.deepEqual(rapidFireFillTelemetryMatches(rows, { fingerprint: 'f1', applicationId: 'self', nowMs }), ['a', 'b']);
  assert.deepEqual(rapidFireFillTelemetryMatches(rows, { fingerprint: 'f3', applicationId: 'self', nowMs }), []);
  assert.deepEqual(rapidFireFillTelemetryMatches(rows, { fingerprint: null, applicationId: 'self', nowMs }), []);
  assert.deepEqual(rapidFireFillTelemetryMatches([], { fingerprint: 'f1', applicationId: 'self', nowMs }), []);
});

test('rapid-fire ledger adds with one reused telemetry block are all recorded and flagged for review only', async (t) => {
  const { directory, captured, env } = await telemetryEnv(t, 'job-agent-rapid-fire-');
  const reused = { durationBucket: '2-5m', fieldsFilled: 6, shortAnswerCount: 6, resumeUploaded: false };
  const results = [];
  for (const slug of ['a', 'bb', 'ccc']) {
    const result = await runCli(['ledger', 'add', '--stdin'], entry(slug, { telemetry: reused }), env);
    assert.equal(result.code, 0, result.stderr);
    results.push(result);
  }
  // Never blocks or drops: all three rows are stored, unchanged by the check.
  const stored = await readRows(join(directory, 'applications.ndjson'));
  assert.deepEqual(stored.map((row) => row.id), ['rapid-a', 'rapid-bb', 'rapid-ccc']);
  for (const row of stored) {
    assert.equal(row.fillMetricsSource, 'telemetry');
    assert.equal('fillTelemetryReview' in row, false);
    assert.equal('reviewFlag' in row, false);
    assert.equal('entryOrigin' in row, false);
  }
  const first = JSON.parse(results[0].stdout);
  assert.equal('fillTelemetryReview' in first, false);
  assert.doesNotMatch(results[0].stderr, /Flagged for review/);
  const second = JSON.parse(results[1].stdout);
  assert.equal(second.recorded, 'rapid-bb');
  assert.equal(second.fillTelemetryReview.flagged, true);
  assert.equal(second.fillTelemetryReview.reason, FILL_TELEMETRY_REVIEW_REASON);
  assert.deepEqual(second.fillTelemetryReview.matchingApplicationIds, ['rapid-a']);
  assert.match(results[1].stderr, /WARNING: Flagged for review \(not blocked\)/);
  const third = JSON.parse(results[2].stdout);
  assert.deepEqual(third.fillTelemetryReview.matchingApplicationIds, ['rapid-a', 'rapid-bb']);

  // Telemetry is unchanged: flagged and unflagged submits send the same property set and
  // nothing about the review flag reaches the relay.
  const submitted = captured.filter((body) => body.event === 'application_submitted');
  assert.equal(submitted.length, 3);
  const keys = (body) => Object.keys(body.properties).sort();
  assert.deepEqual(keys(submitted[1]), keys(submitted[0]));
  assert.deepEqual(keys(submitted[2]), keys(submitted[0]));
  assert.doesNotMatch(JSON.stringify(captured), /fillTelemetryReview|identical-fill-telemetry|fingerprint/);

  // Local review marker surfaces in `ledger review`, and review_generated telemetry is unchanged.
  const before = captured.length;
  const review = await runCli(['ledger', 'review'], {}, env);
  assert.equal(review.code, 0, review.stderr);
  const report = JSON.parse(review.stdout);
  assert.deepEqual(report.fillTelemetryReviewFlags.map((flag) => [flag.applicationId, flag.reason, flag.matchingApplicationIds]), [
    ['rapid-bb', FILL_TELEMETRY_REVIEW_REASON, ['rapid-a']],
    ['rapid-ccc', FILL_TELEMETRY_REVIEW_REASON, ['rapid-a', 'rapid-bb']],
  ]);
  const generated = captured.slice(before).filter((body) => body.event === 'review_generated');
  for (const body of generated) {
    assert.deepEqual(Object.keys(body.properties).sort(), ['interviewCount', 'offerCount', 'rejectionCount', 'reviewDue', 'submissionCount', 'withdrawalCount']);
  }
});

test('distinct telemetry and after-the-fact logged entries are not flagged', async (t) => {
  const { directory, env } = await telemetryEnv(t, 'job-agent-rapid-fire-clean-');
  const cases = [
    ['a', { telemetry: { durationBucket: '1-2m', fieldsFilled: 6, shortAnswerCount: 6, resumeUploaded: false, resumeFieldPresent: false } }],
    ['bb', { telemetry: { durationBucket: '1-2m', fieldsFilled: 7, shortAnswerCount: 6, resumeUploaded: true, resumeFieldPresent: true } }],
    // Logged after the fact: no telemetry block, so entryOrigin=logged and never part of the check.
    ['ccc', { answers: { Email: 'filled', Phone: 'filled' } }],
    ['dddd', { answers: { Email: 'filled', Phone: 'filled' } }],
  ];
  for (const [slug, extra] of cases) {
    const result = await runCli(['ledger', 'add', '--stdin'], entry(slug, extra), env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal('fillTelemetryReview' in JSON.parse(result.stdout), false);
    assert.doesNotMatch(result.stderr, /Flagged for review/);
  }
  const stored = await readRows(join(directory, 'applications.ndjson'));
  assert.equal(stored.length, 4);
  assert.equal(stored.filter((row) => row.entryOrigin === 'logged').length, 2);
  const local = await readRows(join(directory, 'fill-telemetry-review.ndjson'));
  assert.deepEqual(local.map((row) => row.applicationId), ['rapid-a', 'rapid-bb']);
  for (const row of local) assert.deepEqual(Object.keys(row).sort(), ['applicationId', 'fingerprint', 'recordedAt']);
  const review = JSON.parse((await runCli(['ledger', 'review'], {}, env)).stdout);
  assert.equal('fillTelemetryReviewFlags' in review, false);
});

test('an unreadable local review stream never breaks ledger add or ledger review', async (t) => {
  const { directory, env } = await telemetryEnv(t, 'job-agent-rapid-fire-corrupt-');
  await writeFile(join(directory, 'fill-telemetry-review.ndjson'), 'not json\n', { mode: 0o600 });
  const telemetry = { durationBucket: '2-5m', fieldsFilled: 6, resumeUploaded: false };
  for (const slug of ['a', 'bb']) {
    const result = await runCli(['ledger', 'add', '--stdin'], entry(slug, { telemetry }), env);
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal((await readRows(join(directory, 'applications.ndjson'))).length, 2);
  const review = await runCli(['ledger', 'review'], {}, env);
  assert.equal(review.code, 0, review.stderr);
});
