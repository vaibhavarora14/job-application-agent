import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  extractLocation,
  attachLocationToJob,
  placesFromLabel,
  countryCodeOf,
  greenhouseSalary,
  ashbySalary,
  formatPayLabel,
  compensationKind,
  parseSalaryDetails,
  LOCATION_RECORD_MAX_AGE_MS,
} from '../lib/job-locations.mjs';
import { jobPostingJsonLd, postedDate, employerSalary, payLines, payRows, MAX_PAY_BANDS, filterBoardJobs } from '../lib/live-jobs.mjs';
import { extractEmploymentType } from '../lib/job-locations.mjs';
import { locationIndexFreshness, locationSnapshotShrinkCheck } from '../lib/job-locations-freshness.mjs';

const now = Date.parse('2026-10-28T10:00:00.000Z');
const base = {
  jobId: 'community-job-0000000000000abc',
  company: 'Acme',
  role: 'Software Engineer',
  applicationChannel: 'ashby',
  providerUrl: 'https://jobs.ashbyhq.com/acme',
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-27T00:00:00.000Z',
  contributionCount: 1,
  livenessStatus: 'open',
  lastCheckedAt: '2026-10-27T00:00:00.000Z',
  closedAt: null,
  slug: 'acme-software-engineer-0000000000000abc',
};

test('Lever onsite (the API spelling) and on-site both map to onsite', () => {
  const job = { ...base, url: 'https://jobs.lever.co/acme/aaaa-bbbb' };
  const lever = { id: 'aaaa-bbbb', text: 'Software Engineer', hostedUrl: job.url, country: 'IN', workplaceType: 'onsite', categories: { allLocations: ['Bengaluru'], commitment: 'FTE', team: 'Engineering', department: 'R&D' }, createdAt: 1771847961855 };
  const result = extractLocation(job, lever, now);
  assert.equal(result.workplace, 'onsite');
  assert.equal(extractLocation(job, { ...lever, workplaceType: 'on-site' }, now).workplace, 'onsite');
  assert.equal(extractLocation(job, { ...lever, workplaceType: 'unspecified' }, now).workplace, 'unknown');
  assert.deepEqual(result.places, [{ locality: 'Bengaluru', country: 'IN' }]);
  assert.equal(result.employmentType, 'full-time');
  assert.equal(result.department, 'R&D');
  assert.equal(result.team, 'Engineering');
  assert.equal(result.postedAt, new Date(1771847961855).toISOString());
});

