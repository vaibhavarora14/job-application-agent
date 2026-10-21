import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRoleFamily,
  communityJobsLiveUpstreamUrl,
  filterBoardJobs,
  isListedOpenJob,
  jobIdFromSlug,
  jobPostingJsonLd,
  jobSlug,
  liveJobWireRecord,
  similarOpenRoles,
  validateLiveJobs,
  validateLiveJobsBoard,
  TRUST_LINE,
} from '../lib/live-jobs.mjs';
import { fixtureLiveJobs } from '../lib/jobs-board-data.mjs';

const now = Date.parse('2026-10-13T12:00:00.000Z');

test('jobSlug is stable from company, role, and job id', () => {
  const job = {
    jobId: 'community-job-aaaaaaaaaaaaaaaa',
    company: 'Example Labs',
    role: 'Senior Backend Engineer',
  };
  assert.equal(jobSlug(job), 'example-labs-senior-backend-engineer-aaaaaaaaaaaaaaaa');
  assert.equal(jobIdFromSlug(jobSlug(job)), job.jobId);
});

test('validateLiveJobs accepts liveness fields and rejects unknown keys', () => {
  const jobs = fixtureLiveJobs(now).map((job) => {
    const rest = { ...job };
    delete rest.location;
    delete rest.slug;
    return rest;
  });
  const ok = validateLiveJobs({ version: 1, jobs, nextCursor: null });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.jobs[0].livenessStatus, 'open');

  const bad = validateLiveJobs({
    version: 1,
    jobs: [{ ...jobs[0], contributorHash: 'nope' }],
    nextCursor: null,
  });
  assert.equal(bad.ok, false);
});

test('validateLiveJobsBoard round-trips a cached multi-page board', () => {
  const base = fixtureLiveJobs(now).map((job) => {
    const rest = { ...job };
    delete rest.location;
    delete rest.slug;
    return rest;
  });
  // 250 jobs: more than one upstream page, which validateLiveJobs alone rejects.
  const jobs = Array.from({ length: 250 }, (_, i) => ({
    ...base[i % base.length],
    jobId: `community-job-${i.toString(16).padStart(16, '0')}`,
  }));
  const pageValidated = [];
  for (let start = 0; start < jobs.length; start += 100) {
    const page = validateLiveJobs({ version: 1, jobs: jobs.slice(start, start + 100), nextCursor: null });
    assert.equal(page.ok, true);
    pageValidated.push(...page.data.jobs);
  }
  // What fetch-live-jobs writes to the Cache API after paginating.
  const cached = JSON.parse(JSON.stringify({
    version: 1,
    jobs: pageValidated.map(liveJobWireRecord),
    nextCursor: null,
    meta: { newestLastCheckedAt: null },
  }));
  assert.equal(validateLiveJobs(cached).ok, false);
  const board = validateLiveJobsBoard(cached);
  assert.equal(board.ok, true);
  assert.deepEqual(board.data.jobs, pageValidated);
  assert.deepEqual(board.data.meta, { newestLastCheckedAt: null });

  assert.equal(validateLiveJobsBoard({ version: 1, jobs: [], nextCursor: null }).ok, true);
  // Old cache entries stored derived slugs; they must fail so the loader refetches.
  assert.equal(validateLiveJobsBoard({ ...cached, jobs: pageValidated }).ok, false);
  assert.equal(validateLiveJobsBoard({ ...cached, jobs: [...cached.jobs.slice(0, 120), { ...cached.jobs[0], extra: 1 }] }).ok, false);
  assert.equal(validateLiveJobsBoard({ ...cached, version: 2 }).ok, false);
  assert.equal(validateLiveJobsBoard(null).ok, false);
});

test('board listing hides stale and non-open roles', () => {
  const jobs = fixtureLiveJobs(now);
  const open = jobs.filter((job) => isListedOpenJob(job, now));
  assert.ok(open.every((job) => job.livenessStatus === 'open'));
  assert.ok(open.length >= 3);

  const stale = { ...open[0], lastCheckedAt: '2026-10-01T00:00:00.000Z' };
  assert.equal(isListedOpenJob(stale, now), false);

  const filtered = filterBoardJobs(open, { role: 'Engineering', postedDays: 14, now });
  assert.ok(filtered.every((job) => classifyRoleFamily(job.role) === 'Engineering'));
});

