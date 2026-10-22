import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withTestReview } from './support/review-approval.mjs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import {
  assertAndRecordThinOverrideUse,
  assertSubmissionFillGuard,
  buildReview,
  commandCategory,
  durationBucket,
  entryOriginForFillMetrics,
  isLoggedNotAgentFilled,
  isThinSubmission,
  LOGGED_ENTRY_ORIGIN,
  JOB_APPROVAL_REVIEW_EACH,
  migrateProfile,
  normalizeSubmissionMode,
  stampSubmissionModeChoice,
  SUBMISSION_MODE_RESET_NOTICE,
  normalizeJobApprovalMode,
  normalizeThinSubmissionOverride,
  PROFILE_ONE_CLICK_CHANNEL,
  profileStatus,
  resolveSubmissionFillMetrics,
  routineAutoProfileThinSubmitError,
  scoreJob,
  telemetryApplicationPaused,
  telemetryApplicationSkipped,
  telemetryApplicationStarted,
  telemetryApplicationSubmitted,
  telemetryErrorCategory,
  telemetryErrorCode,
  telemetryJobAssessed,
  THIN_SUBMISSION_OVERRIDE,
  validateLedgerCheckCandidate,
  validateLedgerEntry,
  validateProfile,
  validateSubmissionTelemetry,
} from '../scripts/job-application.mjs';
import { validateEvent } from '../scripts/telemetry-schema.mjs';

const thinOverride = (note = 'Candidate confirmed in chat that this empty ATS accept is intentional') => ({
  acknowledgment: THIN_SUBMISSION_OVERRIDE,
  candidateConfirmation: note,
});

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
  mustHaves: [
    { requirement: 'TypeScript', status: 'met', evidence: 'Resume skills and shipped products' },
    { requirement: 'React', status: 'met', evidence: 'Multiple production roles' },
    { requirement: 'Python', status: 'partial', evidence: 'Snorkel and Juvoxa' },
  ],
};

function isolatedCliEnv(directory) {
  return {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    // Never read the host's real stored profile (the ledger guard consults submissionMode).
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `job-application-agent-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
}

function runCli(script, args, input, env, runtimeArgs = []) {
  input = withTestReview(env, args, input);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...runtimeArgs, script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('validates a candidate-defined target profile', () => {
  assert.equal(validateProfile(target).name, 'Test Candidate');
  assert.throws(() => validateProfile({ ...target, roleFamilies: [] }), /non-empty/);
  assert.throws(() => validateProfile({ ...target, submissionMode: 'always' }), /review-each/);
});

test('returns the canonical resume path for direct browser uploads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-resume-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const resume = join(directory, 'resume.pdf');
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  await writeFile(resume, '%PDF-1.7\ncanonical resume fixture');
  const env = isolatedCliEnv(directory);

  const result = JSON.parse(execFileSync(process.execPath, [script, 'resume', 'path'], { env, encoding: 'utf8' }));

  assert.deepEqual(result, { path: resume });
});

test('returns a verified local resume cache while configured cloud storage is offline', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-offline-resume-'));
  const cloudDirectory = await mkdtemp(join(tmpdir(), 'public-job-agent-offline-cloud-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(cloudDirectory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const resume = join(directory, 'resume.pdf');
  const configPath = join(cloudDirectory, 'config.json');
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  await writeFile(resume, '%PDF-1.7\ncached resume fixture');
  await writeFile(configPath, JSON.stringify({ version: 2, url: 'https://127.0.0.1:9', token: 'offline-client-token-with-sufficient-length', clientId: 'offline-client' }), { mode: 0o600 });
  const env = { ...isolatedCliEnv(directory), JOB_APPLICATION_AGENT_CLOUD_CONFIG: configPath };

  const result = JSON.parse(execFileSync(process.execPath, [script, 'resume', 'path'], { env, encoding: 'utf8' }));

  assert.deepEqual(result, { path: resume });
});

test('preserves the Linux secret-tool install error for profile-dependent commands', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-agent-linux-profile-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const platformOverride = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process, 'platform', { value: 'linux' });")}`;
  const env = { ...isolatedCliEnv(directory), PATH: '' };

  const result = await runCli(script, ['profile', 'field', 'name'], undefined, env, ['--import', platformOverride]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /secret-tool is not installed/);
  assert.doesNotMatch(result.stderr, /profile needs migration/i);
});

test('preserves an unavailable Linux Secret Service error for profile-dependent commands', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-agent-linux-service-error-'));
  const toolDirectory = await mkdtemp(join(tmpdir(), 'job-agent-secret-tool-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(toolDirectory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const toolPath = join(toolDirectory, 'secret-tool');
  const toolSource = '#!/bin/sh\nprintf "%s\\n" "secret-tool: Secret Service is unavailable" >&2\nexit 1\n';
  await writeFile(toolPath, toolSource, { mode: 0o755 });
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const platformOverride = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process, 'platform', { value: 'linux' });")}`;
  const env = { ...isolatedCliEnv(directory), PATH: toolDirectory };

  const result = await runCli(script, ['profile', 'field', 'name'], undefined, env, ['--import', platformOverride]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Secret Service could not read the profile/);
  assert.doesNotMatch(result.stderr, /profile needs migration/i);
});

test('migrates a legacy profile without discarding identity or salary preference', () => {
  const legacy = {
    name: 'Test Candidate', email: 'candidate@example.com', phone: '+1 555 0100',
    location: 'Bengaluru, India', workAuthorization: 'India', linkedin: 'https://linkedin.com/in/example',
    salaryPreference: 'INR 90 lakh annually',
  };
  const migrated = migrateProfile(legacy, {});
  assert.equal(migrated.name, legacy.name);
  assert.equal(migrated.targetCompensation, legacy.salaryPreference);
  assert.deepEqual(migrated.roleFamilies, ['product-engineering', 'full-stack', 'ai-ml']);
  assert.deepEqual(migrated.seniority, ['senior', 'staff']);
  assert.equal(migrated.submissionMode, 'review-each');
  assert.equal(migrated.autoSubmitMinScore, 80);
  assert.equal(migrated.manualReviewMinScore, 70);
  assert.equal(migrated.minMustHaveCoverage, 70);
  assert.equal(profileStatus(legacy).configured, false);
  assert.ok(profileStatus(legacy).legacyFields.includes('salaryPreference'));
  assert.equal(profileStatus(migrated).configured, true);
  const customized = migrateProfile({ ...migrated, autoSubmitMinScore: 85 }, {});
  assert.equal(customized.autoSubmitMinScore, 85);
});

test('scores a matching role from candidate preferences', () => {
  const result = scoreJob(matchingJob, target);
  assert.equal(result.decision, 'review');
  assert.equal(result.autoEligible, true);
  assert.equal(result.mustHaveCoverage, 83);
  assert.ok(result.score >= 80);
  assert.equal(scoreJob({ ...matchingJob, discoverySourceId: 'community-abcdef1234567890' }, target).decision, 'review');
});

test('applies posting, eligibility, work-mode, seniority and evidence gates before auto-submit', () => {
  assert.equal(scoreJob({ ...matchingJob, postingStatus: 'closed' }, target).decision, 'exclude');
  assert.equal(scoreJob({ ...matchingJob, postingStatus: 'unclear' }, target).decision, 'ask');
  assert.equal(scoreJob({ ...matchingJob, eligibility: 'ineligible' }, target).decision, 'exclude');
  assert.equal(scoreJob({ ...matchingJob, eligibility: 'unclear' }, target).decision, 'ask');
  assert.equal(scoreJob({ ...matchingJob, workMode: 'onsite' }, target).decision, 'exclude');
  assert.equal(scoreJob({ ...matchingJob, seniority: 'principal' }, target).decision, 'skip');
  assert.equal(scoreJob({ ...matchingJob, mustHaves: undefined }, target).decision, 'ask');
  assert.equal(scoreJob({ ...matchingJob, mustHaves: [{ requirement: 'Rust', status: 'unclear' }] }, target).decision, 'ask');
  assert.equal(scoreJob({ ...matchingJob, mustHaves: [{ requirement: 'Rust', status: 'missing' }] }, target).decision, 'skip');
});

test('keeps 70-79 scores manual and caps experience mismatches below auto-submit', () => {
  const manualRequirements = Array.from({ length: 10 }, (_, index) => ({ requirement: `Requirement ${index + 1}`, status: index < 7 ? 'met' : 'missing' }));
  const manual = scoreJob({ ...matchingJob, description: 'General software products', mustHaves: manualRequirements }, target);
  assert.equal(manual.decision, 'review');
  assert.equal(manual.autoEligible, false);
  assert.ok(manual.score >= 70 && manual.score < 80);

  const overlevel = scoreJob({ ...matchingJob, experienceMin: 2, experienceMax: 5 }, target);
  assert.equal(overlevel.decision, 'review');
  assert.equal(overlevel.autoEligible, false);
  assert.ok(overlevel.score <= 79);

  const customTarget = { ...target, seniority: [...target.seniority, 'lead'] };
  const lead = scoreJob({ ...matchingJob, seniority: 'lead' }, customTarget);
  assert.equal(lead.decision, 'review');
  assert.equal(lead.autoEligible, false);
});

test('skips published compensation below a comparable configured floor', () => {
  const compensatedTarget = { ...target, compensationFloor: { amount: 9000000, currency: 'INR', period: 'year' } };
  assert.equal(scoreJob({ ...matchingJob, salaryMaximum: 6000000, salaryCurrency: 'INR' }, compensatedTarget).decision, 'skip');
  const unknown = scoreJob({ ...matchingJob, salaryMaximum: undefined, salaryCurrency: undefined }, compensatedTarget);
  assert.equal(unknown.decision, 'review');
  assert.equal(unknown.autoEligible, true);
});

test('regresses the five confirmed rejection patterns', () => {
  const dave = scoreJob({ ...matchingJob, company: 'Dave Evans', title: 'Founding Engineer', postingStatus: 'closed', seniority: 'founding' }, target);
  assert.equal(dave.decision, 'exclude');

  const launchDarkly = scoreJob({ ...matchingJob, company: 'LaunchDarkly', eligibility: 'ineligible' }, target);
  assert.equal(launchDarkly.decision, 'exclude');

  const playPower = scoreJob({ ...matchingJob, company: 'PlayPower Labs', experienceMin: 2, experienceMax: 5 }, target);
  assert.equal(playPower.decision, 'review');
  assert.equal(playPower.autoEligible, false);
  assert.ok(playPower.score <= 79);

  const railway = scoreJob({
    ...matchingJob,
    company: 'Railway',
    mustHaves: [
      { requirement: 'TypeScript', status: 'met' },
      { requirement: 'React product architecture', status: 'met' },
      { requirement: 'Complex asynchronous deployment jobs', status: 'partial' },
      { requirement: 'GraphQL', status: 'missing' },
      { requirement: 'Temporal or Rust', status: 'missing' },
    ],
  }, target);
  assert.equal(railway.decision, 'skip');
  assert.equal(railway.autoEligible, false);

  const holepunch = scoreJob({
    ...matchingJob,
    company: 'Holepunch',
    title: 'Senior Node.js Software Engineer',
    postingStatus: 'closed',
    mustHaves: [{ requirement: 'P2P networking', status: 'missing' }],
  }, target);
  assert.equal(holepunch.decision, 'exclude');
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
  assert.deepEqual(validateLedgerEntry(entry), { ...entry, applyKind: 'live' });
  assert.equal(validateLedgerEntry({ ...entry, employerJobId: 'greenhouse:123' }).employerJobId, 'greenhouse:123');
  assert.equal(validateLedgerEntry({ ...entry, id: 'workday-role', source: 'workday' }).source, 'workday');
  assert.equal(validateLedgerEntry({ ...entry, applyKind: 'fixture' }).applyKind, 'fixture');
  assert.throws(() => validateLedgerEntry({ ...entry, status: 'draft' }), /submitted/);
  assert.throws(() => validateLedgerEntry({ ...entry, applyKind: 'demo' }), /applyKind/);
});

