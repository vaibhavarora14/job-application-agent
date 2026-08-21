import assert from 'node:assert/strict';
import test from 'node:test';

import { communitySourceId, isRepeatableCommunitySourceRoute, normalizeCommunitySource } from '../scripts/source-community-schema.mjs';

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

test('rejects identity-like path namespaces even when they contain a collection cue', () => {
  for (const baseUrl of ['https://example.com/users/jane/openings', 'https://example.com/profile/jane/careers', 'https://x.com/jane/jobs']) {
    assert.throws(() => normalizeCommunitySource({ ...source, baseUrl }), /profile or personal|identity-like/i, baseUrl);
  }
});

test('rejects repeatedly encoded identity paths and identity-bearing taxonomy fields', () => {
  assert.throws(
    () => normalizeCommunitySource({ ...source, baseUrl: 'https://example.com/candidate%2540example.com/openings' }),
    /identity-like/i,
  );
  assert.throws(() => normalizeCommunitySource({ ...source, regions: ['candidate@example.com'] }), /identity-like/i);
  assert.throws(() => normalizeCommunitySource({ ...source, roleFamilies: ['+1 415 555 0100'] }), /identity-like/i);
});

test('normalizes trailing DNS root dots before rejecting private hosts', () => {
  for (const baseUrl of ['https://localhost./jobs', 'https://service.local./careers', 'https://service.internal./openings']) {
    assert.throws(() => normalizeCommunitySource({ ...source, baseUrl }), /public internet hostname/i, baseUrl);
  }
});

test('rejects identity-like public hostnames after normalizing a trailing DNS root dot', () => {
  for (const baseUrl of ['https://14155550100.example.org./jobs', 'https://candidate-14155550100.example.org/openings']) {
    assert.throws(() => normalizeCommunitySource({ ...source, baseUrl }), /identity-like/i, baseUrl);
  }
});

test('source IDs normalize scheme and hostname case while preserving path case', async () => {
  const upperHost = await communitySourceId({ ...source, baseUrl: 'HTTPS://EXAMPLE.COM/Jobs' });
  const lowerHost = await communitySourceId({ ...source, baseUrl: 'https://example.com/Jobs' });
  const lowerPath = await communitySourceId({ ...source, baseUrl: 'https://example.com/jobs' });
  assert.equal(upperHost, lowerHost);
  assert.notEqual(upperHost, lowerPath);
});
