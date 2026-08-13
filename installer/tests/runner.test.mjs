import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createUpdateRunner } from '../src/runner.mjs';

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
