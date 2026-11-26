import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { skillErrorProperties, telemetryErrorCode } from '../scripts/job-application.mjs';
import { sanitizeTelemetryErrorMessage } from '../scripts/telemetry-schema.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
const PASTE = 'Software engineer with ten years of backend TypeScript experience building APIs.';

function isolatedEnv(directory) {
  return {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
}

function runCli(args, { env, stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin === undefined) child.stdin.end();
    else if (Buffer.isBuffer(stdin)) child.stdin.end(stdin);
    else child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

async function stateDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jaa-resume-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({
    version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false,
  }));
  return directory;
}

function assertRecovery(stderr, { omit = [] } = {}) {
  assert.match(stderr, /resume import --stdin/);
  assert.match(stderr, /Do not skip this step and do not invent a résumé/);
  assert.match(stderr, /absolute path to a \.pdf/i);
  assert.equal(telemetryErrorCode(new Error(stderr.replace(/^Error: /, ''))), 'upload_failed');
  const sanitized = sanitizeTelemetryErrorMessage(stderr.replace(/^Error: /, ''));
  for (const value of omit) {
    assert.equal(stderr.includes(value), false, `stderr leaked ${value}`);
    assert.equal(sanitized?.includes(value), false, `sanitized leaked ${value}`);
  }
}

test('resume import with no source prints recovery instead of a dead end', async (t) => {
  const directory = await stateDir(t);
  const result = await runCli(['resume', 'import'], { env: isolatedEnv(directory) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No résumé source was given/);
  assertRecovery(result.stderr);
});

test('resume path with no résumé prints recovery', async (t) => {
  const directory = await stateDir(t);
  const result = await runCli(['resume', 'path'], { env: isolatedEnv(directory) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Canonical resume is not imported/);
  assertRecovery(result.stderr);
});

test('resume import of a non-PDF prints recovery and omits the path', async (t) => {
  const directory = await stateDir(t);
  const docx = join(directory, 'cv-secret-name.docx');
  await writeFile(docx, 'not a pdf');
  const result = await runCli(['resume', 'import', docx], { env: isolatedEnv(directory) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Local resume must be a PDF/);
  assertRecovery(result.stderr, { omit: [docx, 'cv-secret-name', directory] });
  const properties = skillErrorProperties(new Error(result.stderr.replace(/^Error: /, '')), 'resume');
  assert.equal(properties.errorCode, 'upload_failed');
  assert.equal(properties.recoverable, true);
  assert.equal(properties.sanitizedMessage.includes('cv-secret-name'), false);
  assert.equal(properties.sanitizedMessage.includes(directory), false);
});

test('resume import --stdin with empty input prints recovery', async (t) => {
  const directory = await stateDir(t);
  const result = await runCli(['resume', 'import', '--stdin'], { env: isolatedEnv(directory), stdin: '' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No résumé was pasted/);
  assertRecovery(result.stderr);
});

test('resume import --stdin pastes text, writes a PDF, and offers the first job', async (t) => {
  const directory = await stateDir(t);
  const result = await runCli(['resume', 'import', '--stdin'], {
    env: isolatedEnv(directory),
    stdin: { text: PASTE },
  });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.sourceKind, 'pasted-text');
  assert.equal(body.firstJob.mode, 'review-each');
  assert.equal(body.firstJob.resumeImported, true);
  assert.equal(body.firstJob.autoSubmit, false);
  const stored = await readFile(join(directory, 'resume.pdf'));
  assert.equal(stored.subarray(0, 4).toString('ascii'), '%PDF');
  assert.match(stored.toString('latin1'), /Software engineer with ten years/);
  assert.equal(result.stderr.includes(PASTE), false);
  const metadata = JSON.parse(await readFile(join(directory, 'resume.json'), 'utf8'));
  assert.equal(metadata.source, 'pasted-text');
  assert.equal(JSON.stringify(metadata).includes(PASTE), false);
});

test('resume import --stdin accepts raw pasted text', async (t) => {
  const directory = await stateDir(t);
  const result = await runCli(['resume', 'import', '--stdin'], {
    env: isolatedEnv(directory),
    stdin: PASTE,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sourceKind, 'pasted-text');
});

test('resume import --stdin accepts raw PDF bytes', async (t) => {
  const directory = await stateDir(t);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 0x20), Buffer.from('\n%%EOF\n')]);
  const result = await runCli(['resume', 'import', '--stdin'], {
    env: isolatedEnv(directory),
    stdin: pdf,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sourceKind, 'pdf-bytes');
});

test('resume import --stdin JSON path recovers a local PDF', async (t) => {
  const directory = await stateDir(t);
  const pdfPath = join(directory, 'source.pdf');
  const fixture = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1000, 0x20), Buffer.from('\n%%EOF\n')]);
  await writeFile(pdfPath, fixture);
  const result = await runCli(['resume', 'import', '--stdin'], {
    env: isolatedEnv(directory),
    stdin: { path: pdfPath },
  });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.sourceKind, 'local-pdf');
  assert.equal(body.firstJob.resumeImported, true);
});

test('a failed paste does not echo résumé text into stderr or telemetry', async (t) => {
  const directory = await stateDir(t);
  const secret = 'SECRET-RESUME-BODY-MUST-NOT-LEAK';
  const result = await runCli(['resume', 'import', '--stdin'], {
    env: isolatedEnv(directory),
    stdin: { text: secret },
  });
  assert.equal(result.code, 1);
  assertRecovery(result.stderr, { omit: [secret] });
});
