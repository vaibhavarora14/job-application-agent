import assert from 'node:assert/strict';
import test from 'node:test';
import { shortPostedLabel } from '../lib/jobs-board-query.mjs';
import { formatClosedDate, formatReviewedDate, validateLiveJobs } from '../lib/live-jobs.mjs';
import { countryLabel } from '../lib/job-locations.mjs';

// The board reuses Intl formatters instead of constructing one per row (CPU on
// Workers Free). Output must match a freshly constructed formatter exactly.
const dates = ['2026-01-01T00:00:00.000Z', '2026-10-28T23:59:59.999Z', '2025-12-18T10:00:00.000Z', '2024-02-29T12:00:00.000Z', '2026-07-04T05:30:00.000Z'];

test('shortPostedLabel matches a fresh formatter for this year and other years', () => {
  const now = Date.parse('2026-10-29T04:00:00.000Z');
  for (const iso of dates) {
    const date = new Date(iso);
    const sameYear = date.getUTCFullYear() === new Date(now).getUTCFullYear();
    const expected = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' }).format(date);
    assert.equal(shortPostedLabel(iso, now), expected, iso);
    assert.equal(shortPostedLabel(iso, now), expected, `${iso} (cached)`);
  }
  assert.equal(shortPostedLabel('not a date', now), '');
});

test('formatReviewedDate / formatClosedDate match fresh formatters per time zone, and fall back on a bad zone', () => {
  for (const timeZone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
    for (const iso of dates) {
      assert.equal(formatReviewedDate(iso, timeZone), new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(new Date(iso)));
      assert.equal(formatClosedDate(iso, timeZone), new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(new Date(iso)));
    }
  }
  assert.equal(formatReviewedDate('2026-10-28T10:00:00.000Z', 'Not/AZone'), '2026-10-28');
  assert.equal(formatClosedDate('2026-10-28T10:00:00.000Z', 'Not/AZone'), '2026-10-28');
  assert.equal(formatReviewedDate('nope'), '');
});

test('countryLabel matches Intl.DisplayNames and keeps its special cases', () => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (const code of ['US', 'gb', 'IN', 'DE', 'ZZ', 'EU', 'Sg']) {
    assert.equal(countryLabel(code), names.of(code.toUpperCase()) ?? code, code);
    assert.equal(countryLabel(code), names.of(code.toUpperCase()) ?? code, `${code} (cached)`);
  }
  assert.equal(countryLabel('USA'), 'United States');
  assert.equal(countryLabel('UK'), 'United Kingdom');
  assert.equal(countryLabel('Germany'), 'Germany');
});

test('remembered ISO timestamps still reject malformed values', () => {
  const job = {
    jobId: 'community-job-0000000000000001', url: 'https://jobs.example.com/1', company: 'Acme', role: 'Engineer',
    applicationChannel: 'greenhouse', providerUrl: 'https://jobs.example.com/1', firstSeenAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-01T00:00:00.000Z', contributionCount: 1, livenessStatus: 'open', lastCheckedAt: '2026-10-28T00:00:00.000Z', closedAt: null,
  };
  const page = (overrides) => ({ version: 1, jobs: [{ ...job, ...overrides }], nextCursor: null });
  assert.equal(validateLiveJobs(page({})).ok, true);
  assert.equal(validateLiveJobs(page({})).ok, true);
  for (const bad of ['2026-10-01', '2026-10-01T00:00:00Z', '2026-02-30T00:00:00.000Z', ' 2026-10-01T00:00:00.000Z', 42]) {
    assert.equal(validateLiveJobs(page({ firstSeenAt: bad })).ok, false, String(bad));
  }
});
