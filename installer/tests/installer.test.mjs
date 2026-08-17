import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONFIG_FILENAME,
  installSkill,
  readInstallStatus,
  setAutomaticUpdates,
  updateSkill,
} from '../src/installer.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'job-agent-installer-'));
  const packageRoot = path.join(root, 'package');
  const homeDir = path.join(root, 'home');
  const agentHome = path.join(homeDir, '.agents');
  const skillSource = path.join(packageRoot, 'job-application-agent');
  await mkdir(path.join(skillSource, 'scripts'), { recursive: true });
  await writeFile(path.join(skillSource, 'SKILL.md'), '# Version one\n');
  await writeFile(path.join(skillSource, 'scripts', 'job-application.mjs'), 'export {};\n');
  return { root, packageRoot, homeDir, agentHome, skillSource };
}

test('installs the packaged skill while preserving private state outside the install directory', async () => {
  const f = await fixture();
  const privateState = path.join(f.homeDir, 'Library', 'Application Support', 'job-application-agent');
  await mkdir(privateState, { recursive: true });
  await writeFile(path.join(privateState, 'applications.ndjson'), '{"private":true}\n');

  const result = await installSkill({
    packageRoot: f.packageRoot,
    packageVersion: '3.0.0',
    homeDir: f.homeDir,
    agentHome: f.agentHome,
    platform: 'test',
    scheduler: false,
  });

  assert.equal(result.installedVersion, '3.0.0');
  assert.equal(await readFile(path.join(f.agentHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# Version one\n');
  assert.equal(await readFile(path.join(privateState, 'applications.ndjson'), 'utf8'), '{"private":true}\n');
  assert.equal((await stat(path.join(f.agentHome, 'job-application-agent', CONFIG_FILENAME))).mode & 0o777, 0o600);
});

test('updates atomically and keeps the immediately previous version for rollback', async () => {
  const f = await fixture();
  await installSkill({ packageRoot: f.packageRoot, packageVersion: '3.0.0', homeDir: f.homeDir, agentHome: f.agentHome, platform: 'test', scheduler: false });
  await writeFile(path.join(f.skillSource, 'SKILL.md'), '# Version two\n');

  const result = await updateSkill({
    packageRoot: f.packageRoot,
    packageVersion: '3.1.0',
    homeDir: f.homeDir,
    agentHome: f.agentHome,
    platform: 'test',
    scheduler: false,
  });

  assert.equal(result.installedVersion, '3.1.0');
  assert.equal(await readFile(path.join(f.agentHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# Version two\n');
  assert.equal(await readFile(path.join(f.agentHome, 'job-application-agent', 'previous', 'SKILL.md'), 'utf8'), '# Version one\n');
});

test('automatic updates default on and can be explicitly disabled and re-enabled', async () => {
  const f = await fixture();
  await installSkill({ packageRoot: f.packageRoot, packageVersion: '3.0.0', homeDir: f.homeDir, agentHome: f.agentHome, platform: 'test', scheduler: false });

  assert.equal((await readInstallStatus({ agentHome: f.agentHome })).automaticUpdates, true);
  await setAutomaticUpdates(false, { agentHome: f.agentHome, homeDir: f.homeDir, platform: 'test', scheduler: false });
  assert.equal((await readInstallStatus({ agentHome: f.agentHome })).automaticUpdates, false);
  await setAutomaticUpdates(true, { agentHome: f.agentHome, homeDir: f.homeDir, platform: 'test', scheduler: false });
  assert.equal((await readInstallStatus({ agentHome: f.agentHome })).automaticUpdates, true);
});

test('a failed staged install leaves the current skill untouched', async () => {
  const f = await fixture();
  await installSkill({ packageRoot: f.packageRoot, packageVersion: '3.0.0', homeDir: f.homeDir, agentHome: f.agentHome, platform: 'test', scheduler: false });
  await writeFile(path.join(f.skillSource, 'SKILL.md'), '');

  await assert.rejects(
    updateSkill({ packageRoot: f.packageRoot, packageVersion: '3.1.0', homeDir: f.homeDir, agentHome: f.agentHome, platform: 'test', scheduler: false }),
    /invalid packaged skill/i,
  );
  assert.equal(await readFile(path.join(f.agentHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# Version one\n');
});

test('copies the skill into an existing vendor skills directory and skips missing vendor homes', async () => {
  const f = await fixture();
  const cursorSkills = path.join(f.homeDir, '.cursor', 'skills');
  await mkdir(cursorSkills, { recursive: true });

  await installSkill({
    packageRoot: f.packageRoot,
    packageVersion: '3.0.0',
    homeDir: f.homeDir,
    agentHome: f.agentHome,
    platform: 'test',
    scheduler: false,
  });

  assert.equal(await readFile(path.join(cursorSkills, 'job-application-agent', 'SKILL.md'), 'utf8'), '# Version one\n');
  await assert.rejects(stat(path.join(f.homeDir, '.claude', 'skills')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.homeDir, '.codex', 'skills')), { code: 'ENOENT' });
});

test('migrates a previous Codex skill and install.json into ~/.agents without deleting the old files', async () => {
  const f = await fixture();
  const legacyHome = path.join(f.homeDir, '.codex');
  const legacySkill = path.join(legacyHome, 'skills', 'job-application-agent');
  const legacyManager = path.join(legacyHome, 'job-application-agent');
  await mkdir(path.join(legacySkill, 'scripts'), { recursive: true });
  await mkdir(legacyManager, { recursive: true });
  await writeFile(path.join(legacySkill, 'SKILL.md'), '# Codex skill\n');
  await writeFile(path.join(legacySkill, 'scripts', 'job-application.mjs'), 'export {};\n');
  await writeFile(path.join(legacyManager, CONFIG_FILENAME), `${JSON.stringify({
    installed: true,
    installedVersion: '2.0.4',
    automaticUpdates: false,
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }, null, 2)}\n`);

  const result = await installSkill({
    packageRoot: f.packageRoot,
    packageVersion: '3.0.0',
    homeDir: f.homeDir,
    agentHome: f.agentHome,
    legacyHome,
    platform: 'test',
    scheduler: false,
  });
  assert.equal(result.installedVersion, '3.0.0');
  assert.equal(result.automaticUpdates, false);
  assert.equal(result.installedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(await readFile(path.join(f.agentHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# Version one\n');
  assert.equal(await readFile(path.join(f.agentHome, 'job-application-agent', 'previous', 'SKILL.md'), 'utf8'), '# Codex skill\n');
  assert.equal(await readFile(path.join(legacySkill, 'SKILL.md'), 'utf8'), '# Version one\n');
  assert.match(await readFile(path.join(legacyManager, CONFIG_FILENAME), 'utf8'), /2\.0\.4/);
});
