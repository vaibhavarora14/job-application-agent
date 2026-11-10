// Regression tests for the local routine-auto gates (see scripts/routine-gates.mjs), built from an
// Oct 22 routine-auto round that submitted 24 LinkedIn/Wellfound jobs without running
// `sources jobs`, recorded every `round source` after the last submit, never uploaded a résumé,
// and sent jobs whose latest score was `ask` or `skip`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssessmentGuard } from '../scripts/assessment-guard.mjs';
import { evaluateRoundCoverage, latestAssessmentDecision, routineSubmitGateMessage } from '../scripts/routine-gates.mjs';
import { asLegacyRound } from './support/legacy-round.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

const target = {
  name: 'Test Candidate', email: 'candidate@example.com', phone: '+1 555 0100', location: 'Toronto, Canada',
  workAuthorization: 'Canada', roleFamilies: ['product-engineering'], seniority: ['senior', 'staff'],
  skills: ['TypeScript'], targetLocations: ['Canada', 'Remote'], workModes: ['remote'],
  submissionMode: 'routine-auto', yearsExperience: 10, autoSubmitMinScore: 80, manualReviewMinScore: 70, minMustHaveCoverage: 70,
};

function job(slug, overrides = {}) {
  return {
    title: 'Senior Product Engineer', company: `Gate ${slug}`, description: 'Build products with TypeScript.',
    source: 'greenhouse', eligibility: 'eligible', postingStatus: 'active', roleFamily: 'product-engineering',
    seniority: 'senior', workMode: 'remote', remote: true, locations: ['Remote'],
    url: `https://boards.greenhouse.io/gate${slug}/jobs/1`,
    mustHaves: [{ requirement: 'TypeScript', status: 'met', evidence: 'Resume skills' }],
    target, ...overrides,
  };
}

function entry(slug, overrides = {}) {
  return {
    id: `gate-${slug}`, company: `Gate ${slug}`, role: 'Senior Product Engineer', url: `https://boards.greenhouse.io/gate${slug}/jobs/1`,
    source: 'greenhouse', discoverySource: 'job-board', discoverySourceId: 'indeed', applicationChannel: 'greenhouse',
    score: 88, status: 'submitted', submittedAt: new Date().toISOString(), approval: 'STANDING AUTHORIZATION', answers: {},
    telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true, resumeFieldPresent: true },
    ...overrides,
  };
}

async function fixture(t, label, { communityUrl = 'http://127.0.0.1:9' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), `jaa-gates-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  return {
    directory,
    env: {
      ...process.env,
      JOB_APPLICATION_AGENT_STATE_DIR: directory,
      JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
      JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: communityUrl,
      JOB_APPLICATION_AGENT_NO_BROWSER: '1',
      JOB_APPLICATION_AGENT_ASSESSMENT_BACKOFF_MS: '0',
      JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    },
  };
}

/** Local stand-in for the public community job feed (GET /v1/jobs only). */
async function communityFeed(t) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: 1, jobs: [], nextCursor: null }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// Async so the in-process community feed server can answer while the CLI runs.
function run(env, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}
async function ok(env, args, input) {
  const result = await run(env, args, input);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function refused(env, args, input, pattern) {
  const result = await run(env, args, input);
  assert.equal(result.status, 1, `expected a refusal, got: ${result.stdout}`);
  assert.match(result.stderr, pattern);
  return result.stderr;
}
const lead = (roundId, sourceId, slug, overrides = {}) => ({
  roundId, sourceId, company: `Gate ${slug}`, role: 'Senior Product Engineer', url: `https://boards.greenhouse.io/gate${slug}/jobs/1`,
  disposition: 'qualified', applicationId: `gate-${slug}`, evidence: 'Meets the evidenced target requirements.', ...overrides,
});
const emptySearch = (roundId, sourceId) => ({
  roundId, sourceId, company: `${sourceId} search`, url: `https://search.example.com/${sourceId}`,
  disposition: 'no-relevant-opening', evidence: 'Searched with the target filters; no relevant opening.',
});
async function writePdf(directory) {
  await writeFile(join(directory, 'resume.pdf'), '%PDF-1.4\n% synthetic test résumé\n', { mode: 0o600 });
}

