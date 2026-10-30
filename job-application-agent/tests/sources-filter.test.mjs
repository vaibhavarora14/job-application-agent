// #221: sources list names its real filters and says it has no text query.
import assert from 'node:assert/strict';
import test from 'node:test';

import { sourcesList } from '../scripts/job-application.mjs';

test('an unknown source filter lists the allowed keys; a job-search key explains there is no text query', async () => {
  await assert.rejects(sourcesList({ query: 'backend engineer' }), (error) => {
    assert.match(error.message, /^Unknown source filter: query\. Allowed filters: regions, roleFamilies, kinds \(string arrays\) and requiresSession \(Boolean\)/);
    assert.match(error.message, /it has no text query/);
    return true;
  });
  await assert.rejects(sourcesList({ region: ['india'] }), (error) => /Unknown source filter: region\. Allowed filters/.test(error.message) && !/text query/.test(error.message));
  const remote = await sourcesList({ regions: ['remote'] });
  assert.ok(remote.count > 0);
});
