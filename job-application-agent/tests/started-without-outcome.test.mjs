// #222: jobs `score` sent to review with no submit, skip or pause are listed by `round status`
// so the agent reports them. Local only; no telemetry change.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assessmentJobKey } from '../scripts/assessment-guard.mjs';
import { MAX_LISTED_STARTED_JOBS, noteReviewPaused, noteReviewStarted, startedWithoutOutcome, startedWithoutOutcomeWarning } from '../scripts/started-without-outcome.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
const T0 = '2026-10-30T09:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const job = (n, extra = {}) => ({ url: `https://jobs.lever.co/acme/${n}`, company: 'Acme', title: `Engineer ${n}`, ...extra });

test('lists review-scored jobs in the round window with no outcome', () => {
  let started = { version: 1, jobs: {} };
  for (const n of [1, 2, 3, 4, 5]) started = noteReviewStarted(started, job(n), at(n));
  started = noteReviewStarted(started, job(9), at(-30)); // before the round
  const summary = startedWithoutOutcome({
    started,
    applications: [{ url: 'https://jobs.lever.co/acme/1', company: 'Acme', role: 'Engineer 1', status: 'submitted' }],
    attentionEvents: [{ type: 'opened', url: 'https://jobs.lever.co/acme/2' }],
    skips: { jobs: { [assessmentJobKey(job(3))]: { decision: 'skip' } } },
    decisions: { jobs: { [assessmentJobKey(job(4))]: { decision: 'ask' } } },
    startedAt: T0,
  });
  assert.deepEqual(summary, { count: 1, jobs: [{ company: 'Acme', role: 'Engineer 5', url: 'https://jobs.lever.co/acme/5', scoredAt: at(5) }] });
  assert.match(startedWithoutOutcomeWarning(summary), /^1 job was scored for review in this round with no submit, skip or pause/);
  assert.equal(startedWithoutOutcomeWarning({ count: 0, jobs: [] }), null);
});

test('a completed round ignores jobs scored after it ended; the list is capped', () => {
  let started = { version: 1, jobs: {} };
  for (let n = 0; n < MAX_LISTED_STARTED_JOBS + 5; n += 1) started = noteReviewStarted(started, job(n), at(1));
  started = noteReviewStarted(started, job('late'), at(120));
  const summary = startedWithoutOutcome({ started, startedAt: T0, completedAt: at(60) });
  assert.equal(summary.count, MAX_LISTED_STARTED_JOBS + 5);
  assert.equal(summary.jobs.length, MAX_LISTED_STARTED_JOBS);
  assert.equal(summary.truncated, true);
  assert.ok(!summary.jobs.some((item) => item.url.endsWith('/late')));
});

test('scores before and after a round do not place a job in it', () => {
  let started = noteReviewStarted({ version: 1, jobs: {} }, job(1), at(-30));
  started = noteReviewStarted(started, job(1), at(120));
  assert.equal(startedWithoutOutcome({ started, startedAt: T0, completedAt: at(60) }).count, 0);
  started = noteReviewStarted(started, job(1), at(30));
  assert.equal(startedWithoutOutcome({ started, startedAt: T0, completedAt: at(60) }).jobs[0].scoredAt, at(30));
});

test('a same-title posting at another URL is not closed by the other posting\'s outcome', () => {
  let started = noteReviewStarted({ version: 1, jobs: {} }, job(1, { title: 'Engineer' }), at(1));
  started = noteReviewStarted(started, job(2, { title: 'Engineer' }), at(2));
  started = noteReviewStarted(started, { company: 'Acme', title: 'Designer' }, at(3)); // scored without a URL
  const summary = startedWithoutOutcome({
    started, startedAt: T0,
    applications: [{ url: 'https://jobs.lever.co/acme/1', company: 'Acme', role: 'Engineer' }, { url: 'https://jobs.lever.co/acme/77', company: 'Acme', role: 'Designer' }],
  });
  assert.deepEqual(summary.jobs.map((item) => item.url), ['https://jobs.lever.co/acme/2']);
});

test('a job scored without a URL is closed by a pause that names its company and title', () => {
  let started = noteReviewStarted({ version: 1, jobs: {} }, { company: 'Acme', title: 'Designer' }, at(1));
  started = noteReviewStarted(started, job(2, { title: 'Designer' }), at(2));
  const paused = noteReviewPaused(started, { url: 'https://example.com/apply/designer', company: 'Acme', title: 'Designer' }, at(3));
  assert.equal(paused.changed, true);
  assert.deepEqual(startedWithoutOutcome({ started: paused.state, startedAt: T0 }).jobs.map((item) => item.url), ['https://jobs.lever.co/acme/2']);
});

test('round status reports a review-scored job until it is paused', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jaa-started-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const env = {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_NO_BROWSER: '1',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
  const ok = (args, input) => {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const target = {
    name: 'Test Candidate', email: 'candidate@example.com', phone: '+1 555 0100', location: 'Toronto, Canada',
    workAuthorization: 'Canada', roleFamilies: ['product-engineering'], seniority: ['senior', 'staff'],
    skills: ['TypeScript'], targetLocations: ['Canada', 'Remote'], workModes: ['remote'],
    submissionMode: 'review-each', yearsExperience: 10, autoSubmitMinScore: 80, manualReviewMinScore: 70, minMustHaveCoverage: 70,
  };
  const posting = (n) => ({
    title: `Senior Product Engineer ${n}`, company: 'Fit Co', description: 'Build products with TypeScript.',
    source: 'greenhouse', eligibility: 'eligible', postingStatus: 'active', roleFamily: 'product-engineering',
    seniority: 'senior', workMode: 'remote', remote: true, locations: ['Remote'], url: `https://boards.greenhouse.io/fitco/jobs/${n}`,
    mustHaves: [{ requirement: 'TypeScript', status: 'met', evidence: 'Resume skills' }], target,
  });
  const { roundId } = ok(['round', 'start', '--stdin'], { requestedCount: 1 });
  assert.equal(ok(['score', '--stdin'], posting(1)).decision, 'review');
  assert.equal(ok(['score', '--stdin'], posting(2)).decision, 'review');
  let status = ok(['round', 'status', roundId]);
  assert.equal(status.startedWithoutOutcome.count, 2);
  assert.deepEqual(status.startedWithoutOutcome.jobs.map((item) => item.url), ['https://boards.greenhouse.io/fitco/jobs/1', 'https://boards.greenhouse.io/fitco/jobs/2']);

  ok(['attention', 'add', '--stdin'], { roundId, applicationId: 'fit-co-1', url: 'https://boards.greenhouse.io/fitco/jobs/1', stage: 'questions', blocker: 'judgment', requiredActions: ['provide-judgment'] });
  status = ok(['round', 'status', roundId]);
  assert.equal(status.startedWithoutOutcome.count, 1);
  assert.equal(status.startedWithoutOutcome.jobs[0].role, 'Senior Product Engineer 2');

  // The record stays local: URL, company, title and times only.
  const stored = JSON.parse(await readFile(join(directory, 'review-started.json'), 'utf8'));
  const records = Object.values(stored.jobs);
  for (const record of records) for (const key of Object.keys(record)) assert.ok(['company', 'pausedAt', 'scoredAt', 'title', 'url'].includes(key), key);
  assert.equal(records.filter((record) => record.pausedAt).length, 1, 'attention add marks the paused job locally');
});
