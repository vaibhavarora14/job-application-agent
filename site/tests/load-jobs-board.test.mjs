import assert from 'node:assert/strict';
import test from 'node:test';
import { findJobBySlug, loadJobsBoard } from '../lib/load-jobs-board.mjs';
import { fixtureLiveJobs } from '../lib/jobs-board-data.mjs';

const now = Date.parse('2026-10-13T12:00:00.000Z');

function linearFind(allJobs, slug) {
  const exact = allJobs.find((job) => job.slug === slug);
  if (exact) return exact;
  const match = String(slug ?? '').match(/-([0-9a-f]{16})$/i);
  if (!match) return null;
  return allJobs.find((job) => job.jobId === `community-job-${match[1].toLowerCase()}`) ?? null;
}

test('findJobBySlug indexed lookup matches the linear scan', async () => {
  const board = await loadJobsBoard({ useFixtures: true, now });
  assert.ok(board.all.length >= 3);
  const probes = [
    ...board.all.map((job) => job.slug),
    // Renamed company/role, same id suffix → jobId fallback.
    ...board.all.map((job) => `renamed-role-${job.jobId.replace(/^community-job-/, '')}`),
    'no-such-role',
    'no-such-role-ffffffffffffffff',
    '',
  ];
  for (const slug of probes) assert.equal(findJobBySlug(board.all, slug), linearFind(board.all, slug), slug);
});

test('findJobBySlug keeps first-match semantics for duplicate slugs', () => {
  const a = { slug: 'dup-aaaaaaaaaaaaaaaa', jobId: 'community-job-aaaaaaaaaaaaaaaa', n: 1 };
  const b = { slug: 'dup-aaaaaaaaaaaaaaaa', jobId: 'community-job-aaaaaaaaaaaaaaaa', n: 2 };
  assert.equal(findJobBySlug([a, b], 'dup-aaaaaaaaaaaaaaaa'), a);
  assert.equal(findJobBySlug([a, b], 'other-aaaaaaaaaaaaaaaa'), a);
});

test('loadJobsBoard with an injected loader is not memoised across calls', async () => {
  const jobs = fixtureLiveJobs(now);
  const first = await loadJobsBoard({ loadLive: async () => jobs, now });
  const second = await loadJobsBoard({ loadLive: async () => jobs, now });
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
  assert.ok(first.open.length >= 3);
});
