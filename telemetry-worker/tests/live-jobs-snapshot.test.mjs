import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import worker, { handleRequest } from '../src/worker.mjs';
import {
  SNAPSHOT_BUILT_AT_KEY,
  SNAPSHOT_KEY,
  maybeWriteSnapshot,
  resetSnapshotMemo,
  serializeSnapshot,
  snapshotDue,
} from '../src/live-jobs-snapshot.mjs';
import { createMemoryD1, hasNodeSqlite } from './d1-mock.mjs';

const sqliteTest = hasNodeSqlite ? test : test.skip;
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const SECRET = 'test-signing-secret-at-least-24-chars';
const STATUSES = ['open', 'closed', 'unknown'];

async function seededDb(count = 260) {
  const db = createMemoryD1();
  for (const file of (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(join(migrationsDir, file), 'utf8'));
  }
  const insert = db.database.prepare(`
    INSERT INTO community_jobs (
      job_id, canonical_url, company, role, application_channel, discovery_source, provider_url,
      publication_status, review_status, published_at, reviewed_at, first_seen_at, last_seen_at,
      first_skill_version, last_skill_version, liveness_status, last_checked_at, closed_at, contribution_count
    ) VALUES (?, ?, 'Co', ?, 'greenhouse', ?, ?, ?, ?, ?, ?, ?, ?, '3.7.0', '3.7.0', ?, ?, ?, ?)
  `);
  for (let index = 0; index < count; index++) {
    const jobId = `community-job-${index.toString(16).padStart(16, '0')}`;
    // Few distinct days so many rows tie on last_seen_at and the job_id tiebreak matters.
    const seen = `2026-09-${String((index % 7) + 1).padStart(2, '0')}T00:00:00.000Z`;
    const status = STATUSES[index % 3];
    const published = index % 11 === 0 ? 'pending' : 'published';
    insert.run(
      jobId, `https://example.com/${jobId}`, `Role ${index}`, index % 4 === 0 ? null : 'job-board',
      `https://example.com/p/${jobId}`, published, 'maintainer-reviewed', seen, seen, seen, seen,
      status, index % 5 === 0 ? null : '2026-10-20T00:00:00.000Z', status === 'closed' ? '2026-10-20T00:00:00.000Z' : null,
      1 + (index % 3),
    );
  }
  db.database.prepare(`INSERT OR REPLACE INTO public_liveness_meta (id, newest_last_checked_at) VALUES (1, '2026-10-28T10:00:00.000Z')`).run();
  return db;
}

function memoryKv() {
  const map = new Map();
  return {
    map,
    gets: 0,
    puts: 0,
    async get(key) { this.gets++; return map.has(key) ? map.get(key) : null; },
    async put(key, value) { this.puts++; map.set(key, value); },
  };
}

function bindings(db, kv) {
  return { PUBLIC_STATS_DB: db, SIGNING_SECRET: SECRET, ...(kv ? { LIVE_JOBS_SNAPSHOT: kv } : {}) };
}

async function getJson(env, path) {
  const response = await handleRequest(new Request(`https://relay.example.com${path}`), env);
  return { response, body: await response.json() };
}

async function walk(env, { status = null, limit = 100 } = {}) {
  const pages = [];
  let cursor = null;
  for (let guard = 0; guard < 500; guard++) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set('status', status);
    if (cursor) params.set('cursor', cursor);
    const { response, body } = await getJson(env, `/v1/jobs/live?${params}`);
    assert.equal(response.status, 200);
    pages.push({ body, source: response.headers.get('x-live-jobs-source') });
    cursor = body.nextCursor;
    if (!cursor) return pages;
  }
  throw new Error('cursor loop');
}

