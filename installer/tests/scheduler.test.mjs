import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installScheduler, removeScheduler } from '../src/scheduler.mjs';

test('macOS scheduler runs at login and hourly using the latest npm package', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-macos-'));
  const calls = [];
  const result = await installScheduler({ platform: 'darwin', homeDir, command: '/usr/local/bin/job-application-agent', userId: 501, runCommand: async (...args) => calls.push(args) });
  const plist = await readFile(result.path, 'utf8');
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /<integer>3600<\/integer>/);
  assert.match(plist, /auto-update/);
  assert.deepEqual(calls.at(-1), ['launchctl', ['bootstrap', 'gui/501', result.path]]);
  await removeScheduler({ platform: 'darwin', homeDir, userId: 501, runCommand: async (...args) => calls.push(args) });
  assert.equal(calls.at(-1)[0], 'launchctl');
});

test('Linux scheduler installs an hourly user systemd timer', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-linux-'));
  const calls = [];
  const result = await installScheduler({ platform: 'linux', homeDir, command: '/usr/local/bin/job-application-agent', runCommand: async (...args) => calls.push(args) });
  const timer = await readFile(result.timerPath, 'utf8');
  const service = await readFile(result.servicePath, 'utf8');
  assert.match(timer, /OnBootSec=2m/);
  assert.match(timer, /OnUnitActiveSec=1h/);
  assert.match(service, /auto-update/);
  assert.deepEqual(calls, [
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable', '--now', 'job-application-agent-update.timer']],
  ]);
});

test('Windows scheduler definition runs hourly and at logon', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-win32-'));
  const calls = [];
  const result = await installScheduler({ platform: 'win32', homeDir, command: 'C:\\bin\\job-application-agent.cmd', runCommand: async (...args) => calls.push(args) });
  const script = await readFile(result.scriptPath, 'utf8');
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /RepetitionInterval/);
  assert.match(script, /auto-update/);
  assert.deepEqual(calls, [['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', result.scriptPath]]]);
});
