import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

import {
  defaultTelemetryEndpoint,
  isGitHubActions,
  isPermanentRejection,
  lifecycleDedupeKey,
  prepareTelemetryInput,
  PRODUCTION_TELEMETRY_ENDPOINT,
  relayCompatibleEvent,
  TelemetryClient,
  TEST_RUNNER_TELEMETRY_ENDPOINT,
  withoutProfileOneClick,
} from '../scripts/telemetry-client.mjs';
import { defaultSourceCommunityEndpoint } from '../scripts/source-community-client.mjs';

function fakeRelay({ failTimes = 0, failContactTimes = 0 } = {}) {
  const requests = [];
  let failures = failTimes;
  let contactFailures = failContactTimes;
  const fetch = async (url, options = {}) => {
    requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/v1/install')) return Response.json({ installationId: '11111111-1111-4111-8111-111111111111', token: 'relay-token', expiresAt: '2099-01-01T00:00:00.000Z' });
    if (url.endsWith('/v1/contact')) {
      if (contactFailures > 0) {
        contactFailures -= 1;
        throw new Error('offline');
      }
      return Response.json({ accepted: true, installId: '11111111-1111-4111-8111-111111111111' }, { status: 202 });
    }
    if (failures > 0) {
      failures -= 1;
      throw new Error('offline');
    }
    return Response.json({ accepted: true, eventId: '22222222-2222-4222-8222-222222222222' }, { status: 202 });
  };
  return { requests, fetch };
}

function eventBodies(relay) {
  return relay.requests.filter((request) => String(request.url).endsWith('/v1/events')).map((request) => request.body);
}

function contactBodies(relay) {
  return relay.requests.filter((request) => String(request.url).endsWith('/v1/contact')).map((request) => request.body);
}

// A real CLI invocation (not a test file), for endpoint checks that model production use.
const CLI_ARGV = ['node', '/usr/lib/node_modules/job-application-agent/job-application-agent/scripts/job-application.mjs'];

test('new installations disclose and send the first event immediately', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-new-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = fakeRelay();
  let notice = '';
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: (value) => { notice += value; } });
  const session = await client.beginCommand('search');
  assert.equal(session.installationEventPending, true);
  assert.equal(session.allowSend, true);
  await client.record({ event: 'installation_started', properties: { osFamily: 'macos', nodeMajor: 24, submissionMode: 'unconfigured' } }, session);
  const result = await client.record({ event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: '1-5s' } }, session);
  assert.match(notice, /usage analytics/i);
  assert.equal(result.sent, true);
  assert.equal(relay.requests.length, 3);
  assert.equal((await client.beginCommand('search')).installationEventPending, false);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'telemetry.json'))).mode & 0o777, 0o600);
});

test('existing installations without telemetry.json send immediately including the install event', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-existing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'applications.ndjson'), '{"private":"historical"}\n');
  const relay = fakeRelay();
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: () => {} });
  const firstSession = await client.beginCommand('search');
  assert.equal(firstSession.installationEventPending, true);
  assert.equal(firstSession.allowSend, true);
  assert.equal((await client.record({ event: 'installation_started', properties: { osFamily: 'linux', nodeMajor: 22, submissionMode: 'unconfigured' } }, firstSession)).sent, true);
  assert.equal((await client.record({ event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: 'under-1s' } }, firstSession)).sent, true);
  assert.ok(relay.requests.length >= 3);
});

test('disclosure no longer drops the first command after the notice', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-grace-removed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: true, disclosed: false, graceConsumed: false, installationEventPending: false }));
  const relay = fakeRelay();
  let notice = '';
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: (value) => { notice += value; } });
  const session = await client.beginCommand('search');
  assert.match(notice, /usage analytics/i);
  assert.equal(session.allowSend, true);
  assert.equal((await client.record({ event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: 'under-1s' } }, session)).sent, true);
  assert.ok(relay.requests.length >= 2);
});

test('corrupt telemetry.json is treated as enabled unless an explicit opt-out exists', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'telemetry.json'), '{not-json');
  const relay = fakeRelay();
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: () => {}, debug: () => {} });
  const session = await client.beginCommand('search');
  assert.equal(session.enabled, true);
  assert.equal(session.allowSend, true);
  assert.equal((await client.status()).enabled, true);
  const rewritten = JSON.parse(await readFile(join(directory, 'telemetry.json'), 'utf8'));
  assert.equal(rewritten.enabled, true);
  assert.equal((await client.record({ event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: 'under-1s' } }, session)).sent, true);
});

