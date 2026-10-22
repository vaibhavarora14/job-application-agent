import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { commandCategory } from '../scripts/job-application.mjs';
import { runOutreach } from '../scripts/outreach-cli.mjs';
import {
  REVIEW_BATCH_MAX_ITEMS, applicationMatcher, approvalPhrase, approveBatch, consumeReview, loadBatch, stageBatch, verifyReview,
} from '../scripts/review-batch.mjs';
import { renderReviewPage, startReviewPage } from '../scripts/review-page.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

async function stateDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'review-batch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  return directory;
}
function envFor(directory) {
  return {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_TELEMETRY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_NO_BROWSER: '1',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `job-application-agent-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
}
function cli(env, args, input) {
  const run = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
  return { status: run.status, stderr: run.stderr, json: run.status === 0 ? JSON.parse(run.stdout) : null };
}

const answers = { 'Why this team?': 'I have shipped agent tooling for two years.', Sponsorship: 'No' };
function entry(overrides = {}) {
  return {
    id: 'acme-staff-1', company: 'Acme', role: 'Staff Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'greenhouse',
    score: 86, status: 'submitted', submittedAt: '2026-10-20T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers,
    telemetry: { fieldsFilled: 12, resumeUploaded: true, durationMs: 240000 },
    ...overrides,
  };
}
function item(overrides = {}) {
  return { type: 'application', applicationId: 'acme-staff-1', company: 'Acme', role: 'Staff Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1', ats: 'greenhouse', fitScore: 86, answers, ...overrides };
}
async function approved(directory, items, options = {}) {
  const batch = await stageBatch(directory, { items }, options.stage);
  const { token, batch: done } = await approveBatch(directory, batch.batchId, { channel: 'chat-phrase', phrase: approvalPhrase(batch), ...options.approve });
  return { reviewBatchId: batch.batchId, reviewToken: token, batch: done };
}

test('stage validates size, duplicates and item shape', async (t) => {
  const directory = await stateDir(t);
  const many = Array.from({ length: REVIEW_BATCH_MAX_ITEMS + 1 }, (_, i) => item({ applicationId: `a-${i}`, url: `https://jobs.example.org/${i}` }));
  await assert.rejects(stageBatch(directory, { items: many }), /at most 25/);
  await assert.rejects(stageBatch(directory, { items: [item(), item()] }), /same application twice/);
  await assert.rejects(stageBatch(directory, { items: [{ ...item(), type: 'fax' }] }), /type must be/);
  await assert.rejects(stageBatch(directory, { items: [item({ flaggedAnswers: ['missing'] })] }), /flaggedAnswers/);
  await assert.rejects(stageBatch(directory, { items: [item({ extra: 1 })] }), /Unknown items\[0\] property: extra/);
  const batch = await stageBatch(directory, { items: [item(), { type: 'email', opportunityId: 'opp-1', draftRevision: 2, company: 'Acme', text: 'Hello' }] });
  assert.match(batch.code, /^[A-Z]{3}-\d{2}$/);
  assert.equal(batch.items.length, 2);
  if (process.platform !== 'win32') {
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(join(directory, 'review-batches', `${batch.batchId}.json`))).mode & 0o777, 0o600);
  }
});

test('approval needs the exact phrase, at least one item, and a pending unexpired batch', async (t) => {
  const directory = await stateDir(t);
  const batch = await stageBatch(directory, { items: [item()] });
  await assert.rejects(approveBatch(directory, batch.batchId, { channel: 'chat-phrase', phrase: 'APPROVE' }), /phrase does not match/);
  await assert.rejects(approveBatch(directory, batch.batchId, { channel: 'chat-phrase', phrase: approvalPhrase(batch), excludeNumbers: [1] }), /at least one item/);
  await assert.rejects(approveBatch(directory, batch.batchId, { channel: 'chat-phrase', phrase: approvalPhrase(batch), now: new Date(Date.now() + 25 * 3600_000) }), /expired/);
  const ok = await approveBatch(directory, batch.batchId, { channel: 'chat-phrase', phrase: ` approve ${batch.code.toLowerCase()} ` });
  assert.match(ok.token, /^rbt1\./);
  await assert.rejects(approveBatch(directory, batch.batchId, { channel: 'chat-phrase', phrase: approvalPhrase(batch) }), /is approved/);
});

