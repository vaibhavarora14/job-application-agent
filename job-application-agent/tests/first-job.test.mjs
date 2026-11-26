import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MIN_PASTED_RESUME_CHARS,
  RESUME_IMPORT_RECOVERY,
  activationSnapshot,
  assertPastedResumeText,
  firstJobGuide,
  firstJobReason,
  formatFirstJobGuide,
  hasAssessedJob,
  parseResumeImportInput,
  resumeImportFailure,
} from '../scripts/first-job.mjs';
import { ASSESSMENT_DECISIONS_FILE } from '../scripts/routine-gates.mjs';
import { sanitizeTelemetryErrorMessage } from '../scripts/telemetry-schema.mjs';

test('firstJobReason distinguishes install, upgrade, and pending', () => {
  assert.equal(firstJobReason(null, '3.8.10'), 'install');
  assert.equal(firstJobReason('3.8.5', '3.8.10'), 'upgrade');
  assert.equal(firstJobReason('3.8.10', '3.8.10'), 'pending');
});

test('firstJobGuide is absent after an assessment and names resume recovery before then', () => {
  assert.equal(firstJobGuide('3.8.10', null, { assessed: true, resumeImported: false }), null);
  assert.equal(firstJobGuide('3.8.10', null, { assessed: true, resumeImported: true }), null);
  const missing = firstJobGuide('3.8.10', null, { assessed: false, resumeImported: false });
  assert.equal(missing.reason, 'install');
  assert.equal(missing.mode, 'review-each');
  assert.equal(missing.autoSubmit, false);
  assert.equal(missing.resumeImported, false);
  assert.equal(missing.jobsUrl, 'https://jobappagent.com/jobs');
  assert.match(missing.instruction, /Do not auto-submit/);
  assert.match(missing.instruction, /Do not invent fill counts/);
  assert.equal(missing.resumeRecovery, RESUME_IMPORT_RECOVERY);
  const ready = firstJobGuide('3.8.10', '3.8.10', { assessed: false, resumeImported: true });
  assert.equal(ready.reason, 'pending');
  assert.equal(ready.resumeImported, true);
  assert.equal(ready.resumeRecovery, undefined);
  assert.match(ready.instruction, /A résumé is already imported/);
});

test('formatFirstJobGuide never includes a file name, company name, or résumé body', () => {
  const text = formatFirstJobGuide(firstJobGuide('3.8.10', null, { resumeImported: false }));
  assert.match(text, /Next: complete one first job/);
  assert.match(text, /resume import --stdin/);
  assert.match(text, /https:\/\/jobappagent\.com\/jobs/);
  assert.doesNotMatch(text, /\/Users\//);
  assert.doesNotMatch(text, /Acme Corp|Jane Doe|curriculum vitae/i);
});

test('resumeImportFailure is upload_failed, recoverable, and strips identity from telemetry', () => {
  const error = resumeImportFailure('Résumé file not found at the given path; pass an absolute path or a Google Doc URL.');
  assert.equal(error.telemetryErrorCode, 'upload_failed');
  assert.match(error.message, /resume import --stdin/);
  assert.doesNotMatch(error.message, /\/tmp\/secret-resume\.pdf/);
  const sanitized = sanitizeTelemetryErrorMessage(error.message, { homeDir: '/home/qa-person', userName: 'qa-person' });
  assert.ok(sanitized);
  assert.doesNotMatch(sanitized, /qa-person/);
  assert.doesNotMatch(sanitized, /https:\/\//);
});

test('hasAssessedJob ignores empty or malformed decision files', () => {
  assert.equal(hasAssessedJob(null), false);
  assert.equal(hasAssessedJob({ version: 1, jobs: {} }), false);
  assert.equal(hasAssessedJob({ jobs: [] }), false);
  assert.equal(hasAssessedJob({ jobs: { ab: { decision: 'skip' } } }), true);
});

test('activationSnapshot reads local decisions and résumé presence without leaking paths', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'jaa-first-job-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JOB_APPLICATION_AGENT_STATE_DIR: root };
  const empty = await activationSnapshot({ env, homeDir: root });
  assert.deepEqual(empty, { assessed: false, resumeImported: false });
  await writeFile(path.join(root, 'resume.pdf'), '%PDF-1.4\n');
  const withResume = await activationSnapshot({ env, homeDir: root });
  assert.equal(withResume.resumeImported, true);
  assert.equal(withResume.assessed, false);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, ASSESSMENT_DECISIONS_FILE), JSON.stringify({
    version: 1,
    jobs: { cd: { decision: 'review', autoEligible: false, score: 72, at: '2026-11-26T00:00:00.000Z' } },
  }));
  const assessed = await activationSnapshot({ env, homeDir: root });
  assert.equal(assessed.assessed, true);
  assert.equal(JSON.stringify(assessed).includes(root), false);
});

