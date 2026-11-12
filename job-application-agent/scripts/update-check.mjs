// Notify-only update check for the installed skill.
// Reads the latest published version from the public npm registry and reports it.
// It never downloads, installs, or runs anything; the agent tells the user and
// waits for them to ask for an update. No profile, ledger, or identity data is sent.
import { existsSync } from 'node:fs';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';

import {
  FIRST_JOB_PROMPTED_VERSION,
  firstJobPrompt,
  isCopiedSkillDirectory,
  managedInstallConfigPath,
  managedRuntimeStatus,
} from './managed-runtime.mjs';
import { SKILL_VERSION } from './version.mjs';

export const NPM_LATEST_URL = 'https://registry.npmjs.org/job-application-agent/latest';
export const UPDATE_COMMAND = 'npx job-application-agent@latest update';
export const DISABLE_AUTO_UPDATES_COMMAND = 'npx job-application-agent@latest updates disable';
export const AUTO_UPDATE_NOTICE = [
  'Automatic updates are ON for this installation: a background job installs new versions of job-application-agent from npm at login and hourly.',
  'New installs now default to update notifications only (nothing is installed without you asking).',
  `To keep automatic updates, do nothing. To switch to notifications only, run: ${DISABLE_AUTO_UPDATES_COMMAND}`,
].join('\n');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function compareVersions(a, b) {
  const left = SEMVER.exec(String(a ?? ''));
  const right = SEMVER.exec(String(b ?? ''));
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff) return Math.sign(diff);
  }
  if (left[4] === right[4]) return 0;
  if (!left[4]) return 1; // a release sorts after its prereleases
  if (!right[4]) return -1;
  return left[4] < right[4] ? -1 : 1;
}

export function installConfigPath(env = process.env, homeDir = os.homedir()) {
  return managedInstallConfigPath(env, homeDir);
}

async function readInstallConfig(configPath) {
  try {
    const value = JSON.parse(await readFile(configPath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeInstallConfig(configPath, config) {
  const temp = `${configPath}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => {});
  await rename(temp, configPath);
}

async function latestVersion({ fetchImpl, url, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.version === 'string' && SEMVER.test(body.version) ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdate({
  currentVersion = SKILL_VERSION,
  env = process.env,
  homeDir = os.homedir(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  copiedSkill = false,
  scriptFile,
  existsImpl = existsSync,
} = {}) {
  const configPath = installConfigPath(env, homeDir);
  let config = await readInstallConfig(configPath);
  const automaticUpdates = config?.installed === true && config.automaticUpdates === true;
  const skillOnly = copiedSkill === true || (typeof scriptFile === 'string' && isCopiedSkillDirectory(scriptFile, existsImpl));
  const result = {
    currentVersion,
    automaticUpdates,
    updateCommand: UPDATE_COMMAND,
    instruction: 'Tell the user about an available update and ask before running the update command. Never update automatically.',
  };
  let dirty = false;
  if (automaticUpdates && config.autoUpdateNoticeShown !== true) {
    result.notice = AUTO_UPDATE_NOTICE;
    config = { ...config, autoUpdateNoticeShown: true };
    dirty = true;
  }
  if (config?.installed === true && config[FIRST_JOB_PROMPTED_VERSION] !== currentVersion) {
    const previous = typeof config[FIRST_JOB_PROMPTED_VERSION] === 'string' ? config[FIRST_JOB_PROMPTED_VERSION] : null;
    result.firstJob = firstJobPrompt(currentVersion, previous);
    config = { ...config, [FIRST_JOB_PROMPTED_VERSION]: currentVersion };
    dirty = true;
  }
  if (skillOnly && config?.installed !== true) result.managedRuntime = managedRuntimeStatus();
  if (dirty && config) await writeInstallConfig(configPath, config).catch(() => {});
  if (String(env.JOB_APPLICATION_AGENT_NO_UPDATE_CHECK ?? '').trim() === '1') {
    return { ...result, checked: false, reason: 'disabled' };
  }
  const url = env.JOB_APPLICATION_AGENT_UPDATE_CHECK_URL || NPM_LATEST_URL;
  // Test runs never reach the live registry unless they point the check at a mock.
  if (env.JAA_TEST === '1' && !env.JOB_APPLICATION_AGENT_UPDATE_CHECK_URL) {
    return { ...result, checked: false, reason: 'test-run' };
  }
  if (typeof fetchImpl !== 'function') return { ...result, checked: false, reason: 'unavailable' };
  const latest = await latestVersion({ fetchImpl, url, timeoutMs });
  if (!latest) return { ...result, checked: false, reason: 'unavailable' };
  const order = compareVersions(latest, currentVersion);
  return { ...result, checked: true, latestVersion: latest, updateAvailable: order === 1 };
}
