/**
 * Precomputed /v1/jobs/live snapshot in Workers KV.
 *
 * Why: /v1/jobs/live is ~half of relay traffic (the site Worker pages the whole
 * board through it on every board-cache refresh). Paging D1 per request made it the
 * largest D1 rows-read consumer on the Workers Free plan (5M rows/day). The cron
 * writes every published, maintainer-reviewed job once per SNAPSHOT_INTERVAL_MINUTES
 * as one compact JSON blob; the route pages that blob in memory and only falls back
 * to the indexed D1 query when the snapshot is missing, stale, or malformed.
 *
 * Free-plan budget: 1 snapshot write every 30 min = 48 KV writes/day (limit 1,000).
 * The build time rides on the key's metadata, so the cron's "is it missing/old?"
 * check is one KV list per tick (288/day, limit 1,000) instead of an extra write.
 * Reads are one KV get per isolate per memo window.
 *
 * Wire format: rows are positional arrays in SNAPSHOT_COLUMNS order (smaller blob,
 * cheaper JSON.parse than objects). Rows are already sorted by
 * (last_seen_at DESC, job_id DESC), matching the D1 query.
 */

export const SNAPSHOT_KEY = 'live-jobs:v1';
export const SNAPSHOT_INTERVAL_MINUTES = 30;
/** Older than this and the route ignores the snapshot (cron stalled) and reads D1. */
export const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Per-isolate memo of the parsed snapshot; also used as the KV edge cacheTtl. */
const MEMO_MS = 5 * 60 * 1000;
const KV_CACHE_TTL_SECONDS = 300;

export const SNAPSHOT_COLUMNS = Object.freeze([
  'job_id', 'canonical_url', 'company', 'role', 'application_channel', 'discovery_source',
  'provider_url', 'first_seen_at', 'last_seen_at', 'liveness_status', 'last_checked_at',
  'closed_at', 'contribution_count',
]);
const C = Object.fromEntries(SNAPSHOT_COLUMNS.map((name, index) => [name, index]));

/** @type {{ at: number, snapshot: ReturnType<typeof indexSnapshot> } | null} */
let memo = null;

export function resetSnapshotMemo() { memo = null; }

export function serializeSnapshot(rows, builtAt) {
  return JSON.stringify({
    v: 1,
    builtAt,
    columns: SNAPSHOT_COLUMNS,
    rows: rows.map((row) => SNAPSHOT_COLUMNS.map((column) => row[column] ?? null)),
  });
}

function indexSnapshot(parsed) {
  if (!parsed || parsed.v !== 1 || typeof parsed.builtAt !== 'string' || !Array.isArray(parsed.rows)) return null;
  if (!Array.isArray(parsed.columns) || parsed.columns.join(',') !== SNAPSHOT_COLUMNS.join(',')) return null;
  const builtAtMs = Date.parse(parsed.builtAt);
  if (Number.isNaN(builtAtMs)) return null;
  for (const row of parsed.rows) {
    if (!Array.isArray(row) || row.length !== SNAPSHOT_COLUMNS.length) return null;
    if (typeof row[C.job_id] !== 'string' || typeof row[C.last_seen_at] !== 'string') return null;
  }
  const byStatus = { open: [], closed: [], unknown: [] };
  for (const row of parsed.rows) byStatus[row[C.liveness_status]]?.push(row);
  return { builtAtMs, all: parsed.rows, byStatus };
}

/** Same object shape (and key order) as worker.mjs mapLiveJob(). */
function mapRow(row) {
  return {
    jobId: row[C.job_id],
    url: row[C.canonical_url],
    company: row[C.company],
    role: row[C.role],
    applicationChannel: row[C.application_channel],
    ...(row[C.discovery_source] == null ? {} : { discoverySource: row[C.discovery_source] }),
    providerUrl: row[C.provider_url],
    firstSeenAt: row[C.first_seen_at],
    lastSeenAt: row[C.last_seen_at],
    contributionCount: Number(row[C.contribution_count]),
    livenessStatus: row[C.liveness_status] ?? 'unknown',
    lastCheckedAt: row[C.last_checked_at] ?? null,
    closedAt: row[C.closed_at] ?? null,
  };
}

/** First index whose (last_seen_at, job_id) sorts strictly after the cursor in DESC order. */
function seek(rows, cursor) {
  if (!cursor) return 0;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const seen = rows[mid][C.last_seen_at];
    const id = rows[mid][C.job_id];
    const before = seen < cursor.lastSeenAt || (seen === cursor.lastSeenAt && id < cursor.jobId);
    if (before) high = mid; else low = mid + 1;
  }
  return low;
}

export function pageSnapshot(snapshot, { limit, cursor = null, status = null }) {
  const rows = status == null ? snapshot.all : (snapshot.byStatus[status] ?? []);
  const start = seek(rows, cursor);
  const slice = rows.slice(start, start + limit + 1);
  return { jobs: slice.slice(0, limit).map(mapRow), hasMore: slice.length > limit };
}

/** Parsed snapshot or null (missing / malformed / stale). Never throws. */
export async function readSnapshot(kv, now = Date.now()) {
  if (!kv?.get) return null;
  if (memo && now - memo.at < MEMO_MS) {
    return now - memo.snapshot.builtAtMs <= SNAPSHOT_MAX_AGE_MS ? memo.snapshot : null;
  }
  let snapshot = null;
  try {
    const text = await kv.get(SNAPSHOT_KEY, { cacheTtl: KV_CACHE_TTL_SECONDS });
    if (text) snapshot = indexSnapshot(JSON.parse(text));
  } catch { snapshot = null; }
  if (!snapshot) { memo = null; return null; }
  memo = { at: now, snapshot };
  return now - snapshot.builtAtMs <= SNAPSHOT_MAX_AGE_MS ? snapshot : null;
}

export function snapshotDue(scheduledTime) {
  if (scheduledTime == null) return true;
  const date = new Date(scheduledTime);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return Number.isFinite(minutes) && minutes % SNAPSHOT_INTERVAL_MINUTES === 0;
}

/**
 * Cron hook: rebuild on the interval tick, or whenever the snapshot is missing or
 * too old (first deploy, a failed write). Returns true when a snapshot was written.
 */
export async function maybeWriteSnapshot(env, store, { scheduledTime, now = Date.now() } = {}) {
  const kv = env.LIVE_JOBS_SNAPSHOT;
  if (!kv?.put || !store?.listLiveSnapshotRows) return false;
  let due = snapshotDue(scheduledTime);
  if (!due) {
    const listed = kv.list ? await kv.list({ prefix: SNAPSHOT_KEY, limit: 10 }) : null;
    const builtAt = listed?.keys?.find((key) => key.name === SNAPSHOT_KEY)?.metadata?.builtAt;
    const builtAtMs = typeof builtAt === 'string' ? Date.parse(builtAt) : Number.NaN;
    due = Number.isNaN(builtAtMs) || now - builtAtMs > SNAPSHOT_INTERVAL_MINUTES * 60 * 1000 + 10 * 60 * 1000;
  }
  if (!due) return false;
  const builtAt = new Date(now).toISOString();
  const rows = await store.listLiveSnapshotRows();
  await kv.put(SNAPSHOT_KEY, serializeSnapshot(rows, builtAt), { metadata: { builtAt } });
  return true;
}
