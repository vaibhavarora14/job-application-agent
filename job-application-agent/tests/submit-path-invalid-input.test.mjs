import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateDelivery, validateLead } from '../scripts/application-accounting.mjs';
import {
  coerceScore,
  inferAtsSourceFromUrl,
  normalizeAttentionInput,
  normalizeOutcomeStatus,
  normalizeRoundCompleteInput,
  normalizeSourceCoverage,
  scoreJob,
  skillErrorProperties,
  validateLedgerEntry,
} from '../scripts/job-application.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

const target = {
  name: 'Test Candidate',
  email: 'candidate@example.com',
  phone: '+1 555 0100',
  location: 'Toronto, Canada',
  workAuthorization: 'Canada',
  roleFamilies: ['product-engineering', 'full-stack', 'ai-ml'],
  seniority: ['senior', 'staff'],
  skills: ['TypeScript', 'Python', 'React'],
  targetLocations: ['Canada', 'Remote'],
  excludedLocations: ['United States only'],
  workModes: ['remote'],
  industries: ['AI'],
  excludedCompanies: ['Blocked Corp'],
  submissionMode: 'review-each',
  yearsExperience: 10,
  autoSubmitMinScore: 80,
  manualReviewMinScore: 70,
  minMustHaveCoverage: 70,
};

const matchingJob = {
  title: 'Senior Product Engineer',
  company: 'Example AI',
  description: 'Build AI products with TypeScript, React and Python.',
  source: 'greenhouse',
  eligibility: 'eligible',
  postingStatus: 'active',
  roleFamily: 'product-engineering',
  seniority: 'senior',
  workMode: 'remote',
  remote: true,
  locations: ['Remote', 'Canada'],
  url: 'https://job-boards.greenhouse.io/example/jobs/123',
  mustHaves: [
    { requirement: 'TypeScript', status: 'met', evidence: 'Resume skills and shipped products' },
    { requirement: 'React', status: 'met', evidence: 'Multiple production roles' },
    { requirement: 'Python', status: 'partial', evidence: 'Snorkel and Juvoxa' },
  ],
};

const ledgerBase = {
  id: 'example-senior-product-engineer-2026-01-15',
  company: 'Example',
  role: 'Senior Product Engineer',
  url: 'https://job-boards.greenhouse.io/example/jobs/123',
  source: 'greenhouse',
  score: 84,
  status: 'submitted',
  submittedAt: '2026-01-15T10:00:00.000Z',
  approval: 'APPROVE SUBMIT',
  answers: {},
};

function isolatedEnv(directory) {
  return {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'absent-cloud.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
}

async function cliFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'submit-path-invalid-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ enabled: false, disclosed: true }));
  const env = isolatedEnv(directory);
  const run = (args, input) => spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: 'utf8',
    input: input === undefined ? '' : JSON.stringify(input),
  });
  return { directory, run };
}

test('ledger add accepts title/jobUrl, rounds score, and defaults omitted submittedAt', () => {
  const now = Date.now();
  const recorded = validateLedgerEntry({
    ...ledgerBase,
    role: undefined,
    url: undefined,
    title: 'Senior Product Engineer',
    jobUrl: 'https://job-boards.greenhouse.io/example/jobs/123',
    score: '84',
    submittedAt: undefined,
  });
  assert.equal(recorded.role, 'Senior Product Engineer');
  assert.equal(recorded.url, 'https://job-boards.greenhouse.io/example/jobs/123');
  assert.equal(recorded.score, 84);
  assert.ok(Number.isFinite(Date.parse(recorded.submittedAt)));
  assert.ok(Math.abs(Date.parse(recorded.submittedAt) - now) < 60_000);

  assert.equal(validateLedgerEntry({ ...ledgerBase, score: 84.4 }).score, 84);
  const submittedAt = '2026-01-15T10:00:00.000Z';
  assert.equal(validateLedgerEntry({ ...ledgerBase, submittedAt: Date.parse(submittedAt) }).submittedAt, submittedAt);
  assert.equal(validateLedgerEntry({ ...ledgerBase, submittedAt: Date.parse(submittedAt) / 1000 }).submittedAt, submittedAt);
  assert.throws(() => validateLedgerEntry({ ...ledgerBase, score: 0.84 }), /entry\.score must be an integer from 0 to 100.*0–1 fraction/);
  assert.equal(coerceScore('86', 'entry.score'), 86);
});

