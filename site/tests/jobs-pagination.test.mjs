import test from 'node:test';
import assert from 'node:assert/strict';
import { jobPagination } from '../lib/jobs-pagination.mjs';

test('splits results into fixed pages with a partial final page', () => {
  const jobs = Array.from({ length: 61 }, (_, index) => index);
  const pages = [1, 2, 3].map(number => jobPagination(jobs.length, number));
  assert.deepEqual(pages.map(page => jobs.slice(page.start, page.end).length), [25, 25, 11]);
  assert.deepEqual(pages.flatMap(page => jobs.slice(page.start, page.end)), jobs);
});

test('clamps page after results shrink and handles empty or single-page results', () => {
  assert.deepEqual(jobPagination(0, 10), { page: 1, totalPages: 1, start: 0, end: 0, numbers: [1] });
  assert.equal(jobPagination(12, 10).page, 1);
  assert.equal(jobPagination(50, 10).page, 2);
  assert.equal(jobPagination(50, -1).page, 1);
  assert.deepEqual(jobPagination(25, 1).numbers, [1]);
});

test('keeps first, last and nearby page numbers with compact gaps', () => {
  assert.deepEqual(jobPagination(955, 1).numbers, [1, 2, 3, 'gap-4', 39]);
  assert.deepEqual(jobPagination(955, 20).numbers, [1, 'gap-2', 19, 20, 21, 'gap-22', 39]);
  assert.deepEqual(jobPagination(955, 39).numbers, [1, 'gap-2', 37, 38, 39]);
  assert.deepEqual(jobPagination(100, 2).numbers, [1, 2, 3, 4]);
});
