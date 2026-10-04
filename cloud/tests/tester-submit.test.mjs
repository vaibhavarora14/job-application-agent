import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { issueInvite, redeemInvite, workspaceEnv } from '../src/tester-access.mjs';
import { openDb } from '../src/db.mjs';
import { saveProfile } from '../src/skill.mjs';
import { fillGreenhouse } from '../src/apply/greenhouse.mjs';
import { loadBoards } from '../src/discover/index.mjs';
import { enqueue } from '../src/queue.mjs';
import { drainOnce } from '../src/worker.mjs';
import { isolatedEnv, sampleProfile, sampleExtras } from './helpers.mjs';

async function setup(t, channel = 'greenhouse') {
  const base = await isolatedEnv(t);
  const env = { ...base, CLOUD_TESTER_HOSTED: '1', CLOUD_TESTER_ORIGIN: 'https://invites.example.test', CLOUD_TESTER_DATA_DIR: join(base.CLOUD_DATA_DIR, 'testers') };
  const account = await redeemInvite(issueInvite('submit@example.test', env).token, 'test-only-password', env);
  const scoped = workspaceEnv(account.id, env);
  const db = openDb(scoped);
  saveProfile(sampleProfile, sampleExtras, join(base.CLOUD_DATA_DIR, 'test.pdf'), scoped);
  db.prepare(`INSERT INTO jobs (id,company,role,title,description,url,application_channel,discovery_source,created_at) VALUES ('job','Test','Engineer','Engineer','TypeScript','https://boards.greenhouse.io/test/jobs/1',?,'direct-company','now')`).run(channel);
  db.prepare(`INSERT INTO assessments (job_id,decision,score,auto_eligible,payload_json,result_json,created_at) VALUES ('job','review',90,1,'{}','{}','now')`).run();
  return { env, scoped, account, db };
}

// Only the browser boundary is replaced. These tests never contact an employer.
function pageHarness(after, { valid = true, beforeClick = () => {} } = {}) {
  let clicks = 0;
  let visits = 0;
  const locator = { first() { return this; }, count: async () => 1, evaluate: async () => 'text', fill: async () => {}, inputValue: async () => '', setInputFiles: async () => {}, click: async () => { clicks++; }, evaluateAll: async () => valid };
  const page = {
    goto: async () => { visits++; }, waitForTimeout: async () => {},
    evaluate: async () => { if (!clicks) beforeClick(); return clicks ? after : 'Name Email Resume'; },
    locator: () => locator, getByLabel: () => locator, getByRole: () => locator,
    url: () => 'https://boards.greenhouse.io/test/jobs/1',
  };
  return { withPageImpl: async (_env, fn) => fn(page), clicks: () => clicks, visits: () => visits };
}

test('invited tester submits on the filled page and records only visible employer confirmation', async (t) => {
  const { scoped, db } = await setup(t);
  const browser = pageHarness('Thanks for applying to Test.');
  const result = await fillGreenhouse({ jobId: 'job', env: scoped, ...browser });
  assert.equal(result.ok, true);
  assert.equal(browser.clicks(), 1);
  assert.equal(browser.visits(), 1);
  assert.equal(db.prepare('SELECT status FROM applications').get().status, 'submitted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tester_ledger').get().n, 1);
  await fillGreenhouse({ jobId: 'job', env: scoped, ...browser });
  assert.equal(browser.clicks(), 1);
});

test('unclear confirmation remains unsent and a retried fill cannot click again', async (t) => {
  const { scoped, db } = await setup(t);
  const browser = pageHarness('Please wait');
  const result = await fillGreenhouse({ jobId: 'job', env: scoped, ...browser });
  assert.equal(result.reason, 'unclear-confirmation');
  assert.equal(db.prepare('SELECT status FROM applications').get().status, 'confirmation-unclear');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tester_ledger').get().n, 0);
  await fillGreenhouse({ jobId: 'job', env: scoped, ...browser });
  assert.equal(browser.clicks(), 1);
});

test('invalid form and permission revoked after filling both block clicks', async (t) => {
  const { scoped, db } = await setup(t);
  const invalid = pageHarness('Thanks for applying', { valid: false });
  assert.equal((await fillGreenhouse({ jobId: 'job', env: scoped, ...invalid })).reason, 'gate');
  assert.equal(invalid.clicks(), 0);
  const revoked = pageHarness('Thanks for applying', { beforeClick: () => saveProfile({ ...sampleProfile, submissionMode: 'review-each' }, sampleExtras, null, scoped) });
  assert.equal((await fillGreenhouse({ jobId: 'job', env: scoped, ...revoked })).reason, 'gate');
  assert.equal(revoked.clicks(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tester_ledger').get().n, 0);
});

test('Lever/Ashby are excluded from discovery and rejected by fill and queued worker', async (t) => {
  for (const channel of ['lever', 'ashby']) {
    const { env, scoped } = await setup(t, channel);
    await writeFile(env.CLOUD_BOARDS_PATH, JSON.stringify([{ channel: 'greenhouse' }, { channel: 'lever' }, { channel: 'ashby' }]));
    assert.deepEqual((await loadBoards(scoped)).map(b => b.channel), ['greenhouse']);
    const browser = pageHarness('Thanks for applying');
    assert.equal((await fillGreenhouse({ jobId: 'job', env: scoped, ...browser })).reason, 'invite-or-channel');
    assert.equal(browser.visits(), 0);
    enqueue('submit', { jobId: 'job' }, scoped);
    assert.match((await drainOnce(scoped)).error, /channel unavailable/);
  }
});

test('revoked membership and forged tester environment cannot launch a browser', async (t) => {
  const { env, scoped, account } = await setup(t);
  const db = new DatabaseSync(join(env.CLOUD_TESTER_DATA_DIR, 'access.sqlite'));
  db.prepare('UPDATE accounts SET active = 0 WHERE id = ?').run(account.id);
  db.close();
  const browser = pageHarness('Thanks for applying');
  assert.equal((await fillGreenhouse({ jobId: 'job', env: scoped, ...browser })).reason, 'invite-or-channel');
  assert.equal((await fillGreenhouse({ jobId: 'job', env: { ...scoped }, ...browser })).reason, 'invite-or-channel');
  assert.equal(browser.visits(), 0);
});