test('ledger add infers omitted source from the job URL and still names ATS mix-ups', () => {
  const inferred = validateLedgerEntry({ ...ledgerBase, source: undefined });
  assert.equal(inferred.source, 'greenhouse');
  assert.equal(validateLedgerEntry({
    ...ledgerBase,
    source: 'https://jobs.ashbyhq.com/example/123',
    url: 'https://jobs.ashbyhq.com/example/123',
  }).source, 'ashby');
  assert.throws(
    () => validateLedgerEntry({ ...ledgerBase, source: 'job-board' }),
    /entry\.source "job-board" is a discoverySource; source is the ATS/,
  );
  assert.equal(inferAtsSourceFromUrl('https://jobs.lever.co/example/abc'), 'lever');
});

test('score infers omitted source and maps eligibility aliases', () => {
  const omitted = scoreJob({ ...matchingJob, source: undefined }, target);
  assert.equal(typeof omitted.decision, 'string');
  assert.equal(matchingJob.source, 'greenhouse');

  const yes = scoreJob({ ...matchingJob, eligibility: 'yes' }, target);
  assert.equal(yes.decision, omitted.decision);
  assert.equal(scoreJob({ ...matchingJob, eligibility: 'unknown' }, target).decision, 'ask');
  assert.equal(scoreJob({ ...matchingJob, eligibility: 'no' }, target).decision, 'exclude');

  assert.throws(
    () => scoreJob({ ...matchingJob, source: undefined, url: undefined, applicationChannel: undefined }, target),
    (error) => {
      assert.match(error.message, /^job\.source is invalid\. Allowed: /);
      assert.match(error.message, /\bgreenhouse\b/);
      assert.equal(skillErrorProperties(error, 'assess').fieldLabel, 'job.source');
      return true;
    },
  );
});

test('outcome status aliases and rejections name outcome.status plus allowed values', () => {
  assert.equal(normalizeOutcomeStatus('withdrawn'), 'withdrawn');
  assert.equal(normalizeOutcomeStatus('hired'), 'offer');
  assert.equal(normalizeOutcomeStatus('ghosted'), 'closed');
  assert.throws(
    () => normalizeOutcomeStatus('pending'),
    (error) => {
      assert.match(error.message, /^outcome\.status is invalid\. Allowed: /);
      assert.match(error.message, /\bwithdrawn\b/);
      assert.match(error.message, /\boffer\b/);
      assert.doesNotMatch(error.message, /pending/);
      return true;
    },
  );
});

test('ledger outcome --stdin accepts a job URL as id and url/jobUrl aliases', async (t) => {
  const { directory, run } = await cliFixture(t);
  await writeFile(join(directory, 'applications.ndjson'), `${JSON.stringify({
    id: 'web-1',
    company: 'Acme',
    role: 'Engineer',
    url: 'https://jobs.example.com/web',
    source: 'company',
    score: 90,
    status: 'submitted',
    submittedAt: '2026-03-01T00:00:00.000Z',
    approval: 'APPROVE SUBMIT',
    answers: {},
  })}\n`);

  const byIdUrl = run(['ledger', 'outcome', '--stdin'], {
    id: 'https://jobs.example.com/web',
    status: 'rejected',
    occurredAt: '2026-04-02T00:00:00.000Z',
  });
  assert.equal(byIdUrl.status, 0, byIdUrl.stderr);
  assert.equal(JSON.parse(byIdUrl.stdout).recordedOutcome, 'web-1');

  const byJobUrl = run(['ledger', 'outcome', '--stdin'], {
    jobUrl: 'https://jobs.example.com/web',
    status: 'hired',
    occurredAt: '2026-04-03T00:00:00.000Z',
  });
  assert.equal(byJobUrl.status, 0, byJobUrl.stderr);
  assert.equal(JSON.parse(byJobUrl.stdout).status, 'offer');

  const ghosted = run(['ledger', 'outcome', 'web-1', '--status', 'no-response']);
  assert.equal(ghosted.status, 0, ghosted.stderr);
  assert.equal(JSON.parse(ghosted.stdout).status, 'closed');
});

