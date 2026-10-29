import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPublicStats, isCountableInstallActivity, recordPublicAggregate } from '../src/public-stats.mjs';
import { FIXTURE_INSTALL_CORRECTION } from '../src/corrections/fixture-installs-2026-10-22.mjs';
import { applyInstallCorrection, planInstallCorrection } from '../src/install-corrections.mjs';
import worker from '../src/worker.mjs';
import { createMemoryD1, hasNodeSqlite } from './d1-mock.mjs';

const sqliteTest = hasNodeSqlite ? test : test.skip;
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const secret = 'test-signing-secret-with-sufficient-length';

async function applyMigrations(db, { stopBefore = null } = {}) {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    if (stopBefore && file.startsWith(stopBefore)) break;
    await db.exec(await readFile(join(migrationsDir, file), 'utf8'));
  }
}

const lifetime = (db) => db.database.prepare('SELECT * FROM public_stats_lifetime WHERE id = 1').get();
const send = (db, installationId, event, properties = {}, now = new Date('2026-10-22T06:00:00.000Z')) =>
  recordPublicAggregate(db, { installationId, event, properties }, secret, now);

test('only real activity counts an installation', () => {
  assert.equal(isCountableInstallActivity({ event: 'installation_started' }), false);
  assert.equal(isCountableInstallActivity({ event: 'command_completed', properties: { command: 'apply' } }), false);
  assert.equal(isCountableInstallActivity({ event: 'command_completed', properties: { command: 'score' } }), true);
  assert.equal(isCountableInstallActivity({ event: 'job_assessed', properties: {} }), true);
  assert.equal(isCountableInstallActivity({ event: 'application_submitted', properties: {} }), true);
});