test('validates structured submission metrics without adding them to the ledger shape', () => {
  const metrics = { durationBucket: '5-15m', fieldsFilled: 14, shortAnswerCount: 2, resumeUploaded: true };
  // An explicit résumé upload implies the form had a résumé/CV field.
  assert.deepEqual(validateSubmissionTelemetry(metrics), { ...metrics, resumeFieldPresent: true });
  assert.deepEqual(validateSubmissionTelemetry({ durationMs: 70_000, fieldsFilled: 3, resumeUploaded: false }), {
    fieldsFilled: 3, resumeUploaded: false, durationBucket: '1-2m',
  });
  assert.equal(validateSubmissionTelemetry({ startedAt: '2026-10-13T10:00:00.000Z', endedAt: '2026-10-13T10:08:00.000Z' }).durationBucket, '5-15m');
  assert.throws(() => validateSubmissionTelemetry({ ...metrics, fieldsFilled: 1.5 }), /integer/i);
});

test('strips unknown telemetry keys with a warning, keeps valid ones, and hard-rejects PII', () => {
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return originalWrite.call(process.stderr, chunk, ...rest);
  };
  try {
    assert.deepEqual(validateSubmissionTelemetry({
      fieldsFilled: 9,
      resumeUploaded: true,
      durationBucket: '2-5m',
      otpVerified: true,
      otpVerifiedAt: '2026-10-15T04:00:00.000Z',
      mysteryAgentFlag: true,
    }), {
      fieldsFilled: 9,
      resumeUploaded: true,
      durationBucket: '2-5m',
      otpVerified: true,
      resumeFieldPresent: true,
    });
    assert.match(writes.join(''), /dropped unknown entry\.telemetry properties: otpVerifiedAt, mysteryAgentFlag/);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.throws(
    () => validateSubmissionTelemetry({ fieldsFilled: 3, resumeUploaded: true, candidateName: 'Ada' }),
    /PII property: candidateName/,
  );
  assert.throws(
    () => validateSubmissionTelemetry({ fieldsFilled: 3, resumeUploaded: true, email: 'ada@example.com' }),
    /PII property: email/,
  );
  assert.throws(
    () => validateSubmissionTelemetry({ fieldsFilled: 3, resumeUploaded: true, identity: { name: 'Ada' } }),
    /PII property: identity/,
  );
  assert.throws(
    () => validateSubmissionTelemetry({ fieldsFilled: 3, resumeUploaded: true, otpVerified: 'yes' }),
    /otpVerified must be a Boolean/,
  );
});

test('resolves fill metrics from telemetry counts or answer keys without storing values', () => {
  assert.deepEqual(resolveSubmissionFillMetrics({ answers: {} }, {}), {
    fieldsFilled: 0, shortAnswerCount: 0, resumeUploaded: false, fillMetricsSource: 'empty',
  });
  assert.equal(resolveSubmissionFillMetrics({
    answers: { 'Full name': 'redacted', Resume: 'uploaded' },
  }, {}).fieldsFilled, 2);
  assert.equal(resolveSubmissionFillMetrics({
    answers: { 'Full name': 'redacted', Resume: 'uploaded' },
  }, {}).resumeUploaded, true);
  assert.equal(resolveSubmissionFillMetrics({
    answers: { 'Full name': 'redacted', Resume: 'uploaded' },
  }, {}).fillMetricsSource, 'answer_keys');
  assert.deepEqual(resolveSubmissionFillMetrics({ answers: {} }, { fieldsFilled: 12, resumeUploaded: true }), {
    fieldsFilled: 12, shortAnswerCount: 11, resumeUploaded: true, fillMetricsSource: 'telemetry',
  });
});

test('guards empty ledger submissions unless thin override, profile one-click, or fixture apply', () => {
  const live = { applyKind: 'live', answers: {}, approval: 'APPROVE SUBMIT' };
  assert.throws(() => assertSubmissionFillGuard(live, resolveSubmissionFillMetrics(live, {})), /fieldsFilled/);
  assert.throws(
    () => assertSubmissionFillGuard(live, resolveSubmissionFillMetrics(live, { fieldsFilled: 0, resumeUploaded: false })),
    /looks empty/i,
  );
  assert.throws(
    () => assertSubmissionFillGuard(
      live,
      resolveSubmissionFillMetrics(live, { fieldsFilled: 0, resumeUploaded: false }),
      THIN_SUBMISSION_OVERRIDE,
    ),
    /must be an object/i,
  );
  assert.throws(
    () => assertSubmissionFillGuard(
      { ...live, approval: 'STANDING AUTHORIZATION' },
      resolveSubmissionFillMetrics(live, { fieldsFilled: 0, resumeUploaded: false }),
      thinOverride(),
    ),
    /routine-auto|unattended|STANDING AUTHORIZATION/i,
  );
  assert.throws(
    () => assertSubmissionFillGuard(
      live,
      resolveSubmissionFillMetrics(live, { fieldsFilled: 0, resumeUploaded: false }),
      thinOverride(),
      { approvalMode: 'routine-auto' },
    ),
    /routine-auto|unattended/i,
  );
  const attended = assertSubmissionFillGuard(
    live,
    resolveSubmissionFillMetrics(live, { fieldsFilled: 0, resumeUploaded: false }),
    thinOverride('Candidate confirmed empty apply for role A in conversation'),
  );
  assert.equal(attended.thinSubmissionOverrideUsed, true);
  assert.equal(attended.path, 'thin_override');

  const oneClick = assertSubmissionFillGuard(
    { ...live, applicationChannel: PROFILE_ONE_CLICK_CHANNEL, approval: 'STANDING AUTHORIZATION' },
    resolveSubmissionFillMetrics(live, { fieldsFilled: 0, resumeUploaded: false, profileResumeOnFile: true }),
  );
  assert.equal(oneClick.path, 'profile_one_click');
  assert.equal(oneClick.thinSubmissionOverrideUsed, false);

  assert.doesNotThrow(() => assertSubmissionFillGuard(
    live,
    resolveSubmissionFillMetrics(live, { fieldsFilled: 9, resumeUploaded: true }),
  ));
  assert.doesNotThrow(() => assertSubmissionFillGuard(
    { applyKind: 'fixture', answers: {} },
    resolveSubmissionFillMetrics({ answers: {} }, {}),
  ));
});

test('normalizes thin override objects and rejects bare strings', () => {
  assert.throws(() => normalizeThinSubmissionOverride(THIN_SUBMISSION_OVERRIDE), /must be an object/i);
  assert.throws(() => normalizeThinSubmissionOverride({ acknowledgment: THIN_SUBMISSION_OVERRIDE, candidateConfirmation: 'too short' }), /16/);
  const note = 'Candidate confirmed this empty ATS accept for Acme Eng in chat';
  assert.deepEqual(normalizeThinSubmissionOverride(thinOverride(note)), {
    acknowledgment: THIN_SUBMISSION_OVERRIDE,
    candidateConfirmation: note,
  });
});

test('blocks ledger add for empty fill metrics without thin override', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-empty-submit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const env = isolatedCliEnv(directory);
  const base = {
    id: 'empty-submit-role', company: 'Example', role: 'Engineer', url: 'https://jobs.example.com/empty-submit',
    source: 'lever', score: 80, status: 'submitted', submittedAt: '2026-10-13T18:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {},
  };
  const missing = await runCli(script, ['ledger', 'add', '--stdin'], base, env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /fieldsFilled/);
  const zero = await runCli(script, ['ledger', 'add', '--stdin'], {
    ...base, telemetry: { fieldsFilled: 0, resumeUploaded: false, durationBucket: 'under-1s' },
  }, env);
  assert.equal(zero.code, 1);
  assert.match(zero.stderr, /looks empty/i);
  const routineRejected = await runCli(script, ['ledger', 'add', '--stdin'], {
    ...base,
    id: 'empty-submit-routine-ack',
    url: 'https://jobs.example.com/empty-submit-routine-ack',
    telemetry: { fieldsFilled: 0, resumeUploaded: false, durationBucket: 'under-1s' },
    thinSubmissionOverride: thinOverride('Candidate confirmed empty apply for routine batch job one'),
  }, env);
  assert.equal(routineRejected.code, 1);
  assert.match(routineRejected.stderr, /routine-auto|STANDING AUTHORIZATION|unattended/i);
  const bareString = await runCli(script, ['ledger', 'add', '--stdin'], {
    ...base,
    id: 'empty-submit-bare',
    approval: 'APPROVE SUBMIT',
    url: 'https://jobs.example.com/empty-submit-bare',
    telemetry: { fieldsFilled: 0, resumeUploaded: false, durationBucket: 'under-1s' },
    thinSubmissionOverride: THIN_SUBMISSION_OVERRIDE,
  }, env);
  assert.equal(bareString.code, 1);
  assert.match(bareString.stderr, /must be an object/i);
  const allowed = await runCli(script, ['ledger', 'add', '--stdin'], {
    ...base,
    id: 'empty-submit-ack',
    company: 'Empty Ack Co',
    role: 'Empty Apply Engineer',
    approval: 'APPROVE SUBMIT',
    url: 'https://jobs.example.com/empty-submit-ack',
    telemetry: { fieldsFilled: 0, resumeUploaded: false, durationBucket: 'under-1s' },
    thinSubmissionOverride: thinOverride('Candidate confirmed empty apply for Empty Ack Co Engineer in chat'),
  }, env);
  assert.equal(allowed.code, 0, allowed.stderr);
  const reused = await runCli(script, ['ledger', 'add', '--stdin'], {
    ...base,
    id: 'empty-submit-reuse',
    company: 'Reuse Co',
    role: 'Reuse Engineer',
    approval: 'APPROVE SUBMIT',
    url: 'https://jobs.example.com/empty-submit-reuse',
    telemetry: { fieldsFilled: 0, resumeUploaded: false, durationBucket: 'under-1s' },
    thinSubmissionOverride: thinOverride('Candidate confirmed empty apply for Empty Ack Co Engineer in chat'),
  }, env);
  assert.equal(reused.code, 1);
  assert.match(reused.stderr, /already used for a different job/i);
  const oneClick = await runCli(script, ['ledger', 'add', '--stdin'], {
    ...base,
    id: 'hirist-one-click',
    company: 'Hirist Co',
    role: 'Backend Engineer',
    url: 'https://www.hirist.tech/j/example-role-1',
    source: 'other',
    applicationChannel: PROFILE_ONE_CLICK_CHANNEL,
    telemetry: { fieldsFilled: 0, resumeUploaded: false, profileResumeOnFile: true, durationBucket: 'under-1s' },
  }, env);
  assert.equal(oneClick.code, 0, oneClick.stderr);
  const filled = await runCli(script, ['ledger', 'add', '--stdin'], {
    ...base,
    id: 'filled-submit-role',
    company: 'Filled Co',
    role: 'Filled Apply Engineer',
    url: 'https://jobs.example.com/filled-submit',
    telemetry: { fieldsFilled: 11, shortAnswerCount: 2, resumeUploaded: true, durationBucket: '5-15m' },
  }, env);
  assert.equal(filled.code, 0, filled.stderr);
});

