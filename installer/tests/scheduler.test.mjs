import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installScheduler, LEGACY_SCHEDULER_LABEL, removeScheduler, SCHEDULER_LABEL } from '../src/scheduler.mjs';

const NODE = '/usr/local/bin/node';
const SCRIPT = '/usr/local/share/job-application-agent/check-update-runner.mjs';
const VERSION = '3.1.1';

async function base(runCommand) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-sched-'));
  const agentHome = path.join(homeDir, '.agents');
  return { homeDir, agentHome };
}

test('macOS scheduler invokes only the pinned node executable with explicit argv', async () => {
  const { homeDir, agentHome } = await base();
  const calls = [];
  const result = await installScheduler({ platform: 'darwin', homeDir, agentHome, nodePath: NODE, checkScriptPath: SCRIPT, packageVersion: VERSION, userId: 501, runCommand: async (...args) => calls.push(args) });
  const plist = await readFile(result.path, 'utf8');
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /<integer>3600<\/integer>/);
  assert.match(plist, /ProcessType/);
  const argvMatches = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
  const strings = [...argvMatches.matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1]);
  assert.deepEqual(strings, [NODE, SCRIPT, agentHome, VERSION]);
  assert.doesNotMatch(plist, /@latest|npm exec|npm install|npm update|\/bin\/sh|\/bin\/bash|npx/);
  assert.equal(result.path, path.join(homeDir, 'Library', 'LaunchAgents', `${SCHEDULER_LABEL}.plist`));
  assert.deepEqual(calls.at(-1), ['launchctl', ['bootstrap', 'gui/501', result.path]]);
  assert.equal(calls[0][0], 'launchctl');
  assert.match(calls[0][1][2], new RegExp(`${LEGACY_SCHEDULER_LABEL}\\.plist$`));
  await removeScheduler({ platform: 'darwin', homeDir, agentHome, userId: 501, runCommand: async (...args) => calls.push(args) });
  assert.equal(calls.at(-1)[0], 'launchctl');
});

test('macOS scheduler removes the legacy LaunchAgent so two agents are not left running', async () => {
  const { homeDir, agentHome } = await base();
  const launchAgents = path.join(homeDir, 'Library', 'LaunchAgents');
  await mkdir(launchAgents, { recursive: true });
  const legacyPath = path.join(launchAgents, `${LEGACY_SCHEDULER_LABEL}.plist`);
  await writeFile(legacyPath, '<plist />\n');
  const calls = [];
  await installScheduler({ platform: 'darwin', homeDir, agentHome, nodePath: NODE, checkScriptPath: SCRIPT, packageVersion: VERSION, userId: 501, runCommand: async (...args) => calls.push(args) });
  await assert.rejects(readFile(legacyPath), { code: 'ENOENT' });
  assert.ok(calls.some((call) => call[0] === 'launchctl' && String(call[1][2]).endsWith(`${LEGACY_SCHEDULER_LABEL}.plist`)));
});

test('macOS installScheduler is idempotent: reinstall boots out then bootstraps one agent', async () => {
  const { homeDir, agentHome } = await base();
  const calls = [];
  const runCommand = async (...args) => calls.push(args);
  await installScheduler({ platform: 'darwin', homeDir, agentHome, nodePath: NODE, checkScriptPath: SCRIPT, packageVersion: VERSION, userId: 501, runCommand });
  const firstCount = calls.filter(c => c[0] === 'launchctl' && c[1][0] === 'bootstrap').length;
  await installScheduler({ platform: 'darwin', homeDir, agentHome, nodePath: NODE, checkScriptPath: SCRIPT, packageVersion: VERSION, userId: 501, runCommand });
  const boots = calls.filter(c => c[0] === 'launchctl' && c[1][0] === 'bootout');
  const bootstraps = calls.filter(c => c[0] === 'launchctl' && c[1][0] === 'bootstrap');
  assert.equal(firstCount, 1);
  assert.equal(bootstraps.length, 2);
  assert.ok(boots.length >= 2);
  const plist = await readFile(path.join(homeDir, 'Library', 'LaunchAgents', `${SCHEDULER_LABEL}.plist`), 'utf8');
  assert.match(plist, new RegExp(SCHEDULER_LABEL));
});

