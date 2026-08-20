import assert from 'node:assert/strict';
import test from 'node:test';

import { isRepeatableCommunitySourceRoute, normalizeCommunitySource } from '../scripts/source-community-schema.mjs';

const source = {
  name: 'Example Jobs',
  baseUrl: 'https://example.com/',
  kind: 'job-board',
  regions: ['global'],
  roleFamilies: ['engineering'],
  requiresSession: false,
};

test('rejects known ATS and network job-detail routes', () => {
  const detailUrls = [
    'https://example.wd5.myworkdayjobs.com/en-US/jobs/job/Bengaluru/Senior-Engineer_R-12345',
    'https://www.linkedin.com/jobs/view/1234567890',
    'https://job-boards.greenhouse.io/example/jobs/1234567',
    'https://jobs.lever.co/example/12345678-1234-4123-8123-123456789abc',
    'https://jobs.ashbyhq.com/example/12345678-1234-4123-8123-123456789abc',
    'https://apply.workable.com/example/j/ABC123DEF4/',
    'https://jobs.smartrecruiters.com/Example/123456789-senior-engineer',
  ];

  for (const baseUrl of detailUrls) {
    assert.equal(isRepeatableCommunitySourceRoute(new URL(baseUrl)), false, baseUrl);
    assert.throws(
      () => normalizeCommunitySource({ ...source, baseUrl }),
      /repeatable discovery surface|identity-like content/i,
      baseUrl,
    );
  }
});

test('accepts roots and recognizable collection, directory, feed, careers, openings, and job-index routes', () => {
  const collectionUrls = [
    'https://example.com/',
    'https://example.com/careers',
    'https://example.com/openings/engineering',
    'https://example.com/jobs/search',
    'https://example.com/job-index',
    'https://example.com/community/directory',
    'https://example.com/hiring/feed.xml',
    'https://example.wd5.myworkdayjobs.com/en-US/jobs',
    'https://www.linkedin.com/jobs/search',
    'https://job-boards.greenhouse.io/example',
    'https://jobs.lever.co/example',
    'https://jobs.ashbyhq.com/example',
    'https://apply.workable.com/example',
    'https://jobs.smartrecruiters.com/Example',
  ];

  for (const baseUrl of collectionUrls) {
    assert.equal(isRepeatableCommunitySourceRoute(new URL(baseUrl)), true, baseUrl);
    assert.equal(normalizeCommunitySource({ ...source, baseUrl }).baseUrl, baseUrl.replace(/\/$/, ''), baseUrl);
  }
});

test('fails closed for unknown non-collection paths and strips collection queries and fragments', () => {
  for (const baseUrl of ['https://example.com/software-engineer', 'https://example.com/jobs/senior-software-engineer']) {
    assert.equal(isRepeatableCommunitySourceRoute(new URL(baseUrl)), false, baseUrl);
    assert.throws(() => normalizeCommunitySource({ ...source, baseUrl }), /repeatable discovery surface/i);
  }

  const normalized = normalizeCommunitySource({
    ...source,
    baseUrl: 'https://example.com/openings/engineering?email=candidate@example.com&token=secret#jobs',
  });
  assert.equal(normalized.baseUrl, 'https://example.com/openings/engineering');
  assert.equal(JSON.stringify(normalized).includes('candidate@example.com'), false);
});
