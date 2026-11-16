import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { AUTO_UPDATE_NOTICE, checkForUpdate, compareVersions, NPM_LATEST_URL, UPDATE_COMMAND } from '../scripts/update-check.mjs';
import { SKILL_VERSION } from '../scripts/version.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'job-application.mjs');

async function home(config) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jaa-update-check-'));
  const agentHome = path.join(root, '.agents');
  if (config) {
    await mkdir(path.join(agentHome, 'job-application-agent'), { recursive: true });
    await writeFile(path.join(agentHome, 'job-application-agent', 'install.json'), JSON.stringify(config));
  }
  return { root, agentHome, env: { JOB_APPLICATION_AGENT_HOME: agentHome, JOB_APPLICATION_AGENT_UPDATE_CHECK_URL: NPM_LATEST_URL } };
}

function registry(version, calls = []) {
  return async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return { ok: true, json: async () => ({ version }) };
  };
}

test('compareVersions orders releases and prereleases', () => {
  assert.equal(compareVersions('3.8.0', '3.7.23'), 1);
  assert.equal(compareVersions('3.7.23', '3.7.23'), 0);
  assert.equal(compareVersions('3.7.9', '3.7.23'), -1);
  assert.equal(compareVersions('3.8.0-rc.1', '3.8.0'), -1);
  assert.equal(compareVersions('nope', '3.8.0'), null);
});

test('reports an available update without installing anything', async () => {
  const f = await home({ installed: true, automaticUpdates: false });
  const calls = [];
  const result = await checkForUpdate({ currentVersion: '3.7.23', env: f.env, homeDir: f.root, fetchImpl: registry('3.8.0', calls) });
  assert.equal(result.checked, true);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, '3.8.0');
  assert.equal(result.automaticUpdates, false);
  assert.match(result.instruction, /ask before/i);
  assert.equal(result.notice, undefined);
  assert.deepEqual(calls, [{ url: NPM_LATEST_URL, method: 'GET' }]);
});