sqliteTest('migration 0006 keeps every existing installation counted', async () => {
  const db = createMemoryD1();
  await applyMigrations(db, { stopBefore: '0006' });
  db.database.prepare(`INSERT INTO public_installations (installation_hash, installed_at, last_active_at)
    VALUES ('a', '2026-01-01T00:00:00.000Z', NULL), ('b', '2026-01-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run();
  await db.exec(await readFile(join(migrationsDir, '0006_install_counting.sql'), 'utf8'));
  assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM public_installations WHERE uncounted = 0').get().n, 2);
  // A pre-deploy worker inserting without the column still produces counted rows.
  db.database.prepare(`INSERT INTO public_installations (installation_hash, installed_at, last_active_at) VALUES ('c', '2026-10-22T00:00:00.000Z', NULL)`).run();
  assert.equal(db.database.prepare(`SELECT uncounted FROM public_installations WHERE installation_hash = 'c'`).get().uncounted, 0);
});

sqliteTest('installs count at first real activity, never at installation_started or a fixture ledger add', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const fixture = '11111111-1111-4111-8111-111111111111';
  const real = '22222222-2222-4222-8222-222222222222';
  const noStart = '33333333-3333-4333-8333-333333333333';

  await send(db, fixture, 'installation_started');
  await send(db, fixture, 'command_completed', { command: 'apply', status: 'ok' });
  assert.equal(lifetime(db).installations, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM public_installations').get().n, 1);

  await send(db, real, 'installation_started');
  assert.equal(lifetime(db).installations, 0);
  await send(db, real, 'job_assessed');
  assert.equal(lifetime(db).installations, 1);
  await send(db, real, 'job_assessed');
  await send(db, real, 'application_submitted', { ats: 'ashby' });
  await send(db, real, 'command_completed', { command: 'score' });
  assert.equal(lifetime(db).installations, 1);

  await send(db, noStart, 'command_completed', { command: 'discover' });
  assert.equal(lifetime(db).installations, 2);
  await send(db, noStart, 'installation_started');
  assert.equal(lifetime(db).installations, 2);

  const counted = db.database.prepare('SELECT COUNT(*) AS n FROM public_installations WHERE uncounted = 0').get().n;
  assert.equal(counted, 2);
  const stats = await buildPublicStats(db, new Date('2026-10-22T06:00:00.000Z'));
  assert.equal(stats.metrics.installations, 2);
});

test('correction plan applies a cluster only when candidates and listed times match exactly', () => {
  const plan = planInstallCorrection(
    ['2026-10-13T10:00:00.000Z', '2026-10-13T10:00:00.050Z', '2026-10-13T11:00:00.000Z', '2026-10-13T12:00:00.000Z'],
    [
      { installation_hash: 'a', installed_at: '2026-10-13T10:00:00.400Z' },
      { installation_hash: 'b', installed_at: '2026-10-13T10:00:00.700Z' },
      { installation_hash: 'c', installed_at: '2026-10-13T11:00:00.300Z' },
      { installation_hash: 'd', installed_at: '2026-10-13T11:00:01.000Z' }, // unexpected extra: skip the cluster
      { installation_hash: 'e', installed_at: '2026-10-13T13:00:00.000Z' }, // outside every window
    ],
  );
  assert.deepEqual(plan.matched.sort(), ['a', 'b']);
  assert.equal(plan.listed, 4);
  assert.equal(plan.skipped, 2); // 11:00 had two candidates, 12:00 had none
});

sqliteTest('one-off correction marks matched installs, lowers the total once, and deletes nothing', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const insert = db.database.prepare('INSERT INTO public_installations (installation_hash, installed_at, last_active_at) VALUES (?, ?, ?)');
  insert.run('fix-1', '2026-10-13T10:00:00.300Z', null);
  insert.run('fix-2', '2026-10-13T10:00:00.350Z', null);
  insert.run('fix-3', '2026-10-14T09:00:00.900Z', null);
  insert.run('real-active', '2026-10-13T10:00:01.000Z', '2026-10-13T11:00:00.000Z'); // active: never a candidate
  insert.run('real-old', '2026-09-01T00:00:00.000Z', null);
  db.database.prepare('UPDATE public_stats_lifetime SET installations = 5 WHERE id = 1').run();

  const correction = {
    id: 'test-correction',
    reason: 'fixture',
    observedAt: ['2026-10-13T10:00:00.000Z', '2026-10-13T10:00:00.010Z', '2026-10-14T09:00:00.000Z', '2026-10-15T00:00:00.000Z'],
  };
  const logs = [];
  const first = await applyInstallCorrection(db, correction, { now: new Date('2026-10-22T06:00:00.000Z'), log: (line) => logs.push(line) });
  assert.equal(first.applied, true);
  assert.equal(first.matched, 3);
  assert.equal(first.listed, 4);
  assert.equal(first.skipped, 1);
  assert.equal(lifetime(db).installations, 2);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM public_installations').get().n, 5);
  const excluded = db.database.prepare('SELECT installation_hash FROM public_installation_exclusions ORDER BY installation_hash').all().map((row) => row.installation_hash);
  assert.deepEqual(excluded, ['fix-1', 'fix-2', 'fix-3']);
  const uncounted = db.database.prepare('SELECT installation_hash FROM public_installations WHERE uncounted = 1 ORDER BY installation_hash').all().map((row) => row.installation_hash);
  assert.deepEqual(uncounted, ['fix-1', 'fix-2', 'fix-3']);
  const audit = db.database.prepare('SELECT * FROM public_stats_corrections').get();
  assert.equal(audit.applied_count, 3);
  assert.equal(audit.skipped_count, 1);
  assert.deepEqual(JSON.parse(logs[0]), { correction: 'test-correction', listed: 4, applied: 3, skipped: 1 });

  const second = await applyInstallCorrection(db, correction, { log: (line) => logs.push(line) });
  assert.equal(second.reason, 'already_applied');
  assert.equal(lifetime(db).installations, 2);
  assert.equal(logs.length, 1);
});

sqliteTest('the scheduled handler applies the committed correction exactly once', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const insert = db.database.prepare('INSERT INTO public_installations (installation_hash, installed_at, last_active_at) VALUES (?, ?, NULL)');
  FIXTURE_INSTALL_CORRECTION.observedAt.forEach((at, index) => insert.run(`h${index}`, new Date(Date.parse(at) + 400).toISOString()));
  db.database.prepare('UPDATE public_stats_lifetime SET installations = 1000 WHERE id = 1').run();
  const logs = [];
  const bindings = {
    PUBLIC_STATS_DB: db,
    CORRECTION_LOG: (line) => logs.push(line),
    JOB_STORE: { async listDueForLivenessCheck() { return { jobs: [], hasMore: false }; }, async updateLivenessBatch() {} },
  };
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-22T06:05:00Z') }, bindings);
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-22T06:10:00Z') }, bindings);
  assert.equal(lifetime(db).installations, 1000 - 398);
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]), { correction: 'fixture-installs-2026-10-22', listed: 398, applied: 398, skipped: 0 });
});

test('committed correction lists 398 timestamps and no installation identifiers', async () => {
  const times = FIXTURE_INSTALL_CORRECTION.observedAt;
  assert.equal(times.length, 398);
  assert.equal(new Set(times).size, 398);
  for (const value of times) {
    assert.match(value, /^2026-10-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Date.parse(value) >= Date.parse('2026-10-01T00:00:00Z') && Date.parse(value) < Date.parse('2026-10-23T00:00:00Z'));
  }
  const source = await readFile(new URL('../src/corrections/fixture-installs-2026-10-22.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});
