import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installScheduler, removeScheduler } from '../src/scheduler.mjs';

test('macOS scheduler runs at login and hourly using the latest npm package', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-macos-'));
  const result = await installScheduler({ platform: 'darwin', homeDir, command: '/usr/local/bin/job-application-agent' });
  const plist = await readFile(result.path, 'utf8');
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /<integer>3600<\/integer>/);
  assert.match(plist, /auto-update/);
  await removeScheduler({ platform: 'darwin', homeDir });
});

test('Linux scheduler installs an hourly user systemd timer', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-linux-'));
  const result = await installScheduler({ platform: 'linux', homeDir, command: '/usr/local/bin/job-application-agent' });
  const timer = await readFile(result.timerPath, 'utf8');
  const service = await readFile(result.servicePath, 'utf8');
  assert.match(timer, /OnBootSec=2m/);
  assert.match(timer, /OnUnitActiveSec=1h/);
  assert.match(service, /auto-update/);
});

test('Windows scheduler definition runs hourly and at logon', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-win32-'));
  const result = await installScheduler({ platform: 'win32', homeDir, command: 'C:\\bin\\job-application-agent.cmd' });
  const script = await readFile(result.scriptPath, 'utf8');
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /RepetitionInterval/);
  assert.match(script, /auto-update/);
});