test('explicit opt-out file and env var keep telemetry disabled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-optout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'telemetry.opt-out'), 'opted-out\n');
  const relay = fakeRelay();
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: () => {} });
  assert.equal((await client.beginCommand('search')).allowSend, false);
  const envClient = new TelemetryClient({
    stateDir: await mkdtemp(join(tmpdir(), 'telemetry-env-')),
    endpoint: 'https://relay.example.com',
    fetch: relay.fetch,
    stderr: () => {},
    env: { JOB_APPLICATION_AGENT_TELEMETRY_DISABLED: '1' },
  });
  assert.equal((await envClient.beginCommand('search')).enabled, false);
});

test('disable preserves installation id while reset removes it and keeps telemetry disabled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-controls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = fakeRelay();
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: () => {} });
  const session = await client.beginCommand('search');
  await client.record({ event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: 'under-1s' } }, session);
  const disabled = await client.configure('disable');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.hasInstallationId, true);
  await client.configure('enable');
  const resumed = await client.beginCommand('search');
  await client.record({ event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: 'under-1s' } }, resumed);
  assert.equal(relay.requests.filter((request) => request.url.endsWith('/v1/install')).length, 1);
  const reset = await client.configure('reset');
  assert.equal(reset.enabled, false);
  assert.equal(reset.hasInstallationId, false);
  assert.equal((await client.status()).enabled, false);
});

test('failed sends are queued and retried on the next command without marking the session unavailable forever', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-queue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logs = [];
  const relay = fakeRelay({ failTimes: 3 });
  const client = new TelemetryClient({
    stateDir: directory,
    endpoint: 'https://relay.example.com',
    fetch: relay.fetch,
    stderr: () => {},
    debug: (value) => { logs.push(value); },
    timeoutMs: 50,
  });
  const session = await client.beginCommand('apply');
  const first = await client.record({ event: 'application_paused', properties: { jobHash: 'a'.repeat(64), ats: 'lever', stage: 'legal', reason: 'legal' } }, session);
  assert.equal(first.sent, false);
  assert.equal(first.reason, 'unavailable');
  assert.equal(session.unavailable, undefined);
  const second = await client.record({ event: 'command_completed', properties: { command: 'apply', result: 'paused', durationBucket: 'under-1s' } }, session);
  assert.equal(second.sent, true);
  await client.beginCommand('apply');
  const queue = await readFile(join(directory, 'telemetry-queue.ndjson'), 'utf8').catch(() => '');
  assert.equal(queue.trim(), '');
  assert.ok(logs.some((line) => /queued type=event reason=/i.test(line)));
});

test('preview validates but never transmits and network failures never escape', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-preview-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: async () => { throw new Error('offline'); }, stderr: () => {}, timeoutMs: 20 });
  const event = { event: 'application_paused', properties: { jobHash: 'a'.repeat(64), ats: 'lever', stage: 'legal', reason: 'legal' } };
  assert.equal((await client.preview(event)).event, 'application_paused');
  const session = await client.beginCommand('apply');
  assert.deepEqual(await client.record(event, session), { sent: false, reason: 'unavailable' });
});

test('converts a transient job URL to a hash and domain before validation', async () => {
  const event = await prepareTelemetryInput({
    event: 'application_paused',
    properties: { jobUrl: 'https://jobs.example.com/role/123?email=candidate@example.com', ats: 'ashby', stage: 'legal', reason: 'legal' },
  });
  assert.equal(event.properties.domain, undefined);
  assert.equal(event.properties.jobHash.length, 64);
  assert.equal(JSON.stringify(event).includes('candidate@example.com'), false);
});

test('record input rejects undocumented top-level properties', async () => {
  await assert.rejects(() => prepareTelemetryInput({
    event: 'command_completed',
    properties: { command: 'search', result: 'success', durationBucket: 'under-1s' },
    prompt: 'private free-form content',
  }), /unknown/i);
});

test('strict record rejects invalid schema while automatic telemetry emits a schema_invalid counter', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-strict-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = fakeRelay();
  const logs = [];
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: () => {}, debug: (value) => { logs.push(value); } });
  const session = await client.beginCommand('telemetry');
  const invalid = { event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: 'raw private value' } };
  await assert.rejects(() => client.record(invalid, session, { strict: true }), /durationBucket/i);
  assert.deepEqual(await client.record(invalid, session), { sent: false, reason: 'invalid' });
  assert.ok(logs.some((line) => /schema-invalid/i.test(line)));
  const counter = relay.requests.map((request) => request.body).find((body) => body?.event === 'skill_error');
  assert.equal(counter?.properties?.errorCategory, 'schema_invalid');
  assert.equal(counter?.properties?.sanitizedMessage, undefined);
});

