#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { installScheduler } from '../../installer/src/scheduler.mjs';

const execFileAsync = promisify(execFile);

async function validate() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'job-agent-native-artifacts-'));
  const homeDir = path.join(root, 'home');
  const agentHome = path.join(homeDir, '.agents');
  const runCommand = async () => {};

  try {
    if (process.platform === 'darwin') {
      const result = await installScheduler({
        platform: 'darwin',
        homeDir,
        agentHome,
        command: process.execPath,
        userId: process.getuid(),
        runCommand,
      });
      await execFileAsync('plutil', ['-lint', result.path]);
      return;
    }

    if (process.platform === 'linux') {
      const result = await installScheduler({
        platform: 'linux',
        homeDir,
        agentHome,
        command: process.execPath,
        runCommand,
      });
      await execFileAsync('systemd-analyze', ['verify', result.servicePath, result.timerPath]);
      return;
    }

    if (process.platform === 'win32') {
      const result = await installScheduler({
        platform: 'win32',
        homeDir,
        agentHome,
        command: process.execPath,
        runCommand,
      });
      const source = await readFile(result.scriptPath, 'utf8');
      const escapedCommand = process.execPath.replaceAll("'", "''");
      if (!source.includes(`-Execute '${escapedCommand}' -Argument 'auto-update'`)) {
        throw new Error('PowerShell scheduler does not preserve the executable and argument boundary.');
      }
      const parser = '$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile($env:JOB_AGENT_POWERSHELL_ARTIFACT, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }';
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser], {
        env: { ...process.env, JOB_AGENT_POWERSHELL_ARTIFACT: result.scriptPath },
      });
      return;
    }

    throw new Error(`Unsupported CI platform: ${process.platform}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

validate().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
