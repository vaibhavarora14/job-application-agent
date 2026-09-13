import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CloudStateClient, readCachedCloudProfile, saveCloudConfig } from '../scripts/cloud-state-client.mjs';
import { deliveryProjection, discoveryProjection, validateDelivery, validateLead } from '../scripts/application-accounting.mjs';
import worker, { sha256Hex } from '../../state-worker/src/worker.mjs';
import { createBackup, restoreBackup } from '../../state-worker/src/backup.mjs';
import { createMemoryD1, hasNodeSqlite } from '../../state-worker/tests/d1-mock.mjs';
import { createMemoryR2 } from '../../state-worker/tests/r2-mock.mjs';

const TOKEN = 'accounting-cloud-client-synthetic-token-long-enough';
const sqliteTest = hasNodeSqlite ? test : test.skip;
const now = '2026-09-13T10:00:00.000Z';
const application = { id: 'app', company: 'Example', role: 'Engineer', source: 'email', url: 'https://example.com/jobs/app', status: 'submitted', submittedAt: '2026-09-12T10:00:00.000Z' };
const failure = validateDelivery({ version: 1, id: 'failure-event', applicationId: 'app', attemptId: 'initial:app', type: 'delivery-failed', occurredAt: now, evidenceType: 'final-delivery-failure', evidence: 'Synthetic final failure matched to the original application email.' });
const retry = validateDelivery({ version: 1, id: 'retry-event', applicationId: 'app', attemptId: 'recovery-attempt', type: 'retry-confirmed', channel: 'browser', url: 'https://example.com/jobs/app', channelVerifiedAt: now, approval: 'STANDING AUTHORIZATION', evidenceType: 'browser-confirmation', evidence: 'Synthetic visible ATS success.', occurredAt: '2026-09-13T11:00:00.000Z' });
const qualifiedLead = validateLead({ version: 1, id: 'lead-event', type: 'lead-reviewed', roundId: 'round-1', sourceId: 'direct', url: application.url, company: application.company, role: application.role, disposition: 'qualified', observedAt: now, evidence: 'Synthetic active employer posting matches requirements.' });

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-agent-accounting-cloud-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const configPath = join(root, 'cloud', 'config.json');
  await mkdir(stateDir, { recursive: true });
  const schema = await readFile(new URL('../../state-worker/migrations/0001_private_state.sql', import.meta.url), 'utf8');
  const DB = createMemoryD1(schema);
  await DB.prepare('INSERT INTO clients (client_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('client-test', 'Synthetic Accounting Client', sha256Hex(TOKEN), now).run();
  const bindings = { DB, STATE: createMemoryR2(), STATE_TOKEN: 'legacy', LEGACY_WRITES_DISABLED: '1' };
  const fetchImpl = (input, init) => worker.fetch(new Request(input, init), bindings);
  await saveCloudConfig({ version: 2, url: 'https://state.example.com', token: TOKEN, clientId: 'client-test' }, { configPath });
  const client = new CloudStateClient({ stateDir, configPath, fetchImpl });
  return { root, stateDir, configPath, schema, bindings, fetchImpl, client };
}