test('round source refuses "searched" without a matching recorded call; legacy rounds keep the old rule', async (t) => {
  const feed = await communityFeed(t);
  const { directory, env } = await fixture(t, 'source', { communityUrl: feed.url });
  const { roundId } = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });

  await refused(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'linkedin-jobs-feed', status: 'searched', evidence: 'Searched LinkedIn.' },
    /Coverage refused: linkedin-jobs-feed is marked searched, but no leads were recorded for it in this round/);
  await refused(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'community-jobs-feed', status: 'searched', evidence: 'Read the feed.' },
    /Coverage refused: community-jobs-feed is marked searched, but no successful `sources jobs` pull was recorded in this round/);
  await refused(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'community-jobs-feed', status: 'blocked', blocker: 'access-unavailable', evidence: 'Feed down.' },
    /can be recorded as blocked \(community feed unavailable\) only after a `sources jobs` call in this round failed/);

  // A recorded lead (an empty search counts) and a real feed pull satisfy the check.
  await ok(env, ['round', 'lead', '--stdin'], emptySearch(roundId, 'linkedin-jobs-feed'));
  assert.equal((await ok(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'linkedin-jobs-feed', status: 'searched', evidence: 'Searched LinkedIn.' })).reviewedCount, 1);
  const pulled = await ok(env, ['sources', 'jobs']);
  assert.equal(pulled.communityFeedUnavailable, undefined);
  assert.equal(feed.requests.filter((request) => request.url.startsWith('/v1/jobs')).length, 1);
  await ok(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'community-jobs-feed', status: 'searched', evidence: 'Reviewed the community feed.' });
  const status = await ok(env, ['round', 'status', roundId]);
  assert.equal(status.routineGates.coverage.communityFeed.satisfied, true);
  assert.deepEqual(status.routineGates.coverage.sources.map((item) => [item.sourceId, item.verification]), [['linkedin-jobs-feed', 'verified'], ['community-jobs-feed', 'verified']]);

  // The evidence file is private and local.
  const evidence = await readFile(join(directory, 'round-evidence.ndjson'), 'utf8');
  assert.doesNotMatch(evidence, /candidate@example\.com|Test Candidate/);

  // A round started by an older CLI (no gates record) keeps the earlier behavior.
  const legacy = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  await asLegacyRound(directory, legacy.roundId);
  await ok(env, ['round', 'source', '--stdin'], { roundId: legacy.roundId, sourceId: 'indeed', status: 'searched', evidence: 'Searched Indeed.' });
  assert.equal((await ok(env, ['round', 'status', legacy.roundId])).routineGates, undefined);
});

test('the Oct 22 pattern: coverage recorded after the submits and no community pull cannot complete the round', async (t) => {
  const { directory, env } = await fixture(t, 'after');
  await writePdf(directory);
  const { roundId } = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  await ok(env, ['score', '--stdin'], job('a'));
  await ok(env, ['round', 'lead', '--stdin'], lead(roundId, 'linkedin-jobs-feed', 'a'));
  await ok(env, ['ledger', 'add', '--stdin'], { ...entry('a', { roundId, discoverySourceId: 'linkedin-jobs-feed' }) });

  // Searches recorded only after the round's last submit are refused...
  await ok(env, ['round', 'lead', '--stdin'], emptySearch(roundId, 'direct-company-careers'));
  await refused(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'direct-company-careers', status: 'searched', evidence: 'Checked careers pages.' },
    /Round coverage refused: direct-company-careers was recorded only after the round's last submission/);
  await ok(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'linkedin-jobs-feed', status: 'searched', evidence: 'Searched LinkedIn.', applicationIds: ['gate-a'] });
  // ...and so is a blocker recorded after the fact.
  await ok(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'indeed', status: 'blocked', blocker: 'login', evidence: 'Needs login.' });
  await ok(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'we-work-remotely', status: 'blocked', blocker: 'site-error', evidence: 'Down.' });
  await refused(env, ['round', 'complete', '--stdin'], { roundId, concentrationReason: 'alternatives-exhausted', concentrationEvidence: 'Other sources were blocked.' },
    /Round coverage refused: indeed, we-work-remotely were recorded only after the round's last submission/);
  const status = await ok(env, ['round', 'status', roundId]);
  assert.equal(status.discovery.coverageSatisfied, false);
  assert.deepEqual(status.routineGates.coverage.afterSubmissionSourceIds, ['indeed', 'we-work-remotely']);
});

