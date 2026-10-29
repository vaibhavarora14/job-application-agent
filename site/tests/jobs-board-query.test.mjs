import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOBS_PAGE_SIZE,
  activeFilterChips,
  activeFilterCount,
  boardHref,
  boardQueryString,
  compactLocation,
  countMatchingJobs,
  emptyBoardQuery,
  filterAndSortJobs,
  likelyZeroCause,
  parseBoardQuery,
  shortPostedLabel,
  usdAnnualMax,
  workplaceLabel,
} from '../lib/jobs-board-query.mjs';
import { toUsd, UNITS_PER_USD } from '../lib/fx-rates.mjs';
import { buildApplyAgentPrompt } from '../lib/job-apply-copy.mjs';
import { normalizeEdgeCacheSearch, isEdgeCacheableRequest, edgeCacheKey } from '../lib/edge-cache.mjs';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
let seq = 0;
function job({ workplace = 'remote', label = 'Remote · India', salary = null, level = null, role = 'Software Engineer', postedAt = null, firstSeenAt = '2026-10-01T00:00:00.000Z', company = 'Acme' } = {}) {
  seq += 1;
  const id = seq.toString(16).padStart(16, '0');
  return {
    jobId: `community-job-${id}`,
    slug: `acme-${id}`,
    url: `https://jobs.ashbyhq.com/acme/${id}`,
    company,
    role,
    applicationChannel: 'ashby',
    firstSeenAt,
    lastSeenAt: '2026-10-27T00:00:00.000Z',
    lastCheckedAt: '2026-10-28T06:00:00.000Z',
    livenessStatus: 'open',
    location: { label, workplace, experienceLevel: level, salary, postedAt },
  };
}
const usd = (min, max, period = 'year') => ({ min, max, annualMin: min, annualMax: max, currency: 'USD', period, label: `$${min / 1000}K–$${max / 1000}K USD`, isEstimated: false, source: 'employer' });

test('parseBoardQuery validates values and round-trips through the canonical query string', () => {
  const q = parseBoardQuery(new URLSearchParams('workplace=remote,mars,hybrid&pay=150&nopay=0&level=senior&posted=7&role=Design&show=120&loc=  Berlin   Germany &design=error&ats=greenhouse'));
  assert.deepEqual(q.workplace, ['remote', 'hybrid']);
  assert.equal(q.pay, 150);
  assert.equal(q.nopay, false);
  assert.deepEqual(q.level, ['senior']);
  assert.equal(q.posted, 7);
  assert.deepEqual(q.role, ['Design']);
  assert.equal(q.show, 150, 'show rounds up to whole pages of 50');
  assert.equal(q.loc, 'Berlin Germany');
  assert.equal(q.design, 'error');
  assert.equal('ats' in q, false, 'no ATS filter');
  assert.deepEqual(parseBoardQuery(new URLSearchParams(boardQueryString(q, { keepShow: true, keepDesign: true }))), q);
  assert.equal(parseBoardQuery({ pay: '123', posted: '2' }).pay, 0);
  assert.equal(boardHref(emptyBoardQuery()), '/jobs');
  assert.equal(JOBS_PAGE_SIZE, 50);
  assert.equal(emptyBoardQuery().nopay, true, 'roles without pay are included by default');
});

test('workplace, level, role and location filters; newest posted first', () => {
  const a = job({ workplace: 'remote', postedAt: '2026-10-20T00:00:00.000Z' });
  const b = job({ workplace: 'hybrid', label: 'Berlin · Germany', level: 'senior', postedAt: '2026-10-25T00:00:00.000Z' });
  const c = job({ workplace: 'onsite', label: 'London', level: 'executive', role: 'Product Designer' });
  const jobs = [a, b, c];
  assert.deepEqual(filterAndSortJobs(jobs, emptyBoardQuery(), NOW).map((j) => j.jobId), [b.jobId, a.jobId, c.jobId]);
  assert.deepEqual(filterAndSortJobs(jobs, parseBoardQuery({ workplace: 'remote,hybrid' }), NOW).length, 2);
  assert.deepEqual(filterAndSortJobs(jobs, parseBoardQuery({ level: 'staff' }), NOW), [c], 'Staff+ includes executive');
  assert.deepEqual(filterAndSortJobs(jobs, parseBoardQuery({ role: 'Design' }), NOW), [c]);
  assert.deepEqual(filterAndSortJobs(jobs, parseBoardQuery({ loc: 'germany' }), NOW), [b]);
  assert.deepEqual(filterAndSortJobs(jobs, parseBoardQuery({ posted: '7' }), NOW), [b]);
});

