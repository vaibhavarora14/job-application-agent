import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  INSTALL_SOURCES,
  cacheFreshness,
  classifyPackageRoot,
  npxCacheHashFromPath,
  npxCacheKey,
  resolveSkillInstallOrigin,
} from '../scripts/install-source.mjs';

const PACKAGE = 'job-application-agent';
const VERSION = '3.8.6';

function assertPublicOrigin(origin, allowedKeys = ['installSource', 'installCache']) {
  assert.equal(typeof origin, 'object');
  for (const key of Object.keys(origin)) assert.ok(allowedKeys.includes(key), key);
  assert.ok(INSTALL_SOURCES.includes(origin.installSource), origin.installSource);
  if ('installCache' in origin) assert.ok(['fresh', 'cached'].includes(origin.installCache));
  const wire = JSON.stringify(origin);
  assert.equal(wire.includes('/'), false, wire);
  assert.equal(wire.includes('\\'), false, wire);
  assert.equal(/[A-Za-z]:/.test(wire), false, wire);
  assert.equal(wire.includes('@'), false, wire);
  assert.equal(wire.includes('Alex'), false, wire);
  assert.equal(wire.includes('personal-user'), false, wire);
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('npx cache keys distinguish @latest, a pinned version, and a bare name', () => {
  const latest = npxCacheKey(`${PACKAGE}@latest`);
  const pinned = npxCacheKey(`${PACKAGE}@${VERSION}`);
  const bare = npxCacheKey(PACKAGE);
  assert.equal(latest.length, 16);
  assert.match(latest, /^[0-9a-f]{16}$/);
  assert.notEqual(latest, pinned);
  assert.notEqual(latest, bare);
  assert.equal(npxCacheKey([`${PACKAGE}@latest`]), latest);
});

test('a Windows npx cache path yields only the cache key, not the user directory', () => {
  const hash = npxCacheKey(`${PACKAGE}@latest`);
  const root = path.win32.join('C:\\Users\\Alex\\AppData\\Local\\npm-cache', '_npx', hash, 'node_modules', PACKAGE);
  assert.equal(npxCacheHashFromPath(root, path.win32), hash);
  assert.equal(npxCacheHashFromPath(path.win32.join('C:\\Users\\Alex\\projects', PACKAGE), path.win32), null);
});

test('classifies an npx @latest tree as fresh and a pinned tree as cached without keeping the path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'install-source-npx-'));
  const latestHash = npxCacheKey(`${PACKAGE}@latest`);
  const pinnedHash = npxCacheKey(`${PACKAGE}@3.8.4`);
  const latestRoot = path.join(root, '_npx', latestHash, 'node_modules', PACKAGE);
  const pinnedRoot = path.join(root, '_npx', pinnedHash, 'node_modules', PACKAGE);
  await mkdir(latestRoot, { recursive: true });
  await mkdir(pinnedRoot, { recursive: true });
  await writeJson(path.join(latestRoot, 'package.json'), { name: PACKAGE, version: VERSION });
  await writeJson(path.join(pinnedRoot, 'package.json'), { name: PACKAGE, version: '3.8.4' });

  const latest = await classifyPackageRoot(latestRoot, { packageVersion: VERSION, processStartMs: Date.now() });
  assert.equal(latest.installSource, 'npx-latest');
  assertPublicOrigin(latest);
  assert.equal(JSON.stringify(latest).includes(latestHash), false);

  const now = Date.now();
  const pinned = await classifyPackageRoot(pinnedRoot, {
    packageVersion: '3.8.4',
    processStartMs: now,
    stat: async () => ({ birthtimeMs: now - 24 * 60 * 60 * 1000 }),
  });
  assert.deepEqual(pinned, { installSource: 'npx-pinned', installCache: 'cached' });

  const unnamed = await classifyPackageRoot(path.join(root, '_npx', npxCacheKey(PACKAGE), 'node_modules', PACKAGE), {
    packageVersion: VERSION,
    processStartMs: now,
    stat: async () => ({ birthtimeMs: 0 }),
  });
  assert.deepEqual(unnamed, { installSource: 'npx-name' });

  const otherRoot = path.join(root, '_npx', '0123456789abcdef', 'node_modules', PACKAGE);
  const other = await classifyPackageRoot(otherRoot, {
    packageVersion: VERSION,
    processStartMs: now,
    stat: async () => ({ birthtimeMs: 0 }),
  });
  assert.deepEqual(other, { installSource: 'npx-other' });
});

