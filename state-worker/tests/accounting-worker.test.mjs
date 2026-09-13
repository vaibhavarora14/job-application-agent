import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import worker, { sha256Hex } from '../src/worker.mjs';
import { deliveryProjection } from '../../job-application-agent/scripts/application-accounting.mjs';
import { createMemoryD1, hasNodeSqlite } from './d1-mock.mjs';
import { createMemoryR2 } from './r2-mock.mjs';

const TOKEN_A = 'accounting-mac-token-with-sufficient-length-aaaa';
const TOKEN_B = 'accounting-vps-token-with-sufficient-length-bbbb';
const sqliteTest = hasNodeSqlite ? test : test.skip;
const canonicalUrl = 'https://jobs.example.com/app';

async function setup() {
  const schema = await readFile(new URL('../migrations/0001_private_state.sql', import.meta.url), 'utf8');
  const DB = createMemoryD1(schema);
  const now = new Date().toISOString();
  for (const [id, token] of [['client-mac', TOKEN_A], ['client-vps', TOKEN_B]]) {
    await DB.prepare('INSERT INTO clients (client_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, id, sha256Hex(token), now).run();
  }
  return { DB, STATE: createMemoryR2(), STATE_TOKEN: 'legacy-token', LEGACY_WRITES_DISABLED: '1' };
}

function request(path, { method = 'GET', token = TOKEN_A, body } = {}) {
  return new Request(`https://state.example.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function failure(overrides = {}) {
  return { version: 1, id: 'failure-event', applicationId: 'app', attemptId: 'initial:app', type: 'delivery-failed', occurredAt: new Date().toISOString(), evidenceType: 'final-delivery-failure', evidence: 'Synthetic final recipient failure matched to original email.', ...overrides };
}

function envelope(value) {
  return { recordKey: value.id, idempotencyKey: value.id, occurredAt: value.occurredAt ?? value.observedAt ?? new Date().toISOString(), value };
}

async function seedRecord(env, stream, value) {
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO records (stream, record_key, idempotency_key, payload_json, occurred_at, received_at, client_id, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(stream, value.id, value.id, JSON.stringify(value), now, now, 'client-mac', 'synthetic-test').run();
}

async function seedApplication(env, { failed = true, source = 'email' } = {}) {
  await seedRecord(env, 'applications', { id: 'app', source, company: 'Example', role: 'Engineer', url: canonicalUrl, status: 'submitted', submittedAt: new Date().toISOString() });
  if (failed) await seedRecord(env, 'delivery', failure());
}

async function acquireLease(env) {
  const response = await worker.fetch(request('/v2/leases/application-run', { method: 'POST', body: { action: 'acquire' } }), env);
  assert.equal(response.status, 201);
  return (await response.json()).leaseId;
}

async function prepareRetry(env, leaseId) {
  return worker.fetch(request('/v2/intents', { method: 'POST', body: { applicationId: 'app', canonicalUrl, leaseId, retry: true } }), env);
}

function retryEvent(intentId) {
  const now = new Date().toISOString();
  return { version: 1, id: 'retry-event', applicationId: 'app', attemptId: intentId, type: 'retry-confirmed', channel: 'browser', url: canonicalUrl, channelVerifiedAt: now, approval: 'STANDING AUTHORIZATION', evidenceType: 'browser-confirmation', evidence: 'Synthetic visible confirmation', occurredAt: now };
}

sqliteTest('accounting backend advertises its shared protocol capability', async () => {
  const env = await setup();
  const status = await (await worker.fetch(request('/v2/status'), env)).json();
  assert.ok(status.capabilities?.includes('application-accounting-v1'));
});

sqliteTest('delivery records are validated, idempotent, and visible across trusted clients', async () => {
  const env = await setup();
  await seedApplication(env, { failed: false });
  const invalid = await worker.fetch(request('/v2/streams/delivery', { method: 'POST', body: envelope(failure({ evidenceType: 'guessed-bounce' })) }), env);
  assert.equal(invalid.status, 400);
  const value = failure();
  const first = await worker.fetch(request('/v2/streams/delivery', { method: 'POST', body: envelope(value) }), env);
  assert.equal(first.status, 201);
  const replay = await worker.fetch(request('/v2/streams/delivery', { method: 'POST', body: envelope(value) }), env);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);
  const list = await (await worker.fetch(request('/v2/streams/delivery', { token: TOKEN_B }), env)).json();
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].value.evidence, value.evidence);
});

sqliteTest('orphan delivery evidence is rejected without recording a dangling application or attempt', async () => {
  const env = await setup();
  const absentApplication = await worker.fetch(request('/v2/streams/delivery', { method: 'POST', body: envelope(failure()) }), env);
  assert.equal(absentApplication.status, 400);
  await seedApplication(env, { failed: false });
  const absentAttempt = await worker.fetch(request('/v2/streams/delivery', { method: 'POST', body: envelope(failure({ attemptId: 'unknown-attempt' })) }), env);
  assert.equal(absentAttempt.status, 400);
  const list = await (await worker.fetch(request('/v2/streams/delivery'), env)).json();
  assert.equal(list.records.length, 0);
});

sqliteTest('delivery batch validation rejects invalid schema without partially appending evidence', async () => {
  const env = await setup();
  await seedApplication(env, { failed: false });
  const records = [envelope(failure()), envelope(failure({ id: 'invalid-failure', evidenceType: 'guessed-bounce' }))];
  const response = await worker.fetch(request('/v2/streams/delivery/batch', { method: 'POST', body: { records } }), env);
  assert.equal(response.status, 400);
  const list = await (await worker.fetch(request('/v2/streams/delivery'), env)).json();
  assert.equal(list.records.length, 0);
});

sqliteTest('versioned discovery validates dispositions while preserving unfamiliar legacy records', async () => {
  const env = await setup();
  const legacy = { id: 'legacy-lead', type: 'lead-reviewed', roundId: 'old-round', leadId: 'lead-1', disposition: 'closed-or-stale' };
  const saved = await worker.fetch(request('/v2/streams/discovery', { method: 'POST', body: envelope(legacy) }), env);
  assert.equal(saved.status, 201);
  const invalid = { version: 1, type: 'lead-reviewed', id: 'invalid-lead', roundId: 'round-1', sourceId: 'direct', url: canonicalUrl, company: 'Example', role: 'Engineer', disposition: 'invented-disposition', observedAt: new Date().toISOString(), evidence: 'Synthetic assessment' };
  const denied = await worker.fetch(request('/v2/streams/discovery', { method: 'POST', body: envelope(invalid) }), env);
  assert.equal(denied.status, 400);
  const list = await (await worker.fetch(request('/v2/streams/discovery', { token: TOKEN_B }), env)).json();
  assert.deepEqual(list.records.map(row => row.value), [legacy]);
});

sqliteTest('recovery intent requires a live lease and excludes a different client', async () => {
  const env = await setup();
  await seedApplication(env);
  assert.equal((await prepareRetry(env, 'missing')).status, 409);
  const leaseId = await acquireLease(env);
  const foreign = await worker.fetch(request('/v2/intents', { method: 'POST', token: TOKEN_B, body: { applicationId: 'app', canonicalUrl, leaseId, retry: true } }), env);
  assert.equal(foreign.status, 409);
});

sqliteTest('recovery is denied until every original attempt has a verified final delivery failure', async () => {
  const env = await setup();
  await seedApplication(env, { failed: false });
  const leaseId = await acquireLease(env);
  assert.equal((await prepareRetry(env, leaseId)).status, 409);
  await seedRecord(env, 'delivery', failure());
  assert.equal((await prepareRetry(env, leaseId)).status, 201);
});

sqliteTest('browser notification failure and conflicting evidence never authorize recovery', async () => {
  for (const source of ['ashby', 'email']) {
    const env = await setup();
    await seedApplication(env, { source });
    if (source === 'email') await seedRecord(env, 'delivery', failure({ id: 'receipt-event', type: 'receipt-confirmed', evidenceType: 'employer-acknowledgement' }));
    const leaseId = await acquireLease(env);
    assert.equal((await prepareRetry(env, leaseId)).status, 409, source);
  }
});

sqliteTest('prepared and sent-unverified recovery intents block another recovery transmission', async () => {
  const env = await setup();
  await seedApplication(env);
  const leaseId = await acquireLease(env);
  const prepared = await prepareRetry(env, leaseId);
  assert.equal(prepared.status, 201);
  const { intentId } = await prepared.json();
  assert.equal((await prepareRetry(env, leaseId)).status, 409);
  const uncertain = await worker.fetch(request(`/v2/intents/${intentId}/sent-unverified`, { method: 'POST', body: { leaseId } }), env);
  assert.equal(uncertain.status, 200);
  assert.equal((await prepareRetry(env, leaseId)).status, 409);
});

sqliteTest('simultaneous recovery preparation creates exactly one live intent', async () => {
  const env = await setup();
  await seedApplication(env);
  const leaseId = await acquireLease(env);
  const responses = await Promise.all([prepareRetry(env, leaseId), prepareRetry(env, leaseId)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM application_intents WHERE application_id = ? AND status IN ('prepared', 'sent-unverified')").bind('app').first();
  assert.equal(count.count, 1);
});

sqliteTest('concurrent confirmations with different evidence IDs create only one retry attempt', async () => {
  const env = await setup();
  await seedApplication(env);
  const leaseId = await acquireLease(env);
  const prepared = await prepareRetry(env, leaseId);
  assert.equal(prepared.status, 201);
  const { intentId } = await prepared.json();
  const event = retryEvent(intentId);
  const responses = await Promise.all(['retry-event-a', 'retry-event-b'].map(id => worker.fetch(request(`/v2/intents/${intentId}/confirm`, {
    method: 'POST', body: { leaseId, delivery: { ...event, id } },
  }), env)));
  assert.ok(responses.some(response => response.status === 200));
  assert.ok(responses.every(response => [200, 409].includes(response.status)));
  const applications = await (await worker.fetch(request('/v2/streams/applications'), env)).json();
  const deliveries = await (await worker.fetch(request('/v2/streams/delivery'), env)).json();
  assert.equal(applications.records.length, 1);
  assert.equal(deliveries.records.filter(row => row.value.type === 'retry-confirmed').length, 1);
});

sqliteTest('confirmed recovery appends one retry attempt and preserves a single application', async () => {
  const env = await setup();
  await seedApplication(env);
  const leaseId = await acquireLease(env);
  const prepared = await prepareRetry(env, leaseId);
  assert.equal(prepared.status, 201);
  const { intentId } = await prepared.json();
  const body = { leaseId, delivery: retryEvent(intentId) };
  const confirmation = await worker.fetch(request(`/v2/intents/${intentId}/confirm`, { method: 'POST', body }), env);
  assert.equal(confirmation.status, 200);
  const replay = await worker.fetch(request(`/v2/intents/${intentId}/confirm`, { method: 'POST', body }), env);
  assert.equal(replay.status, 200);
  const applications = await (await worker.fetch(request('/v2/streams/applications', { token: TOKEN_B }), env)).json();
  const deliveries = await (await worker.fetch(request('/v2/streams/delivery', { token: TOKEN_B }), env)).json();
  assert.equal(applications.records.length, 1);
  const events = deliveries.records.map(row => row.value);
  assert.equal(events.filter(event => event.type === 'retry-confirmed').length, 1);
  const projected = deliveryProjection(applications.records.map(row => row.value), events);
  assert.equal(projected.effectiveSubmissionCount, 1);
  assert.equal(projected.applications[0].attempts.length, 2);
  assert.equal((await prepareRetry(env, leaseId)).status, 409);
});

sqliteTest('lease expiry blocks both recovery preparation and confirmation', async () => {
  const env = await setup();
  await seedApplication(env);
  const leaseId = await acquireLease(env);
  const prepared = await prepareRetry(env, leaseId);
  assert.equal(prepared.status, 201);
  const { intentId } = await prepared.json();
  await env.DB.prepare("UPDATE leases SET expires_at = ? WHERE name = 'application-run'").bind('2020-01-01T00:00:00.000Z').run();
  assert.equal((await prepareRetry(env, leaseId)).status, 409);
  const confirmation = await worker.fetch(request(`/v2/intents/${intentId}/confirm`, { method: 'POST', body: { leaseId, delivery: retryEvent(intentId) } }), env);
  assert.equal(confirmation.status, 409);
});