const usageEvent = { event: 'command_completed', properties: { command: 'profile', result: 'success', durationBucket: 'under-1s' } };

test('candidate identity is never attached to analytics events', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-no-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = fakeRelay();
  const client = new TelemetryClient({
    stateDir: directory,
    fetch: relay.fetch,
    stderr: () => {},
    readIdentity: () => ({ name: 'Test Candidate', email: 'candidate@example.com' }),
  });
  await client.record(usageEvent, await client.beginCommand('profile'));
  await client.record(usageEvent, await client.beginCommand('profile'));
  const events = eventBodies(relay);
  assert.ok(events.length >= 2);
  assert.ok(events.every((body) => body.identity === undefined));
  assert.equal(JSON.stringify(events).includes('candidate@example.com'), false);
  assert.equal(JSON.stringify(events).includes('Test Candidate'), false);
  assert.equal(JSON.stringify(events).includes('candidateName'), false);
  assert.equal((await client.status()).identityEnabled, false);
});

test('private contact syncs once per install and again only when the value changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-contact-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = fakeRelay();
  let notice = '';
  let identity = { name: 'Test Candidate', email: 'candidate@example.com' };
  const client = new TelemetryClient({
    stateDir: directory,
    fetch: relay.fetch,
    stderr: (value) => { notice += value; },
    readIdentity: () => identity,
  });
  await client.beginCommand('profile');
  assert.match(notice, /store your saved name and email privately/i);
  assert.match(notice, /telemetry contact disable/i);
  assert.equal(contactBodies(relay).length, 1);
  assert.deepEqual(contactBodies(relay)[0].candidateName, 'Test Candidate');
  assert.deepEqual(contactBodies(relay)[0].candidateEmail, 'candidate@example.com');
  assert.equal(contactBodies(relay)[0].installId, '11111111-1111-4111-8111-111111111111');
  await client.beginCommand('profile');
  assert.equal(contactBodies(relay).length, 1);
  identity = { name: 'Test Candidate', email: 'new@example.com' };
  await client.beginCommand('profile');
  assert.equal(contactBodies(relay).length, 2);
  assert.equal(contactBodies(relay)[1].candidateEmail, 'new@example.com');
});

test('contact opt-out and telemetry disable both stop contact sharing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-contact-optout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = fakeRelay();
  const client = new TelemetryClient({
    stateDir: directory,
    fetch: relay.fetch,
    stderr: () => {},
    readIdentity: () => ({ name: 'Test Candidate', email: 'candidate@example.com' }),
  });
  await client.beginCommand('profile');
  assert.equal(contactBodies(relay).length, 1);
  assert.equal((await client.configureContact('disable')).contactEnabled, false);
  await client.beginCommand('profile');
  assert.equal(contactBodies(relay).length, 1);
  await client.configureContact('enable');
  await client.configure('disable');
  await client.beginCommand('profile');
  assert.equal(contactBodies(relay).length, 1);
});

test('failed contact sends are queued and retried on the next command', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-contact-queue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = fakeRelay({ failContactTimes: 3 });
  const client = new TelemetryClient({
    stateDir: directory,
    fetch: relay.fetch,
    stderr: () => {},
    timeoutMs: 20,
    readIdentity: () => ({ name: 'Test Candidate', email: 'candidate@example.com' }),
  });
  await client.beginCommand('profile');
  // fetchWithRetry spends the three offline failures; the contact is queued, not accepted.
  assert.equal(contactBodies(relay).length, 3);
  const queued = await readFile(join(directory, 'telemetry-queue.ndjson'), 'utf8');
  assert.match(queued, /"type":"contact"/);
  await client.beginCommand('profile');
  assert.equal(contactBodies(relay).length, 4);
  const drained = await readFile(join(directory, 'telemetry-queue.ndjson'), 'utf8').catch(() => '');
  assert.equal(drained.trim(), '');
});

