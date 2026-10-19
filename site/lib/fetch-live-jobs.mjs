import { env } from 'cloudflare:workers';
import { validateLiveJobs } from './live-jobs.mjs';

const MAX_UPSTREAM_BYTES = 256 * 1024;
const BOARD_CACHE_SECONDS = 5 * 60;
const BOARD_CACHE_ORIGIN = 'https://jobappagent.com';
/** Per-isolate memo so one SSR request (metadata + page) and back-to-back requests
 * do not re-parse and re-validate the whole board (~6 ms CPU per pass). */
const BOARD_MEMO_MS = 60 * 1000;
/** @type {Map<string, { at: number, jobs: unknown[] }>} */
const boardMemo = new Map();

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
    if (memo && Date.now() - memo.at < BOARD_MEMO_MS) return memo.jobs;
  }
  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const validated = validateLiveJobs(JSON.parse(await cached.text()));
      if (validated.ok) {
        boardMemo.set(memoKey, { at: Date.now(), jobs: validated.data.jobs });
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
      if (useMemo) boardMemo.set(memoKey, { at: Date.now(), jobs: list });
      if (cache && cacheKey) {
        const payload = {
          version: 1,
          jobs: list,
          nextCursor: null,
          meta: { newestLastCheckedAt },
        };
        await cache.put(cacheKey, new Response(JSON.stringify(payload), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': `public, max-age=60, s-maxage=${BOARD_CACHE_SECONDS}, stale-while-revalidate=900`,
          },
        }));
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