test('Ashby structured compensation, department, team and publish date are stored', () => {
  const job = { ...base, url: 'https://jobs.ashbyhq.com/acme/123' };
  const data = { jobs: [{
    id: '123', title: 'Software Engineer', jobUrl: job.url, location: 'United States (Remote)', workplaceType: 'Remote',
    address: { postalAddress: { addressCountry: 'USA' } }, employmentType: 'FullTime', department: 'Engineering', team: 'Platform',
    publishedAt: '2026-01-13T17:41:00.233+00:00',
    compensation: { summaryComponents: [
      { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
      { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 125000, maxValue: 190000 },
    ] },
  }] };
  const result = extractLocation(job, data, now);
  assert.equal(result.workplace, 'remote');
  assert.deepEqual(result.countryCodes, ['US']);
  assert.equal(result.salary.label, '$125K–$190K USD');
  assert.equal(result.salary.currency, 'USD');
  assert.deepEqual(result.salary.ranges, [{ min: 125000, max: 190000, currency: 'USD', period: 'year', kind: 'base', location: null, label: '$125K–$190K USD' }]);
  assert.equal(result.salary.basis, 'ats');
  assert.equal(result.salary.source, 'employer');
  assert.equal(result.employmentType, 'full-time');
  assert.equal(result.experienceLevel, null);
  assert.equal(result.department, 'Engineering');
  assert.equal(result.postedAt, '2026-01-13T17:41:00.233Z');
  assert.equal(ashbySalary({ ...data.jobs[0], shouldDisplayCompensationOnJobPostings: false }), null);
});

test('Greenhouse pay ranges, metadata and departments are read; nothing is defaulted', () => {
  const job = { ...base, url: 'https://job-boards.greenhouse.io/acme/jobs/42' };
  const gh = {
    id: 42, title: 'Software Engineer', absolute_url: job.url, location: { name: 'Menlo Park, CA; New York, NY' },
    pay_input_ranges: [
      { min_cents: 16600000, max_cents: 19500000, currency_type: 'USD', title: 'Zone 1' },
      { min_cents: 13000000, max_cents: 15200000, currency_type: 'USD', title: 'Zone 3' },
    ],
    metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Level', value: 'Mid-level' }],
    departments: [{ name: 'Engineering' }],
    first_published: '2026-07-21T16:24:17-04:00',
  };
  const result = extractLocation(job, gh, now);
  assert.equal(result.salary.label, '$130K–$195K USD');
  assert.deepEqual(result.salary.ranges.map((range) => [range.location, range.label]), [['Zone 1', '$166K–$195K USD'], ['Zone 3', '$130K–$152K USD']]);
  assert.equal(result.employmentType, 'full-time');
  assert.equal(result.experienceLevel, 'mid');
  assert.equal(result.department, 'Engineering');
  assert.equal(result.postedAt, '2026-07-21T20:24:17.000Z');
  assert.deepEqual(result.places, [
    { locality: 'Menlo Park', region: 'CA', country: 'US' },
    { locality: 'New York', region: 'NY', country: 'US' },
  ]);
  const bare = extractLocation(job, { id: 42, title: 'Software Engineer', absolute_url: job.url, location: { name: 'Somewhere' } }, now);
  assert.equal(bare.employmentType, null);
  assert.equal(bare.experienceLevel, null);
  assert.equal(bare.salary, null);
  assert.deepEqual(bare.places, []);
  assert.equal(greenhouseSalary({ pay_input_ranges: [{ min_cents: 2500, max_cents: 3500, currency_type: 'USD' }] }).period, 'hour');
});

test('location labels only yield places with an explicit country', () => {
  assert.deepEqual(placesFromLabel('Remote - US'), [{ country: 'US' }]);
  assert.deepEqual(placesFromLabel('Bangalore, India'), [{ locality: 'Bangalore', country: 'IN' }]);
  assert.deepEqual(placesFromLabel('Remote / Boston / Salt Lake City'), []);
  assert.equal(countryCodeOf('NAMER'), null);
  assert.equal(countryCodeOf('European Union'), null);
  assert.equal(countryCodeOf('United Kingdom'), 'GB');
});

test('JSON-LD: TELECOMMUTE only with a stated country, never Worldwide', () => {
  const remoteNoCountry = { ...base, url: 'https://jobs.ashbyhq.com/acme/1', location: { label: 'Remote', cities: [], countries: [], countryCodes: [], places: [], workplace: 'remote' } };
  const ld = jobPostingJsonLd(remoteNoCountry);
  assert.equal(ld.jobLocationType, undefined);
  assert.equal(ld.applicantLocationRequirements, undefined);
  assert.equal(ld.jobLocation, undefined);
  assert.equal(JSON.stringify(ld).includes('Worldwide'), false);

  const remoteUs = { ...remoteNoCountry, location: { ...remoteNoCountry.location, countryCodes: ['US'] } };
  const remoteLd = jobPostingJsonLd(remoteUs);
  assert.equal(remoteLd.jobLocationType, 'TELECOMMUTE');
  assert.deepEqual(remoteLd.applicantLocationRequirements, { '@type': 'Country', name: 'United States' });
});

test('JSON-LD: jobLocation, baseSalary, employmentType and datePosted come from the source', () => {
  const salary = { min: 130000, max: 195000, annualMin: 130000, annualMax: 195000, currency: 'USD', period: 'year', label: '$130K–$195K USD', isEstimated: false, source: 'employer', basis: 'ats' };
  const job = {
    ...base,
    url: 'https://job-boards.greenhouse.io/acme/jobs/42',
    location: {
      label: 'Menlo Park, CA', cities: [], countries: [], countryCodes: ['US'], workplace: 'onsite',
      places: [{ locality: 'Menlo Park', region: 'CA', country: 'US' }],
      salary, employmentType: 'full-time', experienceLevel: null, postedAt: '2026-07-21T20:24:17.000Z',
    },
  };
  const ld = jobPostingJsonLd(job);
  assert.deepEqual(ld.jobLocation, { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'US', addressLocality: 'Menlo Park', addressRegion: 'CA' } });
  assert.deepEqual(ld.baseSalary, { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 130000, maxValue: 195000, unitText: 'YEAR' } });
  assert.equal(ld.employmentType, 'FULL_TIME');
  assert.equal(ld.datePosted, '2026-07-21');
  assert.equal(ld.jobLocationType, undefined);
  assert.equal(postedDate(job), '2026-07-21T20:24:17.000Z');
  assert.equal(employerSalary(job).label, '$130K–$195K USD');

  const unstated = jobPostingJsonLd({ ...job, location: { ...job.location, salary: { ...salary, isEstimated: true }, employmentType: null, postedAt: null } });
  assert.equal(unstated.baseSalary, undefined);
  assert.equal(unstated.employmentType, undefined);
  assert.equal(unstated.datePosted, '2026-10-01');
  assert.equal(jobPostingJsonLd({ ...base, url: job.url, location: null }).jobLocation, undefined);
});

