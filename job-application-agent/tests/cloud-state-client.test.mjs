import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CloudStateClient, saveCloudConfig } from '../scripts/cloud-state-client.mjs';
import worker, { sha256Hex } from '../../state-worker/src/worker.mjs';
import { createMemoryD1, hasNodeSqlite } from '../../state-worker/tests/d1-mock.mjs';
import { createMemoryR2 } from '../../state-worker/tests/r2-mock.mjs';

const TOKEN = 'test-client-token-with-sufficient-length-cloud';
const sqliteTest = hasNodeSqlite ? test : test.skip;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'job-agent-cloud-'));
  const stateDir = join(root, 'state');
  const configPath = join(root, 'cloud', 'config.json');
  await mkdir(stateDir, { recursive: true });
  const schema = await readFile(new URL('../../state-worker/migrations/0001_private_state.sql', import.meta.url), 'utf8');
  const DB = createMemoryD1(schema);
  await DB.prepare('INSERT INTO clients (client_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('client-test', 'Test Client', sha256Hex(TOKEN), new Date().toISOString()).run();
  const bindings = { DB, STATE: createMemoryR2(), STATE_TOKEN: 'legacy', LEGACY_WRITES_DISABLED: '1' };
  const fetchImpl = (input, init) => worker.fetch(new Request(input, init), bindings);
  await saveCloudConfig({ version: 2, url: 'https://state.example.com', token: TOKEN, clientId: 'client-test', clientName: 'Test Client' }, { configPath });
  const client = new CloudStateClient({ stateDir, configPath, fetchImpl });
  return { root, stateDir, configPath, bindings, client };
}

sqliteTest('cloud config and profile cache are owner-only and work without Keychain', async () => {
  const ctx = await setup();
  await ctx.client.putDocument('profile', { name: 'Ada', email: 'ada@example.com' }, 0);
  const profile = await ctx.client.refreshProfileCache();
  assert.equal(profile.name, 'Ada');
  if (process.platform !== 'win32') assert.equal((await stat(ctx.configPath)).mode & 0o777, 0o600);
  const cache = join(ctx.stateDir, 'cloud-profile-cache.json');
  if (process.platform !== 'win32') assert.equal((await stat(cache)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(cache, 'utf8')), profile);
});

sqliteTest('reconcile dry-run reports the exact union without writing', async () => {
  const ctx = await setup();
  const local = [
    { id: 'app-1', company: 'A', submittedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'app-2', company: 'B', submittedAt: '2026-01-02T00:00:00.000Z' },
  ];
  await writeFile(join(ctx.stateDir, 'applications.ndjson'), `${local.map(JSON.stringify).join('\n')}\n`);
  await ctx.client.appendRecord('applications', local[0], { recordKey: 'app-1', idempotencyKey: 'migration:app-1' });
  const report = await ctx.client.reconcile({ dryRun: true });
  assert.deepEqual(report.streams.applications, { localRows: 2, cloudRows: 1, localOnly: 1, cloudOnly: 0, unionRows: 2 });
  assert.equal((await ctx.bindings.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE stream = 'applications'").first()).count, 1);
});

sqliteTest('reconcile imports local-only rows idempotently and preserves provenance', async () => {
  const ctx = await setup();
  const local = [{ id: 'app-1', company: 'A', submittedAt: '2026-01-01T00:00:00.000Z' }];
  await writeFile(join(ctx.stateDir, 'applications.ndjson'), `${JSON.stringify(local[0])}\n`);
  const first = await ctx.client.reconcile({ dryRun: false, provenance: 'mac-cutover' });
  const second = await ctx.client.reconcile({ dryRun: false, provenance: 'mac-cutover' });
  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  const row = await ctx.bindings.DB.prepare("SELECT provenance FROM records WHERE stream = 'applications'").first();
  assert.equal(row.provenance, 'mac-cutover');
});

sqliteTest('resume download verifies checksum and creates a private path cache', async () => {
  const ctx = await setup();
  const bytes = Buffer.from('%PDF-1.7\ncloud-resume-fixture');
  await ctx.client.putFile('resume.pdf', bytes, 0);
  const result = await ctx.client.fetchResume();
  assert.equal(result.sha256, sha256Hex(bytes));
  if (process.platform !== 'win32') assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.equal(Buffer.from(await readFile(result.path)).equals(bytes), true);
});

sqliteTest('outage queues an already observed append but blocks application intents', async () => {
  const ctx = await setup();
  const offline = new CloudStateClient({ stateDir: ctx.stateDir, configPath: ctx.configPath, fetchImpl: async () => { throw new Error('offline'); } });
  const queued = await offline.appendRecord('outcomes', { id: 'app-1', status: 'interview' }, { recordKey: 'app-1', idempotencyKey: 'outcome:1', queueOnFailure: true });
  assert.equal(queued.queued, true);
  await assert.rejects(() => offline.createIntent({ applicationId: 'app-2', canonicalUrl: 'https://jobs.example/app-2', leaseId: 'lease' }), /cloud state unavailable/i);
});
