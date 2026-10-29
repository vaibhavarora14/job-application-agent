import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import test from 'node:test';

// The per-isolate board memo lasts as long as the Cache API copy it mirrors (never
// less than 60 s), so a warm isolate stops re-parsing and re-validating the board
// every minute while the cached copy is unchanged anyway.
const relay = { calls: 0 };
const job = (n) => ({
  jobId: `community-job-${String(n).padStart(16, '0')}`,
  url: `https://job-boards.greenhouse.io/example/jobs/${1000 + n}`,
  company: 'Example',
  role: `Engineer ${n}`,
  applicationChannel: 'greenhouse',
  providerUrl: `https://job-boards.greenhouse.io/example/jobs/${1000 + n}`,
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-01T00:00:00.000Z',
  contributionCount: 1,
  livenessStatus: 'open',
  lastCheckedAt: '2026-10-28T00:00:00.000Z',
  closedAt: null,
});
globalThis.__liveJobsMemoTestEnv = {
  COMMUNITY_JOBS_LIVE_UPSTREAM: 'https://relay.example.com/v1/jobs/live',
  TELEMETRY: {
    async fetch() {
      relay.calls++;
      return Response.json({ version: 1, jobs: [job(relay.calls)], nextCursor: null, meta: { newestLastCheckedAt: null } });
    },
  },
};
// node:module registerHooks needs Node >= 22.15; the root suite also runs on Node 20, where this
// file skips (the site job covers it on Node 24).
const supported = typeof nodeModule.registerHooks === 'function';
if (supported) nodeModule.registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env = globalThis.__liveJobsMemoTestEnv;', shortCircuit: true };
    return next(specifier, context);
  },
});

const store = new Map();
const cacheOps = { match: 0, put: 0 };
globalThis.caches = {
  default: {
    async match(request) {
      cacheOps.match++;
      const hit = store.get(request.url);
      return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
    },
    async put(request, response) {
      cacheOps.put++;
      store.set(request.url, { body: await response.text(), headers: [...response.headers] });
    },
  },
};
let clock = Date.parse('2026-10-29T04:00:00.000Z');
const realNow = Date.now;
Date.now = () => clock;
test.after(() => { Date.now = realNow; delete globalThis.caches; });

const { loadLiveJobs } = supported ? await import('../lib/fetch-live-jobs.mjs') : {};
const skip = supported ? false : 'needs node:module registerHooks (Node >= 22.15)';

test('memo mirrors the cached board until the cached copy expires', { skip }, async () => {
  relay.calls = 0;
  const first = await loadLiveJobs({ status: 'open' });
  assert.equal(relay.calls, 1);
  assert.equal(cacheOps.put, 1);
  const [, entry] = [...store].find(([key]) => key.includes('status=open'));
  assert.equal(new Headers(entry.headers).get('x-jaa-board-built-at'), String(clock));

  // Four minutes later the memo still answers: no cache read, no relay call.
  const matchesBefore = cacheOps.match;
  clock += 4 * 60_000;
  assert.equal(await loadLiveJobs({ status: 'open' }), first);
  assert.equal(cacheOps.match, matchesBefore);
  assert.equal(relay.calls, 1);

  // Past the cached copy's 5-minute life the memo expires; with the copy gone the
  // board is fetched fresh again (same freshness as before this change).
  clock += 61_000;
  store.clear();
  const next = await loadLiveJobs({ status: 'open' });
  assert.equal(relay.calls, 2);
  assert.notDeepEqual(next, first);
});

test('a cached board without a built-at stamp (older deploy) keeps the 60 s memo', { skip }, async () => {
  store.clear();
  relay.calls = 0;
  const key = 'https://jobappagent.com/__cache/live-jobs-board?status=closed';
  store.set(key, {
    body: JSON.stringify({ version: 1, jobs: [job(42)], nextCursor: null, meta: { newestLastCheckedAt: null } }),
    headers: [['content-type', 'application/json']],
  });
  const fromCache = await loadLiveJobs({ status: 'closed' });
  assert.equal(fromCache[0].jobId, job(42).jobId);
  assert.equal(relay.calls, 0);
  const matches = cacheOps.match;
  clock += 59_000;
  await loadLiveJobs({ status: 'closed' });
  assert.equal(cacheOps.match, matches, 'within 60 s: memo');
  clock += 2_000;
  await loadLiveJobs({ status: 'closed' });
  assert.equal(cacheOps.match, matches + 1, 'after 60 s: re-read the cached copy');
});
