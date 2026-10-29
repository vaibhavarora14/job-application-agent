// Guard: a test run must never reach the production telemetry relay.
// The repository's own test suite once registered ~400 throwaway installations in the public
// install count (a fixture `ledger add` spawned without a mock relay). This file fails if the
// default endpoint resolution, the npm test setup, or any test file would point a test run at
// the production relay.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import './support/no-live-telemetry.mjs';
import { defaultSourceCommunityEndpoint, DEFAULT_SOURCE_COMMUNITY_ENDPOINT } from '../scripts/source-community-client.mjs';
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  PRODUCTION_TELEMETRY_ENDPOINT,
  TEST_RUNNER_TELEMETRY_ENDPOINT,
  defaultTelemetryEndpoint,
  isTestRun,
} from '../scripts/telemetry-client.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
const CLI_ARGV = ['node', '/usr/lib/node_modules/job-application-agent/job-application-agent/scripts/job-application.mjs'];
const PRODUCTION_HOST = new URL(PRODUCTION_TELEMETRY_ENDPOINT).hostname;

test('this test process never defaults to the production relay', () => {
  assert.ok(isTestRun());
  assert.notEqual(DEFAULT_TELEMETRY_ENDPOINT, PRODUCTION_TELEMETRY_ENDPOINT);
  assert.notEqual(DEFAULT_SOURCE_COMMUNITY_ENDPOINT, PRODUCTION_TELEMETRY_ENDPOINT);
});

test('every test-run marker resolves to the local mock; only JAA_TEST_LIVE_TELEMETRY=1 opts in to production', () => {
  const markers = [
    [{ NODE_TEST_CONTEXT: 'child-v8' }, CLI_ARGV],
    [{ GITHUB_ACTIONS: 'true' }, CLI_ARGV],
    [{ JAA_TEST: '1' }, CLI_ARGV],
    [{ npm_lifecycle_event: 'test' }, CLI_ARGV],
    [{ npm_lifecycle_event: 'prepack' }, CLI_ARGV],
    [{}, ['node', '/repo/job-application-agent/tests/apply-url-gate.test.mjs']],
    [{}, ['node', 'C:\\repo\\job-application-agent\\tests\\apply-url-gate.test.mjs']],
  ];
  for (const [env, argv] of markers) {
    assert.equal(defaultTelemetryEndpoint(env, argv), TEST_RUNNER_TELEMETRY_ENDPOINT, JSON.stringify({ env, argv }));
    assert.equal(defaultSourceCommunityEndpoint(env, argv), TEST_RUNNER_TELEMETRY_ENDPOINT, JSON.stringify({ env, argv }));
    assert.equal(defaultTelemetryEndpoint({ ...env, JAA_TEST_LIVE_TELEMETRY: '1' }, argv), PRODUCTION_TELEMETRY_ENDPOINT);
    assert.equal(defaultTelemetryEndpoint({ ...env, JAA_TEST_LIVE_TELEMETRY: 'yes' }, argv), TEST_RUNNER_TELEMETRY_ENDPOINT);
  }
  // Real candidate use is unchanged: production by default, generic CI=true does not opt out.
  assert.equal(defaultTelemetryEndpoint({}, CLI_ARGV), PRODUCTION_TELEMETRY_ENDPOINT);
  assert.equal(defaultTelemetryEndpoint({ CI: 'true', npm_lifecycle_event: 'npx' }, CLI_ARGV), PRODUCTION_TELEMETRY_ENDPOINT);
  // An explicit URL still wins.
  assert.equal(defaultTelemetryEndpoint({ JAA_TEST: '1', JOB_APPLICATION_AGENT_TELEMETRY_URL: 'http://127.0.0.1:4321' }, CLI_ARGV), 'http://127.0.0.1:4321');
});

test('a CLI spawned by a test without NODE_TEST_CONTEXT or GITHUB_ACTIONS still avoids production', () => {
  const home = mkdtempSync(join(tmpdir(), 'jaa-isolation-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, JOB_APPLICATION_AGENT_HOME: home, JOB_APPLICATION_AGENT_STATE_DIR: home };
    for (const key of ['NODE_TEST_CONTEXT', 'GITHUB_ACTIONS', 'JOB_APPLICATION_AGENT_TELEMETRY_URL', 'JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL', 'JAA_TEST_LIVE_TELEMETRY', 'npm_lifecycle_event']) delete env[key];
    const result = spawnSync(process.execPath, [cli, 'telemetry', 'status'], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.endpoint, TEST_RUNNER_TELEMETRY_ENDPOINT, 'npm test must mark spawned CLIs as a test run (JAA_TEST=1)');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('npm test installs the production-relay fetch guard', async () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /--import \.\/job-application-agent\/tests\/support\/no-live-telemetry\.mjs/);
  assert.match(pkg.scripts['privacy-audit'], /--import \.\/job-application-agent\/tests\/support\/no-live-telemetry\.mjs/);
  if (process.env.JAA_TEST_LIVE_TELEMETRY === '1') return;
  // Load the guard explicitly so this assertion also holds for `node --test <this file>`.
  await import('./support/no-live-telemetry.mjs');
  await assert.rejects(fetch(`${PRODUCTION_TELEMETRY_ENDPOINT}/healthz`), /production telemetry relay/);
  await assert.rejects(fetch(new URL('/v1/events', PRODUCTION_TELEMETRY_ENDPOINT), { method: 'POST' }), /production telemetry relay/);
});

test('no test file points at the production relay', () => {
  const offenders = [];
  const roots = ['job-application-agent/tests', 'telemetry-worker/tests', 'installer', 'state-worker', 'tests', 'scripts'];
  const self = fileURLToPath(import.meta.url);
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/[._-]test\.[cm]?js$/.test(name) || path === self) continue;
      if (readFileSync(path, 'utf8').includes(PRODUCTION_HOST)) offenders.push(relative(repoRoot, path));
    }
  };
  for (const root of roots) walk(join(repoRoot, root));
  assert.deepEqual(offenders, []);
});