test('activationSnapshot treats a v2 cloud config as an imported résumé without reading the host config', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'jaa-first-job-cloud-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'cloud.json');
  await writeFile(configPath, JSON.stringify({
    version: 2,
    url: 'https://127.0.0.1:9',
    token: 'cloud-client-token-with-sufficient-length',
    clientId: 'cloud-client',
  }));
  const snapshot = await activationSnapshot({
    env: { JOB_APPLICATION_AGENT_STATE_DIR: root, JOB_APPLICATION_AGENT_CLOUD_CONFIG: configPath },
    homeDir: root,
  });
  assert.equal(snapshot.resumeImported, true);
  assert.equal(snapshot.assessed, false);
  assert.equal(JSON.stringify(snapshot).includes(configPath), false);
});

test('parseResumeImportInput accepts path, URL, JSON, paste, and PDF bytes', () => {
  assert.equal(parseResumeImportInput('').kind, 'empty');
  assert.equal(parseResumeImportInput(Buffer.alloc(0)).kind, 'empty');
  assert.deepEqual(parseResumeImportInput('/abs/resume.pdf'), { kind: 'path', source: '/abs/resume.pdf' });
  assert.equal(parseResumeImportInput('https://docs.google.com/document/d/abc').kind, 'url');
  assert.equal(parseResumeImportInput(undefined, { inlineJson: { text: 'Software engineer with ten years of TypeScript.' } }).kind, 'text');
  assert.equal(parseResumeImportInput(undefined, { inlineJson: { path: '/abs/resume.pdf' } }).source, '/abs/resume.pdf');
  assert.equal(parseResumeImportInput(undefined, { inlineJson: { url: 'https://docs.google.com/document/d/abc' } }).kind, 'url');
  assert.equal(parseResumeImportInput(undefined, { inlineJson: [] }).kind, 'invalid-json');
  const pdf = Buffer.from('%PDF-1.4\nfixture');
  assert.equal(parseResumeImportInput(pdf).kind, 'pdf-bytes');
  const pasted = parseResumeImportInput('Software engineer with ten years of TypeScript APIs.\n');
  assert.equal(pasted.kind, 'text');
  assert.match(pasted.text, /Software engineer/);
});

test('assertPastedResumeText rejects empty and short paste without echoing it', () => {
  assert.throws(() => assertPastedResumeText(''), /empty/);
  assert.throws(() => assertPastedResumeText('short'), new RegExp(String(MIN_PASTED_RESUME_CHARS)));
  const secret = 'UNIQUE-PASTE-BODY-SHOULD-NOT-LEAK';
  try {
    assertPastedResumeText(secret);
    assert.fail('expected throw');
  } catch (error) {
    assert.equal(error.message.includes(secret), false);
  }
  const ok = 'Software engineer with ten years of backend TypeScript experience building APIs.';
  assert.equal(assertPastedResumeText(`  ${ok}  `), ok);
});