test('attachLocationToJob keeps stated nulls and never re-adds title defaults', () => {
  const job = { ...base, url: 'https://jobs.ashbyhq.com/acme/1' };
  const record = { ...job, label: 'Remote', cities: [], countries: [], countryCodes: [], places: [], workplace: 'remote', salary: null, employmentType: null, experienceLevel: null, checkedAt: '2026-10-27T00:00:00.000Z' };
  const attached = attachLocationToJob(job, { records: [record] }, now);
  assert.equal(attached.location.employmentType, null);
  assert.equal(attached.location.experienceLevel, null);
  assert.equal(attachLocationToJob(job, { records: [record] }, Date.parse(record.checkedAt) + LOCATION_RECORD_MAX_AGE_MS + 1).location, null);
});

test('location index freshness flags refresh, alert and expiry', () => {
  const day = 86400000;
  assert.equal(locationIndexFreshness({ collectedAt: new Date(now - 2 * day).toISOString() }, now).status, 'fresh');
  assert.equal(locationIndexFreshness({ collectedAt: new Date(now - 10 * day).toISOString() }, now).status, 'refresh');
  assert.equal(locationIndexFreshness({ collectedAt: new Date(now - 25 * day).toISOString() }, now).status, 'alert');
  assert.equal(locationIndexFreshness({ collectedAt: new Date(now - 31 * day).toISOString() }, now).status, 'expired');
  assert.equal(locationIndexFreshness({ collectedAt: 'nope' }, now).status, 'invalid');
  assert.equal(locationIndexFreshness({}, now).ok, false);
});

test('Ashby compensation tiers keep each range with its location; labels match the design format', () => {
  const salary = ashbySalary({ compensation: {
    compensationTiers: [
      { title: 'Germany', components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'EUR', minValue: 110500, maxValue: 181500 }] },
      { title: 'Netherlands', components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'EUR', minValue: 100000, maxValue: 170000 }, { compensationType: 'EquityPercentage', interval: 'NONE' }] },
    ],
    summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'EUR', minValue: 100000, maxValue: 181500 }],
  } });
  assert.equal(salary.label, '€100K–€181.5K');
  assert.deepEqual(salary.ranges.map((range) => [range.location, range.label]), [['Germany', '€110.5K–€181.5K'], ['Netherlands', '€100K–€170K']]);
  assert.equal(formatPayLabel(135000, 300000, 'USD', 'year'), '$135K–$300K USD');
  assert.equal(formatPayLabel(45, 60, 'USD', 'hour'), '$45–$60 USD /hr');
  assert.equal(formatPayLabel(90000, 120000, 'CHF', 'year'), '90K–120K CHF');
  assert.equal(formatPayLabel(100000, 100000, 'GBP', 'year'), '£100K');
});