test('records thin override use per confirmation digest and emits override telemetry flag', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-thin-override-'));
  const previousStateDir = process.env.JOB_APPLICATION_AGENT_STATE_DIR;
  process.env.JOB_APPLICATION_AGENT_STATE_DIR = directory;
  t.after(async () => {
    if (previousStateDir == null) delete process.env.JOB_APPLICATION_AGENT_STATE_DIR;
    else process.env.JOB_APPLICATION_AGENT_STATE_DIR = previousStateDir;
    await rm(directory, { recursive: true, force: true });
  });
  const note = 'Candidate confirmed empty apply for Override Co role in conversation';
  await assertAndRecordThinOverrideUse(note, 'https://jobs.example.com/thin-a');
  await assert.rejects(
    () => assertAndRecordThinOverrideUse(note, 'https://jobs.example.com/thin-b'),
    /already used for a different job/i,
  );
  await assertAndRecordThinOverrideUse(note, 'https://jobs.example.com/thin-a?utm=1');
  const entry = {
    company: 'Override Co', role: 'Engineer', url: 'https://jobs.example.com/thin-telemetry',
    source: 'other', approval: 'APPROVE SUBMIT', answers: {},
  };
  const used = await telemetryApplicationSubmitted(entry, {
    telemetrySupplied: true,
    fillMetricsSource: 'telemetry',
    fieldsFilled: 0,
    resumeUploaded: false,
    durationBucket: 'under-1s',
    thinSubmissionOverrideUsed: true,
  });
  assert.equal(used.properties.thinSubmissionOverrideUsed, true);
  const unused = await telemetryApplicationSubmitted(entry, {
    telemetrySupplied: true,
    fillMetricsSource: 'telemetry',
    fieldsFilled: 4,
    resumeUploaded: true,
    durationBucket: '2-5m',
  });
  assert.equal('thinSubmissionOverrideUsed' in unused.properties, false);
});

test('validates optional resumeFieldPresent as a Boolean and infers it only from an explicit upload', () => {
  // Agent-reported: true = form had a résumé/CV upload field, false = it had none.
  assert.equal(validateSubmissionTelemetry({ fieldsFilled: 6, resumeUploaded: false, resumeFieldPresent: false }).resumeFieldPresent, false);
  assert.equal(validateSubmissionTelemetry({ fieldsFilled: 6, resumeUploaded: false, resumeFieldPresent: true }).resumeFieldPresent, true);
  assert.equal(validateSubmissionTelemetry({ fieldsFilled: 6, resumeUploaded: true, resumeFieldPresent: true }).resumeFieldPresent, true);
  // Unknown stays unknown: no key at all.
  assert.equal('resumeFieldPresent' in validateSubmissionTelemetry({ fieldsFilled: 6, resumeUploaded: false }), false);
  assert.equal('resumeFieldPresent' in validateSubmissionTelemetry({ fieldsFilled: 6 }), false);
  assert.equal('resumeFieldPresent' in validateSubmissionTelemetry({ fieldsFilled: 6, resumeUploaded: false, resumeFieldPresent: null }), false);
  // Explicit upload implies a field.
  assert.equal(validateSubmissionTelemetry({ fieldsFilled: 6, resumeUploaded: true }).resumeFieldPresent, true);
  for (const bad of ['yes', 'true', 1, 0, {}, []]) {
    assert.throws(() => validateSubmissionTelemetry({ fieldsFilled: 6, resumeUploaded: false, resumeFieldPresent: bad }), /resumeFieldPresent must be a Boolean/);
  }
  assert.throws(
    () => validateSubmissionTelemetry({ fieldsFilled: 6, resumeUploaded: true, resumeFieldPresent: false }),
    /resumeFieldPresent cannot be false when resumeUploaded is true/,
  );
  // Answer-key heuristics never fabricate the field.
  const fromKeys = resolveSubmissionFillMetrics({ answers: { Resume: 'uploaded', Email: 'filled' } }, {});
  assert.equal(fromKeys.resumeUploaded, true);
  assert.equal('resumeFieldPresent' in fromKeys, false);
  assert.equal(resolveSubmissionFillMetrics({ answers: {} }, { fieldsFilled: 3, resumeUploaded: false, resumeFieldPresent: false }).resumeFieldPresent, false);
});

test('application_submitted carries resumeFieldPresent only when known and still validates', async () => {
  const entry = {
    company: 'Field Co', role: 'Engineer', url: 'https://jobs.example.com/resume-field',
    source: 'greenhouse', approval: 'STANDING AUTHORIZATION', answers: {},
  };
  const base = { telemetrySupplied: true, fillMetricsSource: 'telemetry', fieldsFilled: 5, shortAnswerCount: 1, durationBucket: '2-5m' };
  const present = await telemetryApplicationSubmitted(entry, { ...base, resumeUploaded: true, resumeFieldPresent: true });
  assert.equal(present.properties.resumeFieldPresent, true);
  const none = await telemetryApplicationSubmitted(entry, { ...base, resumeUploaded: false, resumeFieldPresent: false });
  assert.equal(none.properties.resumeFieldPresent, false);
  const unknown = await telemetryApplicationSubmitted(entry, { ...base, resumeUploaded: false });
  assert.equal('resumeFieldPresent' in unknown.properties, false);
  const empty = await telemetryApplicationSubmitted(entry, { telemetrySupplied: false, fillMetricsSource: 'empty' });
  assert.equal('resumeFieldPresent' in empty.properties, false);
  for (const event of [present, none, unknown, empty]) assert.deepEqual(validateEvent(event), event);
  assert.equal(JSON.stringify(present).includes('resume.pdf'), false);
});

test('ledger add emits resumeFieldPresent to the relay and keeps it out of the ledger row', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-agent-resume-field-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captured = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    captured.push(JSON.parse(raw));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: true, disclosed: true, graceConsumed: true, installationEventPending: false, identityEnabled: false, installationId: crypto.randomUUID(), token: 'synthetic-token', tokenExpiresAt: '2099-01-01T00:00:00Z' }));
  const env = { ...isolatedCliEnv(directory), JOB_APPLICATION_AGENT_TELEMETRY_URL: `http://127.0.0.1:${server.address().port}` };
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const entry = (slug, telemetry) => ({
    id: `resume-field-${slug}`, company: `Field ${slug}`, role: 'Engineer', url: `https://jobs.example.com/resume-field-${slug}`,
    source: 'lever', score: 80, status: 'submitted', submittedAt: '2026-10-20T04:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry,
  });
  for (const [slug, telemetry] of [
    ['none', { durationBucket: '1-2m', fieldsFilled: 6, shortAnswerCount: 1, resumeUploaded: false, resumeFieldPresent: false }],
    ['present', { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true, resumeFieldPresent: true }],
    ['unknown', { durationBucket: '2-5m', fieldsFilled: 6, shortAnswerCount: 1, resumeUploaded: false }],
  ]) {
    const result = await runCli(script, ['ledger', 'add', '--stdin'], entry(slug, telemetry), env);
    assert.equal(result.code, 0, result.stderr);
  }
  const submitted = Object.fromEntries(captured
    .filter((body) => body.event === 'application_submitted')
    .map((body) => [body.properties.company, body.properties]));
  assert.equal(submitted['Field none'].resumeFieldPresent, false);
  assert.equal(submitted['Field present'].resumeFieldPresent, true);
  assert.equal('resumeFieldPresent' in submitted['Field unknown'], false);
  const stored = (await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  for (const row of stored) assert.equal('resumeFieldPresent' in row, false);
});

test('ordinary application_submitted stays within the pre-3.7.9 relay property set', async () => {
  // Relays deployed before 3.7.9 reject unknown properties. 3.7.9 always sent
  // thinSubmissionOverrideUsed and every submit was dropped at the relay.
  const PRE_379_RELAY_KEYS = new Set([
    'company', 'title', 'jobHash', 'domain', 'ats', 'durationBucket', 'fieldsFilled', 'shortAnswerCount',
    'resumeUploaded', 'approvalMode', 'telemetrySupplied', 'fillMetricsSource',
  ]);
  const entry = {
    company: 'Compat Co', role: 'Engineer', url: 'https://jobs.example.com/compat',
    source: 'greenhouse', approval: 'STANDING AUTHORIZATION', answers: {},
  };
  const event = await telemetryApplicationSubmitted(entry, {
    telemetrySupplied: true, fillMetricsSource: 'telemetry', fieldsFilled: 9, shortAnswerCount: 1, resumeUploaded: true, durationBucket: '2-5m',
    thinSubmissionOverrideUsed: false,
  });
  const unknown = Object.keys(event.properties).filter((key) => !PRE_379_RELAY_KEYS.has(key));
  assert.deepEqual(unknown, []);
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
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const entry = {
    id: 'example-role-1', company: 'Example', role: 'Senior Product Engineer', url: 'https://jobs.example.com/123?utm_source=x', source: 'company', score: 80, status: 'submitted', submittedAt: '2026-01-15T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {},
    telemetry: { durationBucket: '5-15m', fieldsFilled: 14, shortAnswerCount: 2, resumeUploaded: true },
  };
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const env = isolatedCliEnv(directory);
  execFileSync(process.execPath, [script, 'ledger', 'add', '--stdin'], { input: JSON.stringify(withTestReview(env, ['ledger', 'add'], entry)), env, encoding: 'utf8' });
  const duplicate = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], { input: JSON.stringify({ id: 'different', url: 'https://jobs.example.com/123?ref=friend' }), env, encoding: 'utf8' }));
  assert.equal(duplicate.duplicate, true);
  const relabelled = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], {
    input: JSON.stringify({ id: 'different-again', company: 'Example Holdings', role: 'Staff Engineer', url: 'https://jobs.example.com/123?candidateTracking=opaque-value' }), env, encoding: 'utf8',
  }));
  assert.equal(relabelled.duplicate, true);
  const stored = JSON.parse((await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim());
  assert.equal(stored.fillMetricsSource, 'telemetry');
  assert.equal(stored.telemetrySupplied, true);
  assert.equal('durationBucket' in stored, false);
  assert.equal('fieldsFilled' in stored, false);
  assert.equal('shortAnswerCount' in stored, false);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'applications.ndjson'))).mode & 0o777, 0o600);
});

