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
