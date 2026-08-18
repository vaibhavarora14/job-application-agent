import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONFIG_FILENAME,
  installSkill,
  readInstallStatus,
  setAutomaticUpdates,
  uninstallSkill,
  updateSkill,
} from '../src/installer.mjs';

async function writeReleaseManifest(skillSource, version) {
  const files = ['SKILL.md', 'scripts/job-application.mjs'];
  const entries = {};
  for (const file of files) {
    entries[file] = createHash('sha256').update(await readFile(path.join(skillSource, file))).digest('hex');
  }
  await writeFile(path.join(skillSource, 'release-manifest.json'), `${JSON.stringify({ version, files: entries }, null, 2)}\n`);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'job-agent-installer-'));
  const packageRoot = path.join(root, 'package');
  const homeDir = path.join(root, 'home');
  const agentHome = path.join(homeDir, '.agents');
  const skillSource = path.join(packageRoot, 'job-application-agent');
  await mkdir(path.join(skillSource, 'scripts'), { recursive: true });
  await writeFile(path.join(skillSource, 'SKILL.md'), '# Version one\n');
  await writeFile(path.join(skillSource, 'scripts', 'job-application.mjs'), 'export {};\n');
  await writeReleaseManifest(skillSource, '3.0.0');
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
  await writeReleaseManifest(f.skillSource, '3.1.0');

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

test('background update checks default off and can be explicitly enabled and disabled', async () => {
  const f = await fixture();
  await installSkill({ packageRoot: f.packageRoot, packageVersion: '3.0.0', homeDir: f.homeDir, agentHome: f.agentHome, platform: 'test', scheduler: false });

  assert.equal((await readInstallStatus({ agentHome: f.agentHome })).automaticUpdates, false);
  await setAutomaticUpdates(false, { agentHome: f.agentHome, homeDir: f.homeDir, platform: 'test', scheduler: false });
  assert.equal((await readInstallStatus({ agentHome: f.agentHome })).automaticUpdates, false);
  await setAutomaticUpdates(true, { agentHome: f.agentHome, homeDir: f.homeDir, platform: 'test', scheduler: false });
  assert.equal((await readInstallStatus({ agentHome: f.agentHome })).automaticUpdates, true);
});

test('enabling background updates requires a validated check runner', async () => {
  const f = await fixture();
  await installSkill({ packageRoot: f.packageRoot, packageVersion: '3.0.0', homeDir: f.homeDir, agentHome: f.agentHome, platform: 'test', scheduler: false });
  await assert.rejects(
    () => setAutomaticUpdates(true, { agentHome: f.agentHome, homeDir: f.homeDir, platform: 'test', scheduler: true }),
    /validated update-check runner is required/i,
  );
});

test('backgroundUpdates opt-in enables persistence and reaches the scheduler with a pinned argv', async () => {
  const f = await fixture();
  const calls = [];
  const result = await installSkill({
    packageRoot: f.packageRoot,
    packageVersion: '3.0.0',
    homeDir: f.homeDir,
    agentHome: f.agentHome,
    platform: 'linux',
    scheduler: true,
    backgroundUpdates: true,
    checkRunner: { nodePath: '/usr/bin/node', checkScriptPath: '/opt/agents/job-application-agent/check-update-runner.mjs', agentHome: f.agentHome, packageVersion: '3.0.0' },
    runCommand: async (...args) => calls.push(args),
  });
  assert.equal(result.automaticUpdates, true);
  assert.ok(calls.some(call => call[0] === 'systemctl' && call[1].includes('--user') && call[1].includes('daemon-reload')));
  const servicePath = path.join(f.homeDir, '.config', 'systemd', 'user', 'job-application-agent-update.service');
  const service = await readFile(servicePath, 'utf8');
  assert.match(service, /ExecStart="\/usr\/bin\/node" "\/opt\/agents\/job-application-agent\/check-update-runner\.mjs"/);
  assert.doesNotMatch(service, /@latest|npm exec|npm install|npm update|npx/);
});

test('a disabled background setting removes persistence artifacts on update', async () => {
  const f = await fixture();
  const calls = [];
  const enable = await installSkill({
    packageRoot: f.packageRoot,
    packageVersion: '3.0.0',
    homeDir: f.homeDir,
    agentHome: f.agentHome,
    platform: 'linux',
    scheduler: true,
    backgroundUpdates: true,
    checkRunner: { nodePath: '/usr/bin/node', checkScriptPath: '/opt/agents/job-application-agent/check-update-runner.mjs', agentHome: f.agentHome, packageVersion: '3.0.0' },
    runCommand: async (...args) => calls.push(args),
  });
  assert.equal(enable.automaticUpdates, true);
  await writeFile(path.join(f.skillSource, 'SKILL.md'), '# Version two\n');
  await writeReleaseManifest(f.skillSource, '3.1.0');
  const disable = await updateSkill({
    packageRoot: f.packageRoot,
    packageVersion: '3.1.0',
    homeDir: f.homeDir,
    agentHome: f.agentHome,
    platform: 'linux',
    scheduler: true,
    backgroundUpdates: false,
    runCommand: async (...args) => calls.push(args),
  });
  assert.equal(disable.automaticUpdates, false);
  await assert.rejects(stat(path.join(f.homeDir, '.config', 'systemd', 'user', 'job-application-agent-update.service')), { code: 'ENOENT' });
});

