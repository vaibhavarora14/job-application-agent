import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import worker, { sha256Hex } from '../src/worker.mjs';
import { createMemoryD1 } from './d1-mock.mjs';
import { createMemoryR2 } from './r2-mock.mjs';

const TOKEN_A = 'mac-client-token-with-sufficient-length-aaaa';
const TOKEN_B = 'vps-client-token-with-sufficient-length-bbbb';

async function setup() {
  const schema = await readFile(new URL('../migrations/0001_private_state.sql', import.meta.url), 'utf8');
  const DB = createMemoryD1(schema);
  const now = new Date().toISOString();
  await DB.prepare('INSERT INTO clients (client_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('client-mac', 'Mac Codex', sha256Hex(TOKEN_A), now).run();
  await DB.prepare('INSERT INTO clients (client_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('client-vps', 'VPS Codex', sha256Hex(TOKEN_B), now).run();
  return { DB, STATE: createMemoryR2(), STATE_TOKEN: 'legacy-token', LEGACY_WRITES_DISABLED: '1' };
}

function request(path, { method = 'GET', token = TOKEN_A, body, headers = {} } = {}) {
  const next = { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  if (body !== undefined && !next['content-type']) next['content-type'] = 'application/json';
  const requestBody = body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
  return new Request(`https://state.example.com${path}`, { method, headers: next, body: requestBody });
}

test('v2 authenticates separate revocable clients without exposing hashes', async () => {
  const env = await setup();
  const response = await worker.fetch(request('/v2/status', { token: TOKEN_B }), env);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.client.id, 'client-vps');
  assert.equal(JSON.stringify(status).includes('token_hash'), false);

  await env.DB.prepare('UPDATE clients SET revoked_at = ? WHERE client_id = ?').bind(new Date().toISOString(), 'client-vps').run();
  assert.equal((await worker.fetch(request('/v2/status', { token: TOKEN_B }), env)).status, 401);
});

test('health check is public and exposes no private state', async () => {
  const env = await setup();
  const response = await worker.fetch(request('/healthz', { token: null }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('documents use revisions and reject stale updates', async () => {
  const env = await setup();
  const first = await worker.fetch(request('/v2/documents/profile', { method: 'PUT', body: { value: { name: 'Ada' } }, headers: { 'if-match': '0' } }), env);
  assert.equal(first.status, 201);
  assert.equal((await first.json()).revision, 1);
  const stale = await worker.fetch(request('/v2/documents/profile', { method: 'PUT', body: { value: { name: 'Grace' } }, headers: { 'if-match': '0' } }), env);
  assert.equal(stale.status, 409);
  const get = await worker.fetch(request('/v2/documents/profile', { token: TOKEN_B }), env);
  assert.deepEqual((await get.json()).value, { name: 'Ada' });
});

test('record appends are idempotent and visible across clients', async () => {
  const env = await setup();
  const payload = { recordKey: 'app-1', idempotencyKey: 'migration:app-1', occurredAt: '2026-01-01T00:00:00.000Z', value: { id: 'app-1', company: 'Example' }, provenance: 'mac-migration' };
  const first = await worker.fetch(request('/v2/streams/applications', { method: 'POST', body: payload }), env);
  assert.equal(first.status, 201);
  const retry = await worker.fetch(request('/v2/streams/applications', { method: 'POST', body: payload }), env);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  const list = await worker.fetch(request('/v2/streams/applications', { token: TOKEN_B }), env);
  const body = await list.json();
  assert.equal(body.records.length, 1);
  assert.deepEqual(body.records[0].value, payload.value);
});

test('batch record import is bounded and idempotent', async () => {
  const env = await setup();
  const records = [1, 2].map((number) => ({ recordKey: `app-${number}`, idempotencyKey: `batch-${number}`, occurredAt: '2026-01-01T00:00:00.000Z', value: { id: `app-${number}` }, provenance: 'cutover' }));
  const first = await worker.fetch(request('/v2/streams/applications/batch', { method: 'POST', body: { records } }), env);
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { stream: 'applications', attempted: 2, inserted: 2, duplicates: 0 });
  const retry = await worker.fetch(request('/v2/streams/applications/batch', { method: 'POST', body: { records } }), env);
  assert.equal((await retry.json()).duplicates, 2);
});

test('one application lease excludes other clients and expires safely', async () => {
  const env = await setup();
  const acquired = await worker.fetch(request('/v2/leases/application-run', { method: 'POST', body: { action: 'acquire' } }), env);
  assert.equal(acquired.status, 201);
  const lease = await acquired.json();
  const denied = await worker.fetch(request('/v2/leases/application-run', { method: 'POST', token: TOKEN_B, body: { action: 'acquire' } }), env);
  assert.equal(denied.status, 409);
  const renewed = await worker.fetch(request('/v2/leases/application-run', { method: 'POST', body: { action: 'renew', leaseId: lease.leaseId } }), env);
  assert.equal(renewed.status, 200);
  assert.ok(Date.parse((await renewed.json()).expiresAt) > Date.now());
});

test('resume is stored privately in R2 and verified by checksum', async () => {
  const env = await setup();
  const bytes = Buffer.from('%PDF-1.7\nsynthetic-test-pdf-content');
  const put = await worker.fetch(request('/v2/files/resume.pdf', { method: 'PUT', body: bytes, headers: { 'content-type': 'application/pdf', 'if-match': '0', 'x-content-sha256': sha256Hex(bytes) } }), env);
  assert.equal(put.status, 201);
  const get = await worker.fetch(request('/v2/files/resume.pdf', { token: TOKEN_B }), env);
  assert.equal(get.status, 200);
  assert.equal(Buffer.from(await get.arrayBuffer()).equals(bytes), true);
  assert.equal(get.headers.get('x-sha256'), sha256Hex(bytes));
});

test('resume storage works through the existing Workers KV fallback', async () => {
  const env = await setup();
  delete env.STATE;
  const entries = new Map();
  env.STATE_KV = {
    async getWithMetadata(key, type) {
      const found = entries.get(key);
      if (!found) return { value: null, metadata: null };
      return { value: type === 'arrayBuffer' ? found.bytes.buffer.slice(found.bytes.byteOffset, found.bytes.byteOffset + found.bytes.byteLength) : new TextDecoder().decode(found.bytes), metadata: found.metadata };
    },
    async put(key, value, options = {}) {
      const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
      entries.set(key, { bytes, metadata: options.metadata ?? {} });
    },
    async delete(key) { entries.delete(key); },
  };
  const bytes = Buffer.from('%PDF-1.7\nsynthetic-kv-pdf-content');
  const put = await worker.fetch(request('/v2/files/resume.pdf', { method: 'PUT', body: bytes, headers: { 'content-type': 'application/pdf', 'if-match': '0', 'x-content-sha256': sha256Hex(bytes) } }), env);
  assert.equal(put.status, 201);
  const get = await worker.fetch(request('/v2/files/resume.pdf', { token: TOKEN_B }), env);
  assert.equal(Buffer.from(await get.arrayBuffer()).equals(bytes), true);
  assert.equal(get.headers.get('x-sha256'), sha256Hex(bytes));
});

test('legacy reads remain available but whole-ledger writes are disabled', async () => {
  const env = await setup();
  const legacyRead = await worker.fetch(request('/v1/manifest', { token: 'legacy-token' }), env);
  assert.equal(legacyRead.status, 200);
  const legacyWrite = await worker.fetch(request('/v1/ledgers/applications.ndjson', { method: 'POST', token: 'legacy-token', body: { lines: ['{"id":"a1"}'] } }), env);
  assert.equal(legacyWrite.status, 410);
});

test('forbidden credential-like fields are rejected from structured storage', async () => {
  const env = await setup();
  const response = await worker.fetch(request('/v2/streams/attention', { method: 'POST', body: { recordKey: 'x', idempotencyKey: 'x', value: { password: 'do-not-store' } } }), env);
  assert.equal(response.status, 400);
});

test('submission intent requires the lease and confirmation atomically records application and round', async () => {
  const env = await setup();
  const lease = await (await worker.fetch(request('/v2/leases/application-run', { method: 'POST', body: { action: 'acquire' } }), env)).json();
  const preparedResponse = await worker.fetch(request('/v2/intents', { method: 'POST', body: { applicationId: 'app-2', roundId: 'round-1', canonicalUrl: 'https://jobs.example/app-2', leaseId: lease.leaseId } }), env);
  assert.equal(preparedResponse.status, 201);
  const prepared = await preparedResponse.json();
  const uncertain = await worker.fetch(request(`/v2/intents/${prepared.intentId}/sent-unverified`, { method: 'POST', body: { leaseId: lease.leaseId } }), env);
  assert.equal((await uncertain.json()).requiresVerification, true);

  const confirmation = await worker.fetch(request(`/v2/intents/${prepared.intentId}/confirm`, { method: 'POST', body: { leaseId: lease.leaseId, application: { id: 'app-2', roundId: 'round-1', submittedAt: '2026-01-02T00:00:00.000Z' } } }), env);
  assert.equal(confirmation.status, 200);
  const applications = await (await worker.fetch(request('/v2/streams/applications'), env)).json();
  const rounds = await (await worker.fetch(request('/v2/streams/rounds'), env)).json();
  assert.equal(applications.records.length, 1);
  assert.equal(rounds.records.length, 1);
  assert.equal(rounds.records[0].value.applicationId, 'app-2');
});

test('intent is rejected without a live lease and an uncertain intent prevents retry', async () => {
  const env = await setup();
  assert.equal((await worker.fetch(request('/v2/intents', { method: 'POST', body: { applicationId: 'app-3', canonicalUrl: 'https://jobs.example/app-3', leaseId: 'missing' } }), env)).status, 409);
  const lease = await (await worker.fetch(request('/v2/leases/application-run', { method: 'POST', body: { action: 'acquire' } }), env)).json();
  const intent = await (await worker.fetch(request('/v2/intents', { method: 'POST', body: { applicationId: 'app-3', canonicalUrl: 'https://jobs.example/app-3', leaseId: lease.leaseId } }), env)).json();
  await worker.fetch(request(`/v2/intents/${intent.intentId}/sent-unverified`, { method: 'POST', body: { leaseId: lease.leaseId } }), env);
  const retry = await worker.fetch(request('/v2/intents', { method: 'POST', body: { applicationId: 'app-3', canonicalUrl: 'https://jobs.example/app-3', leaseId: lease.leaseId } }), env);
  assert.equal(retry.status, 409);
  assert.match((await retry.json()).error, /sent-unverified/);
});
