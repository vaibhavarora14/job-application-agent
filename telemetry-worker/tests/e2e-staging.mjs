import assert from 'node:assert/strict';

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

const contributed = await fetch(`${endpoint}/v1/sources`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    schemaVersion: 1,
    skillVersion: '3.1.1-staging',
    installationId: identity.installationId,
    token: identity.token,
    source: {
      name: 'Staging Engineering Board',
      baseUrl: 'https://jobs-staging.example.com/engineering?private=removed#jobs',
      kind: 'job-board',
      regions: ['global'],
      roleFamilies: ['engineering'],
      requiresSession: false,
    },
  }),
});
assert.equal(contributed.status, 202);
const community = await fetch(`${endpoint}/v1/sources`);
assert.equal(community.status, 200);
const communityBody = await community.json();
assert.ok(communityBody.sources.some((source) => source.baseUrl === 'https://jobs-staging.example.com/engineering'));
assert.equal(JSON.stringify(communityBody).includes('private=removed'), false);

process.stdout.write('Staging relay contract passed.\n');