test('identity controls remain available as contact aliases and never attach event identity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-identity-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = fakeRelay();
  const client = new TelemetryClient({ stateDir: directory, fetch: relay.fetch, stderr: () => {}, readIdentity: () => ({ name: 'Test Candidate', email: 'candidate@example.com' }) });
  await client.beginCommand('profile');
  const status = await client.configureIdentity('disable');
  assert.equal(status.contactEnabled, false);
  assert.equal(status.identityEnabled, false);
  await client.record(usageEvent, await client.beginCommand('profile'));
  assert.ok(eventBodies(relay).every((body) => body.identity === undefined));
  assert.equal(contactBodies(relay).length, 1);
  const enabled = await client.configureIdentity('enable');
  assert.equal(enabled.contactEnabled, true);
  await client.beginCommand('profile');
  assert.equal(contactBodies(relay).length, 2);
});

test('dedupes application_started and application_paused per job attempt when record is called twice', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-lifecycle-dedupe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = fakeRelay();
  const logs = [];
  const client = new TelemetryClient({
    stateDir: directory,
    endpoint: 'https://relay.example.com',
    fetch: relay.fetch,
    stderr: () => {},
    debug: (value) => { logs.push(value); },
  });
  const session = await client.beginCommand('apply');
  const started = {
    event: 'application_started',
    properties: {
      jobHash: 'b'.repeat(64),
      ats: 'lever',
      approvalMode: 'review-each',
      requiredFieldCount: 3,
      resumeRequired: true,
      coverLetterRequired: false,
      referralPresent: false,
    },
  };
  const paused = {
    event: 'application_paused',
    properties: { jobHash: 'b'.repeat(64), ats: 'lever', stage: 'legal', reason: 'legal' },
  };
  assert.equal(lifecycleDedupeKey(started), `application_started:${'b'.repeat(64)}`);
  assert.equal((await client.record(started, session)).sent, true);
  assert.match(await client.applicationStartedAt('b'.repeat(64)), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(await client.record(started, session), { sent: false, reason: 'duplicate' });
  assert.equal((await client.record(paused, session)).sent, true);
  assert.deepEqual(await client.record(paused, session), { sent: false, reason: 'duplicate' });
  assert.equal((await client.record({
    event: 'application_paused',
    properties: { jobHash: 'b'.repeat(64), ats: 'lever', stage: 'submission', reason: 'captcha' },
  }, session)).sent, true);
  const lifecycle = eventBodies(relay).filter((body) => ['application_started', 'application_paused'].includes(body.event));
  assert.equal(lifecycle.length, 3);
  assert.ok(logs.some((line) => /duplicate_attempt/i.test(line)));
  assert.match(await client.applicationStartedAt('b'.repeat(64)), /^\d{4}-\d{2}-\d{2}T/);
});

test('legacy queued application_submitted with thinSubmissionOverrideUsed false drains to a strict pre-3.7.9 relay', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-legacy-submitted-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    if (url.endsWith('/v1/install')) return Response.json({ installationId: '11111111-1111-4111-8111-111111111111', token: 'relay-token', expiresAt: '2099-01-01T00:00:00.000Z' });
    // Simulate a relay deployed before 3.7.9: unknown properties are rejected.
    if (body?.properties && 'thinSubmissionOverrideUsed' in body.properties) return Response.json({ error: 'invalid_event' }, { status: 400 });
    return Response.json({ accepted: true, eventId: '22222222-2222-4222-8222-222222222222' }, { status: 202 });
  };
  const legacy = {
    event: 'application_submitted',
    properties: {
      company: 'Example', title: 'Engineer', jobHash: 'a'.repeat(64), domain: 'jobs.example.com', ats: 'greenhouse',
      durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true, approvalMode: 'routine-auto',
      telemetrySupplied: true, fillMetricsSource: 'telemetry', thinSubmissionOverrideUsed: false,
    },
  };
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch, stderr: () => {}, timeoutMs: 50 });
  const session = await client.beginCommand('apply');
  assert.equal((await client.record({ event: 'command_completed', properties: { command: 'apply', result: 'success', durationBucket: 'under-1s' } }, session)).sent, true);
  // Simulate an event a 3.7.9 client queued after the relay rejected it.
  await writeFile(join(directory, 'telemetry-queue.ndjson'), `${JSON.stringify({ type: 'event', queuedAt: new Date().toISOString(), event: legacy })}\n`);
  await client.beginCommand('apply');
  const queue = await readFile(join(directory, 'telemetry-queue.ndjson'), 'utf8').catch(() => '');
  assert.equal(queue.trim(), '');
  const sent = requests.find((request) => request.body?.event === 'application_submitted');
  assert.ok(sent, 'queued submission was sent');
  assert.equal('thinSubmissionOverrideUsed' in sent.body.properties, false);
});