test('postedDays filter on firstSeenAt can empty the board; any-time keeps verified-open roles', () => {
  const nowMs = Date.parse('2026-10-14T12:00:00.000Z');
  const open = [
    {
      jobId: 'community-job-aaaaaaaaaaaaaaaa',
      role: 'Staff Engineer',
      company: 'Acme',
      livenessStatus: 'open',
      lastCheckedAt: '2026-10-14T12:00:00.000Z',
      firstSeenAt: '2026-08-27T00:00:00.000Z',
      lastSeenAt: '2026-10-13T00:00:00.000Z',
    },
    {
      jobId: 'community-job-bbbbbbbbbbbbbbbb',
      role: 'Product Engineer',
      company: 'Beta',
      livenessStatus: 'open',
      lastCheckedAt: '2026-10-14T12:00:00.000Z',
      firstSeenAt: '2026-10-10T00:00:00.000Z',
      lastSeenAt: '2026-10-14T00:00:00.000Z',
    },
  ];
  assert.equal(filterBoardJobs(open, { postedDays: 14, now: nowMs }).length, 1);
  assert.equal(filterBoardJobs(open, { postedDays: 0, now: nowMs }).length, 2);
});

test('communityJobsLiveUpstreamUrl forwards status=open and rejects bad status', () => {
  const upstream = 'https://relay.example.com/v1/jobs/live';
  const url = communityJobsLiveUpstreamUrl(upstream, new URL('https://jobappagent.com/api/community-jobs-live?limit=50&status=open'));
  assert.match(url, /status=open/);
  assert.match(url, /limit=50/);
  assert.throws(
    () => communityJobsLiveUpstreamUrl(upstream, new URL('https://jobappagent.com/api/community-jobs-live?status=nope')),
    /invalid query/,
  );
});

test('closed job JSON-LD sets validThrough and similar roles exclude self', () => {
  const jobs = fixtureLiveJobs(now);
  const closed = jobs.find((job) => job.livenessStatus === 'closed');
  const open = jobs.filter((job) => isListedOpenJob(job, now));
  assert.ok(closed);
  const jsonLd = jobPostingJsonLd(closed);
  assert.equal(jsonLd['@type'], 'JobPosting');
  assert.equal(jsonLd.validThrough, closed.closedAt.slice(0, 10));
  assert.match(jsonLd.description, new RegExp(TRUST_LINE));
  assert.match(jsonLd.description, new RegExp(closed.company));
  assert.equal('jobLocationType' in jsonLd && jsonLd.jobLocationType === undefined, false);

  const similar = similarOpenRoles(closed, open, 3);
  assert.ok(similar.every((job) => job.jobId !== closed.jobId));
  assert.ok(similar.length <= 3);
});

test('open remote JobPosting JSON-LD has validThrough, TELECOMMUTE, and country requirements', () => {
  const jobs = fixtureLiveJobs(now);
  const remote = jobs.find((job) => job.livenessStatus === 'open' && job.location?.workplace === 'remote');
  assert.ok(remote);
  const jsonLd = jobPostingJsonLd(remote);
  assert.equal(jsonLd.jobLocationType, 'TELECOMMUTE');
  assert.ok(jsonLd.applicantLocationRequirements);
  assert.ok(jsonLd.validThrough);
  assert.match(jsonLd.description, new RegExp(remote.role));
  assert.match(jsonLd.description, new RegExp(remote.company));
  if (remote.location?.countries?.[0]) {
    assert.equal(jsonLd.jobLocation?.address?.addressCountry, remote.location.countries[0].toUpperCase());
  }
});

test('validateLiveJobs accepts optional meta.newestLastCheckedAt', () => {
  const jobs = fixtureLiveJobs(now).map((job) => {
    const rest = { ...job };
    delete rest.location;
    delete rest.slug;
    return rest;
  });
  const ok = validateLiveJobs({
    version: 1,
    jobs,
    nextCursor: null,
    meta: { newestLastCheckedAt: '2026-10-13T12:00:00.000Z' },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.meta.newestLastCheckedAt, '2026-10-13T12:00:00.000Z');
});

test('trust wording stays endorsement-safe', () => {
  assert.equal(TRUST_LINE, 'Reviewed and live, checked daily');
  assert.doesNotMatch(TRUST_LINE, /verified/i);
});
