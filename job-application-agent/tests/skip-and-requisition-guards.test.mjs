// Regression tests for two send-path guards:
// 1. A job that `score` skipped or excluded can never be recorded with `ledger add`, in any mode,
//    even after a re-score with changed input.
// 2. NEW REQUISITION CONFIRMED is never enough on its own for a live send: `ledger add` still
//    needs the candidate's explicit per-job approval. An unattended or routine-auto attempt pauses
//    the job instead of sending it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { possibleDuplicateError, skillErrorProperties } from '../scripts/job-application.mjs';

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

test('a seniority-skipped job is refused by ledger add, even after a re-score', async (t) => {
  const { env } = await fixture(t, 'skip');
  const scored = ok(env, ['score', '--stdin'], job());
  assert.equal(scored.decision, 'skip');

  // The send path is closed at the ledger, in any mode (legacy review fields change nothing).
  const added = run(env, ['ledger', 'add', '--stdin'], { ...entry(), reviewBatchId: 'rb-20261101-00000000', reviewToken: 'rbt1.legacy.ignored' });
  assert.equal(added.status, 1);
  assert.match(added.stderr, /Skipped job refused: .*seniority/);

  // Re-scoring with tweaked input does not clear the skip.
  assert.equal(ok(env, ['score', '--stdin'], job({ seniority: 'senior' })).decision, 'review');
  const again = run(env, ['ledger', 'add', '--stdin'], entry({ id: 'skip-co-101b' }));
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Skipped job refused/);

  // Resetting the assessment guard does not clear it either.
  ok(env, ['score', 'guard-reset']);
  assert.equal(run(env, ['ledger', 'add', '--stdin'], entry({ id: 'skip-co-101c' })).status, 1);
  assert.equal(ok(env, ['ledger', 'review']).applications ?? 0, 0);
});

test('a job scored without a URL is matched by company and role; other jobs still record', async (t) => {
  const { env } = await fixture(t, 'skip-nourl');
  const { url: _url, ...noUrl } = job({ company: 'NoUrl Co' });
  assert.equal(ok(env, ['score', '--stdin'], noUrl).decision, 'skip');
  const blocked = run(env, ['ledger', 'add', '--stdin'], entry({ id: 'nourl-1', company: 'NoUrl Co', url: 'https://jobs.lever.co/nourl/1' }));
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Skipped job refused/);

  assert.equal(ok(env, ['score', '--stdin'], job({ company: 'Fit Co', title: 'Senior Product Engineer', seniority: 'senior', url: 'https://jobs.lever.co/fitco/2' })).decision, 'review');
  const recorded = ok(env, ['ledger', 'add', '--stdin'], entry({ id: 'fit-2', company: 'Fit Co', role: 'Senior Product Engineer', url: 'https://jobs.lever.co/fitco/2', employerJobId: 'fitco:2' }));
  assert.equal(recorded.recorded, 'fit-2');
});

test('possible-duplicate error names the earlier role and date after the telemetry prefix', () => {
  const error = possibleDuplicateError({
    reason: 'company-role',
    possibleDuplicate: true,
    match: {
      role: 'Senior Backend Developer',
      submittedAt: '2026-10-26T12:00:00.000Z',
      company: 'Alias Co',
      url: 'https://jobs.lever.co/alias/1',
    },
  });
  assert.match(error.message, /it matches an earlier application at this company/);
  assert.match(error.message, /different employer job ID or requisition number \(record it as employerJobId\)/);
  assert.match(error.message, /review-each: fill the employer application page, stop before Submit/);
  assert.match(error.message, /Do not build a review page/);
  assert.match(error.message, /Unattended, routine-auto or STANDING AUTHORIZATION: do not submit and never pass the phrase on your own/);
  assert.match(error.message, /pauses the job/);
  assert.match(error.message, /Earlier application: Senior Backend Developer on 2026-10-26\.$/);
  assert.ok(error.message.indexOf('Senior Backend Developer') > 160, 'role and date stay past the skill_error prefix');
  assert.doesNotMatch(error.message, /Alias Co|jobs\.lever\.co|batch review/);
  const sanitized = skillErrorProperties(error, 'check').sanitizedMessage;
  assert.doesNotMatch(sanitized, /Senior Backend Developer|2026-10-26|Alias Co|lever\.co/);
  assert.equal(sanitized.length <= 160, true);

  const ambiguous = possibleDuplicateError({ reason: 'company-role', possibleDuplicate: true, match: null });
  assert.match(ambiguous.message, /more than one earlier application at this company/);
  assert.doesNotMatch(ambiguous.message, /Earlier application:/);
});