test('a round with verified coverage before its submits completes; a failed feed pull may be recorded as the blocker', async (t) => {
  const { directory, env } = await fixture(t, 'happy');
  await writePdf(directory);
  const { roundId, resumePreflight, blockers } = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  assert.equal(resumePreflight.ok, true);
  assert.deepEqual(blockers, []);
  // The feed is unreachable here, so the CLI says so and the failure can be recorded as the blocker.
  assert.equal((await ok(env, ['sources', 'jobs'])).communityFeedUnavailable, true);
  await refused(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'community-jobs-feed', status: 'searched', evidence: 'Feed.' }, /no successful `sources jobs` pull/);
  await refused(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'community-jobs-feed', status: 'blocked', blocker: 'login', evidence: 'Feed.' }, /access-unavailable or site-error/);

  await ok(env, ['score', '--stdin'], job('h'));
  await ok(env, ['round', 'lead', '--stdin'], lead(roundId, 'indeed', 'h'));
  await ok(env, ['round', 'lead', '--stdin'], emptySearch(roundId, 'linkedin-jobs-feed'));
  await ok(env, ['round', 'lead', '--stdin'], emptySearch(roundId, 'hacker-news-who-is-hiring'));
  for (const sourceId of ['indeed', 'linkedin-jobs-feed', 'hacker-news-who-is-hiring']) {
    await ok(env, ['round', 'source', '--stdin'], { roundId, sourceId, status: 'searched', evidence: 'Searched with the target filters.' });
  }
  await ok(env, ['ledger', 'add', '--stdin'], { ...entry('h', { roundId }) });
  await refused(env, ['round', 'complete', '--stdin'], { roundId, concentrationReason: 'stronger-fit', concentrationEvidence: 'Only Indeed had a fit.' },
    /Round requires at least one community job feed pull per round, made before the round's submissions/);

  // The blocker must come from a pull made before the submissions, so start a fresh round to show it.
  const second = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  assert.equal((await ok(env, ['sources', 'jobs'])).communityFeedUnavailable, true);
  await ok(env, ['round', 'source', '--stdin'], { roundId: second.roundId, sourceId: 'community-jobs-feed', status: 'blocked', blocker: 'access-unavailable', evidence: 'sources jobs could not reach the feed.' });
  await ok(env, ['score', '--stdin'], job('i'));
  await ok(env, ['round', 'lead', '--stdin'], lead(second.roundId, 'indeed', 'i'));
  await ok(env, ['round', 'lead', '--stdin'], emptySearch(second.roundId, 'linkedin-jobs-feed'));
  for (const sourceId of ['indeed', 'linkedin-jobs-feed']) await ok(env, ['round', 'source', '--stdin'], { roundId: second.roundId, sourceId, status: 'searched', evidence: 'Searched.' });
  await ok(env, ['ledger', 'add', '--stdin'], { ...entry('i', { roundId: second.roundId }) });
  const done = await ok(env, ['round', 'complete', '--stdin'], { roundId: second.roundId, concentrationReason: 'stronger-fit', concentrationEvidence: 'Only Indeed had a fit.' });
  assert.equal(done.completed, true);
  assert.equal(done.routineGates.coverage.communityFeed.blockerRecorded, true);
  assert.equal(done.warnings, undefined);
});

test('round start preflights the résumé upload and surfaces resume-upload-unavailable in status and completion', async (t) => {
  const { directory, env } = await fixture(t, 'resume');
  const missing = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  assert.equal(missing.resumePreflight.ok, false);
  assert.equal(missing.blockers[0].blocker, 'resume-upload-unavailable');
  assert.match(missing.blockers[0].reason, /not imported/);
  assert.match(missing.nextStep, /Résumé upload is unavailable \(resume-upload-unavailable\): tell the candidate now/);
  const status = await ok(env, ['round', 'status', missing.roundId]);
  assert.equal(status.routineGates.blockers[0].blocker, 'resume-upload-unavailable');
  assert.match(status.routineGates.blockers[0].impact, /do not quietly narrow the round to one-click boards/);

  await writeFile(join(directory, 'resume.pdf'), 'plain text, not a PDF');
  const wrongType = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  assert.match(wrongType.blockers[0].reason, /not a PDF, the supported upload type/);
  await writeFile(join(directory, 'resume.pdf'), '');
  assert.match((await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 })).blockers[0].reason, /empty/);
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await writePdf(directory);
    await chmod(join(directory, 'resume.pdf'), 0o000);
    assert.match((await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 })).blockers[0].reason, /not readable/);
    await chmod(join(directory, 'resume.pdf'), 0o600);
  }

  // Completion still works and repeats the blocker so it reaches the candidate.
  await writePdf(directory);
  const { roundId } = missing;
  await ok(env, ['sources', 'jobs']);
  await ok(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'community-jobs-feed', status: 'blocked', blocker: 'access-unavailable', evidence: 'Feed unreachable.' });
  await ok(env, ['score', '--stdin'], job('r'));
  await ok(env, ['round', 'lead', '--stdin'], lead(roundId, 'indeed', 'r'));
  await ok(env, ['round', 'lead', '--stdin'], emptySearch(roundId, 'linkedin-jobs-feed'));
  for (const sourceId of ['indeed', 'linkedin-jobs-feed']) await ok(env, ['round', 'source', '--stdin'], { roundId, sourceId, status: 'searched', evidence: 'Searched.' });
  await ok(env, ['ledger', 'add', '--stdin'], { ...entry('r', { roundId }) });
  const done = await ok(env, ['round', 'complete', '--stdin'], { roundId, concentrationReason: 'stronger-fit', concentrationEvidence: 'Only Indeed had a fit.' });
  assert.equal(done.completed, true);
  assert.match(done.warnings[0], /^resume-upload-unavailable: .*Report this blocker to the candidate/);
});

