import { LOCATION_RECORD_MAX_AGE_MS } from './job-locations.mjs';

const DAY_MS = 86400000;
/** Refresh well before the join cutoff so the site never silently drops all metadata. */
export const LOCATION_INDEX_REFRESH_AFTER_DAYS = 7;
export const LOCATION_INDEX_ALERT_AFTER_DAYS = 21;
export const LOCATION_INDEX_CUTOFF_DAYS = LOCATION_RECORD_MAX_AGE_MS / DAY_MS;

/**
 * Age of the committed `data/job-locations.json` snapshot.
 * @param {{ collectedAt?: string } | null | undefined} index
 * @param {number} [now]
 * @returns {{ ok: boolean, ageDays: number | null, collectedAt: string | null, status: 'fresh' | 'refresh' | 'alert' | 'expired' | 'invalid' }}
 */
export function locationIndexFreshness(index, now = Date.now()) {
  const collectedAt = typeof index?.collectedAt === 'string' ? index.collectedAt : null;
  const collected = collectedAt ? Date.parse(collectedAt) : NaN;
  if (!Number.isFinite(collected) || collected > now + DAY_MS) {
    return { ok: false, ageDays: null, collectedAt, status: 'invalid' };
  }
  const ageDays = Math.max(0, (now - collected) / DAY_MS);
  const status = ageDays > LOCATION_INDEX_CUTOFF_DAYS ? 'expired'
    : ageDays > LOCATION_INDEX_ALERT_AFTER_DAYS ? 'alert'
      : ageDays > LOCATION_INDEX_REFRESH_AFTER_DAYS ? 'refresh'
        : 'fresh';
  return { ok: status === 'fresh' || status === 'refresh', ageDays: Number(ageDays.toFixed(2)), collectedAt, status };
}

/** A refreshed snapshot must keep at least this share of the committed records. */
export const LOCATION_INDEX_MIN_RETAINED_RATIO = 0.5;

/**
 * Fail-closed guard before a refreshed snapshot replaces the committed one: an empty
 * feed page or a broken ATS endpoint must never wipe metadata from every listed role.
 * @param {{ records?: unknown[], snapshotCount?: number } | null | undefined} previous committed index (null when none)
 * @param {{ records?: unknown[], snapshotCount?: number }} next refreshed index
 * @param {{ minRatio?: number }} [options]
 * @returns {{ ok: boolean, reason: string | null, previous: number, next: number }}
 */
export function locationSnapshotShrinkCheck(previous, next, { minRatio = LOCATION_INDEX_MIN_RETAINED_RATIO } = {}) {
  const before = Array.isArray(previous?.records) ? previous.records.length : 0;
  const after = Array.isArray(next?.records) ? next.records.length : 0;
  const result = (reason) => ({ ok: reason === null, reason, previous: before, next: after });
  if (!Number.isFinite(next?.snapshotCount) || next.snapshotCount <= 0) return result('published-jobs snapshot is empty');
  if (after === 0) return result('refreshed snapshot has 0 records');
  if (before > 0 && after < before * minRatio) return result(`refreshed snapshot has ${after} records, fewer than ${Math.round(minRatio * 100)}% of the committed ${before}`);
  return result(null);
}
