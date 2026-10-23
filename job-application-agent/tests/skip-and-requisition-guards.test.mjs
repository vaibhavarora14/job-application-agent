// Regression tests for two send-path guards:
// 1. A job that `score` skipped or excluded can never be staged for review or recorded with
//    `ledger add`, in any mode, even after a re-score with changed input.
// 2. NEW REQUISITION CONFIRMED is never enough on its own for a live send: `ledger add` still
//    needs the candidate's batch-review approval, whatever the approval mode or autonomy grant.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applicationItem, approveItemsSync, withTestReview } from './support/review-approval.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

const target = {
  name: 'Test Candidate', email: 'candidate@example.com', phone: '+1 555 0100', location: 'Toronto, Canada',
  workAuthorization: 'Canada', roleFamilies: ['product-engineering'], seniority: ['senior', 'staff'],
  skills: ['TypeScript'], targetLocations: ['Canada', 'Remote'], workModes: ['remote'],
  submissionMode: 'routine-auto', yearsExperience: 10, autoSubmitMinScore: 80, manualReviewMinScore: 70, minMustHaveCoverage: 70,
};

function job(overrides = {}) {
  return {
    title: 'Principal Product Engineer', company: 'Skip Co', description: 'Build products with TypeScript.',
    source: 'greenhouse', eligibility: 'eligible', postingStatus: 'active', roleFamily: 'product-engineering',
    seniority: 'principal', workMode: 'remote', remote: true, locations: ['Remote'],
    url: 'https://boards.greenhouse.io/skipco/jobs/101',
    mustHaves: [{ requirement: 'TypeScript', status: 'met', evidence: 'Resume skills' }],
    target, ...overrides,
  };
}

function entry(overrides = {}) {
  return {
    id: 'skip-co-101', company: 'Skip Co', role: 'Principal Product Engineer',
    url: 'https://boards.greenhouse.io/skipco/jobs/101', employerJobId: 'skipco:101',
    source: 'greenhouse', discoverySource: 'linkedin', applicationChannel: 'greenhouse',
    score: 86, status: 'submitted', submittedAt: new Date().toISOString(), approval: 'STANDING AUTHORIZATION', answers: {},
    telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
    ...overrides,
  };
}

async function fixture(t, label) {
  const directory = await mkdtemp(join(tmpdir(), `jaa-guards-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  return {
    directory,
    env: {
      ...process.env,
      JOB_APPLICATION_AGENT_STATE_DIR: directory,
      JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
      JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
      JOB_APPLICATION_AGENT_NO_BROWSER: '1',
      JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    },
  };
}

function run(env, args, input) {
  return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
}
function ok(env, args, input) {
  const result = run(env, args, input);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('a seniority-skipped job is refused by review stage and ledger add, even after a re-score', async (t) => {
  const { directory, env } = await fixture(t, 'skip');
  const scored = ok(env, ['score', '--stdin'], job());
  assert.equal(scored.decision, 'skip');

  // The send path is closed before anything is approved...
  const staged = run(env, ['review', 'stage', '--stdin'], { items: [applicationItem(entry())] });
  assert.equal(staged.status, 1);
  assert.match(staged.stderr, /Skipped job refused: .*seniority/);

  // ...and at the ledger, even with a batch approval obtained outside `review stage`.
  const approved = approveItemsSync(directory, [applicationItem(entry())]);
  const added = run(env, ['ledger', 'add', '--stdin'], { ...entry(), ...approved });
  assert.equal(added.status, 1);
  assert.match(added.stderr, /Skipped job refused/);

  // Re-scoring with tweaked input does not clear the skip.
  assert.equal(ok(env, ['score', '--stdin'], job({ seniority: 'senior' })).decision, 'review');
  const again = run(env, ['ledger', 'add', '--stdin'], withTestReview(env, ['ledger', 'add'], entry({ id: 'skip-co-101b' })));
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Skipped job refused/);

  // Resetting the assessment guard does not clear it either.
  ok(env, ['score', 'guard-reset']);
  assert.equal(run(env, ['ledger', 'add', '--stdin'], withTestReview(env, ['ledger', 'add'], entry({ id: 'skip-co-101c' }))).status, 1);
  assert.equal(ok(env, ['ledger', 'review']).applications ?? 0, 0);
});

test('a job scored without a URL is matched by company and role; other jobs still record', async (t) => {
  const { env } = await fixture(t, 'skip-nourl');
  const { url: _url, ...noUrl } = job({ company: 'NoUrl Co' });
  assert.equal(ok(env, ['score', '--stdin'], noUrl).decision, 'skip');
  const blocked = run(env, ['ledger', 'add', '--stdin'], withTestReview(env, ['ledger', 'add'], entry({ id: 'nourl-1', company: 'NoUrl Co', url: 'https://jobs.lever.co/nourl/1' })));
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Skipped job refused/);

  assert.equal(ok(env, ['score', '--stdin'], job({ company: 'Fit Co', title: 'Senior Product Engineer', seniority: 'senior', url: 'https://jobs.lever.co/fitco/2' })).decision, 'review');
  const recorded = ok(env, ['ledger', 'add', '--stdin'], withTestReview(env, ['ledger', 'add'], entry({ id: 'fit-2', company: 'Fit Co', role: 'Senior Product Engineer', url: 'https://jobs.lever.co/fitco/2', employerJobId: 'fitco:2' })));
  assert.equal(recorded.recorded, 'fit-2');
});

test('NEW REQUISITION CONFIRMED never replaces the batch approval on a live send, even in routine-auto with a grant', async (t) => {
  const { env } = await fixture(t, 'newreq');
  ok(env, ['autonomy', 'grant', '--stdin'], { mode: 'routine-auto' });
  const original = entry({ id: 'alias-1', company: 'Alias Co', role: 'Senior Backend Developer', url: 'https://jobs.lever.co/alias/1', employerJobId: 'alias:1', submittedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
  ok(env, ['ledger', 'add', '--stdin'], withTestReview(env, ['ledger', 'add'], original));
  const alias = entry({ id: 'alias-2', company: 'Alias Co', role: 'Sr Backend Engineer', url: 'https://jobs.lever.co/alias/2', employerJobId: 'alias:2' });

  const unattended = run(env, ['ledger', 'add', '--stdin'], { ...alias, duplicateOverride: 'NEW REQUISITION CONFIRMED' });
  assert.equal(unattended.status, 1);
  assert.match(unattended.stderr, /needs a batch approval from the candidate/);

  const reviewed = withTestReview(env, ['ledger', 'add'], alias);
  const withoutPhrase = run(env, ['ledger', 'add', '--stdin'], reviewed);
  assert.equal(withoutPhrase.status, 1);
  assert.match(withoutPhrase.stderr, /NEW REQUISITION CONFIRMED/);
  assert.equal(ok(env, ['ledger', 'add', '--stdin'], { ...reviewed, duplicateOverride: 'NEW REQUISITION CONFIRMED' }).recorded, 'alias-2');
});
