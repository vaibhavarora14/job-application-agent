import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCommunitySource } from '../../job-application-agent/scripts/source-community-schema.mjs';
import { stagingSourceBaseUrl } from './staging-source-fixture.mjs';

test('staging source fixture stays unique without resembling candidate identity', () => {
  const first = stagingSourceBaseUrl(1_787_379_200_000);
  const second = stagingSourceBaseUrl(1_787_379_200_001);
  assert.notEqual(first, second);
  assert.equal(/\d/.test(new URL(first).hostname), false);

  const normalized = normalizeCommunitySource({
    name: 'Staging Engineering Board',
    baseUrl: first,
    kind: 'job-board',
    regions: ['global'],
    roleFamilies: ['engineering'],
    requiresSession: false,
  });
  assert.equal(normalized.baseUrl, first.split('?')[0]);
});
