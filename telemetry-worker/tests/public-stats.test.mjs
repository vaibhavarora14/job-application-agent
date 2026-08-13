import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPublicStats, recordPublicAggregate } from '../src/public-stats.mjs';
import worker from '../src/worker.mjs';

function result(results = []) { return { results, success: true }; }

function readDb() {
  const queued = [
    result([{ installations: 42, active_installations_30d: 18, jobs_assessed: 310, applications_submitted: 96, interviews: 12, offers: 2 }]),
    result([{ day: '2026-08-12', assessed: 14, submitted: 5 }, { day: '2026-08-13', assessed: 21, submitted: 8 }]),
    result([{ label: 'ashby', count: 30 }, { label: 'greenhouse', count: 20 }, { label: 'tiny-segment', count: 2 }]),
    result([{ label: 'senior', count: 50 }, { label: 'staff', count: 25 }, { label: 'principal', count: 1 }]),
    result([{ label: 'interview', count: 12 }, { label: 'offer', count: 2 }]),
  ];
  const queries = [];
  return {
    prepare(query) {
      queries.push(query);
      return { all: async () => queued.shift() };
    },
    queries,
  };
}

function writeDb() {
  const writes = [];
  return {
    prepare(query) {
      return {
        bind(...values) {
          return { run: async () => { writes.push({ query, values }); return { success: true }; } };
        },
      };
    },
    writes,
  };
}

test('public stats returns aggregate metrics and suppresses small segments', async () => {
  const db = readDb();
  const data = await buildPublicStats(db, new Date('2026-08-14T00:00:00Z'));
  assert.equal(data.metrics.installations, 42);
  assert.equal(data.metrics.applicationsSubmitted, 96);
  assert.deepEqual(data.timeline[0], { day: '2026-08-12', assessed: 14, submitted: 5 });
  assert.deepEqual(data.breakdowns.ats, [
    { label: 'ashby', count: 30 },
    { label: 'greenhouse', count: 20 },
    { label: 'other', count: 2 },
  ]);
  assert.equal(data.privacy.minimumSegmentCount, 3);
  assert.equal(JSON.stringify(data).includes('installation_hash'), false);
  for (const query of db.queries) {
    assert.doesNotMatch(query, /SELECT\s+\*/i);
    assert.doesNotMatch(query, /installation_hash\s+AS/i);
  }
});

test('event aggregation stores only an HMAC installation hash and bounded dimensions', async () => {
  const db = writeDb();
  await recordPublicAggregate(db, {
    installationId: '11111111-1111-4111-8111-111111111111',
    event: 'application_submitted',
    properties: { ats: 'ashby' },
  }, 'test-signing-secret-with-sufficient-length', new Date('2026-08-14T00:00:00Z'));
  const serialized = JSON.stringify(db.writes);
  assert.equal(serialized.includes('11111111-1111-4111-8111-111111111111'), false);
  assert.equal(serialized.includes('ashby'), true);
  assert.equal(db.writes.length, 3);
});

test('public endpoint exposes only aggregate output and cache policy', async () => {
  const response = await worker.fetch(new Request('https://relay.example.com/api/public-stats'), { PUBLIC_STATS_DB: readDb() });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /s-maxage=900/);
  const body = await response.text();
  assert.equal(body.includes('installation_hash'), false);
  assert.equal(body.includes('distinct_id'), false);
});

test('public endpoint fails closed without the aggregate store', async () => {
  const response = await worker.fetch(new Request('https://relay.example.com/api/public-stats'), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'stats_unavailable' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
