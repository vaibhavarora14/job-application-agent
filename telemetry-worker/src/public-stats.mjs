const CACHE_SECONDS = 15 * 60;
const ACTIVE_REFRESH_SECONDS = 15 * 60;
const MIN_SEGMENT_COUNT = 3;

const LIFETIME_COLUMNS = new Set([
  'installations',
  'jobs_assessed',
  'applications_submitted',
  'interviews',
  'offers',
]);

function responseHeaders() {
  return {
    'cache-control': `public, max-age=60, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=3600`,
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

function number(value) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

function suppressSmallSegments(entries) {
  const visible = [];
  let suppressed = 0;
  for (const entry of entries) {
    const count = number(entry.count);
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : 'unspecified';
    if (count < MIN_SEGMENT_COUNT) suppressed += count;
    else visible.push({ label, count });
  }
  if (suppressed) visible.push({ label: 'other', count: suppressed });
  return visible;
}

async function anonymousInstallationHash(installationId, secret) {
  if (typeof secret !== 'string' || secret.length < 24) throw new Error('Signing secret is not configured.');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`public-stats:${installationId}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function increment(db, day, metric, segment = '') {
  await db.prepare(`
    INSERT INTO public_daily_metrics (day, metric, segment, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(day, metric, segment) DO UPDATE SET count = count + 1
  `).bind(day, metric, segment).run();
}

async function ensureLifetimeRow(db, nowIso) {
  await db.prepare(`
    INSERT OR IGNORE INTO public_stats_lifetime (
      id, installations, jobs_assessed, applications_submitted, interviews, offers,
      active_installations_30d, refreshed_at
    ) VALUES (1, 0, 0, 0, 0, 0, 0, ?)
  `).bind(nowIso).run();
}

async function bumpLifetime(db, column, nowIso) {
  if (!LIFETIME_COLUMNS.has(column)) throw new Error(`Invalid lifetime column: ${column}`);
  await ensureLifetimeRow(db, nowIso);
  await db.prepare(`
    UPDATE public_stats_lifetime
    SET ${column} = ${column} + 1,
        refreshed_at = ?
    WHERE id = 1
  `).bind(nowIso).run();
}

/** Refresh the rolling 30d active-installation counter (indexed COUNT, not per-request). */
export async function refreshActiveInstallations30d(db, now = new Date()) {
  if (!db?.prepare) return;
  const nowIso = now.toISOString();
  await ensureLifetimeRow(db, nowIso);
  await db.prepare(`
    UPDATE public_stats_lifetime
    SET active_installations_30d = (
      SELECT COUNT(*) FROM public_installations
      WHERE last_active_at >= datetime('now', '-30 days')
    ),
    refreshed_at = ?
    WHERE id = 1
  `).bind(nowIso).run();
}

/**
 * True when an event is real use of an installation. installation_started alone does not count,
 * and neither does a bare `ledger add` command completion: a real submission also sends
 * application_submitted, while a fixture/sandbox apply (applyKind=fixture, e.g. the test suite)
 * sends only command_completed{command: 'apply'}.
 */
export function isCountableInstallActivity(event) {
  if (!event || typeof event.event !== 'string') return false;
  if (event.event === 'installation_started') return false;
  if (event.event === 'command_completed' && event.properties?.command === 'apply') return false;
  return true;
}

export async function recordPublicAggregate(db, event, signingSecret, now = new Date()) {
  if (!db?.prepare) return;
  const day = now.toISOString().slice(0, 10);
  const nowIso = now.toISOString();
  const active = event.event === 'job_assessed' || event.event === 'application_submitted';
  const countable = isCountableInstallActivity(event);
  if (event.event === 'installation_started' || countable) {
    const installationHash = await anonymousInstallationHash(event.installationId, signingSecret);
    if (event.event === 'installation_started') {
      // Registered, not counted: the public total only grows at the first real activity.
      await db.prepare(`
        INSERT OR IGNORE INTO public_installations (installation_hash, installed_at, last_active_at, uncounted)
        VALUES (?, ?, NULL, 1)
      `).bind(installationHash, nowIso).run();
    } else {
      // One statement per event: inserts a counted row, or flips a registered row to counted.
      // Already-counted installations match no row to change (no write).
      const counted = await db.prepare(`
        INSERT INTO public_installations (installation_hash, installed_at, last_active_at, uncounted)
        VALUES (?, ?, ?, 0)
        ON CONFLICT(installation_hash) DO UPDATE SET uncounted = 0
        WHERE public_installations.uncounted = 1
      `).bind(installationHash, nowIso, active ? nowIso : null).run();
      if (number(counted?.meta?.changes) > 0) await bumpLifetime(db, 'installations', nowIso);
      if (active) {
        await db.prepare(`
          UPDATE public_installations
          SET last_active_at = ?
          WHERE installation_hash = ?
        `).bind(nowIso, installationHash).run();
      }
    }
  }
  if (event.event === 'job_assessed') {
    await increment(db, day, 'jobs_assessed');
    await bumpLifetime(db, 'jobs_assessed', nowIso);
  }
  if (event.event === 'application_submitted') {
    await increment(db, day, 'applications_submitted');
    await bumpLifetime(db, 'applications_submitted', nowIso);
    await increment(db, day, 'ats', event.properties.ats);
  }
  if (event.event === 'job_discovered') await increment(db, day, 'seniority', event.properties.seniority);
  if (event.event === 'outcome_recorded') {
    await increment(db, day, 'outcome', event.properties.outcome);
    if (event.properties.outcome === 'interview') {
      await increment(db, day, 'interviews');
      await bumpLifetime(db, 'interviews', nowIso);
    }
    if (event.properties.outcome === 'offer') {
      await increment(db, day, 'offers');
      await bumpLifetime(db, 'offers', nowIso);
    }
  }
}

const HIDDEN_OUTCOME_LABELS = new Set(['interview', 'interviews']);

function publicOutcomes(entries) {
  return entries.filter((entry) => !HIDDEN_OUTCOME_LABELS.has(String(entry?.label ?? '').trim().toLowerCase()));
}

function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

async function readLifetimeTotals(db, now = new Date()) {
  const selectLifetime = () => db.prepare(`
    SELECT installations, active_installations_30d, jobs_assessed, applications_submitted,
           offers, refreshed_at
    FROM public_stats_lifetime
    WHERE id = 1
  `).first();
  let lifetime = await selectLifetime();
  const refreshedAt = Date.parse(String(lifetime?.refreshed_at ?? ''));
  const stale = !lifetime
    || !Number.isFinite(refreshedAt)
    || (now.getTime() - refreshedAt) > ACTIVE_REFRESH_SECONDS * 1000;
  if (stale) {
    await refreshActiveInstallations30d(db, now);
    lifetime = await selectLifetime();
  }
  return lifetime ?? {
    installations: 0,
    active_installations_30d: 0,
    jobs_assessed: 0,
    applications_submitted: 0,
    offers: 0,
  };
}

export async function buildPublicStats(db, now = new Date()) {
  if (!db?.prepare) throw new Error('Public aggregate store is not configured.');
  const [lifetime, timeline, ats, seniority, outcomes] = await Promise.all([
    readLifetimeTotals(db, now),
    db.prepare(`
      SELECT day,
        SUM(CASE WHEN metric = 'jobs_assessed' THEN count ELSE 0 END) AS assessed,
        SUM(CASE WHEN metric = 'applications_submitted' THEN count ELSE 0 END) AS submitted
      FROM public_daily_metrics
      WHERE day >= date('now', '-30 days')
        AND metric IN ('jobs_assessed', 'applications_submitted')
      GROUP BY day ORDER BY day
    `).all(),
    db.prepare(`SELECT segment AS label, SUM(count) AS count FROM public_daily_metrics WHERE day >= date('now', '-90 days') AND metric = 'ats' GROUP BY segment ORDER BY count DESC, label LIMIT 12`).all(),
    db.prepare(`SELECT segment AS label, SUM(count) AS count FROM public_daily_metrics WHERE day >= date('now', '-90 days') AND metric = 'seniority' GROUP BY segment ORDER BY count DESC, label LIMIT 12`).all(),
    db.prepare(`SELECT segment AS label, SUM(count) AS count FROM public_daily_metrics WHERE day >= date('now', '-365 days') AND metric = 'outcome' AND segment NOT IN ('interview', 'interviews') GROUP BY segment ORDER BY count DESC, label`).all(),
  ]);
  const totals = lifetime ?? {};
  const segment = (result) => suppressSmallSegments(Array.isArray(result) ? result : rows(result));
  return {
    generatedAt: now.toISOString(),
    window: { retentionMonths: 24, activityDays: 30 },
    metrics: {
      installations: number(totals.installations),
      activeInstallations30d: number(totals.active_installations_30d),
      jobsAssessed: number(totals.jobs_assessed),
      applicationsSubmitted: number(totals.applications_submitted),
      // The interviews count is collected (public_stats_lifetime.interviews) but never public.
      offers: number(totals.offers),
    },
    timeline: rows(timeline).map((entry) => ({ day: String(entry.day), assessed: number(entry.assessed), submitted: number(entry.submitted) })),
    breakdowns: { ats: segment(ats), seniority: segment(seniority), outcomes: segment(publicOutcomes(rows(outcomes))) },
    privacy: { aggregateOnly: true, minimumSegmentCount: MIN_SEGMENT_COUNT, identityCollected: false },
  };
}

export async function publicStatsResponse(request, env) {
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: responseHeaders() });
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(request.url, { method: 'GET' });
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) return cached;
  try {
    const stats = await buildPublicStats(env.PUBLIC_STATS_DB);
    const result = new Response(JSON.stringify(stats), { status: 200, headers: responseHeaders() });
    if (cache) await cache.put(cacheKey, result.clone());
    return result;
  } catch {
    return new Response(JSON.stringify({ error: 'stats_unavailable' }), { status: 503, headers: { ...responseHeaders(), 'cache-control': 'no-store', 'retry-after': '60' } });
  }
}
