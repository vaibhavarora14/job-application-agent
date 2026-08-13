const CACHE_SECONDS = 15 * 60;
const MIN_SEGMENT_COUNT = 3;

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

export async function recordPublicAggregate(db, event, signingSecret, now = new Date()) {
  if (!db?.prepare) return;
  const day = now.toISOString().slice(0, 10);
  const active = event.event === 'job_assessed' || event.event === 'application_submitted';
  if (event.event === 'installation_started' || active) {
    const installationHash = await anonymousInstallationHash(event.installationId, signingSecret);
    await db.prepare(`
      INSERT INTO public_installations (installation_hash, installed_at, last_active_at)
      VALUES (?, ?, ?)
      ON CONFLICT(installation_hash) DO UPDATE SET
        last_active_at = COALESCE(excluded.last_active_at, public_installations.last_active_at)
    `).bind(installationHash, now.toISOString(), active ? now.toISOString() : null).run();
  }
  if (event.event === 'job_assessed') await increment(db, day, 'jobs_assessed');
  if (event.event === 'application_submitted') {
    await increment(db, day, 'applications_submitted');
    await increment(db, day, 'ats', event.properties.ats);
  }
  if (event.event === 'job_discovered') await increment(db, day, 'seniority', event.properties.seniority);
  if (event.event === 'outcome_recorded') {
    await increment(db, day, 'outcome', event.properties.outcome);
    if (event.properties.outcome === 'interview') await increment(db, day, 'interviews');
    if (event.properties.outcome === 'offer') await increment(db, day, 'offers');
  }
}

function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

export async function buildPublicStats(db, now = new Date()) {
  if (!db?.prepare) throw new Error('Public aggregate store is not configured.');
  const [summary, timeline, ats, seniority, outcomes] = await Promise.all([
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM public_installations) AS installations,
        (SELECT COUNT(*) FROM public_installations WHERE last_active_at >= datetime('now', '-30 days')) AS active_installations_30d,
        COALESCE(SUM(CASE WHEN metric = 'jobs_assessed' THEN count ELSE 0 END), 0) AS jobs_assessed,
        COALESCE(SUM(CASE WHEN metric = 'applications_submitted' THEN count ELSE 0 END), 0) AS applications_submitted,
        COALESCE(SUM(CASE WHEN metric = 'interviews' THEN count ELSE 0 END), 0) AS interviews,
        COALESCE(SUM(CASE WHEN metric = 'offers' THEN count ELSE 0 END), 0) AS offers
      FROM public_daily_metrics
      WHERE day >= date('now', '-24 months')
    `).all(),
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
    db.prepare(`SELECT segment AS label, SUM(count) AS count FROM public_daily_metrics WHERE day >= date('now', '-365 days') AND metric = 'outcome' GROUP BY segment ORDER BY count DESC, label`).all(),
  ]);
  const totals = rows(summary)[0] ?? {};
  const segment = (result) => suppressSmallSegments(rows(result));
  return {
    generatedAt: now.toISOString(),
    window: { retentionMonths: 24, activityDays: 30 },
    metrics: {
      installations: number(totals.installations),
      activeInstallations30d: number(totals.active_installations_30d),
      jobsAssessed: number(totals.jobs_assessed),
      applicationsSubmitted: number(totals.applications_submitted),
      interviews: number(totals.interviews),
      offers: number(totals.offers),
    },
    timeline: rows(timeline).map((entry) => ({ day: String(entry.day), assessed: number(entry.assessed), submitted: number(entry.submitted) })),
    breakdowns: { ats: segment(ats), seniority: segment(seniority), outcomes: segment(outcomes) },
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
