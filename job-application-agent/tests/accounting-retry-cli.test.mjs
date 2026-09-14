import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { validateDelivery } from '../scripts/application-accounting.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

test('CLI records a transmitted cloud retry when late receipt evidence invalidates its original preparation eligibility', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'accounting-retry-cli-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const token = 'synthetic-accounting-retry-cli-token-long-enough';
  const intentId = 'prepared-recovery-intent';
  const leaseId = 'synthetic-live-lease';
  const occurredAt = '2026-09-14T10:00:00.000Z';
  const application = { id: 'app', company: 'Example', role: 'Engineer', url: 'https://jobs.example.com/app', source: 'email', status: 'submitted', submittedAt: '2026-09-12T10:00:00.000Z' };
  const failure = validateDelivery({ version: 1, id: 'failure-event', applicationId: 'app', attemptId: 'initial:app', type: 'delivery-failed', occurredAt: '2026-09-13T10:00:00.000Z', evidenceType: 'final-delivery-failure', evidence: 'Synthetic final failure matched to original email.' });
  const receipt = validateDelivery({ version: 1, id: 'late-receipt', applicationId: 'app', attemptId: 'initial:app', type: 'receipt-confirmed', occurredAt, evidenceType: 'employer-acknowledgement', evidence: 'Synthetic employer acknowledgement arrived after recovery was transmitted.' });
  const retry = validateDelivery({ version: 1, id: 'retry-event', applicationId: 'app', attemptId: intentId, type: 'retry-confirmed', channel: 'browser', url: application.url, channelVerifiedAt: occurredAt, approval: 'STANDING AUTHORIZATION', evidenceType: 'browser-confirmation', evidence: 'Synthetic visible ATS success for prepared recovery.', occurredAt });
  const streams = { applications: [application], delivery: [failure, receipt] };
  const confirmations = [];
  const unexpected = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end(JSON.stringify({ error: 'Synthetic authentication required' }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v2/status') {
      response.end(JSON.stringify({ apiVersion: 2, backend: 'synthetic-accounting-backend', capabilities: ['application-accounting-v1'], documents: [], streams: [], files: [] }));
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v2/streams/')) {
      const stream = url.pathname.split('/').at(-1);
      const records = (streams[stream] ?? []).map((value, index) => ({ sequence: index + 1, recordKey: value.id, idempotencyKey: `accounting:${value.id}`, value }));
      const after = Number(url.searchParams.get('after') ?? 0);
      const page = records.filter(record => record.sequence > after);
      response.end(JSON.stringify({ stream, records: page, nextCursor: page.at(-1)?.sequence ?? after }));
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v2/documents/')) {
      response.writeHead(404).end(JSON.stringify({ error: 'Synthetic document not present' }));
      return;
    }
    if (request.method === 'POST' && url.pathname === `/v2/intents/${intentId}/confirm`) {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      confirmations.push(body);
      if (body.leaseId !== leaseId || body.delivery?.attemptId !== intentId) {
        response.writeHead(409).end(JSON.stringify({ error: 'Wrong prepared intent or lease' }));
        return;
      }
      streams.delivery.push(body.delivery);
      response.end(JSON.stringify({ confirmed: true, intentId }));
      return;
    }
    unexpected.push(`${request.method} ${url.pathname}`);
    response.writeHead(500).end(JSON.stringify({ error: 'Unexpected synthetic backend request' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const backendUrl = `http://127.0.0.1:${server.address().port}`;
  const preload = `const realFetch = globalThis.fetch; globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' ? input : input.url); if (url.origin !== 'https://state.example.com') throw new Error('Unexpected non-fixture network request'); return realFetch(${JSON.stringify(backendUrl)} + url.pathname + url.search, init); };`;
  const configPath = join(stateDir, 'cloud-config.json');
  await writeFile(configPath, JSON.stringify({ version: 2, url: 'https://state.example.com', token, clientId: 'synthetic-client' }), { mode: 0o600 });
  await writeFile(join(stateDir, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  for (const [stream, rows] of Object.entries(streams)) {
    await writeFile(join(stateDir, `${stream}.ndjson`), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
  }
  const env = { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: stateDir, JOB_APPLICATION_AGENT_CLOUD_CONFIG: configPath, JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9' };
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, script, 'ledger', 'retry', '--stdin'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ ...retry, cloudIntentId: intentId, cloudLeaseId: leaseId }));
  });

  assert.deepEqual(unexpected, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(confirmations.length, 1);
  assert.deepEqual(confirmations[0], { delivery: retry, leaseId });
  assert.equal(JSON.parse(result.stdout).recorded, true);
  const localEvents = (await readFile(join(stateDir, 'delivery.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(localEvents.filter(event => event.type === 'retry-confirmed' && event.attemptId === intentId).length, 1);
});