test('cache freshness is omitted when the filesystem has no creation time', () => {
  const start = 1_700_000_000_000;
  assert.equal(cacheFreshness(start - 1000, start), 'fresh');
  assert.equal(cacheFreshness(start - 3 * 60 * 1000, start), 'fresh');
  assert.equal(cacheFreshness(start - 3 * 60 * 1000 - 1, start), 'cached');
  assert.equal(cacheFreshness(0, start), undefined);
  assert.equal(cacheFreshness(Number.NaN, start), undefined);
});

test('classifies a global npm install, a local dependency, a git checkout, and an unpacked tarball', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'install-source-pkg-'));
  const globalRoot = path.join(root, 'prefix', 'lib', 'node_modules', PACKAGE);
  const localRoot = path.join(root, 'app', 'node_modules', PACKAGE);
  const checkout = path.join(root, 'checkout');
  const unpacked = path.join(root, 'unpacked');
  await mkdir(globalRoot, { recursive: true });
  await mkdir(localRoot, { recursive: true });
  await mkdir(checkout, { recursive: true });
  await mkdir(path.join(unpacked), { recursive: true });
  await writeJson(path.join(globalRoot, 'package.json'), { name: PACKAGE, version: VERSION });
  await writeJson(path.join(localRoot, 'package.json'), { name: PACKAGE, version: VERSION });
  await writeJson(path.join(root, 'app', 'package.json'), { name: 'personal-user-app' });
  await writeJson(path.join(checkout, 'package.json'), { name: PACKAGE, version: VERSION });
  await writeJson(path.join(unpacked, 'package.json'), { name: PACKAGE, version: VERSION });
  await writeFile(path.join(checkout, '.git'), 'gitdir: /home/Alex/src/.git\n');

  assert.equal((await classifyPackageRoot(globalRoot)).installSource, 'npm-global');
  assert.equal((await classifyPackageRoot(localRoot)).installSource, 'npm-local');
  assert.equal((await classifyPackageRoot(checkout)).installSource, 'local-checkout');
  assert.equal((await classifyPackageRoot(unpacked)).installSource, 'unpacked-package');
  assert.equal((await classifyPackageRoot(path.join(root, 'empty'))).installSource, 'unknown');
  for (const dir of [globalRoot, localRoot, checkout, unpacked]) assertPublicOrigin(await classifyPackageRoot(dir));
});

async function skillFixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'install-source-skill-'));
  const skillRoot = path.join(homeDir, '.agents', 'skills', PACKAGE);
  await mkdir(path.join(skillRoot, 'scripts'), { recursive: true });
  await writeFile(path.join(skillRoot, 'SKILL.md'), '# skill\n');
  await writeFile(path.join(skillRoot, 'scripts', 'job-application.mjs'), 'export {};\n');
  return { homeDir, skillRoot, scriptPath: path.join(skillRoot, 'scripts', 'job-application.mjs') };
}

test('a managed install replays the recorded npx source on later skill runs', async () => {
  const { homeDir, scriptPath } = await skillFixture();
  await writeJson(path.join(homeDir, '.agents', PACKAGE, 'install.json'), {
    installed: true,
    installedVersion: VERSION,
    installSource: 'npx-pinned',
    installCache: 'cached',
    updatedAt: '2026-11-01T00:00:00.000Z',
    note: '/home/Alex/.npm/_npx/secret',
  });
  const origin = await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} });
  assert.deepEqual(origin, { installSource: 'npx-pinned', installCache: 'cached' });
});

test('a managed tree whose version does not match the installer record is a stale copy', async () => {
  const { homeDir, scriptPath } = await skillFixture();
  await writeJson(path.join(homeDir, '.agents', PACKAGE, 'install.json'), {
    installed: true,
    installedVersion: '3.8.4',
    installSource: 'npx-latest',
    installCache: 'fresh',
  });
  const origin = await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} });
  assert.deepEqual(origin, { installSource: 'stale-copy' });
});

