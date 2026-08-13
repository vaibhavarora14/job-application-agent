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
  const codexHome = path.join(homeDir, '.codex');
  const skillSource = path.join(packageRoot, 'job-application-agent');
  await mkdir(path.join(skillSource, 'scripts'), { recursive: true });
  await writeFile(path.join(skillSource, 'SKILL.md'), '# Version one\n');
  await writeFile(path.join(skillSource, 'scripts', 'job-application.mjs'), 'export {};\n');
  return { root, packageRoot, homeDir, codexHome, skillSource };
}

test('installs the packaged skill while preserving private state outside the install directory', async () => {
  const f = await fixture();
  const privateState = path.join(f.homeDir, 'Library', 'Application Support', 'Codex', 'job-application-agent');
  await mkdir(privateState, { recursive: true });
  await writeFile(path.join(privateState, 'applications.ndjson'), '{"private":true}\n');

  const result = await installSkill({
    packageRoot: f.packageRoot,
    packageVersion: '2.0.0',
    homeDir: f.homeDir,
    codexHome: f.codexHome,
    platform: 'test',
    scheduler: false,
  });

  assert.equal(result.installedVersion, '2.0.0');
  assert.equal(await readFile(path.join(f.codexHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# Version one\n');
  assert.equal(await readFile(path.join(privateState, 'applications.ndjson'), 'utf8'), '{"private":true}\n');
  assert.equal((await stat(path.join(f.codexHome, 'job-application-agent', CONFIG_FILENAME))).mode & 0o777, 0o600);
});

test('updates atomically and keeps the immediately previous version for rollback', async () => {
  const f = await fixture();
  await installSkill({ packageRoot: f.packageRoot, packageVersion: '2.0.0', homeDir: f.homeDir, codexHome: f.codexHome, platform: 'test', scheduler: false });
  await writeFile(path.join(f.skillSource, 'SKILL.md'), '# Version two\n');

  const result = await updateSkill({
    packageRoot: f.packageRoot,
    packageVersion: '2.1.0',
    homeDir: f.homeDir,
    codexHome: f.codexHome,
    platform: 'test',
    scheduler: false,
  });

  assert.equal(result.installedVersion, '2.1.0');
  assert.equal(await readFile(path.join(f.codexHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# Version two\n');
  assert.equal(await readFile(path.join(f.codexHome, 'job-application-agent', 'previous', 'SKILL.md'), 'utf8'), '# Version one\n');
});

test('automatic updates default on and can be explicitly disabled and re-enabled', async () => {
  const f = await fixture();
  await installSkill({ packageRoot: f.packageRoot, packageVersion: '2.0.0', homeDir: f.homeDir, codexHome: f.codexHome, platform: 'test', scheduler: false });

  assert.equal((await readInstallStatus({ codexHome: f.codexHome })).automaticUpdates, true);
  await setAutomaticUpdates(false, { codexHome: f.codexHome, homeDir: f.homeDir, platform: 'test', scheduler: false });
  assert.equal((await readInstallStatus({ codexHome: f.codexHome })).automaticUpdates, false);
  await setAutomaticUpdates(true, { codexHome: f.codexHome, homeDir: f.homeDir, platform: 'test', scheduler: false });
  assert.equal((await readInstallStatus({ codexHome: f.codexHome })).automaticUpdates, true);
});

test('a failed staged install leaves the current skill untouched', async () => {
  const f = await fixture();
  await installSkill({ packageRoot: f.packageRoot, packageVersion: '2.0.0', homeDir: f.homeDir, codexHome: f.codexHome, platform: 'test', scheduler: false });
  await writeFile(path.join(f.skillSource, 'SKILL.md'), '');

  await assert.rejects(
    updateSkill({ packageRoot: f.packageRoot, packageVersion: '2.1.0', homeDir: f.homeDir, codexHome: f.codexHome, platform: 'test', scheduler: false }),
    /invalid packaged skill/i,
  );
  assert.equal(await readFile(path.join(f.codexHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# Version one\n');
});