test('committed snapshot is well-formed and carries no unresolved queue in the bundled file', async () => {
  const index = JSON.parse(await readFile(new URL('../data/job-locations.json', import.meta.url), 'utf8'));
  assert.equal(index.version, 1);
  assert.ok(Number.isFinite(Date.parse(index.collectedAt)));
  assert.ok(Array.isArray(index.records) && index.records.length > 0);
  assert.equal('unresolved' in index, false);
  for (const record of index.records) {
    assert.ok(record.jobId && record.checkedAt);
    if (record.salary) {
      assert.equal(record.salary.isEstimated, false);
      assert.match(record.salary.currency, /^[A-Z]{3}$/);
      assert.ok(Array.isArray(record.salary.ranges) && record.salary.ranges.length > 0);
      assert.ok(['base', 'ote', 'total'].includes(record.salary.kind));
      if (record.salary.kind !== 'base') assert.match(record.salary.label, / (OTE|total comp)$/);
    }
    for (const place of record.places ?? []) assert.match(place.country, /^[A-Z]{2}$/);
  }
});

// Hard guard: the site drops location records older than LOCATION_RECORD_MAX_AGE_MS, so an expired
// snapshot silently blanks location, workplace and pay for every job. Fail CI until it is refreshed
// (`npm run collect:job-locations` or the job-locations-refresh workflow).
test('committed location snapshot has not passed the 30-day cutoff', async () => {
  const index = JSON.parse(await readFile(new URL('../data/job-locations.json', import.meta.url), 'utf8'));
  const freshness = locationIndexFreshness(index, Date.now());
  assert.notEqual(freshness.status, 'expired', `job-locations.json is ${freshness.ageDays} days old; refresh it before shipping`);
  assert.notEqual(freshness.status, 'invalid');
});

const liveJob = {
  ...base,
  url: 'https://job-boards.greenhouse.io/acme/jobs/9',
  location: { label: 'New York, NY', cities: [], countries: [], countryCodes: ['US'], workplace: 'onsite', places: [{ locality: 'New York', region: 'NY', country: 'US' }], salary: null },
};

test('review fix: refreshed snapshot fails closed when empty or sharply reduced', () => {
  const committed = { snapshotCount: 1600, records: Array.from({ length: 580 }, (_, i) => ({ jobId: `j${i}` })) };
  const sized = (n, snapshotCount = 1600) => ({ snapshotCount, records: Array.from({ length: n }, (_, i) => ({ jobId: `j${i}` })) });
  assert.equal(locationSnapshotShrinkCheck(committed, sized(560)).ok, true);
  assert.equal(locationSnapshotShrinkCheck(committed, sized(290)).ok, true);
  const reduced = locationSnapshotShrinkCheck(committed, sized(289));
  assert.equal(reduced.ok, false);
  assert.match(reduced.reason, /fewer than 50%/);
  assert.match(locationSnapshotShrinkCheck(committed, sized(0)).reason, /0 records/);
  assert.match(locationSnapshotShrinkCheck(committed, sized(0, 0)).reason, /feed|empty/);
  assert.equal(locationSnapshotShrinkCheck(null, sized(10)).ok, true);
  assert.equal(locationSnapshotShrinkCheck(null, sized(0)).ok, false);
});

