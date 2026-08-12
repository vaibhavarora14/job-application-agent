import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { createToken, verifyToken } from '../src/worker.mjs';

function env() {
  const captured = [];
  return {
    SIGNING_SECRET: 'test-signing-secret-with-sufficient-length',
    POSTHOG_PROJECT_TOKEN: 'phc_test',
    POSTHOG_HOST: 'https://us.i.posthog.com',
    INSTALL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    EVENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    POSTHOG_FETCH: async (url, options) => {
      captured.push({ url, options, body: JSON.parse(options.body) });
      return new Response('{}', { status: 200 });
    },
    captured,
  };
}

test('health endpoint exposes no analytics or identity data', async () => {
  const response = await worker.fetch(new Request('https://relay.example.com/healthz'), env());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, schemaVersion: 1 });
});

test('install issues a signed anonymous identity and supports verified refresh', async () => {
  const bindings = env();
  const first = await worker.fetch(new Request('https://relay.example.com/v1/install', { method: 'POST', body: '{}' }), bindings);
  assert.equal(first.status, 201);
  const identity = await first.json();
  assert.match(identity.installationId, /^[0-9a-f-]{36}$/);
  assert.equal((await verifyToken(identity.token, bindings.SIGNING_SECRET)).installationId, identity.installationId);

  const refresh = await worker.fetch(new Request('https://relay.example.com/v1/install', { method: 'POST', body: JSON.stringify({ installationId: identity.installationId, token: identity.token }) }), bindings);
  assert.equal((await refresh.json()).installationId, identity.installationId);
});

test('install refreshes an expired valid token without changing the installation ID', async () => {
  const bindings = env();
  const installationId = '11111111-1111-4111-8111-111111111111';
  const expired = await createToken(installationId, bindings.SIGNING_SECRET, new Date('2026-01-01T00:00:00Z'), -1);
  const refresh = await worker.fetch(new Request('https://relay.example.com/v1/install', { method: 'POST', body: JSON.stringify({ installationId, token: expired }) }), bindings);
  assert.equal(refresh.status, 201);
  assert.equal((await refresh.json()).installationId, installationId);
});

test('install rejects undocumented properties', async () => {
  const response = await worker.fetch(new Request('https://relay.example.com/v1/install', { method: 'POST', body: JSON.stringify({ profile: 'private' }) }), env());
  assert.equal(response.status, 400);
});

test('token verification rejects tampering and expiry', async () => {
  const token = await createToken('11111111-1111-4111-8111-111111111111', 'secret-secret-secret-secret', new Date('2026-01-01T00:00:00Z'), 60);
  await assert.rejects(() => verifyToken(`${token}x`, 'secret-secret-secret-secret', new Date('2026-01-01T00:00:01Z')), /token/i);
  await assert.rejects(() => verifyToken(token, 'secret-secret-secret-secret', new Date('2026-01-01T00:02:00Z')), /expired/i);
});

test('event endpoint revalidates schema and forwards a personless PostHog event', async () => {
  const bindings = env();
  const installationId = '11111111-1111-4111-8111-111111111111';
  const token = await createToken(installationId, bindings.SIGNING_SECRET);
  const payload = {
    schemaVersion: 1,
    skillVersion: '1.1.0',
    installationId,
    token,
    event: 'application_submitted',
    properties: {
      company: 'Example AI', title: 'Staff Engineer', jobHash: 'a'.repeat(64), domain: 'jobs.example.com', ats: 'greenhouse', durationBucket: '5-15m', fieldsFilled: 12,
      shortAnswerCount: 2, resumeUploaded: true, approvalMode: 'routine-auto',
    },
  };
  const response = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'private-agent' }, body: JSON.stringify(payload) }), bindings);
  assert.equal(response.status, 202);
  assert.equal(bindings.captured.length, 1);
  assert.equal(bindings.captured[0].body.properties.$process_person_profile, false);
  assert.equal(bindings.captured[0].body.properties.$geoip_disable, true);
  assert.equal(bindings.captured[0].body.distinct_id, installationId);
  assert.equal(JSON.stringify(bindings.captured[0]).includes('private-agent'), false);
  assert.equal(bindings.captured[0].body.timestamp != null, true);
});

test('event endpoint rejects identity fields, malformed payloads, and rate limits', async () => {
  const bindings = env();
  const installationId = '11111111-1111-4111-8111-111111111111';
  const token = await createToken(installationId, bindings.SIGNING_SECRET);
  const base = { schemaVersion: 1, skillVersion: '1.1.0', installationId, token, event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: 'under-1s' } };
  const identity = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', body: JSON.stringify({ ...base, properties: { ...base.properties, email: 'candidate@example.com' } }) }), bindings);
  assert.equal(identity.status, 400);
  const oversized = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', body: JSON.stringify({ ...base, padding: 'x'.repeat(5000) }) }), bindings);
  assert.equal(oversized.status, 413);
  bindings.EVENT_RATE_LIMITER = { limit: async () => ({ success: false }) };
  const limited = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', body: JSON.stringify(base) }), bindings);
  assert.equal(limited.status, 429);
});

test('PostHog failures return a retryable relay error without leaking details', async () => {
  const bindings = env();
  bindings.POSTHOG_FETCH = async () => { throw new Error('upstream secret detail'); };
  const installationId = '11111111-1111-4111-8111-111111111111';
  const token = await createToken(installationId, bindings.SIGNING_SECRET);
  const payload = { schemaVersion: 1, skillVersion: '1.1.0', installationId, token, event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: 'under-1s' } };
  const response = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', body: JSON.stringify(payload) }), bindings);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'upstream_unavailable' });
});
