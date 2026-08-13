import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPublicStats, publicStatsQueries } from '../src/public-stats.mjs';
import worker from '../src/worker.mjs';

function queryEnv() {
  const requests = [];
  const fixtures = {
    'public usage dashboard summary': {
      columns: ['installations', 'active_installations_30d', 'jobs_assessed', 'applications_submitted', 'interviews', 'offers'],
      results: [[42, 18, 310, 96, 12, 2]],
    },
    'public usage dashboard timeline': {
      columns: ['day', 'assessed', 'submitted'],
      results: [['2026-08-12', 14, 5], ['2026-08-13', 21, 8]],
    },
    'public usage dashboard ATS mix': {
      columns: ['label', 'count'],
      results: [['ashby', 30], ['greenhouse', 20], ['tiny-segment', 2]],
    },
    'public usage dashboard seniority mix': {
      columns: ['label', 'count'],
      results: [['senior', 50], ['staff', 25], ['principal', 1]],
    },
    'public usage dashboard outcomes': {
      columns: ['label', 'count'],
      results: [['interview', 12], ['offer', 2]],
    },
  };
  return {
    POSTHOG_PERSONAL_API_KEY: 'phx_private_test_key',
    POSTHOG_PROJECT_ID: '556627',
    POSTHOG_APP_HOST: 'https://us.posthog.com',
    POSTHOG_QUERY_FETCH: async (url, options) => {
      requests.push({ url, options });
      const name = JSON.parse(options.body).name;
      return Response.json(fixtures[name], { status: 200 });
    },
    requests,
  };
}

test('public stats returns bounded aggregate metrics and suppresses small segments', async () => {
  const env = queryEnv();
  const result = await buildPublicStats(env, new Date('2026-08-14T00:00:00Z'));
  assert.equal(result.metrics.installations, 42);
  assert.equal(result.metrics.applicationsSubmitted, 96);
  assert.deepEqual(result.timeline[0], { day: '2026-08-12', assessed: 14, submitted: 5 });
  assert.deepEqual(result.breakdowns.ats, [
    { label: 'ashby', count: 30 },
    { label: 'greenhouse', count: 20 },
    { label: 'other', count: 2 },
  ]);
  assert.equal(result.privacy.minimumSegmentCount, 3);
  assert.equal(JSON.stringify(result).includes('distinct_id'), false);
  assert.equal(env.requests.length, 5);
  for (const request of env.requests) {
    assert.equal(request.options.headers.authorization, 'Bearer phx_private_test_key');
    assert.equal(request.options.body.includes('distinct_id'), publicStatsQueries.summary === JSON.parse(request.options.body).query.query);
  }
});

test('public endpoint keeps the PostHog credential server-side and advertises cache policy', async () => {
  const env = queryEnv();
  const response = await worker.fetch(new Request('https://relay.example.com/api/public-stats'), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /s-maxage=900/);
  const body = await response.text();
  assert.equal(body.includes('phx_private_test_key'), false);
  assert.equal(body.includes('distinct_id'), false);
});

test('public endpoint fails closed when analytics credentials or upstream data are unavailable', async () => {
  const response = await worker.fetch(new Request('https://relay.example.com/api/public-stats'), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'stats_unavailable' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('public queries are fixed aggregates with retention windows and no raw row projection', () => {
  for (const query of Object.values(publicStatsQueries)) {
    assert.match(query, /count|uniqExact/i);
    assert.match(query, /timestamp >=/i);
    assert.doesNotMatch(query, /SELECT\s+\*/i);
    assert.doesNotMatch(query, /properties\.company|properties\.title|properties\.jobHash/i);
  }
});