test('ledger add requires resumeFieldPresent (true, false or "unknown") whenever a telemetry block is sent', async (t) => {
  const { directory, env } = await fixture(t, 'field');
  const send = (slug, telemetry) => {
    const value = entry(slug, { approval: 'APPROVE SUBMIT', telemetry });
    return run(env, ['ledger', 'add', '--stdin'], value);
  };
  const missing = await send('m', { durationBucket: '2-5m', fieldsFilled: 6, resumeUploaded: false });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ledger add refused: entry\.telemetry\.resumeFieldPresent is required\. Report true if this form had a résumé\/CV upload or selection field \(even optional or unused\), false if it had none, or "unknown" only if you never saw the form/);
  assert.equal((await ok(env, ['ledger', 'review'])).submittedTotal ?? 0, 0);
  for (const [slug, value] of [['f', false], ['t', true], ['u', 'unknown']]) {
    const result = await send(slug, { durationBucket: '2-5m', fieldsFilled: 6, resumeUploaded: false, resumeFieldPresent: value });
    assert.equal(result.status, 0, result.stderr);
  }
  // An explicit upload implies the field. Answers without a telemetry block are refused for a live submit.
  assert.equal((await send('up', { durationBucket: '2-5m', fieldsFilled: 6, resumeUploaded: true })).status, 0);
  const logged = await send('log', undefined);
  assert.equal(logged.status, 1, 'empty answers with no telemetry stay refused');
  assert.match(logged.stderr, /telemetry\.fieldsFilled/);
  const loggedEntry = entry('log2', { approval: 'APPROVE SUBMIT', telemetry: undefined, answers: { Email: 'filled', Resume: 'uploaded' } });
  const loggedAfter = await run(env, ['ledger', 'add', '--stdin'], { ...loggedEntry });
  assert.equal(loggedAfter.status, 1);
  assert.match(loggedAfter.stderr, /telemetry\.resumeFieldPresent/);
  const rows = (await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  for (const row of rows) assert.equal('resumeFieldPresent' in row, false);
});

test('routine-auto ledger add refuses a routine job whose latest score is not review + autoEligible', async (t) => {
  const { directory, env } = await fixture(t, 'submit');
  const good = await ok(env, ['score', '--stdin'], job('good'));
  assert.equal(good.decision, 'review');
  assert.equal(good.autoEligible, true);
  assert.equal((await ok(env, ['score', '--stdin'], job('ask', { eligibility: 'unclear' }))).decision, 'ask');
  const manual = await ok(env, ['score', '--stdin'], job('manual', { experienceMin: 15 }));
  assert.equal(manual.decision, 'review');
  assert.equal(manual.autoEligible, false);
  await refused(env, ['ledger', 'add', '--stdin'], entry('ask'),
    /Routine-auto submit refused for Gate ask: the latest score decision is "ask"\. In routine-auto only jobs whose latest score is "review" with autoEligible: true can be sent as routine work/);
  await refused(env, ['ledger', 'add', '--stdin'], entry('never'), /Routine-auto submit refused for Gate never: no score decision is recorded for this job/);
  await refused(env, ['ledger', 'add', '--stdin'], entry('manual'),
    /Routine-auto submit refused for Gate manual: the latest score decision is "review" but autoEligible is false \(score 79\)/);
  assert.equal((await ok(env, ['ledger', 'add', '--stdin'], entry('good'))).recorded, 'gate-good');

  // A re-score that changes the answer is what counts: the latest decision wins.
  assert.equal((await ok(env, ['score', '--stdin'], job('good2'))).decision, 'review');
  assert.equal((await ok(env, ['score', '--stdin'], job('good2', { eligibility: 'unclear' }))).decision, 'ask');
  await refused(env, ['ledger', 'add', '--stdin'], entry('good2'), /latest score decision is "ask"/);

  // The candidate's explicit per-job approval ("APPROVE SUBMIT") still lets them send an `ask` job;
  // legacy batch-review fields are accepted and ignored.
  assert.equal((await ok(env, ['ledger', 'add', '--stdin'], { ...entry('ask', { approval: 'APPROVE SUBMIT' }), reviewBatchId: 'rb-20261101-00000000', reviewToken: 'rbt1.legacy.ignored' })).recorded, 'gate-ask');
  // Skips stay final even with a per-job approval (3.8.3).
  assert.equal((await ok(env, ['score', '--stdin'], job('skip', { seniority: 'principal' }))).decision, 'skip');
  await refused(env, ['ledger', 'add', '--stdin'], entry('skip', { approval: 'APPROVE SUBMIT' }), /Skipped job refused/);
});