test('ledger add refuses a live submission without a batch approval and records one with it', async (t) => {
  const directory = await stateDir(t);
  const env = envFor(directory);
  const missing = cli(env, ['ledger', 'add', '--stdin'], entry());
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ledger add needs a batch approval from the candidate/);
  // A caller-supplied applyKind cannot exempt a live employer URL.
  const disguised = cli(env, ['ledger', 'add', '--stdin'], entry({ applyKind: 'fixture' }));
  assert.match(disguised.stderr, /needs a batch approval/);

  const review = await approved(directory, [item()]);
  const ok = cli(env, ['ledger', 'add', '--stdin'], { ...entry(), reviewBatchId: review.reviewBatchId, reviewToken: review.reviewToken });
  assert.equal(ok.status, 0, ok.stderr);
  const row = JSON.parse((await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim());
  assert.equal(row.reviewBatchId, review.reviewBatchId);
  assert.equal(row.reviewApprovalChannel, 'chat-phrase');
  assert.equal(row.reviewToken, undefined);
  assert.ok((await loadBatch(directory, review.reviewBatchId)).uses.i1.usedAt);
});

test('owned fixtures do not need a batch approval', async (t) => {
  const directory = await stateDir(t);
  const result = cli(envFor(directory), ['ledger', 'add', '--stdin'], entry({ id: 'fixture-1', url: 'https://jobappagent.com/fixtures/greenhouse/', answers: {} }));
  assert.equal(result.status, 0, result.stderr);
});

test('changed answers, a job outside the batch, a removed job and a reused approval are refused', async (t) => {
  const directory = await stateDir(t);
  const env = envFor(directory);
  const second = item({ applicationId: 'beta-1', company: 'Beta', url: 'https://jobs.lever.co/beta/1' });
  const review = await approved(directory, [item(), second], { approve: { excludeNumbers: [2] } });
  const creds = { reviewBatchId: review.reviewBatchId, reviewToken: review.reviewToken };

  const tampered = cli(env, ['ledger', 'add', '--stdin'], { ...entry({ answers: { ...answers, Sponsorship: 'Yes' } }), ...creds });
  assert.match(tampered.stderr, /differs from what the candidate approved \(item 1: the answers changed\)/);
  const outside = cli(env, ['ledger', 'add', '--stdin'], { ...entry({ id: 'other-1', url: 'https://jobs.example.org/other' }), ...creds });
  assert.match(outside.stderr, /does not cover this send/);
  const removed = cli(env, ['ledger', 'add', '--stdin'], { ...entry({ id: 'beta-1', company: 'Beta', url: 'https://jobs.lever.co/beta/1' }), ...creds });
  assert.match(removed.stderr, /removed item 2 \(Beta\)/);

  assert.equal(cli(env, ['ledger', 'add', '--stdin'], { ...entry(), ...creds }).status, 0);
  const match = applicationMatcher({ applicationId: 'acme-staff-1', url: item().url, answers });
  await assert.rejects(verifyReview(directory, creds, { action: 'test', match }), /already used/);
  await assert.rejects(consumeReview(directory, review.reviewBatchId, 'i1', 'again'), /already used/);
});

test('expired approvals, forged tokens, edited batch files and a changed résumé are refused', async (t) => {
  const directory = await stateDir(t);
  const match = applicationMatcher({ applicationId: 'acme-staff-1', url: item().url, answers });
  const review = await approved(directory, [item()]);
  const creds = { reviewBatchId: review.reviewBatchId, reviewToken: review.reviewToken };
  await verifyReview(directory, creds, { action: 'test', match });
  await assert.rejects(verifyReview(directory, creds, { action: 'test', match, now: new Date(Date.now() + 25 * 3600_000) }), /is expired/);
  await assert.rejects(verifyReview(directory, { ...creds, reviewToken: `${creds.reviewToken.slice(0, -2)}xx` }, { action: 'test', match }), /not valid/);
  await assert.rejects(verifyReview(directory, { ...creds, reviewToken: 'rbt1.rb-20260101-00000000.abc' }, { action: 'test', match }), /does not belong/);
  await assert.rejects(verifyReview(directory, creds, { action: 'test', match, checkResume: true, resumeSha256: 'f'.repeat(64) }), /résumé changed/);

  const file = join(directory, 'review-batches', `${review.reviewBatchId}.json`);
  const batch = JSON.parse(await readFile(file, 'utf8'));
  batch.items[0].answersSha256 = '0'.repeat(64);
  await writeFile(file, JSON.stringify(batch));
  await assert.rejects(verifyReview(directory, creds, { action: 'test', match }), /not valid for this batch/);
});