test('salary filter compares in USD at monthly rates and keeps roles without pay unless excluded', () => {
  const noPay = job();
  const dollars = job({ salary: usd(150000, 180000) });
  const euros = job({ salary: { min: 160000, max: 175000, annualMin: 160000, annualMax: 175000, currency: 'EUR', period: 'year', label: '€160K–€175K', isEstimated: false, source: 'employer' } });
  const hourly = job({ salary: usd(60, 90, 'hour') });
  const multi = job({ salary: { ...usd(100000, 120000), ranges: [
    { min: 100000, max: 120000, currency: 'USD', period: 'year', location: 'US', label: '$100K–$120K USD' },
    { min: 150000, max: 210000, currency: 'GBP', period: 'year', location: 'UK', label: '£150K–£210K' },
  ] } });
  const unknownCurrency = job({ salary: { ...usd(1, 2), currency: 'XYZ', label: '1–2 XYZ' } });
  const all = [noPay, dollars, euros, hourly, multi, unknownCurrency];

  assert.ok(Math.abs(toUsd(175000, 'EUR') - 175000 / UNITS_PER_USD.EUR) < 1e-6);
  assert.equal(toUsd(1, 'XYZ'), null);
  assert.equal(usdAnnualMax(noPay), null);
  assert.equal(Math.round(usdAnnualMax(hourly)), 90 * 2080);
  assert.ok(usdAnnualMax(multi) > 270000, 'highest band across currencies');

  const at150 = filterAndSortJobs(all, parseBoardQuery({ pay: '150' }), NOW);
  assert.ok(at150.includes(noPay), 'no-pay roles stay by default');
  assert.ok(at150.includes(dollars) && at150.includes(euros) && at150.includes(hourly) && at150.includes(multi));
  assert.ok(!at150.includes(unknownCurrency), 'unknown currency never matches a threshold');

  const listedOnly = filterAndSortJobs(all, parseBoardQuery({ pay: '200', nopay: '0' }), NOW);
  assert.deepEqual(new Set(listedOnly), new Set([multi]));
  assert.equal(countMatchingJobs(all, parseBoardQuery({ nopay: '0' }), NOW), 5, 'pay listed in any currency counts as listed');
});

test('active chips, badge count and the zero-results cause', () => {
  const q = parseBoardQuery({ workplace: 'remote', pay: '200', nopay: '0', posted: '1' });
  assert.equal(activeFilterCount(q), 4);
  assert.deepEqual(activeFilterChips(q).map((c) => c.label), ['Remote', '$200K+', 'Pay listed only', 'Last 24 hours']);
  const jobs = [job({ salary: usd(150000, 250000), postedAt: '2026-10-01T00:00:00.000Z' })];
  const cause = likelyZeroCause(jobs, q, NOW);
  assert.equal(cause.chip.label, 'Last 24 hours');
  assert.equal(cause.count, 1);
  assert.equal(likelyZeroCause([], q, NOW), null);
});

test('card helpers: compact location, workplace label, posted label', () => {
  assert.equal(compactLocation({ location: { label: 'Remote · India' } }), 'India');
  assert.equal(compactLocation({ location: { label: 'Remote - US · Austin · Boulder' } }), 'US +2');
  assert.equal(compactLocation({ location: { label: 'Remote (UK)' } }), 'UK');
  assert.equal(compactLocation({ location: { workplace: 'remote' } }), '');
  assert.equal(workplaceLabel({ location: { workplace: 'onsite' } }), 'On-site');
  assert.equal(workplaceLabel({ location: { workplace: 'unknown' } }), null);
  assert.equal(shortPostedLabel('2026-09-24T00:00:00.000Z', NOW), '24 Sept'.replace('Sept', new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(new Date('2026-09-24T00:00:00.000Z'))));
  assert.match(shortPostedLabel('2025-12-18T00:00:00.000Z', NOW), /2025/);
});

test('apply prompt is ready to paste and carries the full posting URL', () => {
  const url = 'https://jobs.ashbyhq.com/livekit/463e2769-bb85-4429-96a3-3a175eb228cd';
  const prompt = buildApplyAgentPrompt({ role: 'Senior Product Engineer', company: 'LiveKit', url });
  assert.match(prompt, /review mode/);
  assert.match(prompt, /Senior Product Engineer at LiveKit/);
  assert.ok(prompt.includes(`URL: ${url}`));
  assert.ok(prompt.includes(`npx job-application-agent@latest apply ${url}`));
  assert.match(prompt, /stop before submit/);
});

test('edge cache keys only canonical /jobs filter queries', () => {
  const page = (path, init = {}) => new Request(`https://jobappagent.com${path}`, init);
  assert.equal(normalizeEdgeCacheSearch('/jobs', new URLSearchParams('workplace=remote&pay=150')).toString(), 'pay=150&workplace=remote');
  assert.equal(isEdgeCacheableRequest(page('/jobs?pay=150&workplace=remote&utm_source=x')), true);
  assert.equal(
    edgeCacheKey(page('/jobs?workplace=remote&pay=150'), 'r').url,
    edgeCacheKey(page('/jobs?pay=150&workplace=remote'), 'r').url,
  );
  assert.notEqual(edgeCacheKey(page('/jobs?workplace=remote'), 'r').url, edgeCacheKey(page('/jobs'), 'r').url);
  assert.equal(isEdgeCacheableRequest(page('/jobs?pay=123')), false, 'invalid values bypass');
  assert.equal(isEdgeCacheableRequest(page('/jobs?ats=greenhouse')), false, 'unknown keys bypass');
  assert.equal(isEdgeCacheableRequest(page('/api/jobs/count?workplace=remote')), true);
  assert.equal(isEdgeCacheableRequest(page('/jobs?workplace=remote', { headers: { RSC: '1' } })), false);
});