test('under an autonomy grant a routine send is gated; the candidate\'s per-job APPROVE SUBMIT is not', async (t) => {
  const { env } = await fixture(t, 'grant');
  await ok(env, ['autonomy', 'grant', '--stdin'], { mode: 'routine-auto' });
  await refused(env, ['ledger', 'add', '--stdin'], entry('g'), /Routine-auto submit refused for Gate g: no score decision/);
  assert.equal((await ok(env, ['ledger', 'add', '--stdin'], entry('g2', { approval: 'APPROVE SUBMIT' }))).recorded, 'gate-g2');
});

test('entryOrigin=logged entries do not count toward a gated round target without a per-job approval', async (t) => {
  const { directory, env } = await fixture(t, 'logged');
  const { roundId } = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 2 });
  // A new live add without telemetry is refused and records nothing.
  const live = entry('l1', { roundId, telemetry: undefined, answers: { 'Full name': 'filled', Email: 'filled' } });
  await refused(env, ['ledger', 'add', '--stdin'], live, /Nothing was recorded[\s\S]*telemetry\.fieldsFilled/);
  assert.equal(await readFile(join(directory, 'applications.ndjson'), 'utf8').catch((error) => (error.code === 'ENOENT' ? '' : Promise.reject(error))), '');
  // A row already stored as logged (older CLI) keeps that marker and still does not count
  // toward the round unless it carries a per-job approval.
  const historical = (slug, approval) => ({
    ...entry(slug, { roundId, telemetry: undefined, answers: { 'Full name': 'filled', Email: 'filled' }, approval }),
    applyKind: 'live', fillMetricsSource: 'answer_keys', telemetrySupplied: false, entryOrigin: 'logged',
  });
  await appendFile(join(directory, 'applications.ndjson'), `${JSON.stringify(historical('l1', 'STANDING AUTHORIZATION'))}\n`);
  let status = await ok(env, ['round', 'status', roundId]);
  assert.equal(status.confirmedCount, 0);
  assert.deepEqual(status.routineGates.uncountedLoggedApplicationIds, ['gate-l1']);
  const stored = JSON.parse((await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim());
  assert.equal(stored.entryOrigin, 'logged');
  await refused(env, ['round', 'complete', '--stdin'], { roundId }, /1 entryOrigin=logged entry is not counted without a per-job approval/);

  await appendFile(join(directory, 'applications.ndjson'), `${JSON.stringify(historical('l2', 'APPROVE SUBMIT'))}\n`);
  status = await ok(env, ['round', 'status', roundId]);
  assert.equal(status.confirmedCount, 1);
  assert.deepEqual(status.routineGates.uncountedLoggedApplicationIds, ['gate-l1']);
});

test('score stops retrying a job after 3 invalid-input failures and records it as blocked', async (t) => {
  const { env } = await fixture(t, 'invalid');
  const broken = job('bad', { source: '' });
  for (const attempt of [1, 2]) {
    const stderr = await refused(env, ['score', '--stdin'], broken, /job\.source must be a non-empty string/);
    assert.doesNotMatch(stderr, /now blocked/, `attempt ${attempt}`);
    // A valid job in between resets the global streak but not this job's count.
    await ok(env, ['score', '--stdin'], job(`ok${attempt}`));
  }
  await refused(env, ['score', '--stdin'], broken,
    /Assessment guard: this job failed with invalid input 3 times in this run, so it is now blocked and recorded as skipped \(invalid-input-retries\)\. STOP retrying it/);
  await refused(env, ['score', '--stdin'], job('bad'), /this job failed with invalid input 3 times/);
  const guard = await ok(env, ['score', 'guard']);
  assert.equal(guard.blockedInvalidJobs, 1);
  assert.equal(guard.stopped, false);
  await ok(env, ['score', '--stdin'], job('ok3'));
  await refused(env, ['ledger', 'add', '--stdin'], entry('bad'), /Skipped job refused: score decided "blocked" \(invalid-input-retries\)/);
});