test('application_submitted with profileOneClick is resent without it to a strict relay that predates the key', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-profile-one-click-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  let strict = true;
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    if (url.endsWith('/v1/install')) return Response.json({ installationId: '11111111-1111-4111-8111-111111111111', token: 'relay-token', expiresAt: '2099-01-01T00:00:00.000Z' });
    if (strict && body?.properties && 'profileOneClick' in body.properties) return Response.json({ error: 'invalid_event' }, { status: 400 });
    return Response.json({ accepted: true, eventId: '22222222-2222-4222-8222-222222222222' }, { status: 202 });
  };
  const submitted = {
    event: 'application_submitted',
    properties: {
      company: 'Example', title: 'Engineer', jobHash: 'a'.repeat(64), domain: 'jobs.example.com', ats: 'other',
      durationBucket: 'under-1s', fieldsFilled: 0, shortAnswerCount: 0, resumeUploaded: false, approvalMode: 'review-each',
      telemetrySupplied: true, fillMetricsSource: 'telemetry', profileOneClick: true,
    },
  };
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch, stderr: () => {}, timeoutMs: 50 });
  const session = await client.beginCommand('apply');
  assert.equal((await client.record(submitted, session)).sent, true);
  const attempts = requests.filter((request) => request.body?.event === 'application_submitted');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].body.properties.profileOneClick, true);
  assert.equal('profileOneClick' in attempts[1].body.properties, false);
  // An updated relay gets the key on the first try.
  strict = false;
  requests.length = 0;
  const next = { ...submitted, properties: { ...submitted.properties, jobHash: 'b'.repeat(64), profileOneClick: false } };
  assert.equal((await client.record(next, session)).sent, true);
  const updated = requests.filter((request) => request.body?.event === 'application_submitted');
  assert.equal(updated.length, 1);
  assert.equal(updated[0].body.properties.profileOneClick, false);
  assert.equal(withoutProfileOneClick({ event: 'application_paused', properties: { profileOneClick: true } }), null);
  assert.equal(withoutProfileOneClick({ event: 'application_submitted', properties: { ats: 'lever' } }), null);
});

test('relayCompatibleEvent keeps a true thinSubmissionOverrideUsed and leaves other events untouched', () => {
  const used = { event: 'application_submitted', properties: { thinSubmissionOverrideUsed: true, ats: 'other' } };
  assert.deepEqual(relayCompatibleEvent(used), used);
  const other = { event: 'application_paused', properties: { reason: 'legal' } };
  assert.equal(relayCompatibleEvent(other), other);
  assert.deepEqual(relayCompatibleEvent({ event: 'application_submitted', properties: { ats: 'lever', thinSubmissionOverrideUsed: false } }), { event: 'application_submitted', properties: { ats: 'lever' } });
});

// --- 3.7.11: one rejected event must not block the queue -------------------------------------

const POISON_HASH = 'f'.repeat(64);

function pausedEvent(hashChar) {
  return { event: 'application_paused', properties: { jobHash: hashChar.length === 64 ? hashChar : hashChar.repeat(64), ats: 'lever', stage: 'legal', reason: 'legal' } };
}

function submittedEvent(hashChar, extra = {}) {
  return {
    event: 'application_submitted',
    properties: {
      company: 'Example Corp', title: 'Engineer', jobHash: hashChar.repeat(64), domain: 'jobs.example.com', ats: 'greenhouse',
      durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true, approvalMode: 'routine-auto',
      telemetrySupplied: true, fillMetricsSource: 'telemetry', ...extra,
    },
  };
}

function queueLine(event, queuedAt = new Date().toISOString()) {
  return JSON.stringify({ type: 'event', queuedAt, event });
}

