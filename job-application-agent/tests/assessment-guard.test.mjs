import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ASSESSMENT_GUARD_DEFAULTS,
  AssessmentGuardStop,
  assessmentGuardConfig,
  assessmentInputDigest,
  assessmentJobKey,
  createAssessmentGuard,
  invalidInputBackoffMs,
} from '../scripts/assessment-guard.mjs';
import { telemetryErrorCategory, telemetryErrorCode } from '../scripts/job-application.mjs';
import { usageFor } from '../scripts/cli-args.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

const target = {
  name: 'Test Candidate', email: 'candidate@example.com', phone: '+1 555 0100', location: 'Toronto, Canada',
  workAuthorization: 'Canada', roleFamilies: ['product-engineering'], seniority: ['senior', 'staff'],
  skills: ['TypeScript'], targetLocations: ['Remote'], workModes: ['remote'], submissionMode: 'review-each',
  yearsExperience: 10, autoSubmitMinScore: 80, manualReviewMinScore: 70, minMustHaveCoverage: 70,
};

const job = (index, overrides = {}) => ({
  title: 'Senior Product Engineer', company: `Example ${index}`, description: 'Build products with TypeScript.',
  source: 'greenhouse', eligibility: 'eligible', postingStatus: 'active', roleFamily: 'product-engineering',
  seniority: 'senior', workMode: 'remote', url: `https://jobs.example.com/roles/${index}`,
  mustHaves: [{ requirement: 'TypeScript', status: 'met', evidence: 'Resume' }],
  target, ...overrides,
});

async function stateDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'job-agent-assessment-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function memoryGuard(directory, { env = {}, clock } = {}) {
  const sleeps = [];
  const write = (file, value) => writeFile(file, JSON.stringify(value));
  const guard = createAssessmentGuard({
    dir: () => directory,
    withLock: (_name, action) => action(directory),
    env,
    now: () => new Date(clock.ms),
    sleep: async (ms) => { sleeps.push(ms); clock.ms += ms; },
  });
  return { guard, sleeps, write };
}

function cliEnv(directory, extra = {}) {
  return {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_TELEMETRY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    JOB_APPLICATION_AGENT_ASSESSMENT_BACKOFF_MS: '0',
    ...extra,
  };
}

function runCli(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

async function disabledTelemetry(directory) {
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
}

test('guard defaults are 200 assessments per 6h window, 3 per job, hard stop after 5 invalid inputs', () => {
  assert.equal(ASSESSMENT_GUARD_DEFAULTS.maxAssessments, 200);
  assert.equal(ASSESSMENT_GUARD_DEFAULTS.windowMinutes, 360);
  assert.equal(ASSESSMENT_GUARD_DEFAULTS.maxPerJob, 3);
  assert.equal(ASSESSMENT_GUARD_DEFAULTS.maxConsecutiveInvalid, 5);
  assert.deepEqual(assessmentGuardConfig({}), { ...ASSESSMENT_GUARD_DEFAULTS });
  const configured = assessmentGuardConfig({ JOB_APPLICATION_AGENT_MAX_ASSESSMENTS: '50', JOB_APPLICATION_AGENT_MAX_CONSECUTIVE_INVALID: '3', JOB_APPLICATION_AGENT_ASSESSMENT_WINDOW_MINUTES: 'abc' });
  assert.equal(configured.maxAssessments, 50);
  assert.equal(configured.maxConsecutiveInvalid, 3);
  assert.equal(configured.windowMinutes, 360, 'invalid values fall back to the default');
  assert.equal(assessmentGuardConfig({ JOB_APPLICATION_AGENT_MAX_ASSESSMENTS: '0' }).maxAssessments, 200, 'the cap cannot be disabled with 0');
});

test('invalid-input backoff is exponential and bounded', () => {
  assert.equal(invalidInputBackoffMs(0), 0);
  assert.equal(invalidInputBackoffMs(1), 1_000);
  assert.equal(invalidInputBackoffMs(2), 2_000);
  assert.equal(invalidInputBackoffMs(3), 4_000);
  assert.equal(invalidInputBackoffMs(4), 8_000);
  assert.equal(invalidInputBackoffMs(30), 30_000);
});

test('job key follows the normalized URL and falls back to company and title', () => {
  assert.equal(assessmentJobKey({ url: 'https://Jobs.Example.com/roles/1/?utm_source=x#apply' }), assessmentJobKey({ url: 'https://jobs.example.com/roles/1' }));
  assert.notEqual(assessmentJobKey({ url: 'https://jobs.example.com/roles/1' }), assessmentJobKey({ url: 'https://jobs.example.com/roles/2' }));
  assert.equal(assessmentJobKey({ company: 'Acme', title: 'Engineer' }), assessmentJobKey({ company: ' acme ', title: 'ENGINEER' }));
  assert.equal(assessmentJobKey({}), null);
  assert.notEqual(assessmentInputDigest(job(1), target), assessmentInputDigest(job(1, { eligibility: 'unclear' }), target));
});

test('backs off exponentially and hard-stops after consecutive invalid input, then a success clears the streak', async (t) => {
  const directory = await stateDir(t);
  const clock = { ms: Date.parse('2026-10-22T00:00:00Z') };
  const { guard, sleeps, write } = memoryGuard(directory, { clock });
  const bad = new Error('job.description must be a non-empty string no longer than 40000 characters.');
  for (let i = 0; i < 4; i += 1) {
    const ticket = await guard.before(job(i, { description: '' }), target, write);
    const status = await guard.failure(ticket, bad, { invalidInput: true }, write);
    assert.equal(status.consecutiveInvalidInput, i + 1);
    assert.equal(status.stopped, false);
  }
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000], 'each retry after an invalid input waits twice as long');
  const fifth = await guard.before(job(5, { description: '' }), target, write);
  const status = await guard.failure(fifth, bad, { invalidInput: true }, write);
  assert.equal(status.stopped, true);
  assert.equal(status.stopReason, 'invalid_input');
  await assert.rejects(guard.before(job(6), target, write), (error) => {
    assert.ok(error instanceof AssessmentGuardStop);
    assert.match(error.message, /STOP the run now/);
    assert.match(error.message, /do not retry/);
    assert.match(error.message, /job\.description must be a non-empty string/);
    assert.match(error.message, /score guard-reset/);
    assert.equal(error.suppressTelemetry, false, 'the first refusal is reported');
    return true;
  });
  await assert.rejects(guard.before(job(7), target, write), (error) => error.suppressTelemetry === true);
  clock.ms += 31 * 60_000;
  const ticket = await guard.before(job(8), target, write);
  const ok = await guard.success(ticket, { score: 90, decision: 'review' }, write);
  assert.equal(ok.consecutiveInvalidInput, 0);
  assert.equal(ok.stopped, false);
});

