import { env } from 'cloudflare:workers';
import { liveJobWireRecord, validateLiveJobs, validateLiveJobsBoard } from './live-jobs.mjs';

const MAX_UPSTREAM_BYTES = 256 * 1024;
const BOARD_CACHE_SECONDS = 5 * 60;
const BOARD_CACHE_ORIGIN = 'https://jobappagent.com';
/** Per-isolate memo so one SSR request (metadata + page) and back-to-back requests
 * do not re-parse and re-validate the whole board (~6 ms CPU per pass, several times
 * that on a cold isolate). The memo lives at least this long, and otherwise as long as
 * the Cache API copy it mirrors (built-at + BOARD_CACHE_SECONDS): until then a re-read
 * would only return the same board again. */
const BOARD_MEMO_MS = 60 * 1000;
const BOARD_BUILT_AT_HEADER = 'x-jaa-board-built-at';
/** @type {Map<string, { until: number, jobs: unknown[] }>} */
const boardMemo = new Map();
/** @type {Map<string, Promise<unknown[]>>} */
const boardInflight = new Map();

/**
 * Open-board lookup index for /jobs/<slug>: one line per job, `\n<jobId>\t<wire JSON>`,
 * stored in the Cache API next to the board with the board's own expiry. A cold job
 * page used to validate the whole board (~600 jobs, ~10 ms CPU unoptimised: two URL
 * parses, a slug and four dates per job) to read one job. With the index it finds its
 * line, parses and validates that one record with the same validateLiveJobs rules.
 * Only the site writes it, always from a board that passed validation.
 */
const INDEX_MEMO_MAX = 512;
/** @type {{ until: number, text: string, found: Map<string, unknown[]> } | null} */
let indexMemo = null;

/** @returns {Cache | undefined} */
function workersDefaultCache() {
  if (typeof caches === 'undefined') return undefined;
  return /** @type {{ default?: Cache }} */ (caches).default;
}

function telemetryFetch() {
  const binding = /** @type {{ TELEMETRY?: { fetch: typeof fetch } }} */ (env).TELEMETRY;
  return binding?.fetch?.bind(binding) ?? fetch;
}

function liveUpstreamBase() {
  if (env.COMMUNITY_JOBS_LIVE_UPSTREAM) return env.COMMUNITY_JOBS_LIVE_UPSTREAM;
  if (env.COMMUNITY_JOBS_UPSTREAM) {
    try {
      const url = new URL(env.COMMUNITY_JOBS_UPSTREAM);
      url.pathname = '/v1/jobs/live';
      url.search = '';
      return url.toString();
    } catch {
      /* fall through */
    }
  }
  if (env.COMMUNITY_STATS_UPSTREAM) {
    try {
      return new URL('/v1/jobs/live', env.COMMUNITY_STATS_UPSTREAM).toString();
    } catch {
      /* fall through */
    }
  }
  return null;
}

function indexCacheKey() {
  return new Request(new URL('/__cache/live-jobs-index?status=open', BOARD_CACHE_ORIGIN).toString(), { method: 'GET' });
}

/** @param {unknown[]} jobs validated open board */
function indexText(jobs) {
  let text = '\n';
  for (const job of jobs) text += `${job.jobId}\t${JSON.stringify(liveJobWireRecord(job))}\n`;
  return text;
}

/**
 * @param {Cache} cache
 * @param {unknown[]} jobs validated open board
 * @param {number} builtAt when the board was built (index expires with it)
 */
async function putIndex(cache, jobs, builtAt) {
  const remaining = Math.floor((builtAt + BOARD_CACHE_SECONDS * 1000 - Date.now()) / 1000);
  if (!Number.isFinite(remaining) || remaining < 5) return;
  await cache.put(indexCacheKey(), new Response(indexText(jobs), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': `public, max-age=${Math.min(60, remaining)}, s-maxage=${remaining}`,
      [BOARD_BUILT_AT_HEADER]: String(builtAt),
    },
  }));
}

/**
 * @param {string} text index body
 * @param {string} jobId
 * @returns {unknown[] | null} [job] / [] when absent; null when the line is invalid
 */
