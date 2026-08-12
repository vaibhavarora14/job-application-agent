import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildReview, commandCategory, durationBucket, scoreJob, telemetryJobAssessed, validateLedgerEntry, validateProfile, validateSubmissionTelemetry } from '../scripts/job-application.mjs';

const target = {
  name: 'Test Candidate',
  email: 'candidate@example.com',
  phone: '+1 555 0100',
  location: 'Toronto, Canada',
  workAuthorization: 'Canada',
  roleFamilies: ['product engineer', 'backend engineer'],
  seniority: ['senior', 'staff'],
  skills: ['TypeScript', 'Python', 'React'],
  targetLocations: ['Canada', 'Remote'],
  excludedLocations: ['United States only'],
  workModes: ['remote'],
  industries: ['AI'],
  excludedCompanies: ['Blocked Corp'],
  submissionMode: 'review-each',
};

test('validates a candidate-defined target profile', () => {
  assert.equal(validateProfile(target).name, 'Test Candidate');
  assert.throws(() => validateProfile({ ...target, roleFamilies: [] }), /non-empty/);
  assert.throws(() => validateProfile({ ...target, submissionMode: 'always' }), /review-each/);
});

test('scores a matching role from candidate preferences', () => {
  const result = scoreJob({
    title: 'Senior Product Engineer',
    company: 'Example AI',
    description: 'Build AI products with TypeScript, React and Python.',
    source: 'greenhouse',
    eligibility: 'eligible',
    remote: true,
    locations: ['Remote', 'Canada'],
  }, target);
  assert.equal(result.decision, 'review');
  assert.ok(result.score >= 60);
});

test('excludes explicit ineligibility and candidate exclusions', () => {
  assert.equal(scoreJob({
    title: 'Staff Backend Engineer', company: 'Example', description: 'Python', source: 'lever', eligibility: 'ineligible', remote: true, locations: ['Canada'],
  }, target).decision, 'exclude');
  assert.equal(scoreJob({
    title: 'Staff Backend Engineer', company: 'Blocked Corp Ltd', description: 'Python', source: 'lever', eligibility: 'eligible', remote: true, locations: ['Canada'],
  }, target).decision, 'exclude');
});

test('pauses on unclear eligibility', () => {
  const result = scoreJob({
    title: 'Senior Backend Engineer', company: 'Example', description: 'Python', source: 'company', eligibility: 'unclear', remote: true, locations: ['Remote'],
  }, target);
  assert.equal(result.decision, 'ask');
});

test('accepts only confirmed submission ledger shapes', () => {
  const entry = {
    id: 'example-senior-product-engineer-2026-01-15',
    company: 'Example',
    role: 'Senior Product Engineer',
    url: 'https://jobs.example.com/123',
    source: 'company',
    score: 80,
    status: 'submitted',
    submittedAt: '2026-01-15T10:00:00.000Z',
    approval: 'APPROVE SUBMIT',
    answers: {},
  };
  assert.deepEqual(validateLedgerEntry(entry), entry);
  assert.equal(validateLedgerEntry({ ...entry, id: 'workday-role', source: 'workday' }).source, 'workday');
  assert.throws(() => validateLedgerEntry({ ...entry, status: 'draft' }), /submitted/);
});

test('validates structured submission metrics without adding them to the ledger shape', () => {
  const metrics = { durationBucket: '5-15m', fieldsFilled: 14, shortAnswerCount: 2, resumeUploaded: true };
  assert.deepEqual(validateSubmissionTelemetry(metrics), metrics);
  assert.throws(() => validateSubmissionTelemetry({ ...metrics, note: 'private text' }), /unknown/i);
  assert.throws(() => validateSubmissionTelemetry({ ...metrics, fieldsFilled: 1.5 }), /integer/i);
});

test('requires review at each ten confirmed submissions', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ status: 'submitted', submittedAt: `2026-01-${String(index + 1).padStart(2, '0')}T10:00:00Z` }));
  assert.equal(buildReview(entries).reviewDue, true);
  assert.equal(buildReview(entries.slice(0, 9)).reviewDue, false);
  const withOutcome = entries.map((entry, index) => index === 0 ? { ...entry, status: 'interview' } : entry);
  assert.equal(buildReview(withOutcome).submittedTotal, 10);
  assert.equal(buildReview(withOutcome).outcomeCounts.interview, 1);
  assert.equal(buildReview(withOutcome).reviewDue, true);
});

test('deduplicates ledger entries by normalized URL', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = new URL('../scripts/job-application.mjs', import.meta.url).pathname;
  const entry = {
    id: 'example-role-1', company: 'Example', role: 'Senior Product Engineer', url: 'https://jobs.example.com/123?utm_source=x', source: 'company', score: 80, status: 'submitted', submittedAt: '2026-01-15T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {},
    telemetry: { durationBucket: '5-15m', fieldsFilled: 14, shortAnswerCount: 2, resumeUploaded: true },
  };
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const env = { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: directory };
  execFileSync(process.execPath, [script, 'ledger', 'add', '--stdin'], { input: JSON.stringify(entry), env, encoding: 'utf8' });
  const duplicate = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], { input: JSON.stringify({ id: 'different', url: 'https://jobs.example.com/123?ref=friend' }), env, encoding: 'utf8' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal((await readFile(join(directory, 'applications.ndjson'), 'utf8')).includes('telemetry'), false);
  assert.equal((await stat(join(directory, 'applications.ndjson'))).mode & 0o777, 0o600);
});

test('maps commands and durations to bounded telemetry categories', () => {
  assert.equal(commandCategory(['ledger', 'add', '--stdin']), 'apply');
  assert.equal(commandCategory(['ledger', 'outcome', '--stdin']), 'outcome');
  assert.equal(commandCategory(['score', '--stdin']), 'assess');
  assert.equal(durationBucket(700), 'under-1s');
  assert.equal(durationBucket(70_000), '1-2m');
  assert.equal(durationBucket(2_000_000), '15m-plus');
});

test('builds a structured assessment event without description or candidate profile data', async () => {
  const job = {
    title: 'Senior Product Engineer', company: 'Example AI', description: 'private long job description', source: 'greenhouse', eligibility: 'eligible',
    remote: true, locations: ['Remote'], url: 'https://jobs.example.com/123?candidate=secret',
  };
  const result = scoreJob(job, target);
  const event = await telemetryJobAssessed(job, result);
  assert.equal(event.event, 'job_assessed');
  assert.equal(event.properties.company, 'Example AI');
  assert.equal('description' in event.properties, false);
  assert.equal(JSON.stringify(event).includes('candidate=secret'), false);
  assert.equal(JSON.stringify(event).includes('Test Candidate'), false);
});

test('telemetry CLI controls are private and reset removes anonymous credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-telemetry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = new URL('../scripts/job-application.mjs', import.meta.url).pathname;
  const env = { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: directory, JOB_APPLICATION_AGENT_TELEMETRY_URL: 'https://relay.invalid' };
  const disabled = JSON.parse(execFileSync(process.execPath, [script, 'telemetry', 'disable'], { env, encoding: 'utf8' }));
  assert.equal(disabled.enabled, false);
  const reset = JSON.parse(execFileSync(process.execPath, [script, 'telemetry', 'reset'], { env, encoding: 'utf8' }));
  assert.equal(reset.hasInstallationId, false);
  assert.equal((await stat(join(directory, 'telemetry.json'))).mode & 0o777, 0o600);
});
