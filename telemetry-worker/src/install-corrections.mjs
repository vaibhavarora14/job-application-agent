// One-off corrections to the public lifetime `installations` total.
//
// A correction lists the relay-clock times at which unwanted installations were registered
// (never their IDs). The worker matches them against public_installations rows that were
// counted and never active, marks the matches uncounted, records them in
// public_installation_exclusions, and lowers the lifetime total by exactly the number marked.
// Matching is conservative: registration times that sit close together form a cluster, and a
// cluster is applied only when it contains exactly as many candidate rows as listed times;
// otherwise the whole cluster is skipped and counted in `skipped_count`.
// Each correction applies at most once (public_stats_corrections primary key, same batch).

import { FIXTURE_INSTALL_CORRECTION } from './corrections/fixture-installs-2026-10-22.mjs';

export const INSTALL_CORRECTIONS = Object.freeze([FIXTURE_INSTALL_CORRECTION]);

// installed_at is written after the PostHog forward returns, so it trails the PostHog timestamp.
export const MATCH_BEFORE_MS = 500;
export const MATCH_AFTER_MS = 5_000;

export function planInstallCorrection(observedAt, candidates) {
  const times = observedAt.map((value) => Date.parse(value)).filter(Number.isFinite).sort((a, b) => a - b);
  const rows = candidates
    .map((row) => ({ hash: String(row.installation_hash), at: Date.parse(String(row.installed_at)) }))
    .filter((row) => row.hash && Number.isFinite(row.at))
    .sort((a, b) => a.at - b.at);
  const clusters = [];
  for (const time of times) {
    const start = time - MATCH_BEFORE_MS;
    const end = time + MATCH_AFTER_MS;
    const last = clusters.at(-1);
    if (last && start <= last.end) { last.end = Math.max(last.end, end); last.listed += 1; }
    else clusters.push({ start, end, listed: 1 });
  }
  const matched = [];
  let skipped = 0;
  for (const cluster of clusters) {
    const inside = rows.filter((row) => row.at >= cluster.start && row.at <= cluster.end);
    if (inside.length === cluster.listed) matched.push(...inside.map((row) => row.hash));
    else skipped += cluster.listed;
  }
  return { listed: times.length, matched: [...new Set(matched)], skipped, clusters: clusters.length };
}

export async function applyInstallCorrection(db, correction, { now = new Date(), log = () => {} } = {}) {
  if (!db?.prepare || !correction?.observedAt?.length) return { applied: false, reason: 'not_configured' };
  const done = await db.prepare('SELECT correction_id FROM public_stats_corrections WHERE correction_id = ?').bind(correction.id).first();
  if (done) return { applied: false, reason: 'already_applied' };
  const times = correction.observedAt.map((value) => Date.parse(value)).filter(Number.isFinite);
  const from = new Date(Math.min(...times) - MATCH_BEFORE_MS).toISOString();
  const to = new Date(Math.max(...times) + MATCH_AFTER_MS).toISOString();
  const candidates = await db.prepare(`
    SELECT installation_hash, installed_at
    FROM public_installations
    WHERE uncounted = 0 AND last_active_at IS NULL AND installed_at >= ? AND installed_at <= ?
  `).bind(from, to).all();
  const plan = planInstallCorrection(correction.observedAt, Array.isArray(candidates?.results) ? candidates.results : []);
  const nowIso = now.toISOString();
  const hashes = JSON.stringify(plan.matched);
  await db.prepare(`
    INSERT OR IGNORE INTO public_stats_lifetime (
      id, installations, jobs_assessed, applications_submitted, interviews, offers, active_installations_30d, refreshed_at
    ) VALUES (1, 0, 0, 0, 0, 0, 0, ?)
  `).bind(nowIso).run();
  // One transaction: a repeated run fails on the correction primary key and changes nothing.
  await db.batch([
    db.prepare(`
      INSERT INTO public_stats_corrections (correction_id, metric, listed_count, applied_count, skipped_count, applied_at)
      VALUES (?, 'installations', ?, ?, ?, ?)
    `).bind(correction.id, plan.listed, plan.matched.length, plan.skipped, nowIso),
    db.prepare(`
      INSERT INTO public_installation_exclusions (installation_hash, correction_id, reason, excluded_at)
      SELECT value, ?, ?, ? FROM json_each(?)
    `).bind(correction.id, correction.reason, nowIso, hashes),
    db.prepare(`
      UPDATE public_installations SET uncounted = 1
      WHERE uncounted = 0 AND installation_hash IN (SELECT value FROM json_each(?))
    `).bind(hashes),
    db.prepare(`
      UPDATE public_stats_lifetime
      SET installations = MAX(0, installations - ?), refreshed_at = ?
      WHERE id = 1
    `).bind(plan.matched.length, nowIso),
  ]);
  const summary = { correction: correction.id, listed: plan.listed, applied: plan.matched.length, skipped: plan.skipped };
  log(JSON.stringify(summary));
  return { applied: true, correction: correction.id, listed: plan.listed, matched: plan.matched.length, skipped: plan.skipped };
}

export async function applyPendingInstallCorrections(db, options = {}) {
  const results = [];
  for (const correction of INSTALL_CORRECTIONS) {
    try { results.push(await applyInstallCorrection(db, correction, options)); }
    catch (error) { results.push({ applied: false, reason: 'error', correction: correction.id }); options.log?.(JSON.stringify({ correction: correction.id, error: 'correction_failed' })); }
  }
  return results;
}
