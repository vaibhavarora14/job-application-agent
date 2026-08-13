import { chmod, cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installScheduler, removeScheduler } from './scheduler.mjs';

export const CONFIG_FILENAME = 'install.json';
export const SKILL_NAME = 'job-application-agent';

function pathsFor(codexHome) {
  const managerDir = path.join(codexHome, SKILL_NAME);
  return {
    managerDir,
    configPath: path.join(managerDir, CONFIG_FILENAME),
    target: path.join(codexHome, 'skills', SKILL_NAME),
    previous: path.join(managerDir, 'previous'),
  };
}

async function exists(filePath) {
  try { await lstat(filePath); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function validatePackagedSkill(source) {
  const skillFile = path.join(source, 'SKILL.md');
  const content = await readFile(skillFile, 'utf8').catch(() => '');
  if (!content.trim()) throw new Error('Invalid packaged skill: SKILL.md is missing or empty.');
  await stat(path.join(source, 'scripts', 'job-application.mjs')).catch(() => { throw new Error('Invalid packaged skill: application CLI is missing.'); });
}

async function writeConfig(configPath, config) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
}

export async function readInstallStatus({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  const paths = pathsFor(codexHome);
  try {
    return JSON.parse(await readFile(paths.configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { installed: false, automaticUpdates: false };
    throw error;
  }
}

export async function installSkill({
  packageRoot,
  packageVersion,
  homeDir = os.homedir(),
  codexHome = process.env.CODEX_HOME || path.join(homeDir, '.codex'),
  platform = process.platform,
  scheduler = true,
  command = path.join(codexHome, SKILL_NAME, process.platform === 'win32' ? 'update.cmd' : 'update'),
} = {}) {
  const source = path.join(packageRoot, SKILL_NAME);
  const paths = pathsFor(codexHome);
  await validatePackagedSkill(source);
  await mkdir(path.dirname(paths.target), { recursive: true });
  await mkdir(paths.managerDir, { recursive: true });
  const staging = path.join(paths.managerDir, `staging-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await cp(source, staging, { recursive: true, force: true });
  await validatePackagedSkill(staging);

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

  const prior = await readInstallStatus({ codexHome });
  const config = {
    installed: true,
    installedVersion: packageVersion,
    automaticUpdates: prior.installed ? prior.automaticUpdates !== false : true,
    installedAt: prior.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeConfig(paths.configPath, config);
  if (scheduler && config.automaticUpdates) await installScheduler({ platform, homeDir, command });
  return config;
}

export const updateSkill = installSkill;

export async function setAutomaticUpdates(enabled, {
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  homeDir = os.homedir(),
  platform = process.platform,
  scheduler = true,
  command = path.join(codexHome, SKILL_NAME, process.platform === 'win32' ? 'update.cmd' : 'update'),
} = {}) {
  const paths = pathsFor(codexHome);
  const current = await readInstallStatus({ codexHome });
  if (!current.installed) throw new Error('The skill is not installed.');
  const next = { ...current, automaticUpdates: enabled, updatedAt: new Date().toISOString() };
  await writeConfig(paths.configPath, next);
  if (scheduler) {
    if (enabled) await installScheduler({ platform, homeDir, command });
    else await removeScheduler({ platform, homeDir });
  }
  return next;
}