/** Relay that answers `status` for any event whose jobHash is POISON_HASH, 202 otherwise. */
function selectiveRelay({ poisonStatus = 400, poisonError = 'invalid_event', eventStatus = null, contactStatus = null } = {}) {
  const requests = [];
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    if (url.endsWith('/v1/install')) return Response.json({ installationId: '11111111-1111-4111-8111-111111111111', token: 'relay-token', expiresAt: '2099-01-01T00:00:00.000Z' });
    if (url.endsWith('/v1/contact')) {
      if (contactStatus) return Response.json({ error: 'invalid_contact' }, { status: contactStatus });
      return Response.json({ accepted: true, installId: '11111111-1111-4111-8111-111111111111' }, { status: 202 });
    }
    if (eventStatus) return Response.json({ error: 'upstream_unavailable' }, { status: eventStatus });
    if (body?.properties?.jobHash === POISON_HASH) return Response.json({ error: poisonError }, { status: poisonStatus });
    return Response.json({ accepted: true, eventId: '22222222-2222-4222-8222-222222222222' }, { status: 202 });
  };
  return { requests, fetch, events: () => requests.filter((request) => request.url.endsWith('/v1/events')).map((request) => request.body) };
}

async function readLines(file) {
  return (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('isPermanentRejection: 4xx except 401/408/425/429 is permanent; 5xx and retryable 4xx are not', () => {
  for (const status of [400, 403, 404, 405, 409, 410, 413, 415, 422]) assert.equal(isPermanentRejection(status), true, String(status));
  for (const status of [401, 408, 425, 429, 500, 502, 503, 504, 200, 202, null, undefined]) assert.equal(isPermanentRejection(status), false, String(status));
});

test('a queued event the relay rejects with 400 is quarantined with a local warning and the rest of the queue drains', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-poison-queue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = selectiveRelay();
  let stderr = '';
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: (value) => { stderr += value; }, timeoutMs: 50 });
  await client.beginCommand('apply');
  await writeFile(join(directory, 'telemetry-queue.ndjson'), [
    queueLine(submittedEvent('f')),
    queueLine(submittedEvent('a')),
    queueLine(pausedEvent('b')),
    queueLine(submittedEvent('c')),
  ].join('\n') + '\n');
  stderr = '';
  await client.beginCommand('apply');

  const delivered = relay.events().map((body) => body.properties.jobHash[0]);
  assert.deepEqual(delivered, ['f', 'a', 'b', 'c'], 'every queued item attempted once, in order');
  assert.deepEqual(await readLines(join(directory, 'telemetry-queue.ndjson')), [], 'queue fully drained');
  const quarantined = await readLines(join(directory, 'telemetry-quarantine.ndjson'));
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].type, 'event');
  assert.equal(quarantined[0].status, 400);
  assert.equal(quarantined[0].error, 'invalid_event');
  assert.equal(quarantined[0].event.properties.jobHash, POISON_HASH);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'telemetry-quarantine.ndjson'))).mode & 0o777, 0o600);
  assert.match(stderr, /rejected a application_submitted event \(HTTP 400 invalid_event\)/);
  assert.doesNotMatch(stderr, /Example Corp|jobs\.example\.com|ffffffff/, 'warning never echoes event properties');

  // The poison event is not retried on later commands.
  const before = relay.events().length;
  await client.beginCommand('apply');
  assert.equal(relay.events().length, before);
});

test('a fresh event rejected with 4xx is quarantined, not queued, and reported as rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-poison-fresh-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = selectiveRelay({ poisonStatus: 413, poisonError: 'payload_too_large' });
  let stderr = '';
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: (value) => { stderr += value; }, timeoutMs: 50 });
  const session = await client.beginCommand('apply');
  const result = await client.record(pausedEvent(POISON_HASH), session);
  assert.deepEqual(result, { sent: false, reason: 'rejected' });
  assert.deepEqual(await readLines(join(directory, 'telemetry-queue.ndjson')), []);
  assert.equal((await readLines(join(directory, 'telemetry-quarantine.ndjson')))[0].status, 413);
  assert.match(stderr, /HTTP 413 payload_too_large/);
  assert.equal((await client.record(pausedEvent('d'), session)).sent, true, 'later events still send');
});