sqliteTest('cursor and status pages seek the index (no full scan, no temp sort)', async () => {
  const db = await seededDb();
  const sql = `
    SELECT jobs.job_id FROM community_jobs AS jobs
    WHERE jobs.publication_status = 'published' AND jobs.review_status = 'maintainer-reviewed'
      AND jobs.liveness_status = ? AND (jobs.last_seen_at, jobs.job_id) < (?, ?)
    ORDER BY jobs.last_seen_at DESC, jobs.job_id DESC LIMIT ?`;
  const plan = JSON.stringify(db.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('open', '2026-09-04T00:00:00.000Z', 'community-job-0000000000000050', 101));
  assert.match(plan, /idx_community_jobs_live \(publication_status=\? AND review_status=\? AND liveness_status=\? AND \(last_seen_at,job_id\)<\(\?,\?\)\)/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
});

sqliteTest('snapshot pages are byte-identical to D1 pages for every status, limit and cursor', async () => {
  const db = await seededDb();
  const kv = memoryKv();
  resetSnapshotMemo();
  assert.equal(await maybeWriteSnapshot(bindings(db, kv), {
    listLiveSnapshotRows: async () => db.database.prepare(`
      SELECT job_id, canonical_url, company, role, application_channel, discovery_source, provider_url,
             first_seen_at, last_seen_at, liveness_status, last_checked_at, closed_at, contribution_count
      FROM community_jobs WHERE publication_status = 'published' AND review_status = 'maintainer-reviewed'
      ORDER BY last_seen_at DESC, job_id DESC`).all(),
  }, { scheduledTime: Date.parse('2026-10-29T00:00:00Z'), now: Date.now() }), true);
  for (const status of [null, ...STATUSES]) {
    for (const limit of [1, 7, 50, 100]) {
      resetSnapshotMemo();
      const fromD1 = await walk(bindings(db), { status, limit });
      const fromSnapshot = await walk(bindings(db, kv), { status, limit });
      assert.ok(fromD1.every((page) => page.source === 'd1'));
      assert.ok(fromSnapshot.every((page) => page.source === 'snapshot'));
      assert.equal(JSON.stringify(fromSnapshot.map((page) => page.body)), JSON.stringify(fromD1.map((page) => page.body)), `status=${status} limit=${limit}`);
      // The pre-change query (OR-form cursor, `? IS NULL OR` status) walked the same rows in the same order.
      const legacyIds = db.database.prepare(`
        SELECT job_id FROM community_jobs AS jobs
        WHERE jobs.publication_status = 'published' AND jobs.review_status = 'maintainer-reviewed'
          AND (? IS NULL OR jobs.liveness_status = ?)
        ORDER BY jobs.last_seen_at DESC, jobs.job_id DESC`).all(status, status).map((row) => row.job_id);
      assert.deepEqual(fromD1.flatMap((page) => page.body.jobs.map((job) => job.jobId)), legacyIds);
    }
  }
});

sqliteTest('cron writes the snapshot via the real store; missing or stale snapshots fall back to D1', async () => {
  const db = await seededDb(40);
  const kv = memoryKv();
  resetSnapshotMemo();
  const env = bindings(db, kv);
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-29T01:05:00Z') }, { ...env, LIVENESS_FETCH: async () => new Response('', { status: 404 }) });
  assert.ok(kv.map.has(SNAPSHOT_KEY), 'missing snapshot is written on the next tick');
  assert.ok(kv.map.has(SNAPSHOT_BUILT_AT_KEY));
  const parsed = JSON.parse(kv.map.get(SNAPSHOT_KEY));
  assert.equal(parsed.v, 1);
  assert.equal(parsed.rows.length, db.database.prepare(`SELECT COUNT(*) AS n FROM community_jobs WHERE publication_status = 'published'`).get().n);

  const live = await getJson(env, '/v1/jobs/live?limit=5');
  assert.equal(live.response.headers.get('x-live-jobs-source'), 'snapshot');
  assert.deepEqual(live.body.meta, { newestLastCheckedAt: '2026-10-28T10:00:00.000Z' });
  assert.match(live.response.headers.get('cache-control'), /s-maxage=300/);

  resetSnapshotMemo();
  kv.map.set(SNAPSHOT_KEY, serializeSnapshot([], '2026-01-01T00:00:00.000Z'));
  const stale = await getJson(env, '/v1/jobs/live?limit=5');
  assert.equal(stale.response.headers.get('x-live-jobs-source'), 'd1');
  assert.equal(stale.body.jobs.length, 5);

  resetSnapshotMemo();
  kv.map.set(SNAPSHOT_KEY, '{"v":2}');
  assert.equal((await getJson(env, '/v1/jobs/live?limit=5')).response.headers.get('x-live-jobs-source'), 'd1');
});

test('snapshot cadence is every 2 h on the UTC clock and skips other ticks', async () => {
  assert.equal(snapshotDue(Date.parse('2026-10-29T00:00:00Z')), true);
  assert.equal(snapshotDue(Date.parse('2026-10-29T02:00:00Z')), true);
  assert.equal(snapshotDue(Date.parse('2026-10-29T01:00:00Z')), false);
  assert.equal(snapshotDue(Date.parse('2026-10-29T02:05:00Z')), false);
  const kv = memoryKv();
  const now = Date.parse('2026-10-29T02:05:00Z');
  kv.map.set(SNAPSHOT_BUILT_AT_KEY, '2026-10-29T02:00:00.000Z');
  let built = 0;
  const store = { async listLiveSnapshotRows() { built++; return []; } };
  assert.equal(await maybeWriteSnapshot({ LIVE_JOBS_SNAPSHOT: kv }, store, { scheduledTime: now, now }), false);
  assert.equal(built, 0);
  assert.equal(kv.puts, 0);
});
