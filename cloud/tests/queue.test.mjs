import assert from 'node:assert/strict';
import test from 'node:test';

import { claimNext, enqueue, finish, queuedCounts } from '../src/queue.mjs';
import { isolatedEnv } from './helpers.mjs';

test('queue claims one job and marks it done or failed', async (t) => {
  const env = await isolatedEnv(t);
  const first = enqueue('discover', { n: 1 }, env);
  enqueue('assess', { jobId: 'x' }, env);
  const claimed = claimNext(['discover', 'assess'], env);
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.type, 'discover');
  finish(claimed.id, null, env);
  const next = claimNext(['discover', 'assess'], env);
  assert.equal(next.type, 'assess');
  finish(next.id, 'boom', env);
  const counts = queuedCounts(env);
  assert.ok(counts.some((row) => row.status === 'done' && row.n === 1));
  assert.ok(counts.some((row) => row.status === 'failed' && row.n === 1));
});