test('warns on same-company role matches and serializes concurrent duplicate submissions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-dedup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const env = isolatedCliEnv(directory);
  const base = {
    company: 'Example', role: 'Senior Product Engineer', url: 'https://jobs.example.com/123', source: 'company', score: 88,
    status: 'submitted', submittedAt: '2026-01-15T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, employerJobId: 'example:123',
    telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  };
  const [first, second] = await Promise.all([
    runCli(script, ['ledger', 'add', '--stdin'], { ...base, id: 'example-role-1' }, env),
    runCli(script, ['ledger', 'add', '--stdin'], { ...base, id: 'example-role-2', url: 'https://jobs.example.com/123?ref=other' }, env),
  ]);
  assert.deepEqual([first.code, second.code].sort(), [0, 1]);
  assert.equal((await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim().split('\n').length, 1);

  const possible = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], {
    input: JSON.stringify({ id: 'new-requisition', company: 'Example', role: 'Senior Product Engineer', url: 'https://jobs.example.com/456' }), env, encoding: 'utf8',
  }));
  assert.equal(possible.duplicate, false);
  assert.equal(possible.possibleDuplicate, true);
});

test('accepts any one ledger check identifier set and never hard-matches company+role', () => {
  assert.deepEqual(validateLedgerCheckCandidate({ url: 'https://jobs.example.com/123' }), { url: 'https://jobs.example.com/123' });
  assert.deepEqual(validateLedgerCheckCandidate({ id: 'example-role-1' }), { id: 'example-role-1' });
  assert.deepEqual(validateLedgerCheckCandidate({ employerJobId: 'example:123', company: 'Example' }), {
    employerJobId: 'example:123', company: 'Example',
  });
  assert.deepEqual(validateLedgerCheckCandidate({ company: 'Example', role: 'Senior Product Engineer' }), {
    company: 'Example', role: 'Senior Product Engineer',
  });
  const identifierError = /ledger check requires at least one identifier set: url, id, employerJobId\+company, or company\+role/;
  assert.throws(() => validateLedgerCheckCandidate({}), identifierError);
  assert.throws(() => validateLedgerCheckCandidate({ company: 'Example' }), identifierError);
  assert.throws(() => validateLedgerCheckCandidate({ role: 'Senior Product Engineer' }), identifierError);
  assert.throws(() => validateLedgerCheckCandidate({ employerJobId: 'example:123' }), identifierError);
  try {
    validateLedgerCheckCandidate({});
  } catch (error) {
    assert.match(error.message, identifierError);
    assert.doesNotMatch(error.message, /candidate\.url must/);
  }
  assert.throws(() => validateLedgerCheckCandidate({ url: 'not-a-url' }), /Invalid URL|invalid/i);
  assert.throws(() => validateLedgerCheckCandidate({ id: 'example-role-1', url: 123 }), /candidate\.url must/);
  assert.throws(() => validateLedgerCheckCandidate({ id: 'example-role-1', url: null }), /candidate\.url must/);
});

test('looks up ledger rows without requiring a URL on check', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-check-lookup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const storedUrl = 'https://jobs.example.com/123';
  await writeFile(join(directory, 'applications.ndjson'), `${JSON.stringify({
    id: 'example-role-1', company: 'Example', role: 'Senior Product Engineer', url: storedUrl, source: 'company', score: 88,
    status: 'submitted', submittedAt: '2026-01-15T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true }, employerJobId: 'example:123',
  })}\n`);
  const env = isolatedCliEnv(directory);

  const byUrl = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], {
    input: JSON.stringify({ url: 'https://jobs.example.com/123?utm_source=board' }), env, encoding: 'utf8',
  }));
  assert.equal(byUrl.duplicate, true);
  assert.equal(byUrl.reason, 'url');

  const byId = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], {
    input: JSON.stringify({ id: 'example-role-1' }), env, encoding: 'utf8',
  }));
  assert.equal(byId.duplicate, true);
  assert.equal(byId.possibleDuplicate, false);
  assert.equal(byId.reason, 'id');
  assert.equal(byId.match.url, storedUrl);

  const byEmployerJob = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], {
    input: JSON.stringify({ employerJobId: 'example:123', company: 'Example' }), env, encoding: 'utf8',
  }));
  assert.equal(byEmployerJob.duplicate, true);
  assert.equal(byEmployerJob.possibleDuplicate, false);
  assert.equal(byEmployerJob.reason, 'employer-job-id');

  const newerUrl = 'https://jobs.example.com/123-new';
  await writeFile(join(directory, 'applications.ndjson'), `${JSON.stringify({
    id: 'example-role-1', company: 'Example', role: 'Senior Product Engineer', url: storedUrl, source: 'company', score: 88,
    status: 'submitted', submittedAt: '2026-01-15T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true }, employerJobId: 'example:123',
  })}\n${JSON.stringify({
    id: 'example-role-1b', company: 'Example', role: 'Senior Product Engineer', url: newerUrl, source: 'company', score: 88,
    status: 'submitted', submittedAt: '2026-02-01T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  })}\n`);

  const byCompanyRole = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], {
    input: JSON.stringify({ company: 'Example', role: 'Senior Product Engineer' }), env, encoding: 'utf8',
  }));
  assert.equal(byCompanyRole.duplicate, false);
  assert.equal(byCompanyRole.possibleDuplicate, true);
  assert.equal(byCompanyRole.reason, 'company-role');
  assert.equal(byCompanyRole.match.url, newerUrl);
  assert.equal(byCompanyRole.match.id, 'example-role-1b');

  const seniorUrl = 'https://jobs.example.com/senior';
  const staffUrl = 'https://jobs.example.com/staff';
  await writeFile(join(directory, 'applications.ndjson'), `${JSON.stringify({
    id: 'example-senior', company: 'Example', role: 'Senior Software Engineer', url: seniorUrl, source: 'company', score: 88,
    status: 'submitted', submittedAt: '2026-01-10T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  })}\n${JSON.stringify({
    id: 'example-staff', company: 'Example', role: 'Staff Software Engineer', url: staffUrl, source: 'company', score: 90,
    status: 'submitted', submittedAt: '2026-02-10T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  })}\n`);
  const exactSenior = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], {
    input: JSON.stringify({ company: 'Example', role: 'Senior Software Engineer' }), env, encoding: 'utf8',
  }));
  assert.equal(exactSenior.possibleDuplicate, true);
  assert.equal(exactSenior.match.id, 'example-senior');
  assert.equal(exactSenior.match.url, seniorUrl);

  await writeFile(join(directory, 'applications.ndjson'), `${JSON.stringify({
    id: 'example-backend', company: 'Example', role: 'Backend Engineer', url: 'https://jobs.example.com/backend', source: 'company', score: 84,
    status: 'submitted', submittedAt: '2026-01-05T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  })}\n${JSON.stringify({
    id: 'example-frontend', company: 'Example', role: 'Frontend Engineer', url: 'https://jobs.example.com/frontend', source: 'company', score: 85,
    status: 'submitted', submittedAt: '2026-03-01T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  })}\n`);
  const ambiguousEngineer = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], {
    input: JSON.stringify({ company: 'Example', role: 'Engineer' }), env, encoding: 'utf8',
  }));
  assert.equal(ambiguousEngineer.duplicate, false);
  assert.equal(ambiguousEngineer.possibleDuplicate, true);
  assert.equal(ambiguousEngineer.reason, 'company-role');
  assert.equal(ambiguousEngineer.match, null);

  const identifierError = /ledger check requires at least one identifier set: url, id, employerJobId\+company, or company\+role/;
  for (const input of [{}, { company: 'Example' }, { role: 'Senior Product Engineer' }]) {
    const failed = await runCli(script, ['ledger', 'check', '--stdin'], input, env);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, identifierError);
    assert.doesNotMatch(failed.stderr, /candidate\.url must/);
  }

  const malformedUrl = await runCli(script, ['ledger', 'check', '--stdin'], { id: 'example-role-1', url: 123 }, env);
  assert.equal(malformedUrl.code, 1);
  assert.match(malformedUrl.stderr, /candidate\.url must/);

  assert.equal(byId.sameCompany, true);
  assert.equal(byId.companyApplications.length, 1);
  assert.equal(byId.companyApplications[0].id, 'example-role-1');

  const invalidUrl = await runCli(script, ['ledger', 'check', '--stdin'], { url: 'not-a-url' }, env);
  assert.equal(invalidUrl.code, 1);
  assert.match(invalidUrl.stderr, /Invalid URL|invalid/i);

  const missingAddUrl = await runCli(script, ['ledger', 'add', '--stdin'], {
    id: 'example-role-2', company: 'Example', role: 'Staff Engineer', source: 'company', score: 80,
    status: 'submitted', submittedAt: '2026-01-16T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  }, env);
  assert.equal(missingAddUrl.code, 1);
  assert.match(missingAddUrl.stderr, /entry\.url must/);
});

test('records mail and looks up company+role in separate CLI processes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-outcome-then-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const storedUrl = 'https://jobs.example.com/apollo-1';
  await writeFile(join(directory, 'applications.ndjson'), `${JSON.stringify({
    id: 'apollo-role-1', company: 'Apollo', role: 'Staff Engineer', url: storedUrl, source: 'company', score: 90,
    status: 'submitted', submittedAt: '2026-01-15T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  })}\n`);
  const env = isolatedCliEnv(directory);
  const outcome = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'outcome', '--stdin'], {
    input: JSON.stringify({ id: 'apollo-role-1', status: 'rejected', occurredAt: '2026-01-20T09:00:00Z' }), env, encoding: 'utf8',
  }));
  assert.equal(outcome.recorded, true);
  const check = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'check', '--stdin'], {
    input: JSON.stringify({ company: 'Apollo', role: 'Staff Engineer' }), env, encoding: 'utf8',
  }));
  assert.equal(check.duplicate, false);
  assert.equal(check.possibleDuplicate, true);
  assert.equal(check.match.url, storedUrl);
});

