import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOUD_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const REPO_ROOT = resolve(CLOUD_ROOT, '..');
export const SKILL_CLI = join(REPO_ROOT, 'job-application-agent/scripts/job-application.mjs');

export function dataDir(env = process.env) {
  return resolve(env.CLOUD_DATA_DIR || join(CLOUD_ROOT, 'data'));
}

export function skillStateDir(env = process.env) {
  return resolve(env.JOB_APPLICATION_AGENT_STATE_DIR || join(dataDir(env), 'skill-state'));
}

export function chromeProfileDir(env = process.env) {
  return join(dataDir(env), 'chrome-profile');
}

export function ensureDataDirs(env = process.env) {
  for (const dir of [dataDir(env), skillStateDir(env), chromeProfileDir(env), join(dataDir(env), 'confirmations')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
