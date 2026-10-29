import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { reviewCommandTelemetryResult } from '../scripts/job-application.mjs';
import { approvalPhrase, approveBatch, batchSummary, closeBatch, consumeReview, reviewTelemetryResult, stageBatch } from '../scripts/review-batch.mjs';
import { validateEvent } from '../scripts/telemetry-schema.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
const item = (overrides = {}) => ({ type: 'application', applicationId: 'acme-1', company: 'Acme', role: 'Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1', ats: 'greenhouse', fitScore: 82, answers: { 'Why us?': 'Because.' }, ...overrides });

async function stateDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'review-telemetry-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

test('reviewTelemetryResult is success only when the batch sent something', () => {
  assert.equal(reviewTelemetryResult([]), 'skipped');
  assert.equal(reviewTelemetryResult([{ status: 'pending', used: 0 }]), 'paused');
  assert.equal(reviewTelemetryResult([{ status: 'approved', used: 0 }]), 'paused');
  assert.equal(reviewTelemetryResult([{ status: 'expired', used: 0 }, { status: 'rejected', used: 0 }, { status: 'revoked', used: 0 }]), 'abandoned');
  assert.equal(reviewTelemetryResult([{ status: 'approved', used: 1 }]), 'success');
  assert.equal(reviewTelemetryResult([{ status: 'expired', used: 2 }, { status: 'pending', used: 0 }]), 'success');
  // Every value is an existing command_completed result, so the relay accepts it unchanged.
  for (const result of ['skipped', 'paused', 'abandoned', 'success']) {
    assert.doesNotThrow(() => validateEvent({ event: 'command_completed', properties: { command: 'batch', result, durationBucket: 'under-1s' } }));
  }
});

test('reviewCommandTelemetryResult follows the batch through stage, approve, send and revoke', async (t) => {
  const directory = await stateDir(t);
  const opts = { stateDirectory: directory };
  const staged = await stageBatch(directory, { items: [item(), item({ applicationId: 'acme-2', url: 'https://boards.greenhouse.io/acme/jobs/2' })] });
  assert.equal(await reviewCommandTelemetryResult('stage', '--stdin', { batchId: staged.batchId }, opts), 'paused');
  assert.equal(await reviewCommandTelemetryResult('status', staged.batchId, {}, opts), 'paused');
  const { batch: approved } = await approveBatch(directory, staged.batchId, { channel: 'chat-phrase', phrase: approvalPhrase(staged) });
  assert.equal(await reviewCommandTelemetryResult('approve', '--stdin', { batchId: approved.batchId }, opts), 'paused', 'approved but nothing sent is still a stall');
  await consumeReview(directory, staged.batchId, 'i1', 'ledger-add');
  assert.equal(await reviewCommandTelemetryResult('status', staged.batchId, {}, opts), 'success');

  const other = await stageBatch(directory, { items: [item({ applicationId: 'beta-1', url: 'https://boards.greenhouse.io/beta/jobs/1' })] });
  const revoked = await closeBatch(directory, other.batchId, 'revoked');
  assert.equal(await reviewCommandTelemetryResult('revoke', other.batchId, { batchId: other.batchId }, opts), 'abandoned');

  assert.equal(await reviewCommandTelemetryResult('list', undefined, { batches: [batchSummary(revoked)] }, opts), 'abandoned');
  assert.equal(await reviewCommandTelemetryResult('list', undefined, { batches: [] }, opts), 'skipped');
  assert.equal(await reviewCommandTelemetryResult('stage', '--stdin', { staged: false, batchId: null }, opts), 'paused');
  assert.equal(await reviewCommandTelemetryResult('show', 'rb-20260101-deadbeef', {}, opts), 'paused', 'an unreadable batch is never reported as success');
});

async function relay(t) {
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
  return { captured, url: `http://127.0.0.1:${server.address().port}` };
}

function runCli(env, args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr, json: code === 0 ? JSON.parse(stdout) : null }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

test('a round that stages and polls batches without submitting never reports batch success', async (t) => {
  const directory = await stateDir(t);
  const { captured, url } = await relay(t);
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: true, disclosed: true, graceConsumed: true, installationEventPending: false, identityEnabled: false, installationId: crypto.randomUUID(), token: 'synthetic-token', tokenExpiresAt: '2099-01-01T00:00:00Z' }));
  const env = {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_TELEMETRY_URL: url,
    JOB_APPLICATION_AGENT_NO_BROWSER: '1',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
  const staged = await runCli(env, ['review', 'stage', '--stdin'], { items: [item()] });
  assert.equal(staged.code, 0, staged.stderr);
  for (let i = 0; i < 3; i += 1) assert.equal((await runCli(env, ['review', 'status', staged.json.batchId])).code, 0);
  assert.equal((await runCli(env, ['review', 'list'])).code, 0);
  assert.equal((await runCli(env, ['review', 'revoke', staged.json.batchId])).code, 0);
  const batch = captured.filter((body) => body.event === 'command_completed' && body.properties.command === 'batch').map((body) => body.properties.result);
  assert.deepEqual(batch, ['paused', 'paused', 'paused', 'paused', 'paused', 'abandoned']);
  assert.equal(captured.filter((body) => body.event === 'application_submitted').length, 0);
});
