import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { createToken } from '../src/worker.mjs';
import {
  DEFAULT_MIN_CLIENT_VERSION,
  UPGRADE_MESSAGE,
  clientVersionDecision,
  compareVersionCores,
  minimumClientVersion,
  parseClientVersion,
} from '../src/client-version.mjs';

const installationId = '22222222-2222-4222-8222-222222222222';
const SECRET = 'test-signing-secret-with-sufficient-length';

function bindings(extra = {}) {
  const captured = [];
  const aggregates = [];
  return {
    SIGNING_SECRET: SECRET,
    POSTHOG_PROJECT_TOKEN: 'phc_test',
    POSTHOG_FETCH: async (url, options) => { captured.push(JSON.parse(options.body)); return new Response('{}', { status: 200 }); },
    PUBLIC_STATS_DB: { prepare() { aggregates.push('prepare'); throw new Error('not used'); } },
    PRIVATE_CONTACTS_DB: { prepare() { return { bind() { return { async run() {} }; } }; } },
    JOB_STORE: { async contribute() { return { publicationStatus: 'pending', contributionCount: 1 }; } },
    SOURCE_STORE: { async contribute() { return { publicationStatus: 'pending', uniqueContributors: 1 }; } },
    captured,
    aggregates,
    ...extra,
  };
}

async function sendEvent(env, skillVersion, properties = { command: 'assess', result: 'error', durationBucket: 'under-1s' }) {
  const token = await createToken(installationId, SECRET);
  const body = { schemaVersion: 1, installationId, token, event: 'command_completed', properties };
  if (skillVersion !== undefined) body.skillVersion = skillVersion;
  return worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
}

test('versions parse and compare numerically, not lexically', () => {
  assert.deepEqual(parseClientVersion('3.7.18').core, [3, 7, 18]);
  assert.equal(parseClientVersion('1.1.0-staging').prerelease, 'staging');
  assert.equal(parseClientVersion('v3.7.18'), null);
  assert.equal(parseClientVersion('3.7'), null);
  assert.equal(parseClientVersion(42), null);
  assert.equal(compareVersionCores([3, 7, 10], [3, 7, 9]), 1);
  assert.equal(compareVersionCores([1, 10, 0], [2, 0, 0]), -1);
  assert.equal(compareVersionCores([2, 0, 0], [2, 0, 0]), 0);
});

test('minimum is configurable via MIN_CLIENT_VERSION and falls back safely', () => {
  assert.equal(DEFAULT_MIN_CLIENT_VERSION, '2.0.0');
  assert.equal(minimumClientVersion({}).raw, '2.0.0');
  assert.equal(minimumClientVersion({ MIN_CLIENT_VERSION: '3.7.11' }).raw, '3.7.11');
  assert.equal(minimumClientVersion({ MIN_CLIENT_VERSION: ' 3.0.0 ' }).raw, '3.0.0');
  assert.equal(minimumClientVersion({ MIN_CLIENT_VERSION: 'latest' }).raw, '2.0.0');
  assert.equal(minimumClientVersion({ MIN_CLIENT_VERSION: '' }).raw, '2.0.0');
  assert.equal(clientVersionDecision('1.2.1', { MIN_CLIENT_VERSION: '0.0.0' }).action, 'allow');
});

test('decisions: old clients rejected, staging and current allowed, missing left to schema', () => {
  assert.deepEqual(clientVersionDecision('1.2.1', {}), { action: 'reject', status: 426, minimum: '2.0.0', clientVersion: '1.2.1' });
  assert.equal(clientVersionDecision('1.9.99', {}).action, 'reject');
  assert.equal(clientVersionDecision('0.0.0-redaction-probe', {}).action, 'reject');
  assert.equal(clientVersionDecision('2.0.0', {}).action, 'allow');
  assert.equal(clientVersionDecision('2.0.0-rc.1', {}).action, 'allow');
  assert.equal(clientVersionDecision('3.7.18', {}).action, 'allow');
  for (const staging of ['1.1.0-staging', '3.2.0-staging', '0.0.0-test-migration-staging', '1.0.0-staging.2']) {
    assert.equal(clientVersionDecision(staging, {}).action, 'allow', staging);
  }
  assert.equal(clientVersionDecision('1.0.0-notstaging', {}).action, 'reject');
  assert.equal(clientVersionDecision(undefined, {}).action, 'allow');
  assert.equal(clientVersionDecision('garbage', {}).action, 'allow');
});

