import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { outreachD1 as createMemoryD1 } from './outreach-d1-helper.mjs';
import { cloudOutreachMutation, loadOutreach } from '../src/outreach.mjs';
import { fixture, assessment, handoff } from '../../job-application-agent/tests/fixtures/outreach.mjs';
import { OUTREACH_SCHEMA, withLocalOutreach } from '../../job-application-agent/scripts/outreach-store.mjs';
import { mutateOutreach, readOutreach } from '../../job-application-agent/scripts/outreach-domain.mjs';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createBackup, restoreBackup } from '../src/backup.mjs';
import worker, { sha256Hex } from '../src/worker.mjs';
import { CloudStateClient } from '../../job-application-agent/scripts/cloud-state-client.mjs';
import { runOutreach } from '../../job-application-agent/scripts/outreach-cli.mjs';

const now = '2026-09-16T10:00:00.000Z';
const context = { now, actor: 'host-a' };
test('cloud migration matches local schema', async () => {
  const schema = await readFile(new URL('../migrations/0003_outreach.sql', import.meta.url), 'utf8');
  assert.equal(schema.replace(/\s+/g, ' ').trim(), OUTREACH_SCHEMA.replace(/\s+/g, ' ').trim());
});
test('concurrent cloud hosts cannot both hand off the same company', async () => {
  const db = createMemoryD1(OUTREACH_SCHEMA);
  const run = (action, input) => cloudOutreachMutation(db, action, input, context);
  await run('policy-enable', { operationId: 'enable', timezone: 'UTC' });
  for (const id of ['first', 'second']) {
    await run('assess', assessment(id));
    await run('draft', { operationId: `draft-${id}`, id, text: 'Hello', claimRefs: [], purpose: 'initial' });
  }
  const results = await Promise.allSettled(['first', 'second'].map(id => run('handoff', handoff({ id, operationId: `handoff-${id}` }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const state = await loadOutreach(db);
  assert.equal(Object.keys(state.reservations).length, 1);
  const winner = Object.values(state.reservations)[0].opportunityId;
  await cloudOutreachMutation(db, 'record', { operationId: 'host-b-confirm', id: winner, attemptId: `handoff-${winner}`, type: 'sent-verified', occurredAt: now, evidence: 'Visible sent bubble.', messageRef: 'private-message-1' }, { ...context, actor: 'host-b' });
  assert.equal(readOutreach(await loadOutreach(db), 'show', { id: winner }, now).delivery, 'sent-verified');
});
test('local SQLite survives reopen, uses private modes, and physically removes cleared content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outreach-test-'));
  try {
    const f = fixture();
    await withLocalOutreach(dir, () => ({ state: f.state, result: true }));
    const result = await withLocalOutreach(dir, state => ({ result: readOutreach(state, 'show', { id: 'opportunity-1' }, now) }));
    assert.equal(result.content.drafts.length, 1);
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'outreach.sqlite'))).mode & 0o777, 0o600);
    await withLocalOutreach(dir, state => mutateOutreach(state, 'clear', { operationId: 'clear', ids: ['opportunity-1'] }, context));
    const bytes = await readFile(join(dir, 'outreach.sqlite'));
    assert.equal(bytes.includes(Buffer.from('example-recruiter')), false);
    assert.equal(bytes.includes(Buffer.from('canonical-resume')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restore without a current manifest discards sensitive content and blocks handoffs', async () => {
  const base = await readFile(new URL('../migrations/0001_private_state.sql', import.meta.url), 'utf8');
  const source = createMemoryD1(base + OUTREACH_SCHEMA);
  await cloudOutreachMutation(source, 'policy-enable', { operationId: 'enable', timezone: 'UTC' }, context);
  await cloudOutreachMutation(source, 'assess', assessment(), context);
  const archive = await createBackup(source);
  const target = createMemoryD1(base + OUTREACH_SCHEMA);
  await restoreBackup(target, archive);
  const restored = await loadOutreach(target);
  assert.equal(restored.meta.recoveryBlocked, true);
  assert.equal(restored.meta.enabled, false);
  assert.deepEqual(restored.contents, {});
  assert.equal(restored.opportunities['opportunity-1'].cleared, true);
});