test('cloud intent-prepare and intent-confirm refuse a live send without an approval', async (t) => {
  const directory = await stateDir(t);
  const env = envFor(directory);
  const intent = cli(env, ['cloud', 'intent-prepare', '--stdin'], { applicationId: 'acme-staff-1', canonicalUrl: item().url, leaseId: 'lease' });
  assert.match(intent.stderr, /cloud intent-prepare needs a batch approval/);
  const confirm = cli(env, ['cloud', 'intent-confirm', '--stdin'], { intentId: 'i', leaseId: 'l', application: entry() });
  assert.match(confirm.stderr, /cloud intent-confirm needs a batch approval/);
});

test('outreach handoff needs an approved email item for that draft revision', async (t) => {
  const directory = await stateDir(t);
  const opts = { stateDirectory: directory, cloudClient: { config: async () => null }, migrate: async () => {}, guard: async () => {} };
  await assert.rejects(runOutreach(['handoff', '--stdin'], { ...opts, input: { id: 'opp-1', draftRevision: 1 } }), /outreach handoff needs a batch approval/);
  const review = await approved(directory, [{ type: 'email', opportunityId: 'opp-1', draftRevision: 2, company: 'Acme', text: 'Hello' }]);
  await assert.rejects(
    runOutreach(['handoff', '--stdin'], { ...opts, input: { id: 'opp-1', draftRevision: 1, reviewBatchId: review.reviewBatchId, reviewToken: review.reviewToken } }),
    /draft revision changed \(approved 2\)/,
  );
});

test('review commands run through the CLI and count as batch telemetry', async (t) => {
  const directory = await stateDir(t);
  const env = envFor(directory);
  assert.equal(commandCategory(['review', 'stage']), 'batch');
  const staged = cli(env, ['review', 'stage', '--stdin'], { items: [item()] });
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(staged.json.status, 'pending');
  assert.match(staged.json.table, /1\. APPLY {2}Acme \| Staff Engineer/);
  assert.match(staged.json.next, /Never open, read the code from, or operate the review page yourself/);
  const shown = cli(env, ['review', 'show', staged.json.batchId]);
  assert.deepEqual(shown.json.items[0].answers, answers);
  assert.equal(cli(env, ['review', 'status', staged.json.batchId]).json.reviewToken, undefined);
  const wrong = cli(env, ['review', 'approve', '--stdin'], { batchId: staged.json.batchId, phrase: 'APPROVE AAA-00' });
  assert.match(wrong.stderr, /phrase does not match/);
  const ok = cli(env, ['review', 'approve', '--stdin'], { batchId: staged.json.batchId, phrase: staged.json.approvalPhrase });
  assert.equal(ok.json.status, 'approved');
  assert.equal(ok.json.approvalChannel, 'chat-phrase');
  assert.equal(cli(env, ['review', 'status', staged.json.batchId]).json.reviewToken, ok.json.reviewToken);
  assert.equal(cli(env, ['review', 'list']).json.batches.length, 1);
  const revoked = cli(env, ['review', 'revoke', staged.json.batchId]);
  assert.equal(revoked.json.status, 'revoked');
  const after = cli(env, ['ledger', 'add', '--stdin'], { ...entry(), reviewBatchId: staged.json.batchId, reviewToken: ok.json.reviewToken });
  assert.match(after.stderr, /is revoked/);
});