test('NEW REQUISITION CONFIRMED needs the candidate\'s explicit per-job approval, even in routine-auto with a grant', async (t) => {
  const { directory, env } = await fixture(t, 'newreq');
  ok(env, ['autonomy', 'grant', '--stdin'], { mode: 'routine-auto' });
  const round = ok(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  const submittedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const earlierDate = submittedAt.slice(0, 10);
  const original = entry({ id: 'alias-1', approval: 'APPROVE SUBMIT', company: 'Alias Co', role: 'Senior Backend Developer', url: 'https://jobs.lever.co/alias/1', employerJobId: 'alias:1', submittedAt });
  ok(env, ['ledger', 'add', '--stdin'], original);
  const alias = entry({ id: 'alias-2', company: 'Alias Co', role: 'Sr Backend Engineer', url: 'https://jobs.lever.co/alias/2', employerJobId: 'alias:2' });

  const reviewed = { ...alias, approval: 'APPROVE SUBMIT' };
  const withoutPhrase = run(env, ['ledger', 'add', '--stdin'], reviewed);
  assert.equal(withoutPhrase.status, 1);
  assert.match(withoutPhrase.stderr, /NEW REQUISITION CONFIRMED/);
  assert.match(withoutPhrase.stderr, new RegExp(`Earlier application: Senior Backend Developer on ${earlierDate}`));
  assert.match(withoutPhrase.stderr, /stop before Submit/);
  assert.doesNotMatch(withoutPhrase.stderr, /Paused this job/);
  assert.doesNotMatch(withoutPhrase.stderr, /Alias Co|jobs\.lever\.co|batch review/);
  assert.equal(ok(env, ['attention', 'list']).count, 0);

  const unattended = run(env, ['ledger', 'add', '--stdin'], { ...alias, duplicateOverride: 'NEW REQUISITION CONFIRMED' });
  assert.equal(unattended.status, 1);
  assert.match(unattended.stderr, /NEW REQUISITION CONFIRMED needs the candidate's explicit approval of this job/);
  assert.match(unattended.stderr, /filled employer page, stopped before Submit/);
  assert.match(unattended.stderr, new RegExp(`Earlier application: Senior Backend Developer on ${earlierDate}`));
  const paused = unattended.stderr.match(/Paused this job \(attention (attention-[0-9a-f-]+)\)/);
  assert.ok(paused, unattended.stderr);
  const attention = ok(env, ['attention', 'list']);
  assert.equal(attention.count, 1);
  assert.equal(attention.items[0].id, paused[1]);
  assert.equal(attention.items[0].blocker, 'judgment');
  assert.equal(attention.items[0].roundId, round.roundId);
  assert.equal(attention.items[0].url, alias.url);
  assert.deepEqual(attention.items[0].requiredActions, ['provide-judgment']);
  const storedAttention = await readFile(join(directory, 'attention.ndjson'), 'utf8');
  assert.equal(storedAttention.includes('Alias Co'), false);
  assert.equal(storedAttention.includes('Senior Backend Developer'), false);
  assert.equal(ok(env, ['ledger', 'review']).submittedTotal, 1, 'the duplicate was not recorded');

  const again = run(env, ['ledger', 'add', '--stdin'], { ...alias, duplicateOverride: 'NEW REQUISITION CONFIRMED' });
  assert.match(again.stderr, new RegExp(`Paused this job \\(attention ${paused[1]}\\)`));
  assert.equal(ok(env, ['attention', 'list']).count, 1, 'a second refusal reuses the open pause');

  const standingWithoutPhrase = run(env, ['ledger', 'add', '--stdin'], alias);
  assert.match(standingWithoutPhrase.stderr, /Paused this job/);
  assert.equal(ok(env, ['attention', 'list']).count, 1);

  // Legacy batch-review fields do not stand in for that approval, and do not open another pause.
  const legacy = run(env, ['ledger', 'add', '--stdin'], { ...alias, duplicateOverride: 'NEW REQUISITION CONFIRMED', reviewBatchId: 'rb-20261101-00000000', reviewToken: 'rbt1.legacy.ignored' });
  assert.equal(legacy.status, 1);
  assert.equal(ok(env, ['attention', 'list']).count, 1);

  assert.equal(ok(env, ['ledger', 'add', '--stdin'], { ...reviewed, duplicateOverride: 'NEW REQUISITION CONFIRMED' }).recorded, 'alias-2');
});

function runAsync(env, args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

test('a routine-auto duplicate pause emits application_paused with the existing fields only', async (t) => {
  const captured = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    captured.push(JSON.parse(raw));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/v1/install'
      ? { installationId: '00000000-0000-4000-8000-000000000001', token: 'synthetic-relay-token', expiresAt: '2099-01-01T00:00:00.000Z' }
      : { accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { env } = await fixture(t, 'newreq-telemetry');
  env.JOB_APPLICATION_AGENT_TELEMETRY_URL = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(env.JOB_APPLICATION_AGENT_STATE_DIR, 'telemetry.json'), JSON.stringify({
    version: 1, enabled: true, disclosed: true, graceConsumed: true, installationEventPending: false, contactEnabled: false,
    installationId: '00000000-0000-4000-8000-000000000001', token: 'synthetic-token', tokenExpiresAt: '2099-01-01T00:00:00.000Z',
  }));
  // spawn, not spawnSync: the relay server lives in this process and cannot accept
  // connections while the event loop is blocked.
  assert.equal((await runAsync(env, ['round', 'start', '--stdin'], { requestedCount: 1 })).status, 0);
  assert.equal((await runAsync(env, ['ledger', 'add', '--stdin'], entry({ id: 'alias-1', approval: 'APPROVE SUBMIT', company: 'Alias Co', role: 'Senior Backend Developer', url: 'https://jobs.lever.co/alias/1', employerJobId: 'alias:1', submittedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }))).status, 0);
  const blocked = await runAsync(env, ['ledger', 'add', '--stdin'], entry({ id: 'alias-2', company: 'Alias Co', role: 'Sr Backend Engineer', url: 'https://jobs.lever.co/alias/2', employerJobId: 'alias:2', approval: 'STANDING AUTHORIZATION', applicationChannel: 'lever' }));
  assert.equal(blocked.status, 1, blocked.stderr);
  const paused = captured.filter((body) => body.event === 'application_paused');
  assert.equal(paused.length, 1);
  assert.deepEqual(Object.keys(paused[0].properties).sort(), ['ats', 'jobHash', 'reason', 'stage']);
  assert.equal(paused[0].properties.stage, 'submission');
  assert.equal(paused[0].properties.reason, 'candidate-judgment');
  assert.equal(paused[0].properties.ats, 'lever');
  const serialized = JSON.stringify(paused[0]);
  assert.equal(serialized.includes('Alias Co'), false);
  assert.equal(serialized.includes('Senior Backend Developer'), false);
  assert.equal(serialized.includes('jobs.lever.co'), false);
  const skillErrors = captured.filter((body) => body.event === 'skill_error');
  assert.ok(skillErrors.length >= 1);
  assert.equal(JSON.stringify(skillErrors).includes('Senior Backend Developer'), false);
  assert.equal(JSON.stringify(skillErrors).includes('Alias Co'), false);
});