test('records structured outcomes idempotently without duplicate rows', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-outcomes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  await writeFile(join(directory, 'applications.ndjson'), `${JSON.stringify({
    id: 'example-role-1', company: 'Example', role: 'Senior Product Engineer', url: 'https://jobs.example.com/123', source: 'company', score: 88,
    status: 'submitted', submittedAt: '2026-01-15T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  })}\n`);
  const env = isolatedCliEnv(directory);
  const outcome = { id: 'example-role-1', status: 'rejected', occurredAt: '2026-01-20T09:00:00Z', note: 'No sponsorship' };
  const enriched = { ...outcome, reasons: [{ category: 'eligibility', evidence: 'explicit' }] };
  const first = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'outcome', '--stdin'], { input: JSON.stringify(outcome), env, encoding: 'utf8' }));
  const second = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'outcome', '--stdin'], { input: JSON.stringify(enriched), env, encoding: 'utf8' }));
  const third = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'outcome', '--stdin'], { input: JSON.stringify(enriched), env, encoding: 'utf8' }));
  assert.equal(first.recorded, true);
  assert.equal(second.recorded, true);
  assert.equal(second.enriched, true);
  assert.equal(third.recorded, false);
  assert.equal(third.duplicate, true);
  assert.equal((await readFile(join(directory, 'outcomes.ndjson'), 'utf8')).trim().split('\n').length, 2);
});

test('records bounded interview quality and failure-point enrichment idempotently', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-interview-quality-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  await writeFile(join(directory, 'applications.ndjson'), `${JSON.stringify({
    id: 'example-role-1', company: 'Example', role: 'Staff Product Engineer', url: 'https://jobs.example.com/123', source: 'company', score: 91,
    status: 'submitted', submittedAt: '2026-01-15T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  })}\n`);
  const env = isolatedCliEnv(directory);
  const base = { id: 'example-role-1', status: 'interview', occurredAt: '2026-01-20T09:00:00Z' };
  const enriched = { ...base, interviewQuality: 'weak', failurePoint: 'role-scope' };
  const first = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'outcome', '--stdin'], { input: JSON.stringify(base), env, encoding: 'utf8' }));
  const second = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'outcome', '--stdin'], { input: JSON.stringify(enriched), env, encoding: 'utf8' }));
  const third = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'outcome', '--stdin'], { input: JSON.stringify(enriched), env, encoding: 'utf8' }));
  assert.equal(first.recorded, true);
  assert.equal(second.recorded, true);
  assert.equal(second.enriched, true);
  assert.equal(third.duplicate, true);
  const rows = (await readFile(join(directory, 'outcomes.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].interviewQuality, 'weak');
  assert.equal(rows[1].failurePoint, 'role-scope');

  const invalid = await runCli(script, ['ledger', 'outcome', '--stdin'], { ...base, occurredAt: '2026-01-21T09:00:00Z', interviewQuality: 'excellent' }, env);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /interviewQuality/i);
});

test('builds canonical mature-cohort reviews and honors explicit acknowledgement', () => {
  const old = Array.from({ length: 20 }, (_, index) => ({
    id: `old-${index}`, company: `Company ${index}`, role: 'Senior Engineer', url: `https://jobs.example.com/${index}`,
    status: 'submitted', submittedAt: '2025-12-01T10:00:00Z', source: 'company', score: 80, approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  }));
  const recent = Array.from({ length: 2 }, (_, index) => ({
    id: `recent-${index}`, company: `Recent ${index}`, role: 'Staff Engineer', url: `https://jobs.example.com/recent-${index}`,
    status: 'submitted', submittedAt: '2026-01-19T10:00:00Z', source: 'company', score: 85, approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  }));
  const duplicate = { ...old[0], id: 'old-0-duplicate', url: 'https://another-ats.example.com/requisition/old-0' };
  const outcomes = [
    { id: 'old-0', status: 'interview', occurredAt: '2025-12-10T10:00:00Z', interviewQuality: 'promising' },
    { id: 'old-1', status: 'rejected', occurredAt: '2025-12-11T10:00:00Z', interviewQuality: 'dead', failurePoint: 'constraints', reasons: [{ category: 'must-have-gap', evidence: 'inferred' }] },
  ];
  const now = new Date('2026-01-20T12:00:00Z');
  const review = buildReview([...old, ...recent, duplicate], outcomes, [], now);
  assert.equal(review.rawSubmissionRows, 23);
  assert.equal(review.uniqueSubmittedTotal, 22);
  assert.equal(review.duplicateSubmissionRows, 1);
  assert.equal(review.maturedApplications, 20);
  assert.equal(review.reviewDue, true);
  assert.deepEqual(review.reviewReasons.sort(), ['outcome-effectiveness', 'submission-hygiene']);
  assert.equal(review.reasonCounts['must-have-gap'], 1);
  assert.equal(review.interviewQualityCounts.promising, 1);
  assert.equal(review.interviewQualityCounts.dead, 1);
  assert.equal(review.failurePointCounts.constraints, 1);
  assert.deepEqual(review.interviewLearningSegments, [
    { source: 'company', fitScoreBand: '80-89', interviewQuality: 'dead', failurePoint: 'constraints', count: 1 },
    { source: 'company', fitScoreBand: '80-89', interviewQuality: 'promising', failurePoint: 'unknown', count: 1 },
  ]);
  assert.equal(review.matureOutcomeCounts.interview, 1);
  assert.equal(review.matureOutcomeCounts.rejected, 1);
  assert.equal(review.conversionRates.interview, 5);
  assert.equal(review.conversionRates.rejected, 5);

  const acknowledged = buildReview([...old, ...recent, duplicate], outcomes, [{
    reviewedAt: '2026-01-20T11:00:00Z', uniqueSubmissionCount: 22, maturedApplicationCount: 20,
  }], now);
  assert.equal(acknowledged.reviewDue, false);
});

test('preserves interview quality after a later final outcome', () => {
  const applications = [{
    id: 'role-1', company: 'Example', role: 'Staff Engineer', url: 'https://jobs.example.com/role-1',
    status: 'submitted', submittedAt: '2025-12-01T10:00:00Z', source: 'company', score: 90, approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  }];
  const outcomes = [
    { id: 'role-1', status: 'interview', occurredAt: '2025-12-10T10:00:00Z', interviewQuality: 'promising' },
    { id: 'role-1', status: 'rejected', occurredAt: '2025-12-15T10:00:00Z' },
  ];
  const review = buildReview(applications, outcomes, [], new Date('2026-01-20T12:00:00Z'));
  assert.equal(review.outcomeCounts.rejected, 1);
  assert.equal(review.outcomeCounts.interview, 0);
  assert.equal(review.interviewQualityCounts.promising, 1);
});

test('acknowledges a generated review only through the explicit CLI command', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const entries = Array.from({ length: 10 }, (_, index) => ({
    id: `role-${index}`, company: `Company ${index}`, role: 'Senior Engineer', url: `https://jobs.example.com/${index}`,
    source: 'company', score: 80, status: 'submitted', submittedAt: '2026-01-01T10:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {}, telemetry: { durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true },
  }));
  await writeFile(join(directory, 'applications.ndjson'), `${entries.map(JSON.stringify).join('\n')}\n`);
  const env = isolatedCliEnv(directory);
  const before = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'review'], { env, encoding: 'utf8' }));
  assert.equal(before.reviewDue, true);
  assert.equal(await readFile(join(directory, 'reviews.ndjson'), 'utf8').catch(() => ''), '');
  const ack = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'review-ack', '--stdin'], {
    input: JSON.stringify({ reviewedAt: '2026-02-01T10:00:00Z' }), env, encoding: 'utf8',
  }));
  assert.equal(ack.acknowledged, true);
  const after = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'review'], { env, encoding: 'utf8' }));
  assert.equal(after.reviewDue, false);
});

test('maps commands and durations to bounded telemetry categories', () => {
  assert.equal(commandCategory(['ledger', 'add', '--stdin']), 'apply');
  assert.equal(commandCategory(['ledger', 'check', '--stdin']), 'check');
  assert.equal(commandCategory(['ledger', 'delivery', '--stdin']), 'delivery');
  assert.equal(commandCategory(['ledger', 'retry', '--stdin']), 'delivery');
  assert.equal(commandCategory(['ledger', 'deliveries']), 'delivery');
  assert.equal(commandCategory(['ledger', 'outcome', '--stdin']), 'outcome');
  assert.equal(commandCategory(['attention', 'add', '--stdin']), 'attention');
  assert.equal(commandCategory(['friction', 'record', '--stdin']), 'friction');
  assert.equal(commandCategory(['score', '--stdin']), 'assess');
  assert.equal(commandCategory(['sources', 'list']), 'search');
  assert.equal(durationBucket(700), 'under-1s');
  assert.equal(durationBucket(70_000), '1-2m');
  assert.equal(durationBucket(2_000_000), '15m-plus');
  assert.equal(telemetryErrorCode(new Error('Secret Service could not read the profile.')), 'authentication_required');
  assert.equal(telemetryErrorCode(new Error('secret-tool is not installed.')), 'authentication_required');
  assert.equal(telemetryErrorCode(new Error('Usage: cloud status|configure')), 'invalid_input');
  assert.equal(telemetryErrorCategory(new Error('Usage: cloud status|configure')), 'usage');
  assert.equal(commandCategory(['cloud', 'status']), 'other');
  assert.equal(telemetryErrorCode(new Error('The stored profile needs migration. Run profile check, then profile migrate --stdin.')), 'invalid_input');
  assert.equal(telemetryErrorCode(new Error('Hard duplicate blocked: matching canonical URL.')), 'invalid_input');
  assert.equal(telemetryErrorCode(new Error('No local cloud lease is recorded. Run cloud lease-acquire.')), 'authentication_required');
  assert.equal(telemetryErrorCode(new Error('Cloud state request failed (503): upstream')), 'network_failure');
  assert.equal(telemetryErrorCode(new Error('Cloud state unavailable: fetch failed')), 'network_failure');
  assert.equal(telemetryErrorCode(new Error('Resume export failed with HTTP 500.')), 'upload_failed');
});

test('application_submitted uses null/unknown when telemetry is omitted', async () => {
  const entry = {
    company: 'Example', role: 'Engineer', url: 'https://jobs.example.com/null-telemetry',
    source: 'lever', approval: 'STANDING AUTHORIZATION', answers: {},
  };
  const missing = await telemetryApplicationSubmitted(entry, { telemetrySupplied: false, fillMetricsSource: 'empty' });
  assert.equal(missing.properties.telemetrySupplied, false);
  assert.equal(missing.properties.fillMetricsSource, 'empty');
  assert.equal(missing.properties.fieldsFilled, null);
  assert.equal(missing.properties.shortAnswerCount, null);
  assert.equal(missing.properties.resumeUploaded, null);
  assert.equal(missing.properties.durationBucket, 'unknown');
  assert.equal('thinSubmissionOverrideUsed' in missing.properties, false);

  const fromLifecycle = await telemetryApplicationSubmitted(entry, {
    telemetrySupplied: false,
    fillMetricsSource: 'empty',
    lifecycleStartedAt: new Date(Date.now() - 90_000).toISOString(),
  });
  assert.equal(fromLifecycle.properties.durationBucket, '1-2m');
  assert.equal(fromLifecycle.properties.fieldsFilled, null);

  const supplied = await telemetryApplicationSubmitted(entry, {
    telemetrySupplied: true,
    fillMetricsSource: 'telemetry',
    fieldsFilled: 9,
    resumeUploaded: true,
    shortAnswerCount: 2,
    durationBucket: '5-15m',
  });
  assert.equal(supplied.properties.telemetrySupplied, true);
  assert.equal(supplied.properties.fillMetricsSource, 'telemetry');
  assert.equal(supplied.properties.fieldsFilled, 9);
  assert.equal(supplied.properties.durationBucket, '5-15m');
});