test('non-invalid failures do not count toward the invalid-input stop', async (t) => {
  const directory = await stateDir(t);
  const clock = { ms: Date.parse('2026-10-22T00:00:00Z') };
  const { guard, write } = memoryGuard(directory, { clock });
  for (let i = 0; i < 8; i += 1) {
    const ticket = await guard.before(job(i), target, write);
    const status = await guard.failure(ticket, new Error('Cloud state unavailable'), { invalidInput: false }, write);
    assert.equal(status.consecutiveInvalidInput, 0);
    assert.equal(status.used, 0, 'a failed call releases its reserved assessment slot');
  }
});

test('caps new assessments per rolling window and lifts when the window rolls', async (t) => {
  const directory = await stateDir(t);
  const clock = { ms: Date.parse('2026-10-22T00:00:00Z') };
  const { guard, write } = memoryGuard(directory, { clock, env: { JOB_APPLICATION_AGENT_MAX_ASSESSMENTS: '3', JOB_APPLICATION_AGENT_ASSESSMENT_WINDOW_MINUTES: '60' } });
  for (let i = 0; i < 3; i += 1) {
    const ticket = await guard.before(job(i), target, write);
    await guard.success(ticket, { score: 50, decision: 'skip' }, write);
    clock.ms += 1_000;
  }
  await assert.rejects(guard.before(job(3), target, write), (error) => {
    assert.equal(error.reason, 'cap');
    assert.match(error.message, /3 jobs were already assessed in the last 60 minutes/);
    assert.match(error.message, /STOP assessing now/);
    assert.match(error.message, /JOB_APPLICATION_AGENT_MAX_ASSESSMENTS/);
    return true;
  });
  clock.ms += 61 * 60_000;
  const ticket = await guard.before(job(4), target, write);
  assert.ok(ticket.reservation);
});

test('identical repeat input returns the earlier result; a job is refused after 3 attempts; repeat loops hard-stop', async (t) => {
  const directory = await stateDir(t);
  const clock = { ms: Date.parse('2026-10-22T00:00:00Z') };
  const { guard, write } = memoryGuard(directory, { clock, env: { JOB_APPLICATION_AGENT_MAX_CONSECUTIVE_REPEATS: '4' } });
  const first = await guard.before(job(1), target, write);
  await guard.success(first, { score: 0, decision: 'ask', gates: [], reasons: [], gaps: ['x'] }, write);
  const repeat = await guard.before(job(1), target, write);
  assert.equal(repeat.cached.decision, 'ask');
  assert.equal(repeat.reservation, undefined, 'a repeat does not use an assessment slot');
  // New facts (eligibility confirmed) are a legitimate re-assessment, up to the per-job limit.
  const changed = await guard.before(job(1, { eligibility: 'unclear' }), target, write);
  assert.equal(changed.cached, undefined);
  await guard.success(changed, { score: 0, decision: 'ask' }, write);
  await assert.rejects(guard.before(job(1, { description: 'Another edit' }), target, write), (error) => {
    assert.equal(error.reason, 'same_job');
    assert.match(error.message, /already scored 3 times in this run/);
    return true;
  });
  for (let i = 0; i < 2; i += 1) await guard.before(job(1, { eligibility: 'unclear' }), target, write);
  await assert.rejects(guard.before(job(1, { eligibility: 'unclear' }), target, write), (error) => {
    assert.equal(error.reason, 'repeats');
    assert.match(error.message, /repeats of jobs already assessed/);
    assert.match(error.message, /STOP the loop now/);
    return true;
  });
  const status = await guard.status(write);
  assert.equal(status.stopped, true);
  const reset = await guard.reset(write);
  assert.equal(reset.stopped, false);
  assert.equal(reset.used, 0);
});

