import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';

async function writeReleaseManifest(skillSource, version) {
  const files = ['SKILL.md', 'scripts/job-application.mjs'];
  const entries = {};
  for (const file of files) {
    entries[file] = createHash('sha256').update(await readFile(path.join(skillSource, file))).digest('hex');
  }
  await writeFile(path.join(skillSource, 'release-manifest.json'), `${JSON.stringify({ version, files: entries }, null, 2)}\n`);
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'job-agent-cli-'));
  const packageRoot = path.join(root, 'package');
  const agentHome = path.join(root, '.agents');
  const skillSource = path.join(packageRoot, 'job-application-agent');
  await mkdir(path.join(skillSource, 'scripts'), { recursive: true });
  await writeFile(path.join(skillSource, 'SKILL.md'), '# Skill\n');
  await writeFile(path.join(skillSource, 'scripts', 'job-application.mjs'), 'export {};\n');
  await writeReleaseManifest(skillSource, '3.0.0');
  return { root, packageRoot, agentHome };
}

async function managerEntries(agentHome) {
  try {
    return await readdir(path.join(agentHome, 'job-application-agent'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

test('install is background-check disabled by default and status reports the installed version', async () => {
  const f = await setup();
  const output = [];
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: true, output: value => output.push(value) });
  await runCli(['status'], { agentHome: f.agentHome, homeDir: f.root, output: value => output.push(value) });
  assert.match(output.join('\n'), /3\.0\.0/);
  assert.match(output.join('\n'), /background update checks: disabled/i);
});

test('plain install creates no runner and no persistence artifacts', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: true, output: () => {} });
  assert.deepEqual(await managerEntries(f.agentHome), ['install.json']);
  await assert.rejects(stat(path.join(f.agentHome, 'job-application-agent', 'check-update-runner.mjs')), { code: 'ENOENT' });
});

test('--enable-background-updates opts in and creates the safe check runner', async () => {
  const f = await setup();
  const output = [];
  await runCli(['install', '--enable-background-updates'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: true, output: value => output.push(value) });
  assert.match(output.join('\n'), /background update checks: enabled/i);
  const runner = await readFile(path.join(f.agentHome, 'job-application-agent', 'check-update-runner.mjs'), 'utf8');
  assert.doesNotMatch(runner, /@latest|npm exec|npm install|npm update/);
  assert.match(runner, /manual-review-required/);
});

test('legacy background update command is rejected', async () => {
  const f = await setup();
  await assert.rejects(() => runCli(['background-update'], { packageRoot: f.packageRoot, packageVersion: '3.1.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: true, output: () => {} }), /usage/i);
});

test('update preserves a disabled background setting unless explicitly opted in', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: true, output: () => {} });
  await writeFile(path.join(f.packageRoot, 'job-application-agent', 'SKILL.md'), '# New skill\n');
  await writeReleaseManifest(path.join(f.packageRoot, 'job-application-agent'), '3.1.0');
  const output = [];
  await runCli(['update'], { packageRoot: f.packageRoot, packageVersion: '3.1.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: true, output: value => output.push(value) });
  assert.match(output.join('\n'), /background update checks: disabled/i);
  const entries = await managerEntries(f.agentHome);
  assert.ok(entries.includes('install.json'));
  assert.ok(entries.includes('previous'), 'update keeps a rollback copy');
  assert.ok(!entries.includes('check-update-runner.mjs'), 'no runner is created while background checks stay disabled');
});

test('update with --enable-background-updates enables persistence and the safe runner', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: true, output: () => {} });
  await writeFile(path.join(f.packageRoot, 'job-application-agent', 'SKILL.md'), '# New skill\n');
  await writeReleaseManifest(path.join(f.packageRoot, 'job-application-agent'), '3.1.0');
  const output = [];
  await runCli(['update', '--enable-background-updates'], { packageRoot: f.packageRoot, packageVersion: '3.1.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: true, output: value => output.push(value) });
  assert.match(output.join('\n'), /background update checks: enabled/i);
  await stat(path.join(f.agentHome, 'job-application-agent', 'check-update-runner.mjs'));
});

test('uninstall removes the skill, config, and runner artifacts', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: true, output: () => {} });
  await runCli(['uninstall'], { agentHome: f.agentHome, homeDir: f.root, platform: 'test', output: () => {} });
  await assert.rejects(stat(path.join(f.agentHome, 'skills', 'job-application-agent')), { code: 'ENOENT' });
  assert.deepEqual(await managerEntries(f.agentHome), []);
  const status = await runCli(['status'], { agentHome: f.agentHome, homeDir: f.root, output: () => {} });
  assert.equal(status.installed, false);
});

test('unknown commands fail with usage instead of silently installing', async () => {
  const f = await setup();
  await assert.rejects(runCli(['surprise'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, output: () => {} }), /usage/i);
});