for (const status of [500, 503, 429]) {
  test(`HTTP ${status} keeps retry semantics and preserves every queued item`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `telemetry-retry-${status}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const relay = selectiveRelay({ eventStatus: status });
    let stderr = '';
    const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: (value) => { stderr += value; }, timeoutMs: 50 });
    await client.beginCommand('apply');
    const lines = [queueLine(pausedEvent('a')), queueLine(pausedEvent('b')), queueLine(pausedEvent('c'))];
    await writeFile(join(directory, 'telemetry-queue.ndjson'), `${lines.join('\n')}\n`);
    stderr = '';
    await client.beginCommand('apply');
    assert.equal(relay.events().length, 1, 'stops at the first retryable failure');
    const kept = await readLines(join(directory, 'telemetry-queue.ndjson'));
    assert.deepEqual(kept.map((item) => item.event.properties.jobHash[0]), ['a', 'b', 'c'], 'items after the failure are not dropped');
    assert.deepEqual(await readLines(join(directory, 'telemetry-quarantine.ndjson')), []);
    assert.equal(stderr, '');
  });
}

test('network errors keep every queued item for the next command', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-retry-network-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let offline = true;
  const relay = selectiveRelay();
  const fetch = async (url, options) => {
    if (offline && url.endsWith('/v1/events')) throw new Error('offline');
    return relay.fetch(url, options);
  };
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch, stderr: () => {}, timeoutMs: 50 });
  await client.beginCommand('apply');
  await writeFile(join(directory, 'telemetry-queue.ndjson'), `${[queueLine(pausedEvent('a')), queueLine(pausedEvent('b'))].join('\n')}\n`);
  await client.beginCommand('apply');
  assert.equal((await readLines(join(directory, 'telemetry-queue.ndjson'))).length, 2);
  offline = false;
  await client.beginCommand('apply');
  assert.deepEqual(relay.events().map((body) => body.properties.jobHash[0]), ['a', 'b']);
  assert.deepEqual(await readLines(join(directory, 'telemetry-queue.ndjson')), []);
});

test('a queued event that no longer passes the local schema is quarantined instead of blocking', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-stale-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = selectiveRelay();
  let stderr = '';
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: relay.fetch, stderr: (value) => { stderr += value; }, timeoutMs: 50 });
  await client.beginCommand('apply');
  const stale = { event: 'application_paused', properties: { jobHash: 'e'.repeat(64), ats: 'lever', stage: 'legal', reason: 'retired-reason' } };
  await writeFile(join(directory, 'telemetry-queue.ndjson'), `${[queueLine(stale), queueLine(pausedEvent('a'))].join('\n')}\n`);
  stderr = '';
  await client.beginCommand('apply');
  assert.deepEqual(relay.events().map((body) => body.properties.jobHash[0]), ['a']);
  assert.deepEqual(await readLines(join(directory, 'telemetry-queue.ndjson')), []);
  const quarantined = await readLines(join(directory, 'telemetry-quarantine.ndjson'));
  assert.equal(quarantined[0].error, 'local_schema_invalid');
  assert.match(stderr, /application_paused event \(local_schema_invalid\)/);
});

test('a contact the relay rejects with 400 is dropped without queueing and its values never reach the quarantine or warning', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-contact-rejected-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = selectiveRelay({ contactStatus: 400 });
  let stderr = '';
  const client = new TelemetryClient({
    stateDir: directory,
    endpoint: 'https://relay.example.com',
    fetch: relay.fetch,
    stderr: (value) => { stderr += value; },
    timeoutMs: 50,
    readIdentity: () => ({ name: 'Test Candidate', email: 'candidate@example.com' }),
  });
  const session = await client.beginCommand('profile');
  assert.equal(session.allowContact, true);
  assert.deepEqual(await readLines(join(directory, 'telemetry-queue.ndjson')), []);
  const raw = await readFile(join(directory, 'telemetry-quarantine.ndjson'), 'utf8');
  assert.doesNotMatch(raw, /Test Candidate|candidate@example\.com/);
  assert.equal(JSON.parse(raw.trim()).type, 'contact');
  assert.match(stderr, /rejected a contact update \(HTTP 400 invalid_contact\)/);
  assert.doesNotMatch(stderr, /Test Candidate|candidate@example\.com/);
});

test('quarantine is bounded', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-quarantine-bound-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new TelemetryClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: async () => { throw new Error('unused'); }, stderr: () => {} });
  for (let index = 0; index < 60; index += 1) await client.quarantine({ type: 'event', event: pausedEvent('a') }, { status: 400, error: `e${index}` });
  const quarantined = await readLines(join(directory, 'telemetry-quarantine.ndjson'));
  assert.equal(quarantined.length, 50);
  assert.equal(quarantined.at(-1).error, 'e59');
});

test('relay endpoints never default to production under node --test', () => {
  assert.equal(defaultTelemetryEndpoint({}, CLI_ARGV), PRODUCTION_TELEMETRY_ENDPOINT);
  assert.equal(defaultTelemetryEndpoint({ NODE_TEST_CONTEXT: 'child-v8' }), TEST_RUNNER_TELEMETRY_ENDPOINT);
  assert.equal(defaultTelemetryEndpoint({ NODE_TEST_CONTEXT: 'child', JOB_APPLICATION_AGENT_TELEMETRY_URL: 'http://127.0.0.1:1234' }), 'http://127.0.0.1:1234');
  assert.equal(defaultSourceCommunityEndpoint({}, CLI_ARGV), PRODUCTION_TELEMETRY_ENDPOINT);
  assert.equal(defaultSourceCommunityEndpoint({ NODE_TEST_CONTEXT: 'child' }), TEST_RUNNER_TELEMETRY_ENDPOINT);
  assert.equal(defaultSourceCommunityEndpoint({ NODE_TEST_CONTEXT: 'child', JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9' }), 'http://127.0.0.1:9');
  // This very process runs under the test runner, so the module-level default is already safe.
  assert.notEqual(new TelemetryClient({ stateDir: tmpdir() }).endpoint, PRODUCTION_TELEMETRY_ENDPOINT);
});

test('GitHub Actions never defaults to the production relay, even outside the test runner', () => {
  assert.equal(isGitHubActions({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(isGitHubActions({ GITHUB_ACTIONS: '1' }), true);
  assert.equal(isGitHubActions({}), false);
  assert.equal(isGitHubActions({ GITHUB_ACTIONS: '' }), false);
  assert.equal(isGitHubActions({ GITHUB_ACTIONS: 'false' }), false);
  assert.equal(isGitHubActions({ GITHUB_ACTIONS: '0' }), false);

  assert.equal(defaultTelemetryEndpoint({ GITHUB_ACTIONS: 'true' }), TEST_RUNNER_TELEMETRY_ENDPOINT);
  assert.equal(defaultSourceCommunityEndpoint({ GITHUB_ACTIONS: 'true' }), TEST_RUNNER_TELEMETRY_ENDPOINT);
  // An explicit relay URL still wins (e.g. the staging e2e workflow).
  assert.equal(defaultTelemetryEndpoint({ GITHUB_ACTIONS: 'true', JOB_APPLICATION_AGENT_TELEMETRY_URL: 'https://staging.example' }), 'https://staging.example');
  assert.equal(defaultSourceCommunityEndpoint({ GITHUB_ACTIONS: 'true', JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'https://staging.example' }), 'https://staging.example');
});

test('generic CI=true alone keeps production telemetry (agent runtimes often export CI)', () => {
  assert.equal(defaultTelemetryEndpoint({ CI: 'true' }, CLI_ARGV), PRODUCTION_TELEMETRY_ENDPOINT);
  assert.equal(defaultTelemetryEndpoint({ CI: '1' }, CLI_ARGV), PRODUCTION_TELEMETRY_ENDPOINT);
  assert.equal(defaultSourceCommunityEndpoint({ CI: 'true' }, CLI_ARGV), PRODUCTION_TELEMETRY_ENDPOINT);
});

test('a CLI process spawned without NODE_TEST_CONTEXT inside GitHub Actions resolves a dead local relay', () => {
  // Import by file:// URL so Windows drive-letter paths load under the ESM loader.
  const moduleUrl = (name) => new URL(`../scripts/${name}`, import.meta.url).href;
  const env = { ...process.env, GITHUB_ACTIONS: 'true' };
  delete env.NODE_TEST_CONTEXT;
  delete env.JOB_APPLICATION_AGENT_TELEMETRY_URL;
  delete env.JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL;
  const source = `const t = await import(${JSON.stringify(moduleUrl('telemetry-client.mjs'))});
const s = await import(${JSON.stringify(moduleUrl('source-community-client.mjs'))});
process.stdout.write(JSON.stringify([t.DEFAULT_TELEMETRY_ENDPOINT, s.DEFAULT_SOURCE_COMMUNITY_ENDPOINT]));`;
  const run = (childEnv) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { env: childEnv, encoding: 'utf8' }));
  assert.deepEqual(run(env), [TEST_RUNNER_TELEMETRY_ENDPOINT, TEST_RUNNER_TELEMETRY_ENDPOINT]);
  // Outside every test marker (a real `node -e` / CLI process), production is the default.
  const outsideCi = { ...env };
  for (const key of ['GITHUB_ACTIONS', 'JAA_TEST', 'npm_lifecycle_event']) delete outsideCi[key];
  assert.deepEqual(run(outsideCi), [PRODUCTION_TELEMETRY_ENDPOINT, PRODUCTION_TELEMETRY_ENDPOINT]);
});
