import assert from "node:assert/strict";
import test from "node:test";

import { communityJobsUpstreamUrl, validateCommunityJobs } from "../lib/community-jobs.mjs";

const valid = {
  version: 1,
  jobs: [{
    jobId: "community-job-abcdef1234567890",
    url: "https://jobs.ashbyhq.com/example/12345678-1234-4123-8123-123456789abc",
    company: "Example",
    role: "Senior Product Engineer",
    applicationChannel: "ashby",
    discoverySource: "job-board",
    providerUrl: "https://jobs.ashbyhq.com/example",
    firstSeenAt: "2026-08-24T00:00:00.000Z",
    lastSeenAt: "2026-08-24T00:00:00.000Z",
    contributionCount: 2,
  }],
  nextCursor: "next-page",
};

test("accepts the bounded public job contract without identity or moderation fields", () => {
  assert.deepEqual(validateCommunityJobs(valid), { ok: true, data: valid });
  assert.equal(validateCommunityJobs({ ...valid, installationId: "private" }).ok, false);
  assert.equal(validateCommunityJobs({ ...valid, jobs: [{ ...valid.jobs[0], publicationStatus: "published" }] }).ok, false);
  assert.equal(validateCommunityJobs({ ...valid, jobs: [{ ...valid.jobs[0], url: "javascript:alert(1)" }] }).ok, false);
});

test("constructs a bounded upstream URL with only pagination fields", () => {
  assert.equal(
    communityJobsUpstreamUrl("https://relay.example.com/v1/jobs", new URL("https://stats.example.com/api/community-jobs?limit=25&cursor=next%20page")),
    "https://relay.example.com/v1/jobs?limit=25&cursor=next+page",
  );
  assert.throws(
    () => communityJobsUpstreamUrl("https://relay.example.com/v1/jobs", new URL("https://stats.example.com/api/community-jobs?limit=101")),
    /invalid query/i,
  );
});
