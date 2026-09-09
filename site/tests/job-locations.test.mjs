import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atsTarget,
  extractLocation,
  attachLocations,
  titlesMatch,
  parseSalaryDetails,
  estimateBenchmarkSalary,
  extractExperienceLevel,
  extractEmploymentType
} from '../lib/job-locations.mjs';
import { searchJobs } from '../lib/jobs-search.mjs';

const job = { jobId: 'community-job-0000000000000001', url: 'https://jobs.ashbyhq.com/acme/123', company: 'Acme', role: 'Engineer' };

test('only constructs requests to known ATS APIs from safe job URLs', () => {
  assert.equal(atsTarget(job.url).url, 'https://api.ashbyhq.com/posting-api/job-board/acme');
  for (const url of ['https://localhost/jobs', 'https://jobs.ashbyhq.com.evil.com/acme/123', 'https://jobs.ashbyhq.com/acme%2F..%2Fother/123']) assert.equal(atsTarget(url), null);
  // Synthetic URL userinfo, never a real credential or a network request.
  const credentialUrl = new URL(job.url);
  credentialUrl.username = 'test-user';
  credentialUrl.password = 'test-placeholder';
  assert.equal(atsTarget(credentialUrl.toString()), null);
});

test('supports Ashby URLs with /application suffix and dots in board name', () => {
  const appUrl = 'https://jobs.ashbyhq.com/primeintellect/c074bdd9-bee2-4ee9-ae03-aa8f7537682c/application';
  assert.equal(atsTarget(appUrl)?.url, 'https://api.ashbyhq.com/posting-api/job-board/primeintellect');
  assert.equal(atsTarget(appUrl)?.id, 'c074bdd9-bee2-4ee9-ae03-aa8f7537682c');

  const dotUrl = 'https://jobs.ashbyhq.com/kraken.com/d62250a9-363c-43b0-b3de-958e3cc9f97b';
  assert.equal(atsTarget(dotUrl)?.url, 'https://api.ashbyhq.com/posting-api/job-board/kraken.com');
  assert.equal(atsTarget(dotUrl)?.id, 'd62250a9-363c-43b0-b3de-958e3cc9f97b');
});