test('Linux scheduler pins explicit argv with systemd quoting and no shell', async () => {
  const { homeDir } = await base();
  const calls = [];
  const result = await installScheduler({ platform: 'linux', homeDir, nodePath: NODE, checkScriptPath: SCRIPT, packageVersion: VERSION, runCommand: async (...args) => calls.push(args) });
  const timer = await readFile(result.timerPath, 'utf8');
  const service = await readFile(result.servicePath, 'utf8');
  assert.match(timer, /OnBootSec=2m/);
  assert.match(timer, /OnUnitActiveSec=1h/);
  assert.match(service, /ExecStart=/);
  assert.match(service, new RegExp(NODE.replaceAll('$', '\\$')));
  assert.match(service, new RegExp(SCRIPT.replaceAll('$', '\\$')));
  assert.doesNotMatch(service, /@latest|npm exec|npm install|npm update|npx|\/bin\/sh|\/bin\/bash/);
  assert.deepEqual(calls, [
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable', '--now', 'job-application-agent-update.timer']],
  ]);
});

test('Windows scheduler registers the node executable with a CreateProcess-escaped argument line', async () => {
  const { homeDir, agentHome } = await base();
  const calls = [];
  const result = await installScheduler({ platform: 'win32', homeDir, agentHome, nodePath: 'C:\\Program Files\\nodejs\\node.exe', checkScriptPath: 'C:\\Users\\Ada\\AppData\\Roaming\\job-application-agent\\check-update-runner.mjs', packageVersion: VERSION, runCommand: async (...args) => calls.push(args) });
  const script = await readFile(result.scriptPath, 'utf8');
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /RepetitionInterval/);
  assert.match(script, /New-ScheduledTaskAction -Execute 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(script, /check-update-runner\.mjs/);
  assert.doesNotMatch(script, /@latest|npm exec|npm install|npm update|npx/);
  assert.equal(result.scriptPath, path.join(agentHome, 'job-application-agent', 'register-update-task.ps1'));
  assert.deepEqual(calls, [['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', result.scriptPath]]]);
});

test('Windows scheduler escapes hostile paths as literal arguments with no shell involvement', async () => {
  const { homeDir, agentHome } = await base();
  const hostileNode = 'C:\\Program Files\\nodejs\\node.exe';
  const hostileScript = "C:\\Users\\O'Brien\\AppData\\Local\\job-application-agent\\check-update-runner.mjs";
  const calls = [];
  const result = await installScheduler({ platform: 'win32', homeDir, agentHome, nodePath: hostileNode, checkScriptPath: hostileScript, packageVersion: VERSION, runCommand: async (...args) => calls.push(args) });
  const script = await readFile(result.scriptPath, 'utf8');
  assert.match(script, /New-ScheduledTaskAction -Execute 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(script, / -Argument '.*check-update-runner\.mjs.*'/);
  assert.match(script, /O''Brien/, 'PowerShell single-quote escaping must keep apostrophes literal');
  assert.doesNotMatch(script, /cmd \/c|powershell -Command|start-process|Invoke-Expression|iex/i);
  assert.doesNotMatch(script, /@latest|npm exec|npm install|npm update|npx/);
  assert.deepEqual(calls, [['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', result.scriptPath]]]);
});

test('macOS persistence keeps hostile path characters as literal argv, never shell metacharacters', async () => {
  const { homeDir } = await base();
  const hostile = path.join(homeDir, "weird; $(rm -rf ~) `id` 'quoted' space\u00e9");
  await mkdir(hostile, { recursive: true });
  const hostileScript = path.join(hostile, 'check-update-runner.mjs');
  const result = await installScheduler({ platform: 'darwin', homeDir, agentHome: hostile, nodePath: path.join(hostile, 'node; "binary"'), checkScriptPath: hostileScript, packageVersion: VERSION, userId: 501, runCommand: async () => {} });
  const plist = await readFile(result.path, 'utf8');
  const argvMatches = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
  const strings = [...argvMatches.matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1]);
  assert.deepEqual(strings, [path.join(hostile, 'node; "binary"'), hostileScript, hostile, VERSION]);
  assert.doesNotMatch(plist, /\/bin\/sh|\/bin\/bash|sh -c/);
});

