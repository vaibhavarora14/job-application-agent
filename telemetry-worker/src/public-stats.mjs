const CACHE_SECONDS = 15 * 60;
const MAX_AGE_MONTHS = 24;
const MIN_SEGMENT_COUNT = 3;

const SUMMARY_QUERY = `
SELECT
  uniqExactIf(distinct_id, event = 'installation_started') AS installations,
  uniqExactIf(distinct_id, timestamp >= now() - INTERVAL 30 DAY AND event IN ('job_assessed', 'application_submitted')) AS active_installations_30d,
  countIf(event = 'job_assessed') AS jobs_assessed,
  countIf(event = 'application_submitted') AS applications_submitted,
  countIf(event = 'outcome_recorded' AND properties.outcome = 'interview') AS interviews,
  countIf(event = 'outcome_recorded' AND properties.outcome = 'offer') AS offers
FROM events
WHERE timestamp >= now() - INTERVAL ${MAX_AGE_MONTHS} MONTH`;

const TIMELINE_QUERY = `
SELECT
  toDate(timestamp) AS day,
  countIf(event = 'job_assessed') AS assessed,
  countIf(event = 'application_submitted') AS submitted
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY
  AND event IN ('job_assessed', 'application_submitted')
GROUP BY day
ORDER BY day`;

const ATS_QUERY = `
SELECT properties.ats AS label, count() AS count
FROM events
WHERE timestamp >= now() - INTERVAL 90 DAY
  AND event = 'application_submitted'
GROUP BY label
ORDER BY count DESC, label
LIMIT 12`;

const SENIORITY_QUERY = `
SELECT properties.seniority AS label, count() AS count
FROM events
WHERE timestamp >= now() - INTERVAL 90 DAY
  AND event = 'job_discovered'
GROUP BY label
ORDER BY count DESC, label
LIMIT 12`;

const OUTCOMES_QUERY = `
SELECT properties.outcome AS label, count() AS count
FROM events
WHERE timestamp >= now() - INTERVAL 365 DAY
  AND event = 'outcome_recorded'
GROUP BY label
ORDER BY count DESC, label`;

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

function rows(payload) {
  if (!payload || !Array.isArray(payload.results)) throw new Error('Invalid analytics response.');
  return payload.results;
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

async function runQuery(env, query, name) {
  if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) throw new Error('Public analytics is not configured.');
  const fetchFn = env.POSTHOG_QUERY_FETCH ?? fetch;
  const host = (env.POSTHOG_APP_HOST ?? 'https://us.posthog.com').replace(/\/$/, '');
  const upstream = await fetchFn(`${host}/api/projects/${encodeURIComponent(env.POSTHOG_PROJECT_ID)}/query/`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query }, name }),
  });
  if (!upstream.ok) throw new Error('Analytics query failed.');
  return upstream.json();
}

function mapRows(payload) {
  const columns = Array.isArray(payload.columns) ? payload.columns : [];
  return rows(payload).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

export async function buildPublicStats(env, now = new Date()) {
  const [summaryPayload, timelinePayload, atsPayload, seniorityPayload, outcomesPayload] = await Promise.all([
    runQuery(env, SUMMARY_QUERY, 'public usage dashboard summary'),
    runQuery(env, TIMELINE_QUERY, 'public usage dashboard timeline'),
    runQuery(env, ATS_QUERY, 'public usage dashboard ATS mix'),
    runQuery(env, SENIORITY_QUERY, 'public usage dashboard seniority mix'),
    runQuery(env, OUTCOMES_QUERY, 'public usage dashboard outcomes'),
  ]);
  const summary = mapRows(summaryPayload)[0] ?? {};
  const timeline = mapRows(timelinePayload).map((entry) => ({
    day: String(entry.day),
    assessed: number(entry.assessed),
    submitted: number(entry.submitted),
  }));
  const segment = (payload) => suppressSmallSegments(mapRows(payload).map((entry) => ({ label: entry.label, count: entry.count })));
  const metrics = {
    installations: number(summary.installations),
    activeInstallations30d: number(summary.active_installations_30d),
    jobsAssessed: number(summary.jobs_assessed),
    applicationsSubmitted: number(summary.applications_submitted),
    interviews: number(summary.interviews),
    offers: number(summary.offers),
  };
  return {
    generatedAt: now.toISOString(),
    window: { retentionMonths: MAX_AGE_MONTHS, activityDays: 30 },
    metrics,
    timeline,
    breakdowns: {
      ats: segment(atsPayload),
      seniority: segment(seniorityPayload),
      outcomes: segment(outcomesPayload),
    },
    privacy: {
      aggregateOnly: true,
      minimumSegmentCount: MIN_SEGMENT_COUNT,
      identityCollected: false,
    },
  };
}

export async function publicStatsResponse(request, env) {
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: responseHeaders() });
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(request.url, { method: 'GET' });
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) return cached;
  try {
    const stats = await buildPublicStats(env);
    const result = new Response(JSON.stringify(stats), { status: 200, headers: responseHeaders() });
    if (cache) await cache.put(cacheKey, result.clone());
    return result;
  } catch {
    return new Response(JSON.stringify({ error: 'stats_unavailable' }), {
      status: 503,
      headers: { ...responseHeaders(), 'cache-control': 'no-store', 'retry-after': '60' },
    });
  }
}

export const publicStatsQueries = Object.freeze({ summary: SUMMARY_QUERY, timeline: TIMELINE_QUERY, ats: ATS_QUERY, seniority: SENIORITY_QUERY, outcomes: OUTCOMES_QUERY });