function lookupIndexed(text, jobId) {
  const start = text.indexOf(`\n${jobId}\t`);
  if (start < 0) return [];
  const end = text.indexOf('\n', start + 1);
  if (end < 0) return null;
  let record;
  try {
    record = JSON.parse(text.slice(start + jobId.length + 2, end));
  } catch {
    return null;
  }
  if (record?.jobId !== jobId) return null;
  const validated = validateLiveJobs({ version: 1, jobs: [record], nextCursor: null });
  return validated.ok ? validated.data.jobs : null;
}

/**
 * Raw open jobs a /jobs/<slug> page needs to find `jobId`: the whole board when this
 * isolate already holds it, else `[job]` or `[]` from the lookup index, else (no
 * usable index) the whole board, which also writes the index for the next cold isolate.
 * `jobId` is `community-job-<16 hex>` (jobIdFromSlug), so a job is on the board iff
 * its line is in the index.
 * @param {string} jobId
 * @returns {Promise<unknown[]>}
 */
export async function loadOpenJobsForJobId(jobId) {
  const memo = boardMemo.get('open');
  if (memo && Date.now() < memo.until) return memo.jobs;
  const cache = workersDefaultCache();
  if (!cache || !liveUpstreamBase()) return loadLiveJobsSafe();
  try {
    if (!indexMemo || Date.now() >= indexMemo.until) {
      indexMemo = null;
      const hit = await cache.match(indexCacheKey());
      if (hit) {
        const builtAt = Number(hit.headers.get(BOARD_BUILT_AT_HEADER));
        const text = await hit.text();
        if (text.startsWith('\n')) indexMemo = { until: memoUntil(builtAt), text, found: new Map() };
      }
    }
    if (indexMemo) {
      const known = indexMemo.found.get(jobId);
      if (known) return known;
      const found = lookupIndexed(indexMemo.text, jobId);
      if (found) {
        if (indexMemo.found.size >= INDEX_MEMO_MAX) indexMemo.found.clear();
        indexMemo.found.set(jobId, found);
        return found;
      }
    }
  } catch {
    /* fall back to the whole board */
  }
  indexWanted = true;
  return loadLiveJobsSafe();
}

/** Set when a job page found no usable index; the next validated open board writes one. */
let indexWanted = false;

function boardCacheKey(status) {
  const key = new URL('/__cache/live-jobs-board', BOARD_CACHE_ORIGIN);
  key.searchParams.set('status', status == null ? 'all' : status);
  return new Request(key.toString(), { method: 'GET' });
}

/**
 * Load live jobs for the public board.
 * Defaults to `status=open` so SSR only pages verified-open roles (fast).
 * Caches the aggregated board payload in the Cache API (~5 min) to avoid
 * paginating D1 on every SSR hit.
 *
 * @param {{ fetcher?: typeof fetch, signal?: AbortSignal, status?: 'open' | 'closed' | 'unknown' | null, skipCache?: boolean }} [options]
 */
export async function loadLiveJobs(options = {}) {
  const base = liveUpstreamBase();
  if (!base) return [];
  const status = options.status === undefined ? 'open' : options.status;
  const cache = !options.fetcher && !options.skipCache ? workersDefaultCache() : undefined;
  const cacheKey = cache ? boardCacheKey(status) : null;
  const memoKey = status == null ? 'all' : status;
  const useMemo = !options.fetcher && !options.skipCache;
  if (useMemo) {
    const memo = boardMemo.get(memoKey);
    if (memo && Date.now() < memo.until) return memo.jobs;
    // Single-flight: an SSR request renders metadata and page concurrently and a
    // crawler burst lands several requests on one isolate. Each used to page the
    // whole board through the relay on its own (12 relay calls per refresh instead
    // of 6). Concurrent callers now share one load.
    if (options.signal) return loadBoard({ base, status, cache, cacheKey, memoKey, useMemo, options });
    const shared = () => {
      const inflight = boardInflight.get(memoKey);
      if (inflight) return inflight;
      const load = loadBoard({ base, status, cache, cacheKey, memoKey, useMemo, options })
        .finally(() => { if (boardInflight.get(memoKey) === load) boardInflight.delete(memoKey); });
      boardInflight.set(memoKey, load);
      return load;
    };
    // A follower whose shared load fails (e.g. the leading request was cancelled)
    // retries once rather than rendering an empty board. The retry is itself
    // shared, so a failed burst re-paginates once, not once per follower.
    const pending = boardInflight.get(memoKey);
    if (pending) return pending.catch(() => shared());
    return shared();
  }
  return loadBoard({ base, status, cache, cacheKey, memoKey, useMemo, options });
}