test('systemd quoting prevents $, backtick, percent, and quote expansion in persistence paths', async () => {
  const { homeDir } = await base();
  const hostile = path.join(homeDir, 'dir$PATH`id`%n"quote"');
  await mkdir(hostile, { recursive: true });
  const result = await installScheduler({ platform: 'linux', homeDir, agentHome: hostile, nodePath: '/usr/bin/node', checkScriptPath: path.join(hostile, 'check-update-runner.mjs'), packageVersion: VERSION, runCommand: async () => {} });
  const service = await readFile(result.servicePath, 'utf8');
  const execLine = service.match(/ExecStart=(.*)/)[1];
  assert.ok(execLine.includes('\\$PATH'), 'systemd must escape $ expansion');
  assert.ok(execLine.includes('\\`id\\`'), 'systemd must escape backtick expansion');
  assert.ok(execLine.includes('%%n'), 'systemd must escape percent specifiers');
  assert.ok(execLine.includes('\\"quote\\"'), 'systemd must escape double quotes');
  assert.ok(execLine.includes('"/usr/bin/node"'));
  assert.ok(execLine.includes('"3.1.1"'));
  assert.doesNotMatch(service, /@latest|npm exec|npm install|npm update|npx/);
});

test('unsupported values and relative paths are rejected before any persistence is written', async () => {
  const { homeDir, agentHome } = await base();
  await assert.rejects(() => installScheduler({ platform: 'darwin', homeDir, agentHome, nodePath: 'relative/node', checkScriptPath: SCRIPT, packageVersion: VERSION, userId: 501, runCommand: async () => {} }), /absolute path/i);
  await assert.rejects(() => installScheduler({ platform: 'darwin', homeDir, agentHome, nodePath: NODE, checkScriptPath: 'relative/check.mjs', packageVersion: VERSION, userId: 501, runCommand: async () => {} }), /absolute path/i);
  await assert.rejects(() => installScheduler({ platform: 'darwin', homeDir, agentHome, nodePath: NODE, checkScriptPath: SCRIPT, packageVersion: 'latest', userId: 501, runCommand: async () => {} }), /exact immutable semantic version/i);
  await assert.rejects(() => installScheduler({ platform: 'darwin', homeDir, agentHome, nodePath: NODE, checkScriptPath: SCRIPT, packageVersion: '1.2.x', userId: 501, runCommand: async () => {} }), /exact immutable semantic version/i);
});

test('removeScheduler removes every OS artifact and the local runner artifacts', async () => {
  const { homeDir, agentHome } = await base();
  const launchAgents = path.join(homeDir, 'Library', 'LaunchAgents');
  await mkdir(launchAgents, { recursive: true });
  const plistPath = path.join(launchAgents, `${SCHEDULER_LABEL}.plist`);
  await writeFile(plistPath, '<plist />\n');
  const managerDir = path.join(agentHome, 'job-application-agent');
  await mkdir(managerDir, { recursive: true });
  for (const file of ['check-update-runner.mjs', 'check-update', 'update-status.json', 'register-update-task.ps1']) {
    await writeFile(path.join(managerDir, file), 'x\n');
  }
  const calls = [];
  await removeScheduler({ platform: 'darwin', homeDir, agentHome, userId: 501, runCommand: async (...args) => calls.push(args) });
  await assert.rejects(readFile(plistPath), { code: 'ENOENT' });
  for (const file of ['check-update-runner.mjs', 'check-update', 'update-status.json', 'register-update-task.ps1']) {
    await assert.rejects(readFile(path.join(managerDir, file)), { code: 'ENOENT' });
  }
  assert.ok(calls.some(call => call[0] === 'launchctl' && call[1][0] === 'bootout'));
});

test('test platform never touches OS persistence', async () => {
  const { homeDir, agentHome } = await base();
  const result = await installScheduler({ platform: 'test', homeDir, agentHome, nodePath: NODE, checkScriptPath: SCRIPT, packageVersion: VERSION, runCommand: async () => { throw new Error('must not run'); } });
  assert.deepEqual(result, { installed: false, platform: 'test' });
});