async function writeRows(stateDir, stream, rows) {
  await writeFile(join(stateDir, `${stream}.ndjson`), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
}

async function readRows(stateDir, stream) {
  return (await readFile(join(stateDir, `${stream}.ndjson`), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
}

sqliteTest('local and cloud accounting projections agree after repeated bidirectional reconciliation', async t => {
  const ctx = await setup(t);
  await writeRows(ctx.stateDir, 'applications', [application]);
  await writeRows(ctx.stateDir, 'delivery', [failure]);
  await writeRows(ctx.stateDir, 'discovery', [qualifiedLead]);
  const originalProjection = deliveryProjection([application], [failure]);
  assert.equal(originalProjection.effectiveSubmissionCount, 0);
  await ctx.client.reconcile({ dryRun: false });
  const correction = validateDelivery({ version: 1, id: 'correction-event', applicationId: 'app', attemptId: 'initial:app', type: 'correction', supersedes: failure.id, status: 'receipt-confirmed', occurredAt: '2026-09-14T10:00:00.000Z', evidenceType: 'employer-acknowledgement', evidence: 'Synthetic employer acknowledgement corrects the matched failure.' });
  await ctx.client.appendRecord('delivery', correction);
  const downloaded = await ctx.client.reconcile({ dryRun: false });
  assert.equal(downloaded.streams.delivery.cloudOnly, 1);
  const repeated = await ctx.client.reconcile({ dryRun: false });
  assert.equal(repeated.imported, 0);
  assert.equal(repeated.downloaded, 0);
  const localApplications = await readRows(ctx.stateDir, 'applications');
  const localDelivery = await readRows(ctx.stateDir, 'delivery');
  const cloudApplications = (await ctx.client.listStream('applications')).map(row => row.value);
  const cloudDelivery = (await ctx.client.listStream('delivery')).map(row => row.value);
  assert.equal(cloudDelivery.length, 2);
  assert.deepEqual(deliveryProjection(localApplications, localDelivery), deliveryProjection(cloudApplications, cloudDelivery));
  assert.equal(deliveryProjection(localApplications, localDelivery).effectiveSubmissionCount, 1);
  const localDiscovery = await readRows(ctx.stateDir, 'discovery');
  const cloudDiscovery = (await ctx.client.listStream('discovery')).map(row => row.value);
  assert.deepEqual(discoveryProjection(localDiscovery, { roundId: 'round-1' }), discoveryProjection(cloudDiscovery, { roundId: 'round-1' }));
});

sqliteTest('default reconciliation migrates failed-email recovery history and exports one application with two delivery records', async t => {
  const ctx = await setup(t);
  await writeRows(ctx.stateDir, 'applications', [application]);
  await writeRows(ctx.stateDir, 'delivery', [failure, retry]);
  const result = await ctx.client.reconcile({ dryRun: false });
  assert.equal(result.imported, 3);
  const again = await ctx.client.reconcile({ dryRun: false });
  assert.equal(again.imported, 0);
  const exported = await ctx.client.exportTo(join(ctx.root, 'private-export.json'));
  const archive = JSON.parse(await readFile(exported.path, 'utf8'));
  assert.equal(archive.streams.applications.length, 1);
  assert.equal(archive.streams.delivery.length, 2);
  assert.ok(archive.streams.delivery.every(row => row.provenance === 'local-reconcile'));
  assert.deepEqual(archive.streams.delivery.map(row => row.value), [failure, retry]);
  assert.equal(deliveryProjection(archive.streams.applications.map(row => row.value), archive.streams.delivery.map(row => row.value)).effectiveSubmissionCount, 1);
  if (process.platform !== 'win32') assert.equal((await stat(exported.path)).mode & 0o777, 0o600);
});

sqliteTest('private backup restores delivery attempts and projection without duplicating a second restore', async t => {
  const ctx = await setup(t);
  await writeRows(ctx.stateDir, 'applications', [application]);
  await writeRows(ctx.stateDir, 'delivery', [failure, retry]);
  await ctx.client.reconcile({ dryRun: false });
  const archive = await createBackup(ctx.bindings.DB, now);
  const restored = createMemoryD1(ctx.schema);
  assert.equal((await restoreBackup(restored, archive)).records, 3);
  assert.equal((await restoreBackup(restored, archive)).records, 0);
  const values = async stream => (await restored.prepare('SELECT payload_json FROM records WHERE stream = ? ORDER BY sequence').bind(stream).all()).results.map(row => JSON.parse(row.payload_json));
  const restoredApplications = await values('applications');
  const restoredDelivery = await values('delivery');
  assert.deepEqual(restoredDelivery, [failure, retry]);
  assert.deepEqual(deliveryProjection(restoredApplications, restoredDelivery), deliveryProjection([application], [failure, retry]));
});

sqliteTest('an older backend is rejected before any local-only accounting data uploads', async t => {
  const ctx = await setup(t);
  await writeRows(ctx.stateDir, 'applications', [application]);
  await writeRows(ctx.stateDir, 'delivery', [failure]);
  const mutations = [];
  const older = new CloudStateClient({ stateDir: ctx.stateDir, configPath: ctx.configPath, fetchImpl: async (input, init) => {
    if (new URL(input).pathname === '/v2/status') return Response.json({ apiVersion: 2, backend: 'cloudflare-d1-r2', capabilities: [] });
    if (init.method && init.method !== 'GET') mutations.push({ input, method: init.method });
    return ctx.fetchImpl(input, init);
  } });
  await assert.rejects(() => older.reconcile({ dryRun: false }), /backend upgrade required.*application-accounting-v1/i);
  assert.equal(mutations.length, 0);
  assert.equal((await ctx.bindings.DB.prepare('SELECT COUNT(*) AS count FROM records').first()).count, 0);
  assert.deepEqual(await readRows(ctx.stateDir, 'delivery'), [failure]);
});

sqliteTest('cached accounting permits offline research and durable observation queues while blocking transmission intents', async t => {
  const ctx = await setup(t);
  await ctx.client.putDocument('profile', { name: 'Synthetic Candidate', roleFamilies: ['engineering'] }, 0);
  await ctx.client.refreshProfileCache();
  await writeRows(ctx.stateDir, 'applications', [application]);
  await ctx.client.reconcile({ dryRun: false });
  const offline = new CloudStateClient({ stateDir: ctx.stateDir, configPath: ctx.configPath, fetchImpl: async () => { throw new Error('synthetic network outage'); } });
  await offline.requireAccounting();
  assert.equal((await readCachedCloudProfile(ctx.stateDir)).name, 'Synthetic Candidate');
  assert.deepEqual(await readRows(ctx.stateDir, 'applications'), [application]);
  const queued = await offline.appendRecord('delivery', failure, { queueOnFailure: true });
  assert.equal(queued.queued, true);
  const restarted = new CloudStateClient({ stateDir: ctx.stateDir, configPath: ctx.configPath, fetchImpl: offline.fetchImpl });
  const pending = await restarted.pendingWrites();
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].payload.value, failure);
  assert.equal(pending[0].stream, 'delivery');
  if (process.platform !== 'win32') assert.equal((await stat(join(ctx.stateDir, 'cloud-pending.ndjson'))).mode & 0o777, 0o600);
  await assert.rejects(() => restarted.createIntent({ applicationId: 'another-app', canonicalUrl: 'https://example.com/jobs/another', leaseId: 'expired-lease' }), /cloud state unavailable/i);
  assert.equal((await ctx.bindings.DB.prepare('SELECT COUNT(*) AS count FROM application_intents').first()).count, 0);
});

sqliteTest('a delivery replay followed by repeated synchronization preserves one logical evidence event', async t => {
  const ctx = await setup(t);
  await writeRows(ctx.stateDir, 'applications', [application]);
  await writeRows(ctx.stateDir, 'delivery', [failure]);
  await ctx.client.reconcile({ dryRun: false });
  await ctx.client.appendRecord('delivery', failure, { idempotencyKey: 'different-network-replay-id' });
  const sync = await ctx.client.reconcile({ dryRun: false });
  const repeated = await ctx.client.reconcile({ dryRun: false });
  assert.equal(sync.imported + sync.downloaded + repeated.imported + repeated.downloaded, 0);
  assert.equal((await ctx.client.listStream('delivery')).length, 1);
  assert.equal((await readRows(ctx.stateDir, 'delivery')).length, 1);
  assert.equal(deliveryProjection([application], await readRows(ctx.stateDir, 'delivery')).failedDeliveryCount, 1);
});

sqliteTest('cross-client JSON field ordering does not duplicate the same delivery event during synchronization', async t => {
  const ctx = await setup(t);
  await writeRows(ctx.stateDir, 'applications', [application]);
  await ctx.client.reconcile({ dryRun: false });
  await writeRows(ctx.stateDir, 'delivery', [failure]);
  const reorderedFailure = Object.fromEntries(Object.entries(failure).reverse());
  await ctx.client.appendRecord('delivery', reorderedFailure);
  await ctx.client.reconcile({ dryRun: false });
  await ctx.client.reconcile({ dryRun: false });
  assert.equal((await ctx.client.listStream('delivery')).length, 1);
  assert.equal((await readRows(ctx.stateDir, 'delivery')).length, 1);
});

sqliteTest('unfamiliar versioned discovery records survive synchronization unchanged', async t => {
  const ctx = await setup(t);
  const legacy = {version:7,type:'legacy-discovery-report',id:'legacy',roundId:'old',results:{reviewed:12}};
  await writeRows(ctx.stateDir,'discovery',[legacy]);
  await ctx.client.reconcile({dryRun:false});
  assert.deepEqual((await ctx.client.listStream('discovery'))[0].value,legacy);
  assert.deepEqual(discoveryProjection(await readRows(ctx.stateDir,'discovery')).leads,[]);
});
