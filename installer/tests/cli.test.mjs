import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'job-agent-cli-'));
  const packageRoot = path.join(root, 'package');
  const codexHome = path.join(root, '.codex');
  await mkdir(path.join(packageRoot, 'job-application-agent', 'scripts'), { recursive: true });
  await writeFile(path.join(packageRoot, 'job-application-agent', 'SKILL.md'), '# Skill\n');
  await writeFile(path.join(packageRoot, 'job-application-agent', 'scripts', 'job-application.mjs'), 'export {};\n');
  return { root, packageRoot, codexHome };
}

test('install is automatic-update enabled by default and status reports the installed version', async () => {
  const f = await setup();
  const output = [];
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', codexHome: f.codexHome, homeDir: f.root, platform: 'test', scheduler: false, output: value => output.push(value) });
  await runCli(['status'], { codexHome: f.codexHome, output: value => output.push(value) });
  assert.match(output.join('\n'), /3\.0\.0/);
  assert.match(output.join('\n'), /automatic updates: enabled/i);
});

test('auto-update is a no-op when updates are disabled', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', codexHome: f.codexHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  await runCli(['updates', 'disable'], { codexHome: f.codexHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  await writeFile(path.join(f.packageRoot, 'job-application-agent', 'SKILL.md'), '# New skill\n');
  const output = [];
  await runCli(['auto-update'], { packageRoot: f.packageRoot, packageVersion: '3.1.0', codexHome: f.codexHome, homeDir: f.root, platform: 'test', scheduler: false, output: value => output.push(value) });
  assert.match(output.join('\n'), /disabled/i);
  assert.equal(await readFile(path.join(f.codexHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# Skill\n');
});

test('auto-update does not replace an already-current installation or reload its scheduler', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', codexHome: f.codexHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  const marker = path.join(f.codexHome, 'skills', 'job-application-agent', 'local-marker');
  await writeFile(marker, 'preserve');
  const output = [];
  await runCli(['auto-update'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', codexHome: f.codexHome, homeDir: f.root, platform: 'darwin', output: value => output.push(value) });
  assert.equal(await readFile(marker, 'utf8'), 'preserve');
  assert.match(output.join('\n'), /already current/i);
});

test('auto-update replaces an older skill without reloading the running scheduler', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', codexHome: f.codexHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  await writeFile(path.join(f.packageRoot, 'job-application-agent', 'SKILL.md'), '# New skill\n');
  await runCli(['auto-update'], { packageRoot: f.packageRoot, packageVersion: '3.1.0', codexHome: f.codexHome, homeDir: f.root, platform: 'darwin', output: () => {} });
  assert.equal(await readFile(path.join(f.codexHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# New skill\n');
});

test('unknown commands fail with usage instead of silently installing', async () => {
  const f = await setup();
  await assert.rejects(runCli(['surprise'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', codexHome: f.codexHome, output: () => {} }), /usage/i);
});