test('review fix: a country qualifier in parentheses is parsed before other parenthetical text is stripped', () => {
  assert.deepEqual(placesFromLabel('Cardiff, London or Remote (UK)').map((place) => place.country), ['GB', 'GB']);
  assert.deepEqual(placesFromLabel('Remote (United States) · Remote (Canada)'), [{ country: 'US' }, { country: 'CA' }]);
  assert.deepEqual(placesFromLabel('London (UK)'), [{ locality: 'London', country: 'GB' }]);
  assert.deepEqual(placesFromLabel('Remote (US/Canada) / Berlin, Germany'), [{ country: 'US' }, { country: 'CA' }, { locality: 'Berlin', country: 'DE' }]);
  // Non-country parentheticals and regions are still ignored, never guessed.
  assert.deepEqual(placesFromLabel('Hybrid (London)'), []);
  assert.deepEqual(placesFromLabel('Remote Global (US, EU)'), []);
  const job = { ...base, url: 'https://job-boards.greenhouse.io/monzo/jobs/7' };
  const record = extractLocation(job, { id: 7, title: 'Software Engineer', absolute_url: job.url, location: { name: 'Cardiff, London or Remote (UK)' } }, now);
  assert.deepEqual(record.countryCodes, ['GB']);
  const ld = jobPostingJsonLd({ ...liveJob, location: { ...record, workplace: 'remote' } });
  assert.equal(ld.jobLocationType, 'TELECOMMUTE');
  assert.equal(ld.applicantLocationRequirements.name, 'United Kingdom');
});

test('review fix: OTE / total compensation is labelled honestly and kept out of baseSalary', () => {
  assert.equal(compensationKind('OTE is $170-220k'), 'ote');
  assert.equal(compensationKind('On-target earnings'), 'ote');
  assert.equal(compensationKind('Total compensation range'), 'total');
  assert.equal(compensationKind('Base salary range'), 'base');
  const ote = parseSalaryDetails('OTE is $170-220k');
  assert.equal(ote.kind, 'ote');
  assert.equal(ote.label, '$170K–$220K USD OTE');
  const gh = greenhouseSalary({ pay_input_ranges: [{ min_cents: 15000000, max_cents: 25000000, currency_type: 'USD', title: 'US Pay Range (OTE)', blurb: '<p>target OTE</p>' }] });
  assert.equal(gh.kind, 'ote');
  assert.equal(gh.label, '$150K–$250K USD OTE');
  const ldOte = jobPostingJsonLd({ ...liveJob, location: { ...liveJob.location, salary: { ...gh, isEstimated: false, source: 'employer' } } });
  assert.equal(ldOte.baseSalary, undefined);
  assert.equal(employerSalary({ location: { salary: gh } }).label, '$150K–$250K USD OTE');
  const basePay = greenhouseSalary({ pay_input_ranges: [{ min_cents: 15000000, max_cents: 25000000, currency_type: 'USD', title: 'US base salary range' }] });
  assert.equal(basePay.kind, 'base');
  const ldBase = jobPostingJsonLd({ ...liveJob, location: { ...liveJob.location, salary: basePay } });
  assert.equal(ldBase.baseSalary.value.minValue, 150000);
});

test('review fix: a trailing country code wins over a matching US state only with evidence', () => {
  assert.deepEqual(placesFromLabel('Bengaluru, IN'), [{ locality: 'Bengaluru', country: 'IN' }]);
  assert.deepEqual(placesFromLabel('Toronto, ON, CA'), [{ locality: 'Toronto', region: 'ON', country: 'CA' }]);
  assert.deepEqual(placesFromLabel('Austin, TX'), [{ locality: 'Austin', region: 'TX', country: 'US' }]);
  assert.deepEqual(placesFromLabel('Boston, MA'), [{ locality: 'Boston', region: 'MA', country: 'US' }]);
  assert.deepEqual(placesFromLabel('San Francisco, CA'), [{ locality: 'San Francisco', region: 'CA', country: 'US' }]);
  assert.deepEqual(placesFromLabel('Indianapolis, IN'), [{ locality: 'Indianapolis', region: 'IN', country: 'US' }]);
});

