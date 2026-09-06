import test from 'node:test';
import assert from 'node:assert/strict';
import { atsTarget, extractLocation, attachLocations } from '../lib/job-locations.mjs';
const job = { jobId: 'community-job-0000000000000001', url: 'https://jobs.ashbyhq.com/acme/123', company: 'Acme', role: 'Engineer' };
test('only constructs requests to known ATS APIs from safe job URLs', () => {
  assert.equal(atsTarget(job.url).url, 'https://api.ashbyhq.com/posting-api/job-board/acme');
  for (const url of ['https://localhost/jobs', 'https://jobs.ashbyhq.com.evil.com/acme/123', 'https://jobs.ashbyhq.com/acme%2F..%2Fother/123', 'https://user:pass@jobs.ashbyhq.com/acme/123']) assert.equal(atsTarget(url), null);
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
});
test('joins evidence only to unchanged jobs and expires stale evidence', () => {
  const record = { ...job, label: 'London', cities: ['London'], countries: ['GB'], workplace: 'hybrid', checkedAt: '2026-09-07T00:00:00.000Z' };
  const index = { records: [record] };
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  assert.equal(attachLocations([job], index, now)[0].location.label, 'London');
  assert.equal(attachLocations([{...job, role:'Designer'}], index, now)[0].location, null);
  assert.equal(attachLocations([job], index, now + 40 * 86400000)[0].location, null);
});
