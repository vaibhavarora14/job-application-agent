// Batch review (3.8.0 to 3.8.5) was removed in 3.8.6 by owner decision: sends need no review
// batch or token, old fields are accepted and ignored, and `review` commands are stateless no-ops.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jaa-no-review-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const env = {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
  };
  return { directory, env };
}

function run(env, args, input) {
  return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
}

function entry(overrides = {}) {
  return {
    id: 'nogate-1', company: 'NoGate Co', role: 'Senior Product Engineer', url: 'https://job-boards.greenhouse.io/nogate/jobs/1',
    source: 'greenhouse', score: 88, status: 'submitted', submittedAt: new Date().toISOString(), approval: 'APPROVE SUBMIT', answers: {},
    telemetry: { durationBucket: '2-5m', fieldsFilled: 8, resumeUploaded: true, resumeFieldPresent: true },
    ...overrides,
  };
}

test('ledger add records a live submission with no review batch or token', async (t) => {
  const { directory, env } = await fixture(t);
  const added = run(env, ['ledger', 'add', '--stdin'], entry());
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).recorded, 'nogate-1');
  assert.doesNotMatch(added.stderr, /reviewToken|review batch|approval code/i);
  const row = JSON.parse((await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim());
  for (const key of ['reviewBatchId', 'reviewToken', 'reviewApprovedAt', 'reviewApprovalChannel']) assert.equal(key in row, false, key);
});

test('legacy reviewBatchId and reviewToken are accepted and ignored', async (t) => {
  const { directory, env } = await fixture(t);
  const added = run(env, ['ledger', 'add', '--stdin'], { ...entry({ id: 'nogate-2' }), reviewBatchId: 'rb-20261101-00000000', reviewToken: 'rbt1.not-a-real-token' });
  assert.equal(added.status, 0, added.stderr);
  const row = JSON.parse((await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim());
  assert.equal('reviewBatchId' in row, false);
  assert.equal('reviewToken' in row, false);
});

test('a missing approval is still a hard error (an explicit choice either way)', async (t) => {
  const { env } = await fixture(t);
  const { approval: _approval, ...noApproval } = entry({ id: 'nogate-3' });
  const refused = run(env, ['ledger', 'add', '--stdin'], noApproval);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /entry\.approval must be a non-empty string/);
});

test('review commands are stateless no-ops that say batch review was removed', async (t) => {
  const { directory, env } = await fixture(t);
  for (const args of [['review', 'stage', '--stdin'], ['review', 'open', 'rb-20261101-00000000'], ['review', 'list'], ['review', 'approve', '--stdin']]) {
    const result = run(env, args, args.at(-1) === '--stdin' ? { items: [] } : undefined);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.deprecated, true);
    assert.equal(body.removedIn, '3.8.6');
    assert.match(body.message, /Batch review was removed/);
  }
  assert.equal((await readdir(directory)).includes('review-batches'), false);
});
