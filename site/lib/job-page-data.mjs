import { fixtureLiveJobs } from './jobs-board-data.mjs';
import { attachLocationRecord, attachLocationToJob } from './job-locations.mjs';
import { allJobLocations, locationRecordFor } from './job-location-lookup.mjs';
import { jobIdFromSlug, jobSlug, isListedOpenJob, similarOpenRoles } from './live-jobs.mjs';

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
 * Per raw live-jobs array: lazy slug → page payloads, plus open list only when a
 * closed role needs similar-role scoring. Open `/jobs/<slug>` never builds a
 * board-wide slug map or walks the location records array.
 * @type {WeakMap<object, {
 *   at: number,
 *   pages: Map<string, { job: object, similar: object[], now: number } | null>,
 *   openRaw: object[] | null,
 * }>}
 */
const pageMemos = new WeakMap();
const PAGE_MEMO_MS = 60 * 1000;

/**
 * @param {{
 *   loadLive?: () => Promise<unknown[]>,
 *   useFixtures?: boolean,
 *   now?: number,
 *   locationIndex?: { collectedAt?: string, records: unknown[] },
 * }} [options]
 */
async function loadRawJobs(options = {}, slug = '') {
  if (await wantsFixtures(options)) return fixtureLiveJobs(options.now ?? Date.now());
  if (options.loadLive) return options.loadLive();
  // No valid job has a slug without its 16-hex id tail, so such a slug finds nothing.
  const jobId = jobIdFromSlug(slug);
  if (!jobId) return [];
  try {
    const { loadOpenJobsForJobId } = await import('./fetch-live-jobs.mjs');
    return await loadOpenJobsForJobId(jobId);
  } catch {
    return [];
  }
}

/**
 * Find one job by slug without building a full slug index.
 * Prefer the trailing jobId (O(n) id compare, no slugify); fall back to slug match.
 * @param {unknown[]} raw
 * @param {string} slug
 */
function resolveRawJob(raw, slug) {
  const jobId = jobIdFromSlug(slug);
  if (jobId) {
    for (const job of raw ?? []) {
      if (job?.jobId === jobId) {
        return { ...job, slug: job.slug ?? jobSlug(job) };
      }
    }
  }
  for (const job of raw ?? []) {
    const candidateSlug = job?.slug ?? jobSlug(job);
    if (candidateSlug === slug) return { ...job, slug: candidateSlug };
  }
  return null;
}

/**
 * @param {unknown[]} raw
 * @param {number} now
 */
function openJobsRaw(raw, now) {
  const open = [];
  for (const job of raw ?? []) {
    const withSlug = { ...job, slug: job.slug ?? jobSlug(job) };
    if (isListedOpenJob(withSlug, now)) open.push(withSlug);
  }
  return open;
}

/**
 * Ensure location metadata on one job. Fixtures may already carry `location`;
 * production live jobs join the directory index via O(1) jobId lookup.
 * @param {object} job
 * @param {{ records: unknown[] }} locationIndex
 * @param {number} now
 */
function withLocation(job, locationIndex, now) {
  if (job.location) return job;
  return attachLocationToJob(job, locationIndex, now);
}

/**
 * withLocation for the page's own job: looks up only that job's record (one small
 * shard in the Worker build) unless a test passed its own index.
 * @param {object} job
 * @param {{ records: unknown[] } | undefined} locationIndex
 * @param {number} now
 */
async function withOwnLocation(job, locationIndex, now) {
  if (job.location) return job;
  if (locationIndex) return attachLocationToJob(job, locationIndex, now);
  return attachLocationRecord(job, await locationRecordFor(job.jobId), now);
}

/**
 * @param {unknown[]} raw
 * @param {number} now
 * @param {boolean} memoisable
 */
function memoFor(raw, now, memoisable) {
  if (!memoisable || !Array.isArray(raw) || raw.length === 0) {
    return { at: now, pages: new Map(), openRaw: null };
  }
  const existing = pageMemos.get(raw);
  if (existing && now - existing.at >= 0 && now - existing.at < PAGE_MEMO_MS) return existing;
  const memo = { at: now, pages: new Map(), openRaw: null };
  pageMemos.set(raw, memo);
  return memo;
}

/**
 * Resolve everything `/jobs/<slug>` needs without board-wide location attach or
 * a full location-index records scan. Returns null when the slug is missing or
 * is a stale non-closed role (same notFound cases as the page).
 *
 * @param {string} slug
 * @param {{
 *   loadLive?: () => Promise<unknown[]>,
 *   useFixtures?: boolean,
 *   now?: number,
 *   locationIndex?: { collectedAt?: string, records: unknown[] },
 * }} [options]
 * @returns {Promise<{ job: object, similar: object[], now: number } | null>}
 */
export async function loadJobPageBySlug(slug, options = {}) {
  const now = options.now ?? Date.now();
  const raw = await loadRawJobs(options, slug);
  const memoisable =
    options.now === undefined
    && options.locationIndex === undefined
    && options.useFixtures !== true
    && !(typeof process !== 'undefined' && process.env?.USE_JOBS_BOARD_FIXTURES === '1')
    && Array.isArray(raw)
    && raw.length > 0;
  const memo = memoFor(raw, now, memoisable);

  if (memo.pages.has(slug)) return memo.pages.get(slug);

  const found = resolveRawJob(raw, slug);
  if (!found) {
    memo.pages.set(slug, null);
    return null;
  }

  const job = await withOwnLocation(found, options.locationIndex, now);
  const staleOpen = job.livenessStatus !== 'closed' && !isListedOpenJob(job, now);
  if (staleOpen) {
    memo.pages.set(slug, null);
    return null;
  }

  let similar = [];
  if (job.livenessStatus === 'closed') {
    // Closed pages only — attach locations for similar scoring/display.
    // Open slug pages (crawler-hot path) never enter this branch.
    if (!memo.openRaw) memo.openRaw = openJobsRaw(raw, now);
    const locationIndex = options.locationIndex ?? await allJobLocations();
    const openEnriched = memo.openRaw.map((candidate) => withLocation(candidate, locationIndex, now));
    similar = similarOpenRoles(job, openEnriched, 3);
  }

  const page = { job, similar, now };
  memo.pages.set(slug, page);
  if (job.slug && job.slug !== slug) memo.pages.set(job.slug, page);
  return page;
}
