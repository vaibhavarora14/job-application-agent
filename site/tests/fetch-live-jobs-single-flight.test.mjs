import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import test from 'node:test';

// fetch-live-jobs imports `env` from cloudflare:workers; give it a stub env whose
// TELEMETRY binding counts relay calls.
const relay = { calls: 0, fail: false };
globalThis.__liveJobsTestEnv = {
  COMMUNITY_JOBS_LIVE_UPSTREAM: 'https://relay.example.com/v1/jobs/live',
  TELEMETRY: {
    async fetch(request) {
      relay.calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (relay.fail) throw new Error('cancelled');
      const url = new URL(request.url);
      const page = url.searchParams.get('cursor') ? 1 : 0;
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
      return Response.json({
        version: 1,
        jobs: [job(page * 2), job(page * 2 + 1)],
        nextCursor: page === 0 ? 'eyJ2IjoxLCJsYXN0U2VlbkF0IjoiMjAyNi0xMC0wMVQwMDowMDowMC4wMDBaIiwiam9iSWQiOiJjb21tdW5pdHktam9iLTAwMDAwMDAwMDAwMDAwMDEifQ' : null,
        meta: { newestLastCheckedAt: '2026-10-28T00:00:00.000Z' },
      });
    },
  },
};
// node:module registerHooks needs Node >= 22.15; the root suite also runs on Node 20, where this
// file skips (the site job covers it on Node 24).
const supported = typeof nodeModule.registerHooks === 'function';
if (supported) nodeModule.registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env = globalThis.__liveJobsTestEnv;', shortCircuit: true };
    return next(specifier, context);
  },
});

const { loadLiveJobs } = supported ? await import('../lib/fetch-live-jobs.mjs') : {};
const skip = supported ? false : 'needs node:module registerHooks (Node >= 22.15)';

test('concurrent board loads in one isolate share a single relay pagination', { skip }, async () => {
  relay.calls = 0;
  const [first, second, third] = await Promise.all([loadLiveJobs(), loadLiveJobs(), loadLiveJobs()]);
  assert.equal(relay.calls, 2, 'one 2-page walk, not three');
  assert.equal(first.length, 4);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  // Memoised afterwards: no further relay calls.
  await loadLiveJobs();
  assert.equal(relay.calls, 2);
});

test('followers retry once, together, when the shared load fails', { skip }, async () => {
  relay.calls = 0;
  relay.fail = true;
  const leader = loadLiveJobs({ status: 'closed' });
  const followers = [loadLiveJobs({ status: 'closed' }), loadLiveJobs({ status: 'closed' }), loadLiveJobs({ status: 'closed' })];
  await assert.rejects(leader);
  relay.fail = false;
  const boards = await Promise.all(followers);
  for (const jobs of boards) assert.equal(jobs.length, 4);
  // 1 failed first page + one shared 2-page retry, not one retry per follower.
  assert.equal(relay.calls, 3);
});