test('a managed install from before this field is recorded as unrecorded, not as @latest', async () => {
  const { homeDir, scriptPath } = await skillFixture();
  await writeJson(path.join(homeDir, '.agents', PACKAGE, 'install.json'), {
    installed: true,
    installedVersion: VERSION,
    automaticUpdates: false,
  });
  const origin = await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} });
  assert.deepEqual(origin, { installSource: 'managed-unrecorded' });
});

test('skill-add locks classify official, pinned, local, and third-party copies without copying the source', async () => {
  const { homeDir, skillRoot, scriptPath } = await skillFixture();
  const cases = [
    [{ source: 'vaibhavarora14/job-application-agent', sourceType: 'github' }, 'skill-add'],
    [{ source: 'https://github.com/vaibhavarora14/job-application-agent.git', sourceType: 'github', ref: 'main' }, 'skill-add'],
    [{ source: 'git@github.com:vaibhavarora14/job-application-agent.git', sourceType: 'github', ref: 'v3.8.4' }, 'skill-add-pinned'],
    [{ source: '/home/Alex/skills/job-application-agent', sourceType: 'local' }, 'skill-add-local'],
    [{ source: 'personal-user/job-application-agent', sourceType: 'github', sourceUrl: 'https://github.com/personal-user/job-application-agent' }, 'skill-add-other'],
  ];
  for (const [entry, installSource] of cases) {
    await writeJson(path.join(homeDir, '.agents', '.skill-lock.json'), {
      version: 3,
      skills: { 'job-application-agent': entry },
    });
    const origin = await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} });
    assert.deepEqual(origin, { installSource }, JSON.stringify(entry));
    assert.equal(JSON.stringify(origin).includes('Alex'), false);
    assert.equal(JSON.stringify(origin).includes('personal-user'), false);
  }
  await writeJson(path.join(homeDir, '.agents', '.skill-lock.json'), {
    version: 3,
    skills: { 'job-application-agent': { source: 'vaibhavarora14/job-application-agent', sourceType: 'github' } },
  });
  await writeJson(path.join(homeDir, '.agents', 'skills-lock.json'), {
    version: 1,
    skills: { 'job-application-agent': { source: 'personal-user/fork', sourceType: 'github' } },
  });
  const project = await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} });
  assert.equal(project.installSource, 'skill-add-other');
  assert.equal(JSON.stringify(project).includes('personal-user'), false);
});

test('a copied skill tree is not labeled from a global skills lock in another directory', async () => {
  const { homeDir } = await skillFixture();
  const copied = path.join(homeDir, 'Desktop', 'job-application-agent');
  await mkdir(path.join(copied, 'scripts'), { recursive: true });
  await writeFile(path.join(copied, 'SKILL.md'), '# copied\n');
  await writeJson(path.join(homeDir, '.agents', '.skill-lock.json'), {
    version: 3,
    skills: { 'job-application-agent': { source: 'vaibhavarora14/job-application-agent', sourceType: 'github' } },
  });
  const origin = await resolveSkillInstallOrigin({
    scriptPath: path.join(copied, 'scripts', 'job-application.mjs'),
    packageVersion: VERSION,
    homeDir,
    env: {},
  });
  assert.deepEqual(origin, { installSource: 'copied-tree' });
});

test('ClawHub origin metadata classifies the official slug and a third-party owner without emitting registry URLs', async () => {
  const { homeDir, skillRoot, scriptPath } = await skillFixture();
  await writeJson(path.join(skillRoot, '.clawhub', 'origin.json'), {
    version: 1,
    registry: 'https://clawhub.ai',
    slug: 'job-application-agent',
    ownerHandle: 'vaibhavarora14',
    installedVersion: '3.8.4',
    installedAt: 1,
    sourceUrl: 'https://clawhub.ai/vaibhavarora14/job-application-agent',
  });
  assert.deepEqual(
    await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} }),
    { installSource: 'clawhub' },
  );
  await writeJson(path.join(skillRoot, '.clawhub', 'origin.json'), {
    version: 1,
    registry: 'https://clawhub.ai/home/Alex',
    slug: 'job-application-agent',
    ownerHandle: 'personal-user',
    installedVersion: VERSION,
    installedAt: 1,
  });
  const other = await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} });
  assert.deepEqual(other, { installSource: 'clawhub-other' });
  assert.equal(JSON.stringify(other).includes('Alex'), false);
  assert.equal(JSON.stringify(other).includes('personal-user'), false);
});