test('an old grant that carried submit prints the batch-review notice once', async (t) => {
  const directory = await stateDir(t);
  const env = envFor(directory);
  await writeFile(join(directory, 'autonomy.json'), JSON.stringify({ version: 1, enabled: true, mode: 'routine-auto', scopes: ['discover', 'submit', 'send-recruiting-email'], grantedAt: '2026-09-01T00:00:00Z' }), { mode: 0o600 });
  const first = cli(env, ['autonomy', 'status']);
  assert.match(first.stderr, /no longer covers submitting or sending on its own/);
  assert.equal(first.json.maySubmitRoutineApplications, false);
  assert.ok(!first.json.scopes.includes('submit'));
  assert.doesNotMatch(cli(env, ['autonomy', 'status']).stderr, /no longer covers/);
});

function http(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers } }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the local review page escapes job content and approves only with the typed code', async (t) => {
  const directory = await stateDir(t);
  const batch = await stageBatch(directory, { items: [
    item({ company: '<script>alert(1)</script>', answers: { 'Q<1>': 'A & "B"' }, flaggedAnswers: ['Q<1>'] }),
    item({ applicationId: 'beta-1', company: 'Beta', url: 'https://jobs.lever.co/beta/1' }),
  ] });
  const page = await startReviewPage({ stateDir: directory, batchId: batch.batchId, timeoutMs: 60_000 });
  t.after(() => page.close());
  const url = new URL(page.url);

  const get = await http(page.url);
  assert.equal(get.status, 200);
  assert.match(get.headers['content-security-policy'], /default-src 'none'/);
  assert.doesNotMatch(get.text, /<script>/);
  assert.match(get.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(get.text, /A &amp; &quot;B&quot;/);
  assert.equal((await http(`${url.origin}/review/wrong`)).status, 404);
  assert.equal((await http(page.url, { headers: { host: 'evil.example' } })).status, 421);
  assert.equal((await http(page.url, { method: 'POST', body: 'decision=approve&item=i1&code=X', headers: { origin: 'https://evil.example' } })).status, 403);

  const wrong = await http(page.url, { method: 'POST', body: 'decision=approve&item=i1&code=ZZZ-00' });
  assert.equal(wrong.status, 422);
  assert.match(wrong.text, /doesn&#39;t match/);
  assert.equal((await loadBatch(directory, batch.batchId)).status, 'pending');

  const ok = await http(page.url, { method: 'POST', body: `decision=approve&item=i1&code=${batch.code.toLowerCase()}` });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Approved 1 of 2/);
  const stored = await loadBatch(directory, batch.batchId);
  assert.equal(stored.status, 'approved');
  assert.equal(stored.approvalChannel, 'local-page');
  assert.deepEqual(stored.approvedItemIds, ['i1']);
  assert.equal(await page.done, 'approved');
});

test('the review page can reject a batch and renders decided states', async (t) => {
  const directory = await stateDir(t);
  const batch = await stageBatch(directory, { items: [item()] });
  const page = await startReviewPage({ stateDir: directory, batchId: batch.batchId, timeoutMs: 60_000 });
  t.after(() => page.close());
  const rejected = await http(page.url, { method: 'POST', body: 'decision=reject' });
  assert.match(rejected.text, /Batch rejected/);
  assert.equal((await loadBatch(directory, batch.batchId)).status, 'rejected');
  assert.match(renderReviewPage({ ...batch, status: 'pending', pendingExpiresAt: '2000-01-01T00:00:00Z' }, { action: '/x' }), /expired/);
});

test('review open starts a detached local page', async (t) => {
  const directory = await stateDir(t);
  const env = envFor(directory);
  const staged = cli(env, ['review', 'stage', '--stdin'], { items: [item()] });
  const opened = cli(env, ['review', 'open', staged.json.batchId]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.json.url, /^http:\/\/127\.0\.0\.1:\d+\/review\//);
  assert.equal(opened.json.browserOpened, false);
  const again = cli(env, ['review', 'open', staged.json.batchId]);
  assert.equal(again.json.url, opened.json.url);
  const batch = await loadBatch(directory, staged.json.batchId);
  const done = await http(opened.json.url, { method: 'POST', body: `decision=approve&item=i1&code=${batch.code}` });
  assert.match(done.text, /Approved 1 of 1/);
  const status = cli(env, ['review', 'status', staged.json.batchId]);
  assert.equal(status.json.status, 'approved');
  assert.match(status.json.reviewToken, /^rbt1\./);
});