test('reports current when the registry has nothing newer, and degrades quietly offline', async () => {
  const f = await home(null);
  const current = await checkForUpdate({ currentVersion: '3.8.0', env: f.env, homeDir: f.root, fetchImpl: registry('3.8.0') });
  assert.equal(current.updateAvailable, false);
  assert.equal(current.nudge, undefined);
  const offlineHome = await home(null);
  const offline = await checkForUpdate({ currentVersion: '3.8.0', env: offlineHome.env, homeDir: offlineHome.root, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(offline.checked, false);
  assert.equal(offline.reason, 'unavailable');
  assert.equal(offline.nudge, undefined);
});

test('the opt-out env var skips the network entirely', async () => {
  const f = await home(null);
  const calls = [];
  const result = await checkForUpdate({ env: { ...f.env, JOB_APPLICATION_AGENT_NO_UPDATE_CHECK: '1' }, homeDir: f.root, fetchImpl: registry('9.9.9', calls) });
  assert.equal(result.checked, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(calls.length, 0);
});

test('an existing auto-update install gets the keep-or-disable notice once and keeps auto-update', async () => {
  const f = await home({ installed: true, automaticUpdates: true, installedVersion: '3.7.23' });
  const first = await checkForUpdate({ currentVersion: '3.7.23', env: f.env, homeDir: f.root, fetchImpl: registry('3.7.23') });
  assert.equal(first.notice, AUTO_UPDATE_NOTICE);
  assert.match(first.notice, /To keep automatic updates, do nothing/);
  assert.match(first.notice, /updates disable/);
  const second = await checkForUpdate({ currentVersion: '3.7.23', env: f.env, homeDir: f.root, fetchImpl: registry('3.7.23') });
  assert.equal(second.notice, undefined);
  const config = JSON.parse(await readFile(path.join(f.agentHome, 'job-application-agent', 'install.json'), 'utf8'));
  assert.equal(config.automaticUpdates, true);
  assert.equal(config.autoUpdateNoticeShown, true);
});

test('the CLI exposes updates check and never reaches the registry in test runs', async () => {
  const f = await home(null);
  const { stdout } = await run(process.execPath, [CLI, 'updates', 'check'], { env: { ...process.env, JAA_TEST: '1', JOB_APPLICATION_AGENT_HOME: f.agentHome, JOB_APPLICATION_AGENT_UPDATE_CHECK_URL: '' } });
  const result = JSON.parse(stdout);
  assert.equal(result.checked, false);
  assert.equal(result.reason, 'test-run');
  assert.match(result.updateCommand, /job-application-agent@latest update/);
  assert.equal(result.nudge, undefined);
});

function expectedNudge(current, latest) {
  return `job-application-agent ${current} is behind ${latest}. Upgrade with: ${UPDATE_COMMAND}`;
}

test('a newer published version returns one nudge line and does not install anything', async () => {
  const f = await home(null);
  const calls = [];
  const result = await checkForUpdate({
    currentVersion: '3.8.6',
    env: f.env,
    homeDir: f.root,
    now: () => 1_700_000_000_000,
    fetchImpl: registry('3.8.7', calls),
  });
  assert.equal(result.checked, true);
  assert.equal(result.cached, false);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, '3.8.7');
  assert.equal(result.nudge, expectedNudge('3.8.6', '3.8.7'));
  assert.equal(result.nudge.includes('\n'), false);
  assert.equal(result.updateCommand, UPDATE_COMMAND);
  assert.deepEqual(calls, [{ url: NPM_LATEST_URL, method: 'GET' }]);
  const same = await checkForUpdate({
    currentVersion: '3.8.7',
    env: f.env,
    homeDir: f.root,
    now: () => 1_700_000_000_000,
    fetchImpl: registry('3.8.7', calls),
  });
  assert.equal(same.updateAvailable, false);
  assert.equal(same.nudge, undefined);
});

test('the registry is read at most once per day, then again after the cache expires', async () => {
  const f = await home(null);
  const calls = [];
  const started = 1_700_000_000_000;
  const fetchImpl = registry('3.8.7', calls);
  const behind = await checkForUpdate({ currentVersion: '3.8.4', env: f.env, homeDir: f.root, now: () => started, fetchImpl });
  assert.equal(behind.nudge, expectedNudge('3.8.4', '3.8.7'));
  const again = await checkForUpdate({ currentVersion: '3.8.6', env: f.env, homeDir: f.root, now: () => started + DAY_MS - 1, fetchImpl });
  assert.equal(again.cached, true);
  assert.equal(again.nudge, expectedNudge('3.8.6', '3.8.7'));
  assert.equal(calls.length, 1);
  const expired = await checkForUpdate({ currentVersion: '3.8.6', env: f.env, homeDir: f.root, now: () => started + DAY_MS, fetchImpl: registry('3.8.8', calls) });
  assert.equal(expired.cached, false);
  assert.equal(expired.latestVersion, '3.8.8');
  assert.equal(expired.nudge, expectedNudge('3.8.6', '3.8.8'));
  assert.equal(calls.length, 2);
});

test('offline and timeout failures stay quiet, do not throw, and are not retried the same day', async () => {
  const f = await home(null);
  const started = 1_700_000_000_000;
  const offline = await checkForUpdate({
    currentVersion: '3.8.6',
    env: f.env,
    homeDir: f.root,
    now: () => started,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.checked, false);
  assert.equal(offline.reason, 'unavailable');
  assert.equal(offline.nudge, undefined);
  assert.equal(offline.updateAvailable, undefined);

  let calls = 0;
  const cachedFailure = await checkForUpdate({
    currentVersion: '3.8.6',
    env: f.env,
    homeDir: f.root,
    now: () => started + 60_000,
    fetchImpl: async () => { calls += 1; throw new Error('offline again'); },
  });
  assert.equal(cachedFailure.checked, false);
  assert.equal(cachedFailure.cached, true);
  assert.equal(calls, 0);

  const hanging = await home(null);
  let aborted = false;
  const timedOut = await checkForUpdate({
    currentVersion: '3.8.6',
    env: hanging.env,
    homeDir: hanging.root,
    timeoutMs: 30,
    now: () => started,
    fetchImpl: (_url, init) => new Promise((resolve, reject) => {
      const fail = () => {
        aborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener('abort', fail, { once: true });
    }),
  });
  assert.equal(timedOut.checked, false);
  assert.equal(timedOut.reason, 'unavailable');
  assert.equal(timedOut.nudge, undefined);
  assert.equal(aborted, true);
});

test('the opt-out env var hides a cached newer version and skips the network', async () => {
  const f = await home(null);
  const started = 1_700_000_000_000;
  const calls = [];
  await checkForUpdate({ currentVersion: '3.8.6', env: f.env, homeDir: f.root, now: () => started, fetchImpl: registry('3.8.7', calls) });
  const disabled = await checkForUpdate({
    currentVersion: '3.8.6',
    env: { ...f.env, JOB_APPLICATION_AGENT_NO_UPDATE_CHECK: '1' },
    homeDir: f.root,
    now: () => started + 1000,
    fetchImpl: registry('9.9.9', calls),
  });
  assert.equal(disabled.checked, false);
  assert.equal(disabled.reason, 'disabled');
  assert.equal(disabled.nudge, undefined);
  assert.equal(disabled.updateAvailable, undefined);
  assert.equal(calls.length, 1);
});

test('a cache that cannot be written still returns the nudge', async () => {
  const f = await home(null);
  const blockedHome = path.join(f.root, 'not-a-directory');
  await writeFile(blockedHome, 'x');
  const result = await checkForUpdate({
    currentVersion: '3.8.6',
    env: { ...f.env, JOB_APPLICATION_AGENT_HOME: blockedHome },
    homeDir: f.root,
    now: () => 1_700_000_000_000,
    fetchImpl: registry('3.8.7'),
  });
  assert.equal(result.nudge, expectedNudge('3.8.6', '3.8.7'));
  assert.equal(result.checked, true);
});

async function serveVersion(version) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    requests,
    url: `http://127.0.0.1:${port}/job-application-agent/latest`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('the CLI prints the nudge once and reuses the daily cache', async () => {
  const f = await home(null);
  const server = await serveVersion('9.9.9');
  const env = { ...process.env, JAA_TEST: '1', JOB_APPLICATION_AGENT_HOME: f.agentHome, JOB_APPLICATION_AGENT_UPDATE_CHECK_URL: server.url };
  delete env.JOB_APPLICATION_AGENT_NO_UPDATE_CHECK;
  try {
    const first = await run(process.execPath, [CLI, 'updates', 'check'], { env });
    const body = JSON.parse(first.stdout);
    const line = expectedNudge(SKILL_VERSION, '9.9.9');
    assert.equal(body.nudge, line);
    assert.equal(body.updateAvailable, true);
    assert.equal(first.stderr.trim(), line);
    assert.equal(server.requests.length, 1);
    const second = await run(process.execPath, [CLI, 'updates', 'check'], { env });
    assert.equal(JSON.parse(second.stdout).nudge, line);
    assert.equal(second.stderr.trim(), line);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});