test('supports Greenhouse EU and Workable ATS targets', () => {
  const ghEu = 'https://job-boards.eu.greenhouse.io/acme/jobs/42';
  assert.equal(atsTarget(ghEu)?.url, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/42');

  const workable = 'https://apply.workable.com/atria-health/j/F987324A8F';
  assert.equal(atsTarget(workable)?.url, 'https://apply.workable.com/api/v2/accounts/atria-health/jobs/F987324A8F');
  assert.equal(atsTarget(workable)?.id, 'F987324A8F');
});

test('titlesMatch tolerates location and parenthetical suffixes in listing titles', () => {
  assert.equal(titlesMatch('Principal Engineer, Core Product', 'Principal Engineer, Core Product (Bengaluru)'), true);
  assert.equal(titlesMatch('Software Engineer, Intern (Summer or Winter)', 'Software Engineer, Intern (Summer or Winter) - San Francisco / Seattle / New York'), true);
  assert.equal(titlesMatch('Software Engineer, Internship - Production Infrastructure', 'Software Engineer, Internship - Production Infrastructure (New York)'), true);
  assert.equal(titlesMatch('Staff Software Engineer', 'Product Designer'), false);
});

test('parses employer salaries across different currencies and periods', () => {
  const s1 = parseSalaryDetails('Zone 1 Pay Range: $182,000 — $250,208 USD');
  assert.equal(s1?.annualMin, 182000);
  assert.equal(s1?.annualMax, 250208);
  assert.equal(s1?.currency, 'USD');
  assert.equal(s1?.period, 'year');
  assert.equal(s1?.isEstimated, false);

  const s2 = parseSalaryDetails('The estimated salary range is $10,500/month.');
  assert.equal(s2?.annualMin, 126000);
  assert.equal(s2?.period, 'month');

  const s3 = parseSalaryDetails('Hourly compensation of $75 - $95 / hr');
  assert.equal(s3?.period, 'hour');
  assert.equal(s3?.min, 75);
  assert.equal(s3?.annualMin, 156000);

  const s4 = parseSalaryDetails('Compensation Range is: €125,500 to €150,000');
  assert.equal(s4?.currency, 'EUR');
  assert.equal(s4?.annualMin, 125500);

  const s5 = parseSalaryDetails('OTE is $170-220k');
  assert.equal(s5?.annualMin, 170000);
  assert.equal(s5?.annualMax, 220000);
});

test('estimates benchmark salary based on role seniority, domain, and location', () => {
  const usSenior = estimateBenchmarkSalary('Senior Software Engineer', 'United States');
  assert.equal(usSenior.currency, 'USD');
  assert.equal(usSenior.isEstimated, true);
  assert.ok(usSenior.annualMin >= 150000);

  const ukStaff = estimateBenchmarkSalary('Staff Site Reliability Engineer', 'United Kingdom');
  assert.equal(ukStaff.currency, 'GBP');
  assert.equal(ukStaff.isEstimated, true);

  const intern = estimateBenchmarkSalary('Software Engineer Intern', 'United States');
  assert.ok(intern.annualMax <= 100000);
});

test('extracts seniority level and employment type correctly', () => {
  assert.equal(extractExperienceLevel('Staff Software Engineer'), 'staff');
  assert.equal(extractExperienceLevel('Junior Frontend Developer'), 'entry');
  assert.equal(extractExperienceLevel('Software Engineering Intern'), 'intern');
  assert.equal(extractExperienceLevel('Senior Product Manager'), 'senior');
  assert.equal(extractExperienceLevel('Head of Engineering'), 'executive');

  assert.equal(extractEmploymentType('Software Engineering Intern'), 'internship');
  assert.equal(extractEmploymentType('Contract Backend Engineer'), 'contract');
  assert.equal(extractEmploymentType('Full Stack Engineer'), 'full-time');
});

test('extracts exact matching Ashby job with multiple locations, never assumes remote means worldwide', () => {
  const data = { jobs: [{ id: '123', title: 'Engineer', jobUrl: job.url, location: 'New York', workplaceType: 'Remote', address: { postalAddress: { addressLocality: 'New York', addressCountry: 'US' } }, secondaryLocations: [{ location: 'London', address: { postalAddress: { addressLocality: 'London', addressCountry: 'GB' } } }] }] };
  const result = extractLocation(job, data);
  assert.deepEqual(result.cities, ['New York', 'London']);
  assert.deepEqual(result.countries, ['US', 'GB']);
  assert.equal(result.workplace, 'remote');
  assert.equal(extractLocation({ ...job, role: 'Designer' }, data), null);
  assert.equal(extractLocation(job, { jobs: [] }), null);
});

test('Greenhouse uses location label without inventing a country or workplace', () => {
  const gh = { ...job, url: 'https://job-boards.greenhouse.io/acme/jobs/42' };
  const result = extractLocation(gh, { id: 42, title: 'Engineer', absolute_url: gh.url, location: { name: 'San Francisco; New York' } });
  assert.equal(result.label, 'San Francisco; New York');
  assert.deepEqual(result.countries, []);
  assert.equal(result.workplace, 'unknown');
  assert.equal(extractLocation(gh, { id:42, title:'Engineer', absolute_url:gh.url, location:{name:'Remote - US'} }).workplace, 'remote');
});

test('joins evidence only to unchanged jobs and expires stale evidence', () => {
  const record = { ...job, label: 'London', cities: ['London'], countries: ['GB'], workplace: 'hybrid', checkedAt: '2026-09-07T00:00:00.000Z' };
  const index = { records: [record] };
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  assert.equal(attachLocations([job], index, now)[0].location.label, 'London');
  assert.deepEqual(attachLocations([job], index, now)[0].location.countries, ['United Kingdom']);
  assert.equal(attachLocations([{...job, role:'Designer'}], index, now)[0].location, null);
  assert.equal(attachLocations([job], index, now + 40 * 86400000)[0].location, null);
});

test('rejects a different destination and ignores malformed location text', () => {
  assert.equal(extractLocation(job, { jobs: [{ id:'123', title:'Engineer', jobUrl:'https://evil.example/123', location:'London' }] }), null);
  assert.equal(extractLocation(job, { jobs: [{ id:'123', title:'Engineer', jobUrl:job.url, location:'<script>oops</script>' }] }), null);
});

test('searchJobs filters by salary, employment type, and experience level', () => {
  const jobsList = [
    {
      jobId: '1', role: 'Staff Software Engineer', company: 'Acme', url: 'https://jobs.ashbyhq.com/acme/1', applicationChannel: 'ashby', firstSeenAt: '2026-09-08T00:00:00Z',
      location: { label: 'San Francisco', cities: ['San Francisco'], countries: ['United States'], workplace: 'onsite', salary: { annualMin: 220000, annualMax: 290000 }, employmentType: 'full-time', experienceLevel: 'staff' }
    },
    {
      jobId: '2', role: 'Software Engineer Intern', company: 'Beta', url: 'https://jobs.lever.co/beta/2', applicationChannel: 'lever', firstSeenAt: '2026-09-07T00:00:00Z',
      location: { label: 'Remote', cities: [], countries: ['United States'], workplace: 'remote', salary: { annualMin: 60000, annualMax: 80000 }, employmentType: 'internship', experienceLevel: 'intern' }
    }
  ];

  assert.equal(searchJobs(jobsList, { salaryMin: 200000 }).length, 1);
  assert.equal(searchJobs(jobsList, { salaryMin: 200000 })[0].jobId, '1');

  assert.equal(searchJobs(jobsList, { employmentType: 'internship' }).length, 1);
  assert.equal(searchJobs(jobsList, { employmentType: 'internship' })[0].jobId, '2');

  assert.equal(searchJobs(jobsList, { experienceLevel: 'staff' }).length, 1);
  assert.equal(searchJobs(jobsList, { experienceLevel: 'staff' })[0].jobId, '1');

  const sortedHigh = searchJobs(jobsList, { sort: 'salary-high' });
  assert.equal(sortedHigh[0].jobId, '1');
  const sortedLow = searchJobs(jobsList, { sort: 'salary-low' });
  assert.equal(sortedLow[0].jobId, '2');
});