test('marks answer-key fill metrics fallback on ledger and application_submitted', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-answer-key-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const env = isolatedCliEnv(directory);
  const answers = {
    'Full name': 'filled', Email: 'filled', Phone: 'filled', Location: 'filled',
    LinkedIn: 'filled', 'Work authorization': 'filled', Resume: 'uploaded',
  };
  const result = await runCli(script, ['ledger', 'add', '--stdin'], {
    id: 'answer-key-fallback-role',
    company: 'Fallback Co',
    role: 'Engineer',
    url: 'https://jobs.example.com/answer-key-fallback',
    source: 'lever',
    score: 80,
    status: 'submitted',
    submittedAt: '2026-10-15T04:00:00Z',
    approval: 'STANDING AUTHORIZATION',
    answers,
  }, env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /fillMetricsSource=answer_keys/);
  assert.match(result.stderr, /telemetrySupplied=false/);
  assert.match(result.stderr, /Resend entry\.telemetry/);
  const stored = JSON.parse((await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim());
  assert.equal(stored.fillMetricsSource, 'answer_keys');
  assert.equal(stored.telemetrySupplied, false);
  assert.equal('durationBucket' in stored, false);
  assert.equal('fieldsFilled' in stored, false);

  const event = await telemetryApplicationSubmitted(stored, {
    ...resolveSubmissionFillMetrics(stored, {}),
    telemetrySupplied: false,
  });
  assert.equal(event.properties.fillMetricsSource, 'answer_keys');
  assert.equal(event.properties.telemetrySupplied, false);
  assert.equal(event.properties.fieldsFilled, 7);
  assert.equal(event.properties.resumeUploaded, true);
  assert.equal(event.properties.durationBucket, 'unknown');
});

test('answer-key fallback marks the entry as logged after the fact, not agent-filled', () => {
  assert.equal(LOGGED_ENTRY_ORIGIN, 'logged');
  assert.equal(entryOriginForFillMetrics('answer_keys'), 'logged');
  assert.equal(entryOriginForFillMetrics('telemetry'), null);
  assert.equal(entryOriginForFillMetrics('empty'), null);
  assert.equal(entryOriginForFillMetrics(undefined), null);
  const logged = resolveSubmissionFillMetrics({ answers: { 'Full name': 'filled', Email: 'filled' } }, {});
  assert.equal(logged.fillMetricsSource, 'answer_keys');
  assert.equal(logged.entryOrigin, 'logged');
  assert.equal(isLoggedNotAgentFilled(logged), true);
  const filled = resolveSubmissionFillMetrics({ answers: { 'Full name': 'filled' } }, { fieldsFilled: 1, resumeUploaded: false });
  assert.equal('entryOrigin' in filled, false);
  assert.equal(isLoggedNotAgentFilled(filled), false);
  assert.equal('entryOrigin' in resolveSubmissionFillMetrics({ answers: {} }, {}), false);
  assert.equal(isLoggedNotAgentFilled(null), false);
  assert.equal(isLoggedNotAgentFilled({ entryOrigin: 'agent' }), false);
});

test('logged-after-the-fact submissions are never thin agent submits', () => {
  const live = { applyKind: 'live', answers: {}, approval: 'STANDING AUTHORIZATION' };
  const thinMetrics = { fieldsFilled: 0, resumeUploaded: false, fillMetricsSource: 'telemetry' };
  assert.equal(isThinSubmission(live, thinMetrics), true);
  assert.equal(isThinSubmission(live, { ...thinMetrics, entryOrigin: 'logged' }), false);
  const sparse = { applyKind: 'live', answers: { Email: 'filled' }, approval: 'STANDING AUTHORIZATION' };
  const metrics = resolveSubmissionFillMetrics(sparse, {});
  assert.equal(isThinSubmission(sparse, metrics), false);
  assert.equal(assertSubmissionFillGuard(sparse, metrics).path, 'filled');
});

test('validateLedgerEntry accepts known entryOrigin values and rejects others', () => {
  const base = {
    id: 'origin-role', company: 'Origin Co', role: 'Engineer', url: 'https://jobs.example.com/origin', source: 'lever',
    score: 80, status: 'submitted', submittedAt: '2026-10-21T04:00:00Z', approval: 'STANDING AUTHORIZATION', answers: {},
  };
  assert.equal('entryOrigin' in validateLedgerEntry(base), false);
  assert.equal(validateLedgerEntry({ ...base, entryOrigin: 'logged' }).entryOrigin, 'logged');
  assert.equal(validateLedgerEntry({ ...base, entryOrigin: 'agent' }).entryOrigin, 'agent');
  assert.throws(() => validateLedgerEntry({ ...base, entryOrigin: 'manual' }), /entry\.entryOrigin is invalid/);
});

test('application_submitted carries entryOrigin only for logged entries and still validates', async () => {
  const entry = {
    company: 'Origin Co', role: 'Engineer', url: 'https://jobs.example.com/origin-event',
    source: 'greenhouse', approval: 'STANDING AUTHORIZATION', answers: { Email: 'filled', Phone: 'filled' },
  };
  const logged = await telemetryApplicationSubmitted(entry, { ...resolveSubmissionFillMetrics(entry, {}), telemetrySupplied: false });
  assert.equal(logged.properties.entryOrigin, 'logged');
  assert.equal(logged.properties.fillMetricsSource, 'answer_keys');
  assert.deepEqual(validateEvent(logged), logged);
  const fromRow = await telemetryApplicationSubmitted({ ...entry, entryOrigin: 'logged' }, {
    telemetrySupplied: false, fillMetricsSource: 'answer_keys', fieldsFilled: 2, resumeUploaded: false,
  });
  assert.equal(fromRow.properties.entryOrigin, 'logged');
  const agent = await telemetryApplicationSubmitted(entry, {
    telemetrySupplied: true, fillMetricsSource: 'telemetry', fieldsFilled: 9, shortAnswerCount: 1, resumeUploaded: true, durationBucket: '2-5m',
  });
  assert.equal('entryOrigin' in agent.properties, false);
  const empty = await telemetryApplicationSubmitted({ ...entry, answers: {} }, { telemetrySupplied: false, fillMetricsSource: 'empty' });
  assert.equal('entryOrigin' in empty.properties, false);
  assert.throws(() => validateEvent({ ...logged, properties: { ...logged.properties, entryOrigin: 'manual' } }));
});

test('ledger add stores and emits entryOrigin logged for answer-key fallback and ignores caller-supplied values', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-agent-entry-origin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captured = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    captured.push(JSON.parse(raw));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: true, disclosed: true, graceConsumed: true, installationEventPending: false, identityEnabled: false, installationId: crypto.randomUUID(), token: 'synthetic-token', tokenExpiresAt: '2099-01-01T00:00:00Z' }));
  const env = { ...isolatedCliEnv(directory), JOB_APPLICATION_AGENT_TELEMETRY_URL: `http://127.0.0.1:${server.address().port}` };
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const entry = (slug, extra) => ({
    id: `entry-origin-${slug}`, company: `Origin ${slug}`, role: 'Engineer', url: `https://jobs.example.com/entry-origin-${slug}`,
    source: 'greenhouse', score: 80, status: 'submitted', submittedAt: '2026-10-21T04:00:00Z', approval: 'STANDING AUTHORIZATION', ...extra,
  });
  const cases = [
    // Logged after the fact: answers only, no fill telemetry. Accepted, not rejected.
    ['logged', { answers: { Email: 'filled', Phone: 'filled' } }],
    // Agent-filled with telemetry: a caller-supplied entryOrigin is ignored.
    ['agent', { answers: { Email: 'filled' }, entryOrigin: 'logged', telemetry: { durationBucket: '2-5m', fieldsFilled: 9, shortAnswerCount: 1, resumeUploaded: true } }],
  ];
  for (const [slug, extra] of cases) {
    const result = await runCli(script, ['ledger', 'add', '--stdin'], entry(slug, extra), env);
    assert.equal(result.code, 0, result.stderr);
    if (slug === 'logged') assert.match(result.stderr, /entryOrigin=logged/);
  }
  const stored = Object.fromEntries((await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line)).map((row) => [row.id, row]));
  assert.equal(stored['entry-origin-logged'].entryOrigin, 'logged');
  assert.equal(stored['entry-origin-logged'].status, 'submitted');
  assert.equal(stored['entry-origin-logged'].fillMetricsSource, 'answer_keys');
  assert.equal('entryOrigin' in stored['entry-origin-agent'], false);
  assert.equal(stored['entry-origin-agent'].fillMetricsSource, 'telemetry');
  const submitted = Object.fromEntries(captured
    .filter((body) => body.event === 'application_submitted')
    .map((body) => [body.properties.company, body.properties]));
  assert.equal(submitted['Origin logged'].entryOrigin, 'logged');
  assert.equal(submitted['Origin logged'].telemetrySupplied, false);
  assert.equal('entryOrigin' in submitted['Origin agent'], false);
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
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const env = { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: directory, JOB_APPLICATION_AGENT_TELEMETRY_URL: 'https://relay.invalid' };
  const disabled = JSON.parse(execFileSync(process.execPath, [script, 'telemetry', 'disable'], { env, encoding: 'utf8' }));
  assert.equal(disabled.enabled, false);
  const reset = JSON.parse(execFileSync(process.execPath, [script, 'telemetry', 'reset'], { env, encoding: 'utf8' }));
  assert.equal(reset.hasInstallationId, false);
  const identityDisabled = JSON.parse(execFileSync(process.execPath, [script, 'telemetry', 'identity', 'disable'], { env, encoding: 'utf8' }));
  assert.equal(identityDisabled.identityEnabled, false);
  assert.equal(identityDisabled.enabled, false);
  const identityEnabled = JSON.parse(execFileSync(process.execPath, [script, 'telemetry', 'identity', 'enable'], { env, encoding: 'utf8' }));
  assert.equal(identityEnabled.identityEnabled, false);
  assert.equal(identityEnabled.enabled, false);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'telemetry.json'))).mode & 0o777, 0o600);
});