test('an in-tree ClawHub marker wins over a managed npm install record', async () => {
  const { homeDir, skillRoot, scriptPath } = await skillFixture();
  await writeJson(path.join(homeDir, '.agents', PACKAGE, 'install.json'), {
    installed: true,
    installedVersion: VERSION,
    installSource: 'npx-latest',
    installCache: 'fresh',
    updatedAt: '2026-11-12T00:00:00.000Z',
  });
  await writeJson(path.join(skillRoot, '.clawdhub', 'origin.json'), {
    version: 1,
    registry: 'https://clawhub.ai',
    slug: 'job-application-agent',
    installedVersion: '3.8.4',
    installedAt: 1,
  });
  assert.deepEqual(
    await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} }),
    { installSource: 'clawhub' },
  );
});

test('a vendor skill copy uses the managed install record, and a newer skills lock replaces it', async () => {
  const { homeDir } = await skillFixture();
  const vendor = path.join(homeDir, '.cursor', 'skills', PACKAGE);
  await mkdir(path.join(vendor, 'scripts'), { recursive: true });
  await writeFile(path.join(vendor, 'SKILL.md'), '# vendor\n');
  await writeJson(path.join(homeDir, '.agents', PACKAGE, 'install.json'), {
    installed: true,
    installedVersion: VERSION,
    installSource: 'npx-latest',
    installCache: 'fresh',
    updatedAt: '2026-11-10T00:00:00.000Z',
  });
  const scriptPath = path.join(vendor, 'scripts', 'job-application.mjs');
  assert.deepEqual(
    await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} }),
    { installSource: 'npx-latest', installCache: 'fresh' },
  );
  await writeJson(path.join(homeDir, '.agents', '.skill-lock.json'), {
    version: 3,
    skills: {
      'job-application-agent': {
        source: 'vaibhavarora14/job-application-agent',
        sourceType: 'github',
        ref: '3.8.4',
        updatedAt: '2026-11-11T00:00:00.000Z',
      },
    },
  });
  assert.deepEqual(
    await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} }),
    { installSource: 'skill-add-pinned' },
  );
  await writeJson(path.join(homeDir, '.agents', PACKAGE, 'install.json'), {
    installed: true,
    installedVersion: VERSION,
    installSource: 'npx-latest',
    installCache: 'cached',
    updatedAt: '2026-11-12T00:00:00.000Z',
  });
  assert.deepEqual(
    await resolveSkillInstallOrigin({ scriptPath, packageVersion: VERSION, homeDir, env: {} }),
    { installSource: 'npx-latest', installCache: 'cached' },
  );
});

test('running the skill from the package tree reports that package, not the home install.json', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'install-source-repo-'));
  const skillRoot = path.join(root, PACKAGE);
  await mkdir(path.join(skillRoot, 'scripts'), { recursive: true });
  await writeFile(path.join(skillRoot, 'SKILL.md'), '# repo\n');
  await writeJson(path.join(root, 'package.json'), { name: PACKAGE, version: VERSION });
  await mkdir(path.join(root, '.git'), { recursive: true });
  const homeDir = path.join(root, 'home');
  await writeJson(path.join(homeDir, '.agents', PACKAGE, 'install.json'), {
    installed: true,
    installedVersion: VERSION,
    installSource: 'npx-latest',
    installCache: 'fresh',
  });
  const origin = await resolveSkillInstallOrigin({
    scriptPath: path.join(skillRoot, 'scripts', 'telemetry-client.mjs'),
    packageVersion: VERSION,
    homeDir,
    env: {},
  });
  assert.deepEqual(origin, { installSource: 'local-checkout' });
});