test('installing twice converges to a single scheduler artifact set', async () => {
  const f = await fixture();
  const calls = [];
  const opts = {
    packageRoot: f.packageRoot,
    packageVersion: '3.0.0',
    homeDir: f.homeDir,
    agentHome: f.agentHome,
    platform: 'linux',
    scheduler: true,
    backgroundUpdates: true,
    checkRunner: { nodePath: '/usr/bin/node', checkScriptPath: '/opt/agents/job-application-agent/check-update-runner.mjs', agentHome: f.agentHome, packageVersion: '3.0.0' },
    runCommand: async (...args) => calls.push(args),
  };
  await installSkill(opts);
  await installSkill(opts);
  const systemdDir = path.join(f.homeDir, '.config', 'systemd', 'user');
  const entries = (await readdir(systemdDir)).filter(name => name.startsWith('job-application-agent-update'));
  assert.deepEqual(entries.sort(), ['job-application-agent-update.service', 'job-application-agent-update.timer']);
});

test('uninstall removes the skill, config, scheduler artifacts, and vendor copies', async () => {
  const f = await fixture();
  const cursorSkills = path.join(f.homeDir, '.cursor', 'skills');
  await mkdir(cursorSkills, { recursive: true });
  const calls = [];
  await installSkill({
    packageRoot: f.packageRoot,
    packageVersion: '3.0.0',
    homeDir: f.homeDir,
    agentHome: f.agentHome,
    platform: 'linux',
    scheduler: true,
    backgroundUpdates: true,
    checkRunner: { nodePath: '/usr/bin/node', checkScriptPath: '/opt/agents/job-application-agent/check-update-runner.mjs', agentHome: f.agentHome, packageVersion: '3.0.0' },
    runCommand: async (...args) => calls.push(args),
  });
  const { uninstallSkill } = await import('../src/installer.mjs');
  const removed = await uninstallSkill({ homeDir: f.homeDir, agentHome: f.agentHome, platform: 'linux', runCommand: async (...args) => calls.push(args) });
  assert.equal(removed.uninstalled, true);
  await assert.rejects(stat(path.join(f.agentHome, 'skills', 'job-application-agent')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.agentHome, 'job-application-agent', CONFIG_FILENAME)), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(cursorSkills, 'job-application-agent')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.homeDir, '.config', 'systemd', 'user', 'job-application-agent-update.service')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.homeDir, '.config', 'systemd', 'user', 'job-application-agent-update.timer')), { code: 'ENOENT' });
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

test('missing release manifest is rejected before activation', async () => {
  const f = await fixture();
  await writeFile(path.join(f.skillSource, 'release-manifest.json'), '');
  await assert.rejects(
    installSkill({ packageRoot: f.packageRoot, packageVersion: '3.0.0', homeDir: f.homeDir, agentHome: f.agentHome, platform: 'test', scheduler: false }),
    /release-manifest\.json/i,
  );
});

test('checksum verification failure prevents installation and preserves the current skill', async () => {
  const f = await fixture();
  await installSkill({ packageRoot: f.packageRoot, packageVersion: '3.0.0', homeDir: f.homeDir, agentHome: f.agentHome, platform: 'test', scheduler: false });
  await writeFile(path.join(f.skillSource, 'SKILL.md'), '# Tampered version\n');
  await writeReleaseManifest(f.skillSource, '3.1.0');
  await writeFile(path.join(f.skillSource, 'SKILL.md'), '# Tampered after manifest\n');
  await assert.rejects(
    updateSkill({ packageRoot: f.packageRoot, packageVersion: '3.1.0', homeDir: f.homeDir, agentHome: f.agentHome, platform: 'test', scheduler: false }),
    /checksum verification failed/i,
  );
  assert.equal(await readFile(path.join(f.agentHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# Version one\n');
});

test('mutable package versions are rejected', async () => {
  const f = await fixture();
  await assert.rejects(
    installSkill({ packageRoot: f.packageRoot, packageVersion: 'latest', homeDir: f.homeDir, agentHome: f.agentHome, platform: 'test', scheduler: false }),
    /exact immutable semantic version/i,
  );
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