test('review fix: a title that states Full-Time is recorded as full-time', () => {
  assert.equal(extractEmploymentType('Software Engineer (Full-Time)'), 'full-time');
  assert.equal(extractEmploymentType('Account Executive - Full Time'), 'full-time');
  assert.equal(extractEmploymentType('Full Stack Engineer'), null);
  assert.equal(extractEmploymentType('Software Engineer'), null);
});

test('review fix: the detail page lists each employer pay band with its name', () => {
  const salary = greenhouseSalary({ pay_input_ranges: [
    { min_cents: 16600000, max_cents: 19500000, currency_type: 'USD', title: 'US Zone 1' },
    { min_cents: 13000000, max_cents: 15200000, currency_type: 'USD', title: 'US Zone 3' },
    { min_cents: 11000000, max_cents: 13000000, currency_type: 'CAD', title: 'Canada' },
  ] });
  const withBands = { ...liveJob, location: { ...liveJob.location, salary } };
  assert.deepEqual(payLines(withBands), ['US Zone 1: $166K–$195K USD', 'US Zone 3: $130K–$152K USD', 'Canada: CA$110K–CA$130K']);
  const single = greenhouseSalary({ pay_input_ranges: [{ min_cents: 16600000, max_cents: 19500000, currency_type: 'USD', title: 'US' }] });
  assert.deepEqual(payLines({ ...liveJob, location: { ...liveJob.location, salary: single } }), ['$166K–$195K USD']);
  assert.deepEqual(payLines(liveJob), []);
});

test('review fix: a posting with only employer-stated employment metadata is retained', () => {
  const job = { ...base, url: 'https://job-boards.greenhouse.io/acme/jobs/77' };
  const record = extractLocation(job, { id: 77, title: 'Software Engineer', absolute_url: job.url, metadata: [{ name: 'Employment Type', value: 'Contract' }] }, now);
  assert.ok(record);
  assert.equal(record.employmentType, 'contract');
  assert.equal(extractLocation(job, { id: 77, title: 'Software Engineer', absolute_url: job.url }, now), null);
});

test('review fix: the Posted filter uses the employer date, with the first-seen fallback', () => {
  const nowMs = Date.parse('2026-10-28T00:00:00.000Z');
  const open = { ...base, livenessStatus: 'open', lastCheckedAt: '2026-10-27T00:00:00.000Z', firstSeenAt: '2026-10-25T00:00:00.000Z', lastSeenAt: '2026-10-27T00:00:00.000Z' };
  const oldEmployer = { ...open, jobId: 'community-job-00000000000000a1', location: { ...liveJob.location, postedAt: '2026-05-23T00:00:00.000Z' } };
  const newEmployer = { ...open, jobId: 'community-job-00000000000000a2', firstSeenAt: '2026-08-01T00:00:00.000Z', location: { ...liveJob.location, postedAt: '2026-10-20T00:00:00.000Z' } };
  const noEmployer = { ...open, jobId: 'community-job-00000000000000a3', location: { ...liveJob.location, postedAt: null } };
  const ids = filterBoardJobs([oldEmployer, newEmployer, noEmployer], { postedDays: 14, now: nowMs }).map((job) => job.jobId);
  assert.deepEqual(ids, ['community-job-00000000000000a2', 'community-job-00000000000000a3']);
});

test('review fix: explicit weekly and daily pay units are kept', () => {
  const weekly = parseSalaryDetails('£1,500–£2,000 per week');
  assert.equal(weekly.period, 'week');
  assert.equal(weekly.label, '£1.5K–£2K /wk');
  assert.equal(weekly.annualMin, 78000);
  const daily = parseSalaryDetails('Day rate: €500 - €650 per day');
  assert.equal(daily.period, 'day');
  assert.equal(daily.label, '€500–€650 /day');
  const ld = jobPostingJsonLd({ ...liveJob, location: { ...liveJob.location, salary: weekly } });
  assert.equal(ld.baseSalary.value.unitText, 'WEEK');
});