test('CLI emits bounded source coverage without private evidence or attribution', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-agent-coverage-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captured = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    captured.push(JSON.parse(raw));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: true, disclosed: true, graceConsumed: true, installationEventPending: false, identityEnabled: false, installationId: crypto.randomUUID(), token: 'synthetic-token', tokenExpiresAt: '2099-01-01T00:00:00Z' }));
  const env = { ...isolatedCliEnv(directory), JOB_APPLICATION_AGENT_TELEMETRY_URL: `http://127.0.0.1:${server.address().port}` };
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const started = await runCli(script, ['round', 'start', '--stdin'], { requestedCount: 1 }, env);
  assert.equal(started.code, 0, started.stderr);
  const roundId = JSON.parse(started.stdout).roundId;
  const sourceId = 'community-0123456789abcdef';
  for(let i=0;i<8;i++) {
    const result = await runCli(script,['round','lead','--stdin'],{roundId,sourceId,url:`https://fixture.example/jobs/${i}`,company:`Fixture ${i}`,disposition:i<2?'qualified':'closed-stale',observedAt:'2026-08-01T00:00:00Z',evidence:'Private lead assessment'},env);
    assert.equal(result.code,0,result.stderr);
  }
  const report = await runCli(script, ['round', 'source', '--stdin'], { roundId, sourceId, status: 'searched', reviewedCount: 8, qualifiedCount: 2, evidence: 'Private search query and candidate context', applicationIds: [] }, env);
  assert.equal(report.code, 0, report.stderr);
  const event = captured.find((body) => body.event === 'source_checked');
  assert.ok(event, JSON.stringify(captured));
  assert.deepEqual(event.properties, { sourceId: 'community', status: 'searched', reviewedCount: 8, qualifiedCount: 2 });
  assert.equal(JSON.stringify(captured).includes('Private search query'), false);
  assert.equal(JSON.stringify(captured).includes('Private lead assessment'), false);
  assert.equal(JSON.stringify(captured).includes(roundId), false);
  assert.equal(JSON.stringify(captured).includes(sourceId), false);
});

test('builds started, paused, and skipped application telemetry without PII', async () => {
  const job = { ...matchingJob, url: 'https://jobs.example.com/roles/42?utm=1', eligibility: 'eligible', applicationChannel: 'greenhouse' };
  const started = await telemetryApplicationStarted(job, {
    approvalMode: 'routine-auto',
    requiredFieldCount: 9,
    resumeRequired: true,
    coverLetterRequired: false,
    referralPresent: false,
  });
  assert.equal(started.event, 'application_started');
  assert.equal(started.properties.ats, 'greenhouse');
  assert.equal(started.properties.approvalMode, 'routine-auto');
  assert.equal(started.properties.requiredFieldCount, 9);
  assert.equal(started.properties.jobHash.length, 64);
  assert.equal(JSON.stringify(started).includes('utm=1'), false);

  const skipped = await telemetryApplicationSkipped(job, scoreJob({ ...job, postingStatus: 'closed' }, target));
  assert.equal(skipped.event, 'application_skipped');
  assert.equal(skipped.properties.reason, 'closed');

  const paused = await telemetryApplicationPaused({
    url: job.url,
    stage: 'answers',
    blocker: 'legal-attestation',
    applicationChannel: 'workday',
  });
  assert.equal(paused.event, 'application_paused');
  assert.equal(paused.properties.stage, 'questions');
  assert.equal(paused.properties.reason, 'legal');
  assert.equal(paused.properties.ats, 'workday');
});

test('score review emits application_started and attention add emits application_paused', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-agent-lifecycle-telemetry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captured = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    captured.push(JSON.parse(raw));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/v1/install'
      ? { installationId: crypto.randomUUID(), token: 'synthetic-relay-token', expiresAt: '2099-01-01T00:00:00Z' }
      : { accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({
    version: 1,
    enabled: true,
    disclosed: true,
    graceConsumed: true,
    installationEventPending: false,
    contactEnabled: false,
    installationId: crypto.randomUUID(),
    token: 'synthetic-token',
    tokenExpiresAt: '2099-01-01T00:00:00Z',
  }));
  const preload = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; Object.defineProperty(process, 'platform', { value: 'linux' }); cp.execFileSync = (file, args) => { if (file === 'secret-tool' && args[0] === 'lookup') return ${JSON.stringify(JSON.stringify(target))}; throw new Error('Unexpected secret operation'); }; syncBuiltinESMExports();`;
  const runtimeArgs = ['--import', `data:text/javascript,${encodeURIComponent(preload)}`];
  const env = { ...isolatedCliEnv(directory), JOB_APPLICATION_AGENT_TELEMETRY_URL: `http://127.0.0.1:${server.address().port}` };
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

  const scored = await runCli(script, ['score', '--stdin'], {
    ...matchingJob,
    url: 'https://jobs.example.com/apply/lifecycle-started',
    requiredFieldCount: 6,
    resumeRequired: true,
    coverLetterRequired: false,
    referralPresent: false,
  }, env, runtimeArgs);
  assert.equal(scored.code, 0, scored.stderr);
  const started = captured.find((body) => body.event === 'application_started');
  assert.ok(started, JSON.stringify(captured));
  assert.equal(started.properties.ats, 'greenhouse');
  assert.equal(started.properties.approvalMode, 'review-each');
  assert.equal(started.properties.requiredFieldCount, 6);
  assert.equal(started.properties.resumeRequired, true);
  assert.equal(JSON.stringify(started).includes('lifecycle-started'), false);

  const beforePause = captured.length;
  const paused = await runCli(script, ['attention', 'add', '--stdin'], {
    roundId: 'round-lifecycle',
    applicationId: 'app-lifecycle',
    url: 'https://jobs.example.com/apply/lifecycle-paused',
    stage: 'review',
    blocker: 'captcha',
    requiredActions: ['complete-captcha'],
  }, env, runtimeArgs);
  assert.equal(paused.code, 0, paused.stderr);
  const pauseEvent = captured.slice(beforePause).find((body) => body.event === 'application_paused');
  assert.ok(pauseEvent, JSON.stringify(captured.slice(beforePause)));
  assert.equal(pauseEvent.properties.stage, 'review');
  assert.equal(pauseEvent.properties.reason, 'captcha');
  assert.equal(pauseEvent.properties.ats, 'other');
});