/** Memo expiry: the cached copy's own expiry, never shorter than BOARD_MEMO_MS. */
function memoUntil(builtAt) {
  const now = Date.now();
  const floor = now + BOARD_MEMO_MS;
  if (!Number.isFinite(builtAt) || builtAt <= 0 || builtAt > now) return floor;
  return Math.max(floor, builtAt + BOARD_CACHE_SECONDS * 1000);
}

/**
 * @param {{ base: string, status: 'open' | 'closed' | 'unknown' | null, cache: Cache | undefined, cacheKey: Request | null, memoKey: string, useMemo: boolean, options: { fetcher?: typeof fetch, signal?: AbortSignal } }} input
 */
async function loadBoard({ base, status, cache, cacheKey, memoKey, useMemo, options }) {
  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      // The cached copy is the whole board (all pages merged), so validate it in
      // page-sized slices. validateLiveJobs alone caps a payload at one page, which
      // made every hit fall through to a full re-pagination of the upstream.
      const validated = validateLiveJobsBoard(JSON.parse(await cached.text()));
      if (validated.ok) {
        const builtAt = Number(cached.headers.get(BOARD_BUILT_AT_HEADER));
        boardMemo.set(memoKey, { until: memoUntil(builtAt), jobs: validated.data.jobs });
        if (status === 'open' && indexWanted) {
          indexWanted = false;
          await putIndex(cache, validated.data.jobs, builtAt).catch(() => {});
        }
        return validated.data.jobs;
      }
    }
  }

  const fetcher = options.fetcher ?? telemetryFetch();
  const jobs = new Map();
  const cursors = new Set();
  let cursor = null;
  let newestLastCheckedAt = null;
  for (let page = 0; page < 200; page++) {
    const target = new URL(base);
    target.searchParams.set('limit', '100');
    if (status) target.searchParams.set('status', status);
    if (cursor) target.searchParams.set('cursor', cursor);
    const response = await fetcher(new Request(target.toString(), {
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
    if (!response.ok) throw new Error('Live jobs unavailable');
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_UPSTREAM_BYTES) throw new Error('Live jobs response too large');
    const validated = validateLiveJobs(JSON.parse(raw));
    if (!validated.ok) throw new Error('Invalid live jobs response');
    for (const job of validated.data.jobs) jobs.set(job.jobId, job);
    if (validated.data.meta?.newestLastCheckedAt) newestLastCheckedAt = validated.data.meta.newestLastCheckedAt;
    cursor = validated.data.nextCursor;
    if (!cursor) {
      const list = [...jobs.values()];
      const builtAt = Date.now();
      if (useMemo) boardMemo.set(memoKey, { until: memoUntil(cache && cacheKey ? builtAt : Number.NaN), jobs: list });
      if (cache && cacheKey) {
        const payload = {
          version: 1,
          // Store upstream wire records (without the derived slug) so a hit re-validates.
          jobs: list.map(liveJobWireRecord),
          nextCursor: null,
          meta: { newestLastCheckedAt },
        };
        await cache.put(cacheKey, new Response(JSON.stringify(payload), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': `public, max-age=60, s-maxage=${BOARD_CACHE_SECONDS}, stale-while-revalidate=900`,
            [BOARD_BUILT_AT_HEADER]: String(builtAt),
          },
        }));
        if (status === 'open' && indexWanted) {
          indexWanted = false;
          await putIndex(cache, list, builtAt).catch(() => {});
        }
      }
      return list;
    }
    if (cursors.has(cursor)) throw new Error('Repeated live jobs cursor');
    cursors.add(cursor);
  }
  throw new Error('Live jobs page limit exceeded');
}

/**
 * Safe loader for pages/sitemap — empty on failure so SEO pages still render.
 * @param {{ fetcher?: typeof fetch, skipCache?: boolean }} [options]
 */
export async function loadLiveJobsSafe(options = {}) {
  try {
    return await loadLiveJobs(options);
  } catch {
    return [];
  }
}
