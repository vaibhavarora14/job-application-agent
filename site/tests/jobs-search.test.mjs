import test from 'node:test';
import assert from 'node:assert/strict';
import { searchJobs, loadPublishedJobs } from '../lib/jobs-search.mjs';

const job = (id, company = 'Acme', role = 'Software Engineer') => ({ jobId: `community-job-${String(id).padStart(16, '0')}`, company, role, url: 'https://example.com/jobs/1', providerUrl: 'https://example.com/jobs', applicationChannel: 'company', firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-01T00:00:00.000Z', contributionCount: 1 });
test('search combines case-insensitive terms and exact filters without mutating input', () => {
  const jobs = [job(1), job(2, 'Beta', 'Designer'), job(3, 'Acme', 'Senior Engineer')];
  assert.deepEqual(searchJobs(jobs, { query: ' ACME engineer ', company: 'Acme', channel: 'company', sort: 'company' }).map(j => j.jobId), [job(3).jobId, job(1).jobId]);
  assert.equal(searchJobs(jobs, { query: 'example.com', channel: 'ashby' }).length, 0);
  assert.equal(jobs[0].jobId, job(1).jobId);
});
test('loads every page and deduplicates records, including within a page', async () => {
  const calls = [];
  const result = await loadPublishedJobs(async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ version: 1, jobs: calls.length === 1 ? [job(1), job(1)] : [job(1), job(2)], nextCursor: calls.length === 1 ? 'next' : null }) };
  });
  assert.equal(result.length, 2);
  assert.match(calls[0], /limit=100/);
  assert.match(calls[1], /cursor=next/);
});
test('fails rather than silently returning incomplete results', async () => {
  await assert.rejects(loadPublishedJobs(async () => ({ ok: false })));
  await assert.rejects(loadPublishedJobs(async () => ({ ok: true, json: async () => ({ version: 1, jobs: [job(1)], nextCursor: 'loop' }) })));
  await assert.rejects(loadPublishedJobs(async () => ({ ok: true, json: async () => ({ jobs: [] }) })));
});