test('CLI never attaches candidate name/email/phone to analytics events', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-agent-identity-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captured = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    captured.push({ path: request.url, body: JSON.parse(raw) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/v1/install' ? { installationId: crypto.randomUUID(), token: 'synthetic-relay-token', expiresAt: '2099-01-01T00:00:00Z' } : { accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // Synthetic Secret Service implementation: never touch the developer's real profile.
  const preload = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; Object.defineProperty(process, 'platform', { value: 'linux' }); cp.execFileSync = (file, args) => { if (file === 'secret-tool' && args[0] === 'lookup') return ${JSON.stringify(JSON.stringify(target))}; throw new Error('Unexpected secret operation'); }; syncBuiltinESMExports();`;
  const runtimeArgs = ['--import', `data:text/javascript,${encodeURIComponent(preload)}`];
  const env = { ...isolatedCliEnv(directory), JOB_APPLICATION_AGENT_TELEMETRY_URL: `http://127.0.0.1:${server.address().port}` };
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const run = (args) => runCli(script, args, undefined, env, runtimeArgs);
  const first = await run(['profile', 'check']);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(captured.length > 0);
  assert.ok(captured.every(({ body }) => body.identity === undefined));
  assert.equal((await run(['profile', 'check'])).code, 0);
  const events = captured.filter(({ path }) => path === '/v1/events');
  const contacts = captured.filter(({ path }) => path === '/v1/contact');
  assert.ok(events.length > 0);
  const eventWire = JSON.stringify(events);
  assert.equal(eventWire.includes(target.name), false);
  assert.equal(eventWire.includes(target.email), false);
  assert.equal(eventWire.includes(target.phone), false);
  assert.equal(eventWire.includes('candidateName'), false);
  assert.equal(eventWire.includes('candidateEmail'), false);
  // Contact sharing is allowed only on POST /v1/contact — never on analytics events.
  assert.ok(contacts.length >= 1);
  assert.ok(contacts.every(({ body }) => body.candidateName === target.name && body.candidateEmail === target.email));
  assert.equal(JSON.stringify(contacts).includes(target.phone), false);
});

test('routine-auto profile blocks thin submits even with APPROVE SUBMIT unless this one job is review-each', () => {
  const live = { applyKind: 'live', answers: {}, approval: 'APPROVE SUBMIT', url: 'https://jobs.example.com/a' };
  const empty = resolveSubmissionFillMetrics(live, { fieldsFilled: 0, resumeUploaded: false });
  const expected = routineAutoProfileThinSubmitError().message;

  assert.equal(isThinSubmission(live, empty), true);
  assert.equal(isThinSubmission(live, resolveSubmissionFillMetrics(live, { fieldsFilled: 3, resumeUploaded: false })), false);
  assert.equal(isThinSubmission(live, resolveSubmissionFillMetrics(live, { fieldsFilled: 0, resumeUploaded: true })), false);
  assert.equal(isThinSubmission({ ...live, applyKind: 'fixture' }, empty), false);

  // Blocked with the exact guidance, with or without a per-job note.
  assert.throws(
    () => assertSubmissionFillGuard(live, empty, thinOverride(), { profileSubmissionMode: 'routine-auto' }),
    (error) => error.message === expected,
  );
  assert.throws(
    () => assertSubmissionFillGuard(live, empty, null, { profileSubmissionMode: 'routine-auto' }),
    (error) => error.message === expected,
  );
  assert.match(expected, /"jobApprovalMode": "review-each"/);
  assert.match(expected, /does not change your global submissionMode/);

  // Per-job review-each still needs the normal explicit acknowledgement and APPROVE SUBMIT.
  const perJob = assertSubmissionFillGuard(live, empty, thinOverride(), { profileSubmissionMode: 'routine-auto', jobApprovalMode: JOB_APPROVAL_REVIEW_EACH });
  assert.equal(perJob.path, 'thin_override');
  assert.equal(perJob.thinSubmissionOverrideUsed, true);
  assert.throws(
    () => assertSubmissionFillGuard(live, empty, null, { profileSubmissionMode: 'routine-auto', jobApprovalMode: JOB_APPROVAL_REVIEW_EACH }),
    /looks empty/i,
  );
  assert.throws(
    () => assertSubmissionFillGuard({ ...live, approval: 'STANDING AUTHORIZATION' }, empty, thinOverride(), { profileSubmissionMode: 'routine-auto', jobApprovalMode: JOB_APPROVAL_REVIEW_EACH }),
    /not allowed in routine-auto/i,
  );

  // Filled submits and the honest one-click path are unaffected by a routine-auto profile.
  assert.equal(assertSubmissionFillGuard(
    { ...live, approval: 'STANDING AUTHORIZATION' },
    resolveSubmissionFillMetrics(live, { fieldsFilled: 9, resumeUploaded: true }),
    null,
    { profileSubmissionMode: 'routine-auto' },
  ).path, 'filled');
  assert.equal(assertSubmissionFillGuard(
    { ...live, approval: 'STANDING AUTHORIZATION', applicationChannel: PROFILE_ONE_CLICK_CHANNEL },
    resolveSubmissionFillMetrics(live, { fieldsFilled: 0, resumeUploaded: false, profileResumeOnFile: true }),
    null,
    { profileSubmissionMode: 'routine-auto' },
  ).path, 'profile_one_click');

  // review-each profile: unchanged behavior.
  assert.equal(assertSubmissionFillGuard(live, empty, thinOverride(), { profileSubmissionMode: 'review-each' }).path, 'thin_override');
  assert.throws(
    () => assertSubmissionFillGuard(live, empty, null, { profileSubmissionMode: 'review-each' }),
    (error) => /looks empty/i.test(error.message) && error.message !== expected,
  );

  assert.equal(normalizeJobApprovalMode(undefined), null);
  assert.equal(normalizeJobApprovalMode('review-each'), 'review-each');
  assert.throws(() => normalizeJobApprovalMode('routine-auto'), /jobApprovalMode must be "review-each"/);
});

async function profileBackedCli(t, profile) {
  const directory = await mkdtemp(join(tmpdir(), 'public-job-agent-profile-guard-'));
  const toolDirectory = await mkdtemp(join(tmpdir(), 'public-job-agent-profile-tool-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(toolDirectory, { recursive: true, force: true }));
  const profileFile = join(toolDirectory, 'profile.json');
  await writeFile(profileFile, JSON.stringify(profile));
  // Fake Linux Secret Service: lookups return the fixture profile; any write fails loudly.
  const toolSource = `#!/bin/sh\nif [ "$1" = "lookup" ]; then exec /bin/cat '${profileFile}'; fi\necho "unexpected secret-tool $1" >&2\nexit 3\n`;
  await writeFile(join(toolDirectory, 'secret-tool'), toolSource, { mode: 0o755 });
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  const platformOverride = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process, 'platform', { value: 'linux' });")}`;
  const env = { ...isolatedCliEnv(directory), PATH: `${toolDirectory}:${process.env.PATH ?? ''}` };
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  return {
    directory,
    profileFile,
    add: (input) => runCli(script, ['ledger', 'add', '--stdin'], input, env, ['--import', platformOverride]),
  };
}

const profileGuardBase = {
  company: 'Example', role: 'Engineer', source: 'lever', score: 80, status: 'submitted',
  submittedAt: '2026-10-19T05:00:00Z', answers: {},
};
const emptyTelemetry = { fieldsFilled: 0, resumeUploaded: false, durationBucket: 'under-1s' };

test('ledger add under a routine-auto profile blocks empty applies and allows a per-job review-each override', {
  skip: process.platform === 'win32',
}, async (t) => {
  const profile = { ...target, submissionMode: 'routine-auto', submissionModeChosenAt: '2026-10-01T00:00:00.000Z' };
  const cli = await profileBackedCli(t, profile);
  const before = await readFile(cli.profileFile, 'utf8');

  const blocked = await cli.add({
    ...profileGuardBase, id: 'ra-empty-approve', company: 'Guard Co ra-empty-approve', url: 'https://jobs.example.com/ra-empty-approve', approval: 'APPROVE SUBMIT',
    telemetry: emptyTelemetry,
    thinSubmissionOverride: thinOverride('Candidate confirmed empty apply for routine-auto blocked job'),
  });
  assert.equal(blocked.code, 1);
  assert.ok(blocked.stderr.includes(routineAutoProfileThinSubmitError().message), blocked.stderr);

  const noAck = await cli.add({
    ...profileGuardBase, id: 'ra-review-each-noack', company: 'Guard Co ra-review-each-noack', url: 'https://jobs.example.com/ra-review-each-noack', approval: 'APPROVE SUBMIT',
    jobApprovalMode: 'review-each', telemetry: emptyTelemetry,
  });
  assert.equal(noAck.code, 1);
  assert.match(noAck.stderr, /looks empty/i);

  const invalidMode = await cli.add({
    ...profileGuardBase, id: 'ra-invalid-mode', company: 'Guard Co ra-invalid-mode', url: 'https://jobs.example.com/ra-invalid-mode', approval: 'APPROVE SUBMIT',
    jobApprovalMode: 'routine-auto', telemetry: emptyTelemetry,
    thinSubmissionOverride: thinOverride('Candidate confirmed empty apply for invalid mode job'),
  });
  assert.equal(invalidMode.code, 1);
  assert.match(invalidMode.stderr, /jobApprovalMode must be "review-each"/);

  const perJob = await cli.add({
    ...profileGuardBase, id: 'ra-review-each-ok', company: 'Guard Co ra-review-each-ok', url: 'https://jobs.example.com/ra-review-each-ok', approval: 'APPROVE SUBMIT',
    jobApprovalMode: 'review-each', telemetry: emptyTelemetry,
    thinSubmissionOverride: thinOverride('Candidate confirmed in chat this empty apply for Example Engineer is intended'),
  });
  assert.equal(perJob.code, 0, perJob.stderr);

  const filled = await cli.add({
    ...profileGuardBase, id: 'ra-filled', company: 'Guard Co ra-filled', url: 'https://jobs.example.com/ra-filled', approval: 'STANDING AUTHORIZATION',
    telemetry: { fieldsFilled: 11, shortAnswerCount: 2, resumeUploaded: true, durationBucket: '5-15m' },
  });
  assert.equal(filled.code, 0, filled.stderr);

  const rows = (await readFile(join(cli.directory, 'applications.ndjson'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.id), ['ra-review-each-ok', 'ra-filled']);
  assert.equal(rows.some((row) => 'jobApprovalMode' in row), false);
  // The global profile setting is never touched.
  assert.equal(await readFile(cli.profileFile, 'utf8'), before);
  assert.equal(JSON.parse(before).submissionMode, 'routine-auto');
});

test('migration defaults submissionMode to review-each but keeps an explicit choice', () => {
  const legacy = { name: 'Test Candidate', email: 'candidate@example.com', phone: '+1 555 0100', location: 'Bengaluru, India', workAuthorization: 'India' };
  assert.equal(migrateProfile(legacy, {}).submissionMode, 'review-each');
  assert.equal(migrateProfile({ ...legacy, submissionMode: 'review-each' }, {}).submissionMode, 'review-each');
  const chosen = migrateProfile({ ...legacy, submissionMode: 'routine-auto', submissionModeChosenAt: '2026-10-01T00:00:00.000Z' }, {});
  assert.equal(chosen.submissionMode, 'routine-auto');
  assert.equal(chosen.submissionModeChosenAt, '2026-10-01T00:00:00.000Z');
  const override = migrateProfile(legacy, { submissionMode: 'routine-auto' });
  assert.equal(override.submissionMode, 'routine-auto');
});

test('unstamped routine-auto is normalized to review-each; stamped routine-auto is kept', () => {
  const unstamped = normalizeSubmissionMode({ ...target, submissionMode: 'routine-auto' });
  assert.equal(unstamped.reset, true);
  assert.equal(unstamped.profile.submissionMode, 'review-each');
  assert.equal('submissionModeChosenAt' in unstamped.profile, false);
  const bogus = normalizeSubmissionMode({ ...target, submissionMode: 'routine-auto', submissionModeChosenAt: 'yes' });
  assert.equal(bogus.profile.submissionMode, 'review-each');
  const stamped = normalizeSubmissionMode({ ...target, submissionMode: 'routine-auto', submissionModeChosenAt: '2026-10-22T08:00:00Z' });
  assert.equal(stamped.reset, false);
  assert.equal(stamped.profile.submissionMode, 'routine-auto');
  assert.equal(normalizeSubmissionMode({ ...target }).reset, false);
});

test('explicit routine-auto writes are stamped; review-each drops the stamp', () => {
  const now = new Date('2026-10-22T08:00:00Z');
  assert.equal(stampSubmissionModeChoice(validateProfile({ ...target, submissionMode: 'routine-auto' }), now).submissionModeChosenAt, now.toISOString());
  const kept = stampSubmissionModeChoice(validateProfile({ ...target, submissionMode: 'routine-auto', submissionModeChosenAt: '2026-10-01T00:00:00.000Z' }), now);
  assert.equal(kept.submissionModeChosenAt, '2026-10-01T00:00:00.000Z');
  assert.equal('submissionModeChosenAt' in validateProfile({ ...target, submissionModeChosenAt: '2026-10-01T00:00:00.000Z' }), false);
  assert.equal(stampSubmissionModeChoice(validateProfile(target), now).submissionModeChosenAt, undefined);
  assert.throws(() => validateProfile({ ...target, submissionMode: 'routine-auto', submissionModeChosenAt: 'soon' }), /ISO timestamp/);
});

test('a stored unstamped routine-auto profile runs as review-each and prints the notice once', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cli = await profileBackedCli(t, { ...target, submissionMode: 'routine-auto' });
  const before = await readFile(cli.profileFile, 'utf8');
  const first = await cli.add({
    ...profileGuardBase, id: 'reset-empty', company: 'Guard Co reset-empty', url: 'https://jobs.example.com/reset-empty', approval: 'APPROVE SUBMIT', telemetry: emptyTelemetry,
    thinSubmissionOverride: thinOverride('Candidate confirmed in chat this empty apply for reset job is intended'),
  });
  // Under routine-auto this thin submit would be blocked; as review-each the attended override is allowed.
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stderr.split(SUBMISSION_MODE_RESET_NOTICE.trim()).length - 1, 1, first.stderr);
  const second = await cli.add({
    ...profileGuardBase, id: 'reset-filled', company: 'Guard Co reset-filled', url: 'https://jobs.example.com/reset-filled', approval: 'APPROVE SUBMIT',
    telemetry: { fieldsFilled: 9, shortAnswerCount: 1, resumeUploaded: true, durationBucket: '5-15m' },
  });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stderr.includes(SUBMISSION_MODE_RESET_NOTICE.trim()), false);
  assert.equal(await readFile(cli.profileFile, 'utf8'), before);
});

test('ledger add under a review-each profile keeps the existing thin-submit behavior', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cli = await profileBackedCli(t, { ...target, submissionMode: 'review-each' });
  const blocked = await cli.add({
    ...profileGuardBase, id: 're-empty', company: 'Guard Co re-empty', url: 'https://jobs.example.com/re-empty', approval: 'APPROVE SUBMIT', telemetry: emptyTelemetry,
  });
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /looks empty/i);
  assert.equal(blocked.stderr.includes(routineAutoProfileThinSubmitError().message), false);
  const allowed = await cli.add({
    ...profileGuardBase, id: 're-empty-ack', company: 'Guard Co re-empty-ack', url: 'https://jobs.example.com/re-empty-ack', approval: 'APPROVE SUBMIT', telemetry: emptyTelemetry,
    thinSubmissionOverride: thinOverride('Candidate confirmed in chat this review-each empty apply is intended'),
  });
  assert.equal(allowed.code, 0, allowed.stderr);
});
