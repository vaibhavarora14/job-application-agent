import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createUpdateRunner } from '../src/runner.mjs';

const execFileAsync = promisify(execFile);

test('creates a durable Unix launcher that performs only a safe local update check', async () => {
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-'));
  const result = await createUpdateRunner({
    platform: 'darwin',
    agentHome,
    nodePath: '/opt/node/bin/node',
    packageVersion: '3.1.1',
  });
  const script = await readFile(result.path, 'utf8');
  assert.match(script, /JOB_APPLICATION_AGENT_HOME=/);
  assert.doesNotMatch(script, /CODEX_HOME=/);
  assert.match(script, /check-update-runner\.mjs/);
  assert.match(script, /3\.1\.1/);
  assert.doesNotMatch(script, /@latest|npm exec|npm install|npm update/);
  assert.equal((await stat(result.path)).mode & 0o777, 0o700);
});

test('Unix launcher writes safe check state without needing npm under a minimal scheduler PATH', async () => {
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-path-'));
  const emptyPath = await mkdtemp(path.join(os.tmpdir(), 'job-agent-empty-path-'));
  const result = await createUpdateRunner({
    platform: 'darwin',
    agentHome,
    nodePath: process.execPath,
    packageVersion: '3.1.1',
  });

  await execFileAsync(result.path, { env: { PATH: emptyPath } });
  const status = JSON.parse(await readFile(path.join(agentHome, 'job-application-agent', 'update-status.json'), 'utf8'));
  assert.equal(status.installedVersion, '3.1.1');
  assert.equal(status.automaticUpdateExecution, false);
  assert.equal(status.status, 'manual-review-required');
});

test('rejects mutable or missing versions for the safe runner', async () => {
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-version-'));
  await assert.rejects(() => createUpdateRunner({
    platform: 'darwin',
    agentHome,
    nodePath: process.execPath,
    packageVersion: 'latest',
  }), /exact immutable semantic version/i);
  await assert.rejects(() => createUpdateRunner({
    platform: 'darwin',
    agentHome,
    nodePath: process.execPath,
  }), /exact package version is required/i);
});

test('creates a durable Windows launcher that performs only a safe local update check', async () => {
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-win-'));
  const result = await createUpdateRunner({
    platform: 'win32',
    agentHome,
    nodePath: 'C:\\Node\\node.exe',
    packageVersion: '3.1.1',
  });
  const script = await readFile(result.path, 'utf8');
  assert.match(script, /JOB_APPLICATION_AGENT_HOME/);
  assert.doesNotMatch(script, /CODEX_HOME/);
  assert.match(script, /check-update-runner\.mjs/);
  assert.doesNotMatch(script, /@latest|npm exec|npm install|npm update/);
});
