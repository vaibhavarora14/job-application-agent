import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createUpdateRunner } from '../src/runner.mjs';

const execFileAsync = promisify(execFile);

test('creates a durable Unix launcher that always executes the latest npm package', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-'));
  const result = await createUpdateRunner({
    platform: 'darwin',
    codexHome,
    nodePath: '/opt/node/bin/node',
    npmCliPath: '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
  });
  const script = await readFile(result.path, 'utf8');
  assert.match(script, /CODEX_HOME=/);
  assert.match(script, /job-application-agent@latest/);
  assert.match(script, /auto-update/);
  assert.equal((await stat(result.path)).mode & 0o777, 0o700);
});

test('Unix launcher exposes its Node directory to npm child processes under a minimal scheduler PATH', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-path-'));
  const emptyPath = await mkdtemp(path.join(os.tmpdir(), 'job-agent-empty-path-'));
  const fakeNpmCli = path.join(codexHome, 'fake-npm-cli.mjs');
  await writeFile(fakeNpmCli, `import { spawnSync } from 'node:child_process';\nconst child = spawnSync('node', ['--version']);\nprocess.exit(child.status ?? 1);\n`);
  const result = await createUpdateRunner({
    platform: 'darwin',
    codexHome,
    nodePath: process.execPath,
    npmCliPath: fakeNpmCli,
  });

  await execFileAsync(result.path, ['auto-update'], { env: { PATH: emptyPath } });
});

test('creates a durable Windows launcher that always executes the latest npm package', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-win-'));
  const result = await createUpdateRunner({
    platform: 'win32',
    codexHome,
    nodePath: 'C:\\Node\\node.exe',
    npmCliPath: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js',
  });
  const script = await readFile(result.path, 'utf8');
  assert.match(script, /CODEX_HOME/);
  assert.match(script, /job-application-agent@latest/);
  assert.match(script, /auto-update/);
});
