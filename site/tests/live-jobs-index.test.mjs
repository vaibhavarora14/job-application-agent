import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import test from 'node:test';
import locations from '../data/job-locations.json' with { type: 'json' };

// /jobs/<slug> on a cold isolate reads one job from a lookup index (Cache API, written
// by the site from a validated board) instead of validating the whole board. It must
// return exactly what the whole-board path returns for that job, and fall back to the
// whole board whenever the index is missing or does not check out.
const record = locations.records[0];
const relay = { calls: 0 };
const wire = (n, overrides = {}) => ({
  jobId: `community-job-${String(n).padStart(16, '0')}`,
  url: `https://job-boards.greenhouse.io/example/jobs/${1000 + n}`,
  company: 'Example Ünïcode Co',
  role: `Senior Engineer ${n}`,
  applicationChannel: 'greenhouse',
  discoverySource: undefined,
  providerUrl: `https://job-boards.greenhouse.io/example/jobs/${1000 + n}`,
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-02T00:00:00.000Z',
  contributionCount: n,
  livenessStatus: 'open',
  lastCheckedAt: '2026-10-28T00:00:00.000Z',
  closedAt: null,
  ...overrides,
});
const clean = (job) => Object.fromEntries(Object.entries(job).filter(([, v]) => v !== undefined));
// One job matches a real directory location record, so its page attaches a location.
const board = [
  ...Array.from({ length: 150 }, (_, i) => clean(wire(i + 1))),
  clean(wire(999, { jobId: record.jobId, url: record.url, providerUrl: record.url, company: record.company, role: record.role })),
];
globalThis.__liveJobsIndexTestEnv = {
  COMMUNITY_JOBS_LIVE_UPSTREAM: 'https://relay.example.com/v1/jobs/live',
  TELEMETRY: {
    async fetch(request) {
      relay.calls++;
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const jobs = board.slice(offset, offset + 100);
      const next = offset + 100 < board.length ? String(offset + 100) : null;
      return Response.json({ version: 1, jobs, nextCursor: next, meta: { newestLastCheckedAt: null } });
    },
  },
};
const supported = typeof nodeModule.registerHooks === 'function';
if (supported) nodeModule.registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env = globalThis.__liveJobsIndexTestEnv;', shortCircuit: true };
    return next(specifier, context);
  },
});

const store = new Map();
const reads = new Map();
globalThis.caches = {
  default: {
    async match(request) {
      reads.set(request.url, (reads.get(request.url) ?? 0) + 1);
      const hit = store.get(request.url);
      return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
    },
    async put(request, response) {
      store.set(request.url, { body: await response.text(), headers: [...response.headers] });
    },
  },
};
const INDEX = 'https://jobappagent.com/__cache/live-jobs-index?status=open';
const BOARD = 'https://jobappagent.com/__cache/live-jobs-board?status=open';
let clock = Date.parse(record.checkedAt) + 3600_000;
const realNow = Date.now;
Date.now = () => clock;
test.after(() => { Date.now = realNow; delete globalThis.caches; });

let isolate = 0;
/** A fresh module instance stands in for a fresh isolate (empty module memos). */
const freshIsolate = () => import(`../lib/fetch-live-jobs.mjs?isolate=${++isolate}`);
const skip = supported ? false : 'needs node:module registerHooks (Node >= 22.15)';

test('cold isolate: index lookup returns the same job as the whole board, without validating the board', { skip }, async () => {
  const first = await freshIsolate();
  const id = board[10].jobId;
  const whole = await first.loadOpenJobsForJobId(id);
  assert.equal(whole.length, board.length, 'no index yet: whole board');
  assert.equal(relay.calls, 2);
  assert.ok(store.has(INDEX), 'the next validated board writes the index');
  const indexHeaders = new Headers(store.get(INDEX).headers);
  assert.equal(indexHeaders.get('x-jaa-board-built-at'), new Headers(store.get(BOARD).headers).get('x-jaa-board-built-at'));
  assert.match(indexHeaders.get('cache-control'), /s-maxage=(\d+)/);
  assert.ok(Number(indexHeaders.get('cache-control').match(/s-maxage=(\d+)/)[1]) <= 300);

  const cold = await freshIsolate();
  const boardReads = reads.get(BOARD) ?? 0;
  for (const job of whole) {
    assert.deepEqual(await cold.loadOpenJobsForJobId(job.jobId), [job], job.jobId);
  }
  assert.deepEqual(await cold.loadOpenJobsForJobId('community-job-ffffffffffffffff'), [], 'not on the board');
  assert.equal(reads.get(BOARD) ?? 0, boardReads, 'board copy never read');
  assert.equal(relay.calls, 2, 'relay never called');
  // Same array for repeat lookups (metadata + page in one request share the page memo).
  assert.equal(await cold.loadOpenJobsForJobId(id), await cold.loadOpenJobsForJobId(id));
});

test('job page through the index renders the same data as through the whole board', { skip }, async () => {
  const { loadJobPageBySlug } = await import('../lib/job-page-data.mjs');
  const { jobSlug } = await import('../lib/live-jobs.mjs');
  const viaIndex = await import('../lib/fetch-live-jobs.mjs');
  for (const job of [board[0], board[149], board[150]]) {
    const slug = jobSlug(job);
    const page = await loadJobPageBySlug(slug);
    const wholeBoard = await (await freshIsolate()).loadLiveJobs({ status: 'open', skipCache: true });
    const expected = await loadJobPageBySlug(slug, { loadLive: async () => wholeBoard, locationIndex: locations, now: clock });
    assert.ok(page, slug);
    assert.deepEqual(page, expected, slug);
  }
  const located = await loadJobPageBySlug(jobSlug(board[150]));
  assert.equal(located.job.location?.jobId, record.jobId, 'own location record attached');
  assert.equal(await loadJobPageBySlug('example-role-without-id'), null);
  assert.equal(await loadJobPageBySlug('example-senior-engineer-ffffffffffffffff'), null);
  assert.ok(viaIndex);
});

test('a missing, malformed or tampered index falls back to the whole board', { skip }, async () => {
  const id = board[3].jobId;
  const good = store.get(INDEX);
  const cases = {
    missing: null,
    'not an index': { body: 'garbage', headers: good.headers },
    'bad json line': { body: `\n${id}\t{"jobId":\n`, headers: good.headers },
    'wrong id in line': { body: `\n${id}\t${JSON.stringify(board[4])}\n`, headers: good.headers },
    'fails validation': { body: `\n${id}\t${JSON.stringify({ ...board[3], url: 'http://localhost/x' })}\n`, headers: good.headers },
  };
  for (const [name, entry] of Object.entries(cases)) {
    if (entry) store.set(INDEX, entry); else store.delete(INDEX);
    const jobs = await (await freshIsolate()).loadOpenJobsForJobId(id);
    assert.equal(jobs.length, board.length, name);
  }
  store.set(INDEX, good);
});