test('per-job invalid-input backoff waits between retries of the same job, even after other jobs succeed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jaa-gates-backoff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-23T10:00:00Z');
  const guard = createAssessmentGuard({
    dir: () => directory,
    withLock: async (_name, action) => action(),
    env: { JOB_APPLICATION_AGENT_ASSESSMENT_BACKOFF_MS: '1000' },
    now: () => new Date(clock),
    sleep: async (ms) => { clock += ms; },
  });
  const write = (file, value) => writeFile(file, JSON.stringify(value));
  const broken = job('bk', { description: '' });
  let lastFailureAt = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ticket = await guard.before(broken, target, write);
    const status = await guard.failure(ticket, new Error('description is required'), { invalidInput: true }, write);
    lastFailureAt = clock;
    assert.equal(status.jobBlocked, undefined);
    // A different job succeeds right away and clears the global streak.
    const other = await guard.before(job(`fine${attempt}`), target, write);
    await guard.success(other, { score: 90, decision: 'review', autoEligible: true }, write);
  }
  const third = await guard.before(broken, target, write);
  // The global streak was cleared by the other job, but this job's second failure still means a
  // 2 s backoff from that failure before it can be tried again.
  assert.ok(clock - lastFailureAt >= 2000, `retried ${clock - lastFailureAt} ms after the last failure`);
  const blocked = await guard.failure(third, new Error('description is required'), { invalidInput: true }, write);
  assert.deepEqual(blocked.jobBlocked, { count: 3, lastMessage: 'description is required' });
  await assert.rejects(guard.before(broken, target, write), /failed with invalid input 3 times/);
  const saved = JSON.parse(await readFile(join(directory, 'assessment-guard.json'), 'utf8'));
  assert.equal(saved.invalidJobs[third.jobKey].count, 3);
  assert.equal(latestAssessmentDecision([third.jobKey], { guard: saved }), null);
});

test('coverage evaluation and the submit-gate message are pure and local', () => {
  const at = (minute) => new Date(Date.parse('2026-10-22T05:00:00Z') + minute * 60_000).toISOString();
  const coverage = evaluateRoundCoverage({
    gates: { at: at(0), version: 1 }, roundId: 'r',
    evidence: [
      { type: 'community-feed-pull', ok: true, at: at(1) },
      { type: 'lead-recorded', roundId: 'r', sourceId: 'linkedin-jobs-feed', leadId: 'l1', at: at(2) },
      { type: 'lead-recorded', roundId: 'r', sourceId: 'direct-company-careers', leadId: 'l2', at: at(50) },
    ],
    sourceEvents: [
      { type: 'source-checked', sourceId: 'linkedin-jobs-feed', status: 'searched', occurredAt: at(51) },
      { type: 'source-checked', sourceId: 'direct-company-careers', status: 'searched', occurredAt: at(51) },
      { type: 'source-checked', sourceId: 'community-jobs-feed', status: 'searched', occurredAt: at(51) },
    ],
    submissions: [{ id: 'a', at: at(10) }, { id: 'b', at: at(40) }],
  });
  assert.deepEqual(coverage.afterSubmissionSourceIds, ['direct-company-careers']);
  assert.equal(coverage.communityFeed.satisfied, true);
  assert.equal(coverage.verifiedSearchedSourceCount, 2);
  assert.equal(coverage.coverageSatisfied, false);
  assert.equal(routineSubmitGateMessage({ decision: 'review', autoEligible: true }, 'X'), null);
  assert.match(routineSubmitGateMessage({ decision: 'review', autoEligible: false, score: 74 }, 'X'), /"review" but autoEligible is false \(score 74\)/);
  assert.match(routineSubmitGateMessage({ decision: 'skip' }, 'X'), /latest score decision is "skip"/);
});

test('score names the allowed role families when job.roleFamily is unknown (#255)', async (t) => {
  const { env } = await fixture(t, 'role-family');
  await refused(env, ['score', '--stdin'], job('family', { roleFamily: 'software-engineering' }), /Error: job\.roleFamily is invalid\. Allowed: frontend, backend, full-stack, product-engineering, ai-ml, platform, infrastructure, mobile, engineering-management, architecture, security, data, other\. Omit job\.roleFamily to use "other"\./);
});

