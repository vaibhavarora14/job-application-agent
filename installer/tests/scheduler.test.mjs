import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installScheduler, LEGACY_SCHEDULER_LABEL, removeScheduler, SCHEDULER_LABEL } from '../src/scheduler.mjs';

test('macOS scheduler runs at login and hourly using the safe local check runner', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-macos-'));
  const agentHome = path.join(homeDir, '.agents');
  const calls = [];
  const result = await installScheduler({ platform: 'darwin', homeDir, agentHome, command: '/usr/local/bin/job-application-agent-check', userId: 501, runCommand: async (...args) => calls.push(args) });
  const plist = await readFile(result.path, 'utf8');
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /<integer>3600<\/integer>/);
  assert.match(plist, /job-application-agent-check/);
  assert.doesNotMatch(plist, /@latest|npm exec|npm install|npm update/);
  assert.match(plist, new RegExp(SCHEDULER_LABEL));
  assert.match(plist, /\.agents\/logs/);
  assert.doesNotMatch(plist, /codex/);
  assert.equal(result.path, path.join(homeDir, 'Library', 'LaunchAgents', `${SCHEDULER_LABEL}.plist`));
  assert.deepEqual(calls.at(-1), ['launchctl', ['bootstrap', 'gui/501', result.path]]);
  assert.equal(calls[0][0], 'launchctl');
  assert.match(calls[0][1][2], new RegExp(`${LEGACY_SCHEDULER_LABEL}\\.plist$`));
  await removeScheduler({ platform: 'darwin', homeDir, agentHome, userId: 501, runCommand: async (...args) => calls.push(args) });
  assert.equal(calls.at(-1)[0], 'launchctl');
});

test('macOS scheduler removes the legacy LaunchAgent so two timers are not left running', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-macos-legacy-'));
  const agentHome = path.join(homeDir, '.agents');
  const launchAgents = path.join(homeDir, 'Library', 'LaunchAgents');
  await mkdir(launchAgents, { recursive: true });
  const legacyPath = path.join(launchAgents, `${LEGACY_SCHEDULER_LABEL}.plist`);
  await writeFile(legacyPath, '<plist />\n');
  const calls = [];
  await installScheduler({ platform: 'darwin', homeDir, agentHome, command: '/usr/local/bin/job-application-agent-check', userId: 501, runCommand: async (...args) => calls.push(args) });
  await assert.rejects(readFile(legacyPath), { code: 'ENOENT' });
  assert.ok(calls.some((call) => call[0] === 'launchctl' && String(call[1][2]).endsWith(`${LEGACY_SCHEDULER_LABEL}.plist`)));
});

test('Linux scheduler installs an hourly user systemd timer for safe checks only', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-linux-'));
  const calls = [];
  const result = await installScheduler({ platform: 'linux', homeDir, command: '/usr/local/bin/job-application-agent-check', runCommand: async (...args) => calls.push(args) });
  const timer = await readFile(result.timerPath, 'utf8');
  const service = await readFile(result.servicePath, 'utf8');
  assert.match(timer, /OnBootSec=2m/);
  assert.match(timer, /OnUnitActiveSec=1h/);
  assert.match(service, /job-application-agent-check/);
  assert.doesNotMatch(service, /@latest|npm exec|npm install|npm update/);
  assert.deepEqual(calls, [
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable', '--now', 'job-application-agent-update.timer']],
  ]);
});

test('Windows scheduler definition runs hourly and at logon without update arguments', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-win32-'));
  const agentHome = path.join(homeDir, '.agents');
  const calls = [];
  const result = await installScheduler({ platform: 'win32', homeDir, agentHome, command: 'C:\\bin\\job-application-agent-check.cmd', runCommand: async (...args) => calls.push(args) });
  const script = await readFile(result.scriptPath, 'utf8');
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /RepetitionInterval/);
  assert.match(script, /job-application-agent-check\.cmd/);
  assert.doesNotMatch(script, /@latest|npm exec|npm install|npm update/);
  assert.equal(result.scriptPath, path.join(agentHome, 'job-application-agent', 'register-update-task.ps1'));
  assert.deepEqual(calls, [['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', result.scriptPath]]]);
});
