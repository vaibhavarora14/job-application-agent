import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createUpdateRunner } from '../src/runner.mjs';

const execFileAsync = promisify(execFile);

test('returns pinned absolute node, script, and version with no shell wrapper', async () => {
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-'));
  const result = await createUpdateRunner({ agentHome, nodePath: process.execPath, packageVersion: '3.1.1' });

  assert.ok(path.isAbsolute(result.nodePath));
  assert.ok(path.isAbsolute(result.checkScriptPath));
  assert.equal(result.agentHome, agentHome);
  assert.equal(result.packageVersion, '3.1.1');
  assert.equal(path.basename(result.checkScriptPath), 'check-update-runner.mjs');

  const entries = await readdir(path.join(agentHome, 'job-application-agent'));
  assert.ok(entries.includes('check-update-runner.mjs'));
  assert.ok(!entries.includes('check-update'), 'no shell launcher should be created');
  assert.ok(!entries.includes('check-update.cmd'), 'no cmd launcher should be created');
  assert.ok(!entries.includes('update'), 'no legacy update launcher should be created');
  assert.ok(!entries.includes('update.cmd'));

  const mode = (await stat(result.checkScriptPath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('the generated check script is a static, hermetic local file with no code-execution surface', async () => {
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-static-'));
  const result = await createUpdateRunner({ agentHome, nodePath: process.execPath, packageVersion: '3.1.1' });
  const script = await readFile(result.checkScriptPath, 'utf8');
  assert.match(script, /manual-review-required/);
  assert.match(script, /automaticUpdateExecution: false/);
  assert.doesNotMatch(script, /@latest|npm exec|npm install|npm update|npx|node_modules/);
  assert.doesNotMatch(script, /child_process|execFile|spawn|fetch\(|https?:|require\(|eval\(/);
  assert.doesNotMatch(script, /JOB_APPLICATION_AGENT_HOME|PATH=/);
});

test('the check runner runs node directly and writes only a pending-review notice, without npm or a PATH', async () => {
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-run-'));
  const emptyPath = await mkdtemp(path.join(os.tmpdir(), 'job-agent-empty-path-'));
  const result = await createUpdateRunner({ agentHome, nodePath: process.execPath, packageVersion: '3.1.1' });

  await execFileAsync(result.nodePath, [result.checkScriptPath, agentHome, '3.1.1'], { env: { PATH: emptyPath } });
  const status = JSON.parse(await readFile(path.join(agentHome, 'job-application-agent', 'update-status.json'), 'utf8'));
  assert.equal(status.installedVersion, '3.1.1');
  assert.equal(status.automaticUpdateExecution, false);
  assert.equal(status.pendingUpdateVersion, null);
  assert.equal(status.status, 'manual-review-required');
});

test('rejects mutable or missing versions', async () => {
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-version-'));
  await assert.rejects(() => createUpdateRunner({ agentHome, nodePath: process.execPath, packageVersion: 'latest' }), /exact immutable semantic version/i);
  await assert.rejects(() => createUpdateRunner({ agentHome, nodePath: process.execPath }), /exact package version is required/i);
  await assert.rejects(() => createUpdateRunner({ agentHome, nodePath: process.execPath, packageVersion: '^3.0.0' }), /exact immutable semantic version/i);
});

test('rejects relative homes and relative node paths', async () => {
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-abs-'));
  await assert.rejects(() => createUpdateRunner({ agentHome: 'relative/agents', nodePath: process.execPath, packageVersion: '3.1.1' }), /absolute path/i);
  await assert.rejects(() => createUpdateRunner({ agentHome, nodePath: 'relative/node', packageVersion: '3.1.1' }), /absolute path/i);
});

test('resolves symlinked node binaries to their real path', async () => {
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-symlink-'));
  const result = await createUpdateRunner({ agentHome, nodePath: process.execPath, packageVersion: '3.1.1' });
  const real = await import('node:fs/promises').then(m => m.realpath(process.execPath));
  assert.equal(result.nodePath, real);
});
