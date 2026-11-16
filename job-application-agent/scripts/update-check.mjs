// Notify-only update check for the installed skill.
// Reads the latest published version from the public npm registry and reports it.
// A registry read, successful or failed, is cached for 24 hours. The check never
// downloads, installs, or runs anything, and a timeout or network failure returns
// quietly instead of failing the command. No profile, ledger, or identity data is sent.
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';

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
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export function upgradeNudge(currentVersion, latestVersion) {
  const current = String(currentVersion ?? '').replace(/[\r\n]/g, '').trim();
  const latest = String(latestVersion ?? '').replace(/[\r\n]/g, '').trim();
  return `job-application-agent ${current} is behind ${latest}. Upgrade with: ${UPDATE_COMMAND}`;
}

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

function updateCheckCachePath(env, homeDir) {
  return join(dirname(installConfigPath(env, homeDir)), 'update-check.json');
}

async function readUpdateCache(cachePath) {
  try {
    const value = JSON.parse(await readFile(cachePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeUpdateCache(cachePath, cache) {
  await mkdir(dirname(cachePath), { recursive: true });
  const temp = `${cachePath}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => {});
  await rename(temp, cachePath);
}

function freshUpdateCache(cache, nowMs) {
  if (!cache || (cache.ok !== true && cache.ok !== false)) return false;
  if (cache.ok === true && (typeof cache.latestVersion !== 'string' || !SEMVER.test(cache.latestVersion))) return false;
  const checkedAt = Date.parse(cache.checkedAt);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(nowMs)) return false;
  const age = nowMs - checkedAt;
  return age >= 0 && age < UPDATE_CHECK_TTL_MS;
}

function checkedAtStamp(nowMs) {
  const date = new Date(nowMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function versionFields(result, latest) {
  const updateAvailable = compareVersions(latest, result.currentVersion) === 1;
  return {
    ...result,
    checked: true,
    latestVersion: latest,
    updateAvailable,
    ...(updateAvailable ? { nudge: upgradeNudge(result.currentVersion, latest) } : {}),
  };
}

async function latestVersion({ fetchImpl, url, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  const attempt = (async () => {
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (!response?.ok) return null;
      const body = await response.json();
      return typeof body?.version === 'string' && SEMVER.test(body.version) ? body.version : null;
    } catch {
      return null;
    }
  })();
  // A fetch that ignores the abort still loses the race, so a stuck registry cannot hold the command open.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
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
  now = Date.now,
} = {}) {
  const configPath = installConfigPath(env, homeDir);
  let config = await readInstallConfig(configPath);
  const automaticUpdates = config?.installed === true && config.automaticUpdates === true;
  const skillOnly = copiedSkill === true || (typeof scriptFile === 'string' && isCopiedSkillDirectory(scriptFile, existsImpl));
  const result = {
    currentVersion,
    automaticUpdates,
    updateCommand: UPDATE_COMMAND,
    instruction: 'When nudge is present, show that exact line to the user and ask before running the update command. Never update automatically, and never let a failed check block the run.',
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
  const nowMs = typeof now === 'function' ? Number(now()) : Number.NaN;
  const cachePath = updateCheckCachePath(env, homeDir);
  const cache = await readUpdateCache(cachePath);
  if (freshUpdateCache(cache, nowMs)) {
    if (cache.ok === true) return { ...versionFields(result, cache.latestVersion), cached: true };
    return { ...result, checked: false, reason: 'unavailable', cached: true };
  }
  if (typeof fetchImpl !== 'function') return { ...result, checked: false, reason: 'unavailable' };
  const latest = await latestVersion({ fetchImpl, url, timeoutMs });
  const checkedAt = checkedAtStamp(nowMs);
  if (!latest) {
    await writeUpdateCache(cachePath, { checkedAt, ok: false }).catch(() => {});
    return { ...result, checked: false, reason: 'unavailable' };
  }
  await writeUpdateCache(cachePath, { checkedAt, ok: true, latestVersion: latest }).catch(() => {});
  return { ...versionFields(result, latest), cached: false };
}
