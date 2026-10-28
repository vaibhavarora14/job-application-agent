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
  LOCATION_RECORD_MAX_AGE_MS,
} from '../lib/job-locations.mjs';
import { jobPostingJsonLd, postedDate, employerSalary } from '../lib/live-jobs.mjs';
import { locationIndexFreshness } from '../lib/job-locations-freshness.mjs';

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
  assert.deepEqual(result.salary.ranges, [{ min: 125000, max: 190000, currency: 'USD', period: 'year', location: null, label: '$125K–$190K USD' }]);
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