test('ledger check does not fail when a stored row has a missing URL', async (t) => {
  const { directory, run } = await cliFixture(t);
  await writeFile(join(directory, 'applications.ndjson'), `${JSON.stringify({
    id: 'broken-1',
    company: 'Broken Co',
    role: 'Engineer',
    url: '',
    source: 'company',
    score: 80,
    status: 'submitted',
    submittedAt: '2026-03-01T00:00:00.000Z',
    approval: 'APPROVE SUBMIT',
    answers: {},
  })}\n`);
  const checked = run(['ledger', 'check', '--stdin'], { url: 'https://jobs.example.com/fresh' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).duplicate, false);
});

test('attention add maps canonicalUrl and confirm-location', () => {
  const pause = normalizeAttentionInput({
    roundId: 'round-2026-01-15-00000000-0000-4000-8000-000000000000',
    applicationId: 'example-role',
    canonicalUrl: 'https://jobs.example.com/role',
    stage: 'submission',
    blocker: 'unverifiable-claim',
    requiredActions: ['confirm-location'],
  });
  assert.equal(pause.url, 'https://jobs.example.com/role');
  assert.deepEqual(pause.requiredActions, ['verify-claim']);
});

test('round source maps leadsReviewed and coverage status aliases', () => {
  const searched = normalizeSourceCoverage({
    roundId: 'round-1',
    sourceId: 'indeed',
    status: 'complete',
    leadsReviewed: 2,
    evidence: 'Reviewed current listings.',
  });
  assert.equal(searched.status, 'searched');
  assert.equal(searched.value.reviewedCount, 2);

  const blocked = normalizeSourceCoverage({
    roundId: 'round-1',
    sourceId: 'indeed',
    status: 'unavailable',
    blocker: 'login required',
    evidence: 'Source required a session.',
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocker, 'login');

  assert.throws(
    () => normalizeSourceCoverage({
      roundId: 'round-1',
      sourceId: 'indeed',
      status: 'maybe',
      evidence: 'Reviewed current listings.',
    }),
    /coverage\.status must be searched or blocked\. Allowed: searched, blocked\./,
  );
});

test('round complete maps concentrationNote to concentrationEvidence', () => {
  const mapped = normalizeRoundCompleteInput({
    roundId: 'round-1',
    concentrationReason: 'stronger-fit',
    concentrationNote: 'Only this source had a qualified role.',
  });
  assert.equal(mapped.concentrationEvidence, 'Only this source had a qualified role.');
  assert.equal('concentrationNote' in mapped, false);
});

test('round lead maps jobId, jobUrl, and title', () => {
  const lead = validateLead({
    roundId: 'round-1',
    sourceId: 'indeed',
    jobUrl: 'https://example.com/jobs/123',
    company: 'Example',
    title: 'Engineer',
    jobId: 'REQ-9',
    disposition: 'qualified',
    evidence: 'Active employer posting assessed against candidate requirements.',
  });
  assert.equal(lead.url, 'https://example.com/jobs/123');
  assert.equal(lead.role, 'Engineer');
  assert.equal(lead.employerJobId, 'REQ-9');
});

test('empty delivery attemptId defaults to initial:<applicationId>', () => {
  const event = validateDelivery({
    applicationId: 'app-1',
    attemptId: '',
    type: 'delivery-failed',
    occurredAt: '2026-09-13T10:00:00Z',
    evidenceType: 'final-delivery-failure',
    evidence: 'Final recipient failure matched to the sent application message.',
  });
  assert.equal(event.attemptId, 'initial:app-1');
});
