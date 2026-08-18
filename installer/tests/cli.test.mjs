import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

test('install is automatic-update enabled by default and status reports the installed version', async () => {
  const f = await setup();
  const output = [];
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: value => output.push(value) });
  await runCli(['status'], { agentHome: f.agentHome, homeDir: f.root, output: value => output.push(value) });
  assert.match(output.join('\n'), /3\.0\.0/);
  assert.match(output.join('\n'), /automatic updates: enabled/i);
});

test('legacy background update command is rejected', async () => {
  const f = await setup();
  await assert.rejects(() => runCli(['background-update'], { packageRoot: f.packageRoot, packageVersion: '3.1.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} }), /usage/i);
});

test('install wires a safe check runner instead of a package manager execution path', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', output: () => {} });
  const runner = await readFile(path.join(f.agentHome, 'job-application-agent', 'check-update'), 'utf8');
  assert.doesNotMatch(runner, /@latest|npm exec|npm install|npm update/);
  assert.match(runner, /check-update-runner\.mjs/);
});

test('explicit update still replaces an older skill after local verification', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  await writeFile(path.join(f.packageRoot, 'job-application-agent', 'SKILL.md'), '# New skill\n');
  await writeReleaseManifest(path.join(f.packageRoot, 'job-application-agent'), '3.1.0');
  await runCli(['update'], { packageRoot: f.packageRoot, packageVersion: '3.1.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', output: () => {} });
  assert.equal(await readFile(path.join(f.agentHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# New skill\n');
});

test('unknown commands fail with usage instead of silently installing', async () => {
  const f = await setup();
  await assert.rejects(runCli(['surprise'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, output: () => {} }), /usage/i);
});
