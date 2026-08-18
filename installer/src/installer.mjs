import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installScheduler, removeScheduler } from './scheduler.mjs';

export const CONFIG_FILENAME = 'install.json';
export const SKILL_NAME = 'job-application-agent';
export const VENDOR_SKILL_DIRS = ['.codex/skills', '.claude/skills', '.cursor/skills', '.copilot/skills', '.gemini/skills'];

export function resolveAgentHome(homeDir = os.homedir()) {
  return process.env.JOB_APPLICATION_AGENT_HOME || path.join(homeDir, '.agents');
}

export function resolveLegacyCodexHome(homeDir = os.homedir()) {
  return process.env.CODEX_HOME || path.join(homeDir, '.codex');
}

function pathsFor(agentHome) {
  const managerDir = path.join(agentHome, SKILL_NAME);
  return {
    agentHome,
    managerDir,
    configPath: path.join(managerDir, CONFIG_FILENAME),
    target: path.join(agentHome, 'skills', SKILL_NAME),
    previous: path.join(managerDir, 'previous'),
  };
}

async function exists(filePath) {
  try { await lstat(filePath); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function isDirectory(filePath) {
  try { return (await lstat(filePath)).isDirectory(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function assertExactVersion(value, label = 'version') {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) throw new Error(`${label} must be an exact immutable semantic version.`);
  return value;
}

async function listedFiles(root, current = root, files = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await listedFiles(root, absolute, files);
    else files.push(path.relative(root, absolute).replaceAll(path.sep, '/'));
  }
  return files.sort();
}

async function verifyReleaseManifest(source, expectedVersion) {
  const manifestPath = path.join(source, 'release-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Invalid packaged skill: release-manifest.json is missing.');
    throw new Error('Invalid packaged skill: release-manifest.json is unreadable.');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid packaged skill: release-manifest.json must be an object.');
  const version = assertExactVersion(manifest.version, 'release manifest version');
  if (expectedVersion && version !== assertExactVersion(expectedVersion, 'package version')) throw new Error(`Invalid packaged skill: release manifest version ${version} does not match package version ${expectedVersion}.`);
  const files = manifest.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Invalid packaged skill: release-manifest.json must contain a files map.');
  const expectedFiles = Object.keys(files).sort();
  const actualFiles = (await listedFiles(source)).filter((file) => file !== 'release-manifest.json');
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error('Invalid packaged skill: packaged files do not match the release manifest.');
  for (const file of expectedFiles) {
    const expectedHash = String(files[file] ?? '');
    if (!/^[0-9a-f]{64}$/i.test(expectedHash)) throw new Error(`Invalid packaged skill: release manifest hash for ${file} is invalid.`);
    const actualHash = createHash('sha256').update(await readFile(path.join(source, file))).digest('hex');
    if (actualHash !== expectedHash) throw new Error(`Invalid packaged skill: checksum verification failed for ${file}.`);
  }
}

async function validatePackagedSkill(source, expectedVersion) {
  const skillFile = path.join(source, 'SKILL.md');
  const content = await readFile(skillFile, 'utf8').catch(() => '');
  if (!content.trim()) throw new Error('Invalid packaged skill: SKILL.md is missing or empty.');
  await stat(path.join(source, 'scripts', 'job-application.mjs')).catch(() => { throw new Error('Invalid packaged skill: application CLI is missing.'); });
  await verifyReleaseManifest(source, expectedVersion);
}

async function writeConfig(configPath, config) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
}

async function readConfigFile(configPath) {
  try {
    return JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function migrateLegacyCodexInstall({
  homeDir = os.homedir(),
  agentHome = resolveAgentHome(homeDir),
  legacyHome = resolveLegacyCodexHome(homeDir),
} = {}) {
  const paths = pathsFor(agentHome);
  const legacy = pathsFor(legacyHome);
  if (path.resolve(paths.agentHome) === path.resolve(legacy.agentHome)) return { migratedSkill: false, migratedConfig: false };

  let migratedSkill = false;
  let migratedConfig = false;
  if (!(await exists(paths.target)) && await exists(legacy.target)) {
    await mkdir(path.dirname(paths.target), { recursive: true });
    await cp(legacy.target, paths.target, { recursive: true });
    migratedSkill = true;
  }
  if (!(await exists(paths.configPath)) && await exists(legacy.configPath)) {
    await mkdir(paths.managerDir, { recursive: true });
    await cp(legacy.configPath, paths.configPath);
    migratedConfig = true;
  }
  return { migratedSkill, migratedConfig };
}

export async function syncVendorSkillCopies({ homeDir = os.homedir(), sourceSkillDir }) {
  const copied = [];
  const canonical = path.resolve(sourceSkillDir);
  for (const relative of VENDOR_SKILL_DIRS) {
    const skillsDir = path.join(homeDir, ...relative.split('/'));
    if (!(await isDirectory(skillsDir))) continue;
    const dest = path.join(skillsDir, SKILL_NAME);
    if (path.resolve(dest) === canonical) continue;
    await rm(dest, { recursive: true, force: true });
    await cp(sourceSkillDir, dest, { recursive: true, force: true });
    copied.push(dest);
  }
  return copied;
}

export async function readInstallStatus({
  homeDir = os.homedir(),
  agentHome,
  codexHome,
} = {}) {
  const home = agentHome || codexHome || resolveAgentHome(homeDir);
  const current = await readConfigFile(pathsFor(home).configPath);
  if (current) return current;
  const legacyHome = resolveLegacyCodexHome(homeDir);
  if (path.resolve(legacyHome) !== path.resolve(home)) {
    const legacy = await readConfigFile(pathsFor(legacyHome).configPath);
    if (legacy) return legacy;
  }
  return { installed: false, automaticUpdates: false };
}

function defaultCommand(agentHome, platform = process.platform) {
  return path.join(agentHome, SKILL_NAME, platform === 'win32' ? 'update.cmd' : 'update');
}

export async function installSkill({
  packageRoot,
  packageVersion,
  homeDir = os.homedir(),
  agentHome,
  codexHome,
  legacyHome,
  platform = process.platform,
  scheduler = true,
  command,
} = {}) {
  assertExactVersion(packageVersion, 'package version');
  const home = agentHome || codexHome || resolveAgentHome(homeDir);
  const paths = pathsFor(home);
  const source = path.join(packageRoot, SKILL_NAME);
  await migrateLegacyCodexInstall({ homeDir, agentHome: home, legacyHome: legacyHome || resolveLegacyCodexHome(homeDir) });
  await validatePackagedSkill(source, packageVersion);
  await mkdir(path.dirname(paths.target), { recursive: true });
  await mkdir(paths.managerDir, { recursive: true });
  const staging = path.join(paths.managerDir, `staging-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await cp(source, staging, { recursive: true, force: true });
  await validatePackagedSkill(staging, packageVersion);

  const hadTarget = await exists(paths.target);
  if (hadTarget) {
    await rm(paths.previous, { recursive: true, force: true });
    await rename(paths.target, paths.previous);
  }
  try {
    await rename(staging, paths.target);
  } catch (error) {
    if (hadTarget && await exists(paths.previous) && !(await exists(paths.target))) await rename(paths.previous, paths.target);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  const prior = await readInstallStatus({ homeDir, agentHome: home });
  const config = {
    installed: true,
    installedVersion: packageVersion,
    automaticUpdates: prior.installed ? prior.automaticUpdates !== false : true,
    installedAt: prior.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeConfig(paths.configPath, config);
  await syncVendorSkillCopies({ homeDir, sourceSkillDir: paths.target });
  const updateCommand = command || defaultCommand(home, platform);
  if (scheduler && config.automaticUpdates) await installScheduler({ platform, homeDir, agentHome: home, command: updateCommand });
  return config;
}

export const updateSkill = installSkill;

export async function setAutomaticUpdates(enabled, {
  homeDir = os.homedir(),
  agentHome,
  codexHome,
  platform = process.platform,
  scheduler = true,
  command,
} = {}) {
  const home = agentHome || codexHome || resolveAgentHome(homeDir);
  await migrateLegacyCodexInstall({ homeDir, agentHome: home });
  const paths = pathsFor(home);
  const current = await readInstallStatus({ homeDir, agentHome: home });
  if (!current.installed) throw new Error('The skill is not installed.');
  const next = { ...current, automaticUpdates: enabled, updatedAt: new Date().toISOString() };
  await writeConfig(paths.configPath, next);
  if (scheduler) {
    const updateCommand = command || defaultCommand(home, platform);
    if (enabled) await installScheduler({ platform, homeDir, agentHome: home, command: updateCommand });
    else await removeScheduler({ platform, homeDir, agentHome: home });
  }
  return next;
}