test('raised minimum: 3.7.3–3.7.10 queue clients get 202-and-drop, others 426', () => {
  const env = { MIN_CLIENT_VERSION: '3.7.12' };
  assert.equal(clientVersionDecision('3.7.2', env).status, 426);
  assert.equal(clientVersionDecision('3.7.3', env).action, 'drop');
  assert.equal(clientVersionDecision('3.7.10', env).status, 202);
  assert.equal(clientVersionDecision('3.7.11', env).status, 426);
  assert.equal(clientVersionDecision('3.7.12', env).action, 'allow');
});

test('/v1/events refuses an outdated client with 426 and the upgrade message, forwarding nothing', async () => {
  const env = bindings();
  const response = await sendEvent(env, '1.2.1');
  assert.equal(response.status, 426);
  assert.equal(response.headers.get('x-min-client-version'), '2.0.0');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error, 'client_upgrade_required');
  assert.match(body.error, /^[a-z0-9_]{1,64}$/); // 3.7.11+ clients surface this code in their warning
  assert.equal(body.message, UPGRADE_MESSAGE);
  assert.equal(body.message, 'Please upgrade: npx job-application-agent@latest');
  assert.equal(body.minimumVersion, '2.0.0');
  assert.equal(env.captured.length, 0);
  assert.equal(env.aggregates.length, 0);
});

test('/v1/events refuses an outdated client even when its payload no longer matches the schema', async () => {
  const env = bindings();
  const response = await sendEvent(env, '1.2.1', { command: 'assess', unknownLegacyKey: true });
  assert.equal(response.status, 426);
  assert.equal(env.captured.length, 0);
});

test('/v1/events still accepts current and staging clients, and missing versions still fail schema validation', async () => {
  for (const version of ['3.7.18', '2.0.0', '1.1.0-staging']) {
    const env = bindings();
    const response = await sendEvent(env, version);
    assert.equal(response.status, 202, version);
    assert.equal(env.captured.length, 1, version);
  }
  const env = bindings();
  const missing = await sendEvent(env, undefined);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'invalid_event');
});

test('/v1/events drops (202, accepted:false) for queue-band clients when the minimum is raised', async () => {
  const env = bindings({ MIN_CLIENT_VERSION: '3.7.11' });
  const response = await sendEvent(env, '3.7.9');
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.accepted, false);
  assert.equal(body.dropped, true);
  assert.equal(body.message, UPGRADE_MESSAGE);
  assert.equal(env.captured.length, 0);
});

test('contact, job, and source contributions apply the same gate', async () => {
  const token = await createToken(installationId, SECRET);
  const post = (path, body, env) => worker.fetch(new Request(`https://relay.example.com${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
  const env = bindings({ MIN_CLIENT_VERSION: '3.8.0' });
  const contact = await post('/v1/contact', { installId: installationId, token, candidateName: 'A', skillVersion: '3.7.2' }, env);
  assert.equal(contact.status, 426);
  const job = await post('/v1/jobs', { schemaVersion: 1, skillVersion: '3.2.0', installationId, token, job: {} }, env);
  assert.equal(job.status, 426);
  const source = await post('/v1/sources', { schemaVersion: 1, skillVersion: '3.1.1', installationId, token, source: {} }, env);
  assert.equal(source.status, 426);
  const stagingJob = await post('/v1/jobs', { schemaVersion: 1, skillVersion: '3.2.0-staging', installationId, token, job: {} }, env);
  assert.equal(stagingJob.status, 400); // passes the gate, then fails normal validation
});