test('authenticated CLI cloud flow clears stale cache, fails closed offline, and does not alter applications', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outreach-cloud-'));
  try {
    const base = await readFile(new URL('../migrations/0001_private_state.sql', import.meta.url), 'utf8');
    const DB = createMemoryD1(base + OUTREACH_SCHEMA);
    const token = 'synthetic-test-client-token-not-a-real-credential';
    await DB.prepare('INSERT INTO clients VALUES (?, ?, ?, ?, NULL, NULL)').bind('test-client', 'Synthetic', sha256Hex(token), now).run();
    const configPath = join(dir, 'cloud.json');
    await writeFile(configPath, JSON.stringify({ version: 2, url: 'https://private.example', token }), { mode: 0o600 });
    let offline = false; const requests = [];
    const cloudClient = new CloudStateClient({ stateDir: dir, configPath, fetchImpl: async (url, init) => {
      requests.push(url); assert.equal(new URL(url).origin, 'https://private.example');
      if (offline) throw new Error('synthetic offline');
      return worker.fetch(new Request(url, init), { DB });
    } });
    const run = (args, input) => runOutreach(args, { input, stateDirectory: dir, cloudClient, guard: async () => {} });
    await run(['policy', 'enable', '--stdin'], { operationId: 'enable', timezone: 'UTC' });
    await run(['assess', '--stdin'], assessment());
    assert.equal((await run(['show', 'opportunity-1'])).stale, false);
    offline = true;
    assert.equal((await run(['show', 'opportunity-1'])).stale, true);
    await assert.rejects(run(['draft', '--stdin'], { operationId: 'offline-draft', id: 'opportunity-1', text: 'Hello', claimRefs: [], purpose: 'initial' }), /unavailable/);
    assert.equal(Object.keys((await loadOutreach(DB)).operations).includes('offline-draft'), false);
    offline = false;
    await run(['show', 'opportunity-1']);
    await cloudOutreachMutation(DB, 'clear', { operationId: 'other-host-clear', ids: ['opportunity-1'] }, { actor: 'another-host' });
    const cleared = await run(['show', 'opportunity-1']); assert.equal(cleared.content, null);
    assert.equal((await readFile(join(dir, 'outreach-cloud-cache.json'), 'utf8')).includes('example-recruiter'), false);
    assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM records WHERE stream IN ('applications', 'rounds', 'outcomes')").first()).count, 0);
    assert(requests.every(u => /\/v2\/(status|outreach\/)/.test(u)));
    assert.equal((await worker.fetch(new Request('https://private.example/v2/outreach/snapshot'), { DB })).status, 401);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('current deletion manifest redacts old backups and replay cannot restore cleared content', async () => {
  const base = await readFile(new URL('../migrations/0001_private_state.sql', import.meta.url), 'utf8');
  const DB = createMemoryD1(base + OUTREACH_SCHEMA);
  await cloudOutreachMutation(DB, 'policy-enable', { operationId: 'enable', timezone: 'UTC' }, context);
  await cloudOutreachMutation(DB, 'assess', assessment(), context);
  const archive = await createBackup(DB);
  await cloudOutreachMutation(DB, 'clear', { operationId: 'clear', ids: ['opportunity-1'] }, context);
  const state = await loadOutreach(DB);
  const manifest = { keyFingerprint: sha256Hex(state.meta.key), revision: state.meta.revision, tombstones: Object.values(state.tombstones) };
  const target = createMemoryD1(base + OUTREACH_SCHEMA);
  await restoreBackup(target, archive, { deletionManifest: manifest });
  assert.deepEqual((await loadOutreach(target)).contents, {});
  await assert.rejects(cloudOutreachMutation(target, 'assess', assessment('opportunity-1', { operationId: 'resurrection' }), context), /disabled|cleared/);
  await assert.rejects(restoreBackup(target, archive, { deletionManifest: manifest }), /empty destination/);
});
