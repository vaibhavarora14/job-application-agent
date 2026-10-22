import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { AUTO_UPDATE_NOTICE, checkForUpdate, compareVersions, NPM_LATEST_URL } from '../scripts/update-check.mjs';

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
  assert.equal((await checkForUpdate({ currentVersion: '3.8.0', env: f.env, homeDir: f.root, fetchImpl: registry('3.8.0') })).updateAvailable, false);
  const offline = await checkForUpdate({ currentVersion: '3.8.0', env: f.env, homeDir: f.root, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(offline.checked, false);
  assert.equal(offline.reason, 'unavailable');
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
});
