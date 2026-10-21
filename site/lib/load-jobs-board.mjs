import locations from '../data/job-locations.json' with { type: 'json' };
import { fixtureLiveJobs } from './jobs-board-data.mjs';
import { jobIdFromSlug, jobSlug, isListedOpenJob } from './live-jobs.mjs';
import { attachLocations } from './job-locations.mjs';

async function wantsFixtures(options = {}) {
  if (options.useFixtures === true) return true;
  if (options.useFixtures === false) return false;
  if (typeof process !== 'undefined' && process.env?.USE_JOBS_BOARD_FIXTURES === '1') return true;
  try {
    const { env } = await import('cloudflare:workers');
    if (env?.USE_JOBS_BOARD_FIXTURES === '1') return true;
  } catch {
    /* outside Workers runtime */
  }
  return false;
}

/**
 * Derived boards keyed by the raw live-jobs array. fetch-live-jobs memoises that
 * array per Worker instance (~60 s), so metadata + page in one request, and back-to-back
 * requests, reuse one enrichment pass instead of re-mapping and re-filtering the
 * whole board each time. Only the default live path is memoised (never fixtures or
 * test loaders); entries expire with the same window.
 * @type {WeakMap<object, { at: number, board: ReturnType<typeof buildBoard> }>}
 */
const derivedBoards = new WeakMap();
const DERIVED_BOARD_MEMO_MS = 60 * 1000;

/**
 * Resolve board jobs for SSR pages.
 * Prefer a caller-provided fetcher (tests). Fall back to live Worker fetch.
 * Set USE_JOBS_BOARD_FIXTURES=1 for demos/screenshots.
 *
 * @param {{
 *   loadLive?: () => Promise<unknown[]>,
 *   useFixtures?: boolean,
 *   now?: number,
 * }} [options]
 */
export async function loadJobsBoard(options = {}) {
  const now = options.now ?? Date.now();
  let raw = [];
  let memoisable = false;

  if (await wantsFixtures(options)) {
    raw = fixtureLiveJobs(now);
  } else if (options.loadLive) {
    raw = await options.loadLive();
  } else {
    try {
      const { loadLiveJobsSafe } = await import('./fetch-live-jobs.mjs');
      raw = await loadLiveJobsSafe();
      memoisable = options.now === undefined && Array.isArray(raw) && raw.length > 0;
    } catch {
      raw = [];
    }
  }

  if (memoisable) {
    const memo = derivedBoards.get(raw);
    if (memo && now - memo.at >= 0 && now - memo.at < DERIVED_BOARD_MEMO_MS) return memo.board;
    const board = buildBoard(raw, now);
    derivedBoards.set(raw, { at: now, board });
    return board;
  }
  return buildBoard(raw, now);
}

/** @param {unknown[]} raw @param {number} now */
function buildBoard(raw, now) {
  const withSlugs = (raw ?? []).map((job) => ({
    ...job,
    slug: job.slug ?? jobSlug(job),
  }));

  const needsIndex = withSlugs.some((job) => !job.location);
  const enriched = needsIndex
    ? attachLocations(withSlugs, { collectedAt: locations.collectedAt, records: locations.records }, now)
    : withSlugs;

  const open = enriched.filter((job) => isListedOpenJob(job, now));
  const all = enriched;

  let checkedAt = null;
  for (const job of open) {
    if (job.lastCheckedAt && (!checkedAt || job.lastCheckedAt > checkedAt)) checkedAt = job.lastCheckedAt;
  }

  return { all, open, checkedAt, now, locationIndex: locations };
}

/** Slug and jobId lookups per board array (first match wins, like Array#find). */
const slugIndexes = new WeakMap();

function slugIndex(allJobs) {
  let index = slugIndexes.get(allJobs);
  if (!index) {
    const bySlug = new Map();
    const byJobId = new Map();
    for (const job of allJobs) {
      if (!bySlug.has(job.slug)) bySlug.set(job.slug, job);
      if (!byJobId.has(job.jobId)) byJobId.set(job.jobId, job);
    }
    index = { bySlug, byJobId };
    slugIndexes.set(allJobs, index);
  }
  return index;
}

export function findJobBySlug(allJobs, slug) {
  const { bySlug, byJobId } = slugIndex(allJobs);
  const exact = bySlug.get(slug);
  if (exact) return exact;
  const jobId = jobIdFromSlug(slug);
  if (!jobId) return null;
  return byJobId.get(jobId) ?? null;
}