test('review fix: the refresh workflow only ever pushes a checkout of main', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/job-locations-refresh.yml', import.meta.url), 'utf8');
  const refresh = workflow.slice(workflow.indexOf('\n  refresh:'), workflow.indexOf('\n  alert:'));
  assert.match(refresh, /actions\/checkout@[^\n]+\n\s+with:\n(?:\s+#[^\n]*\n)*\s+ref: main/);
  assert.match(refresh, /git rev-parse --abbrev-ref HEAD\)" != "main"/);
});

// Design-approved pay-band rows (PR #183): name + colon, range never split, OTE / total comp wording, max 4 bands.
const bandSalary = (count) => greenhouseSalary({ pay_input_ranges: Array.from({ length: count }, (_, i) => ({ title: `Engineer ${i + 1}`, min_cents: (150000 + i * 10000) * 100, max_cents: (180000 + i * 10000) * 100, currency_type: 'USD' })) });

test('pay bands: each row is a band name and a range with its currency', () => {
  const rows = payRows({ ...liveJob, location: { ...liveJob.location, salary: bandSalary(3) } });
  assert.equal(rows.single, null);
  assert.deepEqual(rows.bands[0], { name: 'Engineer 1', range: '$150K–$180K USD' });
  assert.equal(rows.more, 0);
  // A single range is not a band list; unknown pay is null (no pay chip or row is shown).
  assert.deepEqual(payRows({ ...liveJob, location: { ...liveJob.location, salary: bandSalary(1) } }), { single: '$150K–$180K USD', bands: [], more: 0 });
  assert.equal(payRows(liveJob), null);
});

test('pay bands: at most 4 rows, then a "+N more" count', () => {
  assert.equal(MAX_PAY_BANDS, 4);
  const rows = payRows({ ...liveJob, location: { ...liveJob.location, salary: bandSalary(6) } });
  assert.equal(rows.bands.length, 4);
  assert.equal(rows.more, 2);
  assert.equal(payRows({ ...liveJob, location: { ...liveJob.location, salary: bandSalary(4) } }).more, 0);
});

test('pay bands: OTE in caps after the currency; total comp spelled out, never TC', () => {
  assert.equal(formatPayLabel(150000, 250000, 'USD', 'year', 'ote'), '$150K–$250K USD OTE');
  assert.equal(formatPayLabel(110500, 181500, 'EUR', 'year', 'total'), '€110.5K–€181.5K total comp');
  const tc = greenhouseSalary({ pay_input_ranges: [{ title: 'US (TC)', min_cents: 20000000, max_cents: 30000000, currency_type: 'USD' }] });
  assert.equal(tc.kind, 'total');
  assert.equal(tc.label, '$200K–$300K USD total comp');
  assert.doesNotMatch(tc.label, /\bTC\b/);
});

test('pay bands: CSS keeps the name muted and the range bold and unsplittable', async () => {
  const css = await readFile(new URL('../app/jobs/jobs.module.css', import.meta.url), 'utf8');
  const globals = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  const rule = (name) => css.match(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  // Direction B tokens live site-wide in globals.css :root (muted #5B6B80, ink #0F172A); /jobs aliases them.
  assert.match(globals, /--muted:\s*#5b6b80/i);
  assert.match(globals, /--ink:\s*#0f172a/i);
  assert.match(css, /--j-muted:\s*var\(--muted\)/i);
  assert.match(css, /--j-ink:\s*var\(--ink\)/i);
  assert.match(rule('payBandName'), /color:\s*var\(--j-muted\)/);
  assert.match(rule('payBandRange'), /font-weight:\s*600/);
  assert.match(rule('payBandRange'), /white-space:\s*nowrap/);
  assert.match(rule('payBandRange'), /color:\s*var\(--j-ink\)/);
  assert.match(rule('payBandMore'), /color:\s*var\(--j-muted\)/);
  assert.doesNotMatch(rule('payBand'), /nowrap/);
});
