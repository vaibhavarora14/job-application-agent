import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildReview, scoreJob, validateLedgerEntry, validateProfile } from '../scripts/job-application.mjs';

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
  assert.throws(() => validateLedgerEntry({ ...entry, status: 'draft' }), /submitted/);
});

test('requires review at each ten confirmed submissions', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ status: 'submitted', submittedAt: `2026-01-${String(index + 1).padStart(2, '0')}T10:00:00Z` }));
  assert.equal(buildReview(entries).reviewDue, true);
  assert.equal(buildReview(entries.slice(0, 9)).reviewDue, false);
});

test('deduplicates ledger entries by normalized URL', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = new URL('../scripts/job-application.mjs', import.meta.url).pathname;
  const entry = {
    id: 'example-role-1', company: 'Example', role: 'Senior Product Engineer', url: 'https://jobs.example.com/123?utm_source=x', source: 'company', score: 80, status: 'submitted', submittedAt: '2026-01-15T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {},
  };
  const env = { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: directory };
  execFileSync(process.execPath, [script, 'ledger', 'add', '--stdin'], { input: JSON.stringify(entry), env, encoding: 'utf8' });
  const duplicate = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], { input: JSON.stringify({ id: 'different', url: 'https://jobs.example.com/123?ref=friend' }), env, encoding: 'utf8' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal((await stat(join(directory, 'applications.ndjson'))).mode & 0o777, 0o600);
});