test('round lead takes {"leads": [...]} in one call, validates all first, and source coverage accepts them (#219)', async (t) => {
  const { env } = await fixture(t, 'lead-batch');
  const { roundId } = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  await refused(env, ['round', 'lead', '--stdin'], { leads: [lead(roundId, 'linkedin-jobs-feed', 'x'), { ...lead(roundId, 'linkedin-jobs-feed', 'y'), disposition: 'nope' }] }, /Error: leads\[1\]: Invalid lead disposition\. Allowed: qualified, duplicate, no-relevant-opening, location-authorization-conflict, compensation-below-floor, seniority-mismatch, insufficient-must-have-coverage, closed-stale, blocked\./);
  assert.equal((await ok(env, ['round', 'leads', roundId])).history.length, 0, 'a bad lead in the batch records nothing');
  await refused(env, ['round', 'lead', '--stdin'], { leads: [lead(roundId, 'linkedin-jobs-feed', 'x'), lead(roundId, 'linkedin-jobs-feed', 'y', { supersedes: 'lead-that-does-not-exist' })] }, /Error: leads\[1\]: .*No lead in this call was recorded\./);
  assert.equal((await ok(env, ['round', 'leads', roundId])).history.length, 0, 'a bad reference later in the batch records nothing');
  await refused(env, ['round', 'lead', '--stdin'], { leads: [] }, /array of 1 to 100 leads/);
  await refused(env, ['round', 'lead', '--stdin'], { leads: [lead(roundId, 'linkedin-jobs-feed', 'x')], roundId }, /takes only \{"leads"/);
  const batch = await ok(env, ['round', 'lead', '--stdin'], { leads: ['a', 'b', 'c'].map((slug) => lead(roundId, 'linkedin-jobs-feed', slug)) });
  assert.equal(batch.leadCount, 3);
  assert.equal(batch.recordedCount, 3);
  assert.equal((await ok(env, ['round', 'leads', roundId])).history.length, 3);
  await ok(env, ['round', 'source', '--stdin'], { roundId, sourceId: 'linkedin-jobs-feed', status: 'searched', evidence: 'Searched LinkedIn.' });
  // A single lead still works and returns the old shape.
  const single = await ok(env, ['round', 'lead', '--stdin'], emptySearch(roundId, 'direct-company-careers'));
  assert.equal(single.recorded, true);
});

test('ledger check takes {"candidates": [...]} and returns one result per job (#219)', async (t) => {
  const { env } = await fixture(t, 'check-batch');
  const one = { id: 'batch-1', company: 'Batch Co', role: 'Senior Engineer', url: 'https://boards.greenhouse.io/batchco/jobs/1' };
  const two = { id: 'batch-2', company: 'Other Co', role: 'Staff Engineer', url: 'https://boards.greenhouse.io/otherco/jobs/2' };
  const single = await ok(env, ['ledger', 'check', '--stdin'], one);
  const batch = await ok(env, ['ledger', 'check', '--stdin'], { candidates: [one, two] });
  assert.equal(batch.results.length, 2);
  assert.deepEqual(batch.results[0], single);
  await refused(env, ['ledger', 'check', '--stdin'], { candidates: [one, { company: 'x' }] }, /candidates\[1\]: /);
});

// Counts lock-file opens in one CLI process. The batch must take each lock once.
const LOCK_LOG_PRELOAD = `
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const originalOpen = fsPromises.open;
const counts = {};
fsPromises.open = async function(path, ...args) {
  const name = basename(String(path));
  if (name.endsWith('.lock')) counts[name] = (counts[name] ?? 0) + 1;
  return originalOpen.call(fsPromises, path, ...args);
};
syncBuiltinESMExports();
process.on('exit', () => {
  fs.writeFileSync(process.env.LOCK_LOG, JSON.stringify(counts));
});
`;

async function runCountingLocks(env, args, input) {
  const preload = join(env.JOB_APPLICATION_AGENT_STATE_DIR, 'lock-log-preload.mjs');
  const log = join(env.JOB_APPLICATION_AGENT_STATE_DIR, `lock-log-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(preload, LOCK_LOG_PRELOAD);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, script, ...args], {
      env: { ...env, LOCK_LOG: log },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
  const counts = JSON.parse(await readFile(log, 'utf8'));
  return { ...result, counts };
}

test('a lead batch takes the rounds lock and the evidence lock once, not once per lead (#219)', async (t) => {
  const { env } = await fixture(t, 'lead-locks');
  const { roundId } = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  const leads = ['a', 'b', 'c'].map((slug) => lead(roundId, 'linkedin-jobs-feed', slug));
  const batch = await runCountingLocks(env, ['round', 'lead', '--stdin'], { leads });
  assert.equal(batch.status, 0, batch.stderr);
  assert.equal(batch.counts['.rounds.lock'], 1);
  assert.equal(batch.counts['.round-evidence.lock'], 1);
  const single = await runCountingLocks(env, ['round', 'lead', '--stdin'], emptySearch(roundId, 'direct-company-careers'));
  assert.equal(single.status, 0, single.stderr);
  assert.equal(single.counts['.rounds.lock'], 1);
  assert.equal(single.counts['.round-evidence.lock'], 1);
  assert.equal(JSON.parse(single.stdout).recorded, true);
});

test('round lead --stdin accepts a JSON array of leads and still records one lead object (#219)', async (t) => {
  const { directory, env } = await fixture(t, 'lead-array');
  const { roundId } = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  const leads = ['a', 'b', 'c'].map((slug) => lead(roundId, 'indeed', slug));
  await refused(env, ['round', 'lead', '--stdin'], [leads[0], { ...leads[1], disposition: 'nope' }], /Error: leads\[1\]: Invalid lead disposition/);
  assert.equal((await ok(env, ['round', 'leads', roundId])).history.length, 0, 'a bad lead in the array records nothing');
  await refused(env, ['round', 'lead', '--stdin'], [], /array of 1 to 100 leads/);
  const batch = await runCountingLocks(env, ['round', 'lead', '--stdin'], leads);
  assert.equal(batch.status, 0, batch.stderr);
  const recorded = JSON.parse(batch.stdout);
  assert.equal(recorded.leadCount, 3);
  assert.equal(recorded.recordedCount, 3);
  assert.equal(batch.counts['.rounds.lock'], 1);
  assert.equal(batch.counts['.round-evidence.lock'], 1);
  const evidence = (await readFile(join(directory, 'round-evidence.ndjson'), 'utf8')).split('\n').filter((line) => line.includes('"lead-recorded"'));
  assert.equal(evidence.length, 3);
  const single = await ok(env, ['round', 'lead', '--stdin'], emptySearch(roundId, 'direct-company-careers'));
  assert.equal(single.recorded, true);
  assert.equal(single.leadCount, undefined);
});

test('round source --stdin accepts one coverage object or a JSON array, and stores the evidence string (#219)', async (t) => {
  const { directory, env } = await fixture(t, 'source-array');
  const { roundId } = await ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  for (const sourceId of ['linkedin-jobs-feed', 'direct-company-careers', 'indeed']) {
    await ok(env, ['round', 'lead', '--stdin'], emptySearch(roundId, sourceId));
  }
  const single = await ok(env, ['round', 'source', '--stdin'], {
    roundId, sourceId: 'indeed', status: 'searched', evidence: 'Searched Indeed.',
  });
  assert.equal(single.reviewedCount, 1);
  assert.equal(single.evidence, 'Searched Indeed.');
  assert.equal(single.sourceCount, undefined);
  const bad = [
    { roundId, sourceId: 'linkedin-jobs-feed', status: 'searched', evidence: 'Searched LinkedIn.' },
    { roundId, sourceId: 'direct-company-careers', status: 'nope', evidence: 'Checked careers pages.' },
  ];
  await refused(env, ['round', 'source', '--stdin'], bad, /Error: sources\[1\]: coverage\.status must be searched or blocked\./);
  const storedBefore = (await readFile(join(directory, 'rounds.ndjson'), 'utf8')).split('\n').filter((line) => line.includes('"source-checked"'));
  assert.equal(storedBefore.length, 1, 'a bad source in the array records nothing');
  const reports = [
    { roundId, sourceId: 'linkedin-jobs-feed', status: 'searched', evidence: 'Searched LinkedIn.' },
    { roundId, sourceId: 'direct-company-careers', status: 'searched', evidence: 'Checked careers pages.' },
  ];
  const batch = await runCountingLocks(env, ['round', 'source', '--stdin'], reports);
  assert.equal(batch.status, 0, batch.stderr);
  const parsed = JSON.parse(batch.stdout);
  assert.equal(parsed.sourceCount, 2);
  assert.equal(parsed.recordedCount, 2);
  assert.deepEqual(parsed.results.map((item) => item.sourceId), ['linkedin-jobs-feed', 'direct-company-careers']);
  assert.deepEqual(parsed.results.map((item) => item.evidence), ['Searched LinkedIn.', 'Checked careers pages.']);
  assert.equal(batch.counts['.rounds.lock'], 1);
  const wrapped = await ok(env, ['round', 'source', '--stdin'], { sources: [{ roundId, sourceId: 'hacker-news-who-is-hiring', status: 'blocked', blocker: 'login', evidence: 'Login wall.' }] });
  // hacker news searched needs a lead; blocked does not. Recording a blocked source with no lead is allowed.
  assert.equal(wrapped.sourceCount, 1);
  assert.equal(wrapped.results[0].blocker, 'login');
});

test('ledger check --stdin accepts a JSON array of jobs and still returns one object for one job (#219)', async (t) => {
  const { env } = await fixture(t, 'check-array');
  const one = { id: 'array-1', company: 'Array Co', role: 'Senior Engineer', url: 'https://boards.greenhouse.io/arrayco/jobs/1' };
  const two = { id: 'array-2', company: 'Other Co', role: 'Staff Engineer', url: 'https://boards.greenhouse.io/otherco/jobs/2' };
  const single = await ok(env, ['ledger', 'check', '--stdin'], one);
  assert.equal(single.results, undefined);
  const batch = await ok(env, ['ledger', 'check', '--stdin'], [one, two]);
  assert.equal(batch.results.length, 2);
  assert.deepEqual(batch.results[0], single);
  assert.equal(batch.results[1].duplicate, false);
  await refused(env, ['ledger', 'check', '--stdin'], [one, { company: 'x' }], /candidates\[1\]: /);
  await refused(env, ['ledger', 'check', '--stdin'], [], /array of 1 to 50 jobs/);
});
