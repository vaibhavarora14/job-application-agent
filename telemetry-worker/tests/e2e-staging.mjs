import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';

const endpoint = process.env.TELEMETRY_STAGING_URL?.replace(/\/$/, '');
if (!endpoint) throw new Error('TELEMETRY_STAGING_URL is required.');

const health = await fetch(`${endpoint}/healthz`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true, schemaVersion: 1 });

const install = await fetch(`${endpoint}/v1/install`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
assert.equal(install.status, 201);
const identity = await install.json();

const job = {
  company: 'Telemetry Fixture Company',
  title: 'Staff Product Engineer',
  jobHash: 'a'.repeat(64),
  domain: 'jobs.example.com',
  ats: 'greenhouse',
};

const fixtures = {
  installation_started: { osFamily: 'macos', nodeMajor: 24, submissionMode: 'routine-auto' },
  command_completed: { command: 'telemetry', result: 'success', durationBucket: 'under-1s' },
  job_discovered: { ...job, source: 'company', jobCountry: 'United States', workMode: 'remote', seniority: 'staff', employmentType: 'full-time', roleFamily: 'product-engineering', salaryCurrency: 'USD', salaryMin: 100000, salaryMax: 180000 },
  job_assessed: { ...job, fitScore: 85, eligibility: 'eligible', decision: 'review', matchTags: ['seniority', 'product'], gapTags: [] },
  application_started: { jobHash: job.jobHash, ats: job.ats, approvalMode: 'routine-auto', requiredFieldCount: 12, resumeRequired: true, coverLetterRequired: false, referralPresent: false },
  application_step: { jobHash: job.jobHash, ats: job.ats, stage: 'questions', fieldCategory: 'short-answer', retryCount: 0, durationBucket: '1-2m' },
  application_paused: { jobHash: job.jobHash, ats: job.ats, stage: 'submission', reason: 'captcha' },
  application_skipped: { jobHash: job.jobHash, reason: 'closed', fitScore: 85, eligibility: 'eligible' },
  application_submitted: { ...job, durationBucket: '5-15m', fieldsFilled: 12, shortAnswerCount: 2, resumeUploaded: true, approvalMode: 'routine-auto' },
  round_completed: { requestedCount: 30, submittedCount: 22, assessedCount: 36, skippedCount: 8, pausedCount: 4, errorCount: 1, durationBucket: '15m-plus' },
  outcome_recorded: { ...job, outcome: 'interview', daysSinceSubmission: 7, interviewQuality: 'promising', failurePoint: 'process' },
  review_generated: { submissionCount: 10, interviewCount: 2, rejectionCount: 3, offerCount: 0, withdrawalCount: 0, reviewDue: true },
  skill_error: { errorCode: 'site_changed', stage: 'application', ats: job.ats, jobHash: job.jobHash, recoverable: true },
};

for (const [event, properties] of Object.entries(fixtures)) {
  const response = await fetch(`${endpoint}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      skillVersion: '1.1.0-staging',
      installationId: identity.installationId,
      token: identity.token,
      event,
      properties,
    }),
  });
  assert.equal(response.status, 202, `${event} should be accepted by the live relay`);
}

const rejected = await fetch(`${endpoint}/v1/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    schemaVersion: 1,
    skillVersion: '1.1.0-staging',
    installationId: identity.installationId,
    token: identity.token,
    event: 'command_completed',
    properties: { command: 'telemetry', result: 'success', durationBucket: 'under-1s', email: 'must-be-rejected@example.com' },
  }),
});
assert.equal(rejected.status, 400);

const expectedSourceId = process.env.STAGING_EXPECT_SOURCE_ID;
if (expectedSourceId) {
  assert.match(expectedSourceId, /^community-[0-9a-f]{16}$/);
  const community = await fetch(`${endpoint}/v1/sources`);
  assert.equal(community.status, 200);
  const communityBody = await community.json();
  const source = communityBody.sources.find((entry) => entry.sourceId === expectedSourceId);
  if (process.env.STAGING_EXPECT_REJECTED === 'true') {
    assert.equal(source, undefined);
  } else {
    assert.ok(source);
    assert.equal(source.registryStatus, 'community-reviewed');
    assert.equal(JSON.stringify(source).includes('contributor'), false);
  }
} else {
  const stagingSource = {
    name: 'Staging Engineering Board',
    baseUrl: `https://staging-${Date.now()}.example.com/openings/engineering?private=removed#jobs`,
    kind: 'job-board',
    regions: ['global'],
    roleFamilies: ['engineering'],
    requiresSession: false,
  };
  const contributed = await fetch(`${endpoint}/v1/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, skillVersion: '3.1.1-staging', installationId: identity.installationId, token: identity.token, source: stagingSource }),
  });
  assert.equal(contributed.status, 202);
  const contributedBody = await contributed.json();
  assert.equal(contributedBody.publicationStatus, 'pending');
  assert.equal(contributedBody.uniqueContributors, 1);

  const secondInstall = await fetch(`${endpoint}/v1/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const secondIdentity = await secondInstall.json();
  const secondContribution = await fetch(`${endpoint}/v1/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1, skillVersion: '3.1.1-staging', installationId: secondIdentity.installationId, token: secondIdentity.token,
      source: { ...stagingSource, name: 'Untrusted staging rewrite', regions: ['private-region'], requiresSession: true },
    }),
  });
  const secondBody = await secondContribution.json();
  assert.equal(secondBody.publicationStatus, 'pending');
  assert.equal(secondBody.uniqueContributors, 2);

  const pendingCommunity = await (await fetch(`${endpoint}/v1/sources`)).json();
  const canonicalSourceUrl = stagingSource.baseUrl.split('?')[0];
  assert.equal(pendingCommunity.sources.some((source) => source.baseUrl === canonicalSourceUrl), false);
  assert.equal(JSON.stringify(pendingCommunity).includes('private=removed'), false);
  assert.equal(JSON.stringify(pendingCommunity).includes(identity.installationId), false);
  assert.equal(JSON.stringify(pendingCommunity).includes(secondIdentity.installationId), false);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `community_source_id=${contributedBody.sourceId}\n`);
}

process.stdout.write('Staging relay contract passed.\n');
