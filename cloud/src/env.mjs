import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLOUD_ROOT } from './paths.mjs';

export function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadDotEnv(filePath, env = process.env) {
  if (!existsSync(filePath)) return env;
  const parsed = parseDotEnv(readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] == null || env[key] === '') env[key] = value;
  }
  return env;
}

export function applyLocalDefaults(env = process.env, { cloudRoot = CLOUD_ROOT } = {}) {
  const data = env.CLOUD_DATA_DIR || join(cloudRoot, 'data');
  if (!env.HOST) env.HOST = '127.0.0.1';
  if (!env.PORT) env.PORT = '8787';
  if (!env.CLOUD_DATA_DIR) env.CLOUD_DATA_DIR = data;
  if (!env.JOB_APPLICATION_AGENT_STATE_DIR) env.JOB_APPLICATION_AGENT_STATE_DIR = join(data, 'skill-state');
  if (!env.CLOUD_EMBED_WORKER) env.CLOUD_EMBED_WORKER = '1';
  if (env.OLLAMA_HOST == null) env.OLLAMA_HOST = 'http://127.0.0.1:11434';
  if (!env.PLAYWRIGHT_HEADLESS) env.PLAYWRIGHT_HEADLESS = '1';
  return env;
}

export function loadLocalEnv(env = process.env, { cloudRoot = CLOUD_ROOT } = {}) {
  loadDotEnv(join(cloudRoot, '.env'), env);
  return applyLocalDefaults(env, { cloudRoot });
}
