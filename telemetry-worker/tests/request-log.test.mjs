import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import worker, { createToken, logPath, logSkillVersion } from '../src/worker.mjs';

const installationId = '33333333-3333-4333-8333-333333333333';
const SECRET = 'test-signing-secret-with-sufficient-length';
const ALLOWED_KEYS = ['durationMs', 'gate', 'path', 'skillVersion', 'status'];

function bindings(lines, extra = {}) {
  return {
    SIGNING_SECRET: SECRET,
    POSTHOG_PROJECT_TOKEN: 'phc_test',
    POSTHOG_FETCH: async () => new Response('{}', { status: 200 }),
    PUBLIC_STATS_DB: { prepare() { throw new Error('not used'); } },
    PRIVATE_CONTACTS_DB: { prepare() { return { bind() { return { async run() {} }; } }; } },
    REQUEST_LOG: (line) => lines.push(line),
    ...extra,
  };
}

async function postEvent(env, skillVersion, { url = 'https://relay.example.com/v1/events', token } = {}) {
  const body = {
    schemaVersion: 1, skillVersion, installationId, token: token ?? await createToken(installationId, SECRET),
    event: 'command_completed', properties: { command: 'assess', result: 'success', durationBucket: 'under-1s' },
  };
  return worker.fetch(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret-auth', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify(body),
  }), env);
}

function onlyLine(lines) {
  assert.equal(lines.length, 1, `expected exactly one log line, got ${lines.length}`);
  const record = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(record).sort(), ALLOWED_KEYS);
  return record;
}

test('one structured line per request with only status, skillVersion, path, durationMs, gate', async () => {
  const lines = [];
  const token = await createToken(installationId, SECRET);
  const response = await postEvent(bindings(lines), '3.7.18', { url: 'https://relay.example.com/v1/events?email=a%40b.com&installId=x', token });
  assert.equal(response.status, 202);
  const record = onlyLine(lines);
  assert.deepEqual({ ...record, durationMs: 0 }, { status: 202, skillVersion: '3.7.18', path: '/v1/events', durationMs: 0, gate: null });
  assert.equal(Number.isInteger(record.durationMs) && record.durationMs >= 0, true);
  for (const forbidden of [installationId, token, 'secret-auth', '203.0.113.9', 'a@b.com', 'email', 'installId', 'phc_test']) {
    assert.equal(lines[0].includes(forbidden), false, forbidden);
  }
});

test('the minimum-version gate is tagged and logs the refused version', async () => {
  const lines = [];
  const response = await postEvent(bindings(lines), '1.2.1');
  assert.equal(response.status, 426);
  assert.deepEqual({ ...onlyLine(lines), durationMs: 0 }, { status: 426, skillVersion: '1.2.1', path: '/v1/events', durationMs: 0, gate: 'min_version' });
});

test('requests without a body, unknown paths, bad JSON and auth failures still log exactly once', async () => {
  let lines = [];
  await worker.fetch(new Request('https://relay.example.com/healthz?x=1'), bindings(lines));
  assert.deepEqual({ ...onlyLine(lines), durationMs: 0 }, { status: 200, skillVersion: null, path: '/healthz', durationMs: 0, gate: null });

  lines = [];
  await worker.fetch(new Request('https://relay.example.com/v1/someone@example.com/profile'), bindings(lines));
  assert.deepEqual({ ...onlyLine(lines), durationMs: 0 }, { status: 404, skillVersion: null, path: 'other', durationMs: 0, gate: null });
  assert.equal(lines[0].includes('someone@'), false);

  lines = [];
  const bad = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', body: '{not json' }), bindings(lines));
  assert.equal(bad.status, 400);
  assert.equal(onlyLine(lines).status, 400);

  lines = [];
  const unauthorized = await postEvent(bindings(lines), '3.7.18', { token: 'invalid.token' });
  assert.equal(unauthorized.status, 401);
  assert.equal(onlyLine(lines).skillVersion, '3.7.18');
});

test('skillVersion is reduced to a bounded label; free-text prerelease tags are never logged', () => {
  assert.equal(logSkillVersion(undefined), null);
  assert.equal(logSkillVersion('3.7.19'), '3.7.19');
  assert.equal(logSkillVersion('2.0.0-probe'), '2.0.0-probe');
  assert.equal(logSkillVersion('0.0.0-redaction-probe'), '0.0.0-probe');
  assert.equal(logSkillVersion('3.2.0-staging'), '3.2.0-staging');
  assert.equal(logSkillVersion('2.0.0-rc.1'), '2.0.0-rc.1');
  assert.equal(logSkillVersion('1.0.0-jane.doe'), '1.0.0-prerelease');
  assert.equal(logSkillVersion('1.0.0+build.jane'), '1.0.0');
  assert.equal(logSkillVersion('jane@example.com'), 'invalid');
  assert.equal(logSkillVersion(42), 'invalid');
  assert.equal(logSkillVersion(`1.0.0-${'a'.repeat(80)}`), 'invalid');
  assert.equal(logPath('https://relay.example.com/v1/jobs/live?limit=1'), '/v1/jobs/live');
  assert.equal(logPath('not a url'), 'other');
});

test('relay source has no other console output and invocation logs stay disabled', async () => {
  // worker.mjs: the per-request line, plus the one-off install-correction summary (counts only).
  const expected = { 'worker.mjs': 2, 'client-version.mjs': 0, 'public-stats.mjs': 0, 'install-corrections.mjs': 0 };
  for (const [file, count] of Object.entries(expected)) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const calls = source.match(/console\.(log|error|warn|info|debug)\b/g) ?? [];
    assert.equal(calls.length, count, file);
  }
  const config = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const production = config.slice(0, config.indexOf('"env"'));
  assert.match(production, /"invocation_logs": false/);
  assert.match(production, /"redact_query_string": true/);
  for (const workflow of ['deploy-telemetry.yml', 'staging-telemetry.yml']) {
    const source = await readFile(new URL(`../../.github/workflows/${workflow}`, import.meta.url), 'utf8');
    for (const [, minor] of source.matchAll(/wrangler@4\.(\d+)\./g)) assert.ok(Number(minor) >= 151, `${workflow} wrangler supports redact_query_string`);
  }
  assert.match(production, /"enabled": true/);
});