test('guard refusals are classified rate_limited, not invalid_input', () => {
  const error = new AssessmentGuardStop('Assessment guard stop: job.description must be a non-empty string', { reason: 'invalid_input', until: '2026-10-22T00:30:00Z' });
  assert.equal(telemetryErrorCode(error), 'rate_limited');
  assert.equal(telemetryErrorCategory(error), 'other');
  assert.equal(telemetryErrorCode(new Error('job.description must be a non-empty string')), 'invalid_input');
});

test('usage lists the guard commands', () => {
  assert.match(usageFor('score').usage[0], /guard \| guard-reset/);
});

test('CLI persists the invalid-input streak across invocations and refuses with a clear stop message', async (t) => {
  const directory = await stateDir(t);
  await disabledTelemetry(directory);
  const env = cliEnv(directory);
  for (let i = 0; i < 5; i += 1) {
    const result = await runCli(['score', '--stdin'], job(i, { description: '' }), env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /job\.description must be a non-empty string/);
    if (i === 4) assert.match(result.stderr, /STOP the run, fix the job JSON, and tell the user/);
  }
  const refused = await runCli(['score', '--stdin'], job(9), env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Assessment guard stop: 5 score calls in a row failed with invalid input/);
  assert.equal(refused.stdout, '');
  const status = JSON.parse((await runCli(['score', 'guard'], undefined, env)).stdout);
  assert.equal(status.stopped, true);
  assert.equal(status.stopReason, 'invalid_input');
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'assessment-guard.json'))).mode & 0o777, 0o600);
  const state = await readFile(join(directory, 'assessment-guard.json'), 'utf8');
  assert.equal(state.includes('Test Candidate'), false, 'guard state holds no profile data');
  assert.equal(/https?:\/\//.test(state), false, 'guard state holds hashed job keys, not URLs');
  const reset = JSON.parse((await runCli(['score', 'guard-reset'], undefined, env)).stdout);
  assert.equal(reset.reset, true);
  const ok = await runCli(['score', '--stdin'], job(10), env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).assessmentGuard.used, 1);
});

test('CLI caps assessments across invocations with a configurable limit', async (t) => {
  const directory = await stateDir(t);
  await disabledTelemetry(directory);
  const env = cliEnv(directory, { JOB_APPLICATION_AGENT_MAX_ASSESSMENTS: '2' });
  for (let i = 0; i < 2; i += 1) {
    const result = await runCli(['score', '--stdin'], job(i), env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).assessmentGuard.remaining, 1 - i);
  }
  const capped = await runCli(['score', '--stdin'], job(2), env);
  assert.equal(capped.code, 1);
  assert.match(capped.stderr, /2 jobs were already assessed in the last 360 minutes, the limit for one run\. STOP assessing now/);
});

test('CLI repeat of the same job emits no new assessment telemetry and stop refusals are reported once', async (t) => {
  const directory = await stateDir(t);
  const captured = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    try { captured.push(JSON.parse(raw)); } catch { /* ignore */ }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: true, disclosed: true, graceConsumed: true, installationEventPending: false, identityEnabled: false, contactEnabled: false, installationId: crypto.randomUUID(), token: 'synthetic-token', tokenExpiresAt: '2099-01-01T00:00:00Z' }));
  const env = cliEnv(directory, { JOB_APPLICATION_AGENT_TELEMETRY_URL: `http://127.0.0.1:${server.address().port}`, JOB_APPLICATION_AGENT_MAX_ASSESSMENTS: '1' });
  const first = await runCli(['score', '--stdin'], job(1), env);
  assert.equal(first.code, 0, first.stderr);
  const repeat = await runCli(['score', '--stdin'], job(1), env);
  assert.equal(repeat.code, 0, repeat.stderr);
  const repeated = JSON.parse(repeat.stdout);
  assert.equal(repeated.repeatAssessment, true);
  assert.equal(repeated.decision, JSON.parse(first.stdout).decision);
  assert.equal(captured.filter((body) => body.event === 'job_assessed').length, 1, 'a repeat is not a new assessment');
  for (let i = 2; i < 5; i += 1) {
    const refused = await runCli(['score', '--stdin'], job(i), env);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /STOP assessing now/);
  }
  const errors = captured.filter((body) => body.event === 'skill_error');
  assert.equal(errors.length, 1, 'only the first refusal of a stop is reported');
  assert.equal(errors[0].properties.errorCode, 'rate_limited');
  assert.equal(errors[0].properties.stage, 'assessment');
  assert.equal(captured.filter((body) => body.event === 'job_assessed').length, 1);
});
