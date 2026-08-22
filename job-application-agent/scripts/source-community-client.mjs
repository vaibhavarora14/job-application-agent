import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SKILL_VERSION } from './telemetry-client.mjs';
import { createSourceContributionEnvelope, normalizeCommunitySource, validateCommunitySourceList } from './source-community-schema.mjs';

export const DEFAULT_SOURCE_COMMUNITY_ENDPOINT = process.env.JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL ?? process.env.JOB_APPLICATION_AGENT_TELEMETRY_URL ?? 'https://job-application-agent-telemetry.varora1406.workers.dev';
export const SOURCE_SHARING_NOTICE = 'Community source sharing is enabled by default. Repeatable public job boards and hiring feeds are shared anonymously into a pending maintainer-review queue after removing personal and referral data. Run `sources sharing disable` to opt out.\n';

const CONFIG_FILE = 'source-sharing.json';
const CONFIG_LOCK_FILE = '.source-sharing.lock';
const CONFIG_LOCK_TIMEOUT_MS = 15_000;

function defaultConfig() {
  return { version: 1, enabled: true, disclosed: false, installationId: null, token: null, tokenExpiresAt: null };
}

async function writePrivate(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export class SourceCommunityClient {
  constructor({ stateDir, endpoint = DEFAULT_SOURCE_COMMUNITY_ENDPOINT, fetch: fetchFn = globalThis.fetch, stderr = (value) => process.stderr.write(value), now = () => new Date(), timeoutMs = Number(process.env.JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_TIMEOUT_MS ?? 3000) }) {
    this.stateDir = stateDir;
    this.endpoint = endpoint.replace(/\/$/, '');
    this.fetch = fetchFn;
    this.stderr = stderr;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  get configPath() { return join(this.stateDir, CONFIG_FILE); }
  get configLockPath() { return join(this.stateDir, CONFIG_LOCK_FILE); }

  async ensureDirectory() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
  }

  async readConfig() {
    try {
      const value = JSON.parse(await readFile(this.configPath, 'utf8'));
      return { version: 1, enabled: value.enabled !== false, disclosed: value.disclosed === true, installationId: value.installationId ?? null, token: value.token ?? null, tokenExpiresAt: value.tokenExpiresAt ?? null };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return { version: 1, enabled: false, disclosed: true, installationId: null, token: null, tokenExpiresAt: null };
    }
  }

  async saveConfigUnlocked(config) {
    await this.ensureDirectory();
    await writePrivate(this.configPath, config);
  }

  async withConfigLock(operation) {
    await this.ensureDirectory();
    const startedAt = Date.now();
    let handle;
    while (!handle) {
      try {
        handle = await open(this.configLockPath, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() - startedAt >= CONFIG_LOCK_TIMEOUT_MS) throw new Error('Could not acquire source-sharing config lock.');
        await delay(20);
      }
    }
    try {
      await handle.writeFile(`${process.pid}\n`);
    } catch (error) {
      await handle.close();
      await unlink(this.configLockPath).catch(() => {});
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(this.configLockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async updateConfig(transform) {
    return this.withConfigLock(async () => {
      const current = await this.readConfig() ?? defaultConfig();
      const next = transform(current);
      await this.saveConfigUnlocked(next);
      return next;
    });
  }

  async config() {
    return this.withConfigLock(async () => {
      const existing = await this.readConfig();
      if (existing) return existing;
      const config = defaultConfig();
      await this.saveConfigUnlocked(config);
      return config;
    });
  }

  async status() {
    const config = await this.readConfig();
    return { enabled: config?.enabled ?? true, disclosed: config?.disclosed ?? false, hasInstallationId: Boolean(config?.installationId), endpoint: this.endpoint, schemaVersion: 1 };
  }

  async configure(action) {
    if (action === 'status') return this.status();
    await this.updateConfig((config) => {
      if (action === 'enable') config.enabled = true;
      else if (action === 'disable') config.enabled = false;
      else if (action === 'reset') Object.assign(config, { enabled: false, disclosed: true, installationId: null, token: null, tokenExpiresAt: null });
      else throw new Error('Source sharing action must be status, enable, disable, or reset.');
      config.disclosed = true;
      return config;
    });
    return this.status();
  }

  async credentials(config) {
    if (config.installationId && config.token && config.tokenExpiresAt && Date.parse(config.tokenExpiresAt) > this.now().getTime() + 60_000) return config;
    let body = config.installationId && config.token ? { installationId: config.installationId, token: config.token } : {};
    let response = await this.fetch(`${this.endpoint}/v1/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (response.status === 401 && body.installationId) {
      config = await this.updateConfig((current) => {
        if (current.installationId === body.installationId) Object.assign(current, { installationId: null, token: null, tokenExpiresAt: null });
        return current;
      });
      body = {};
      response = await this.fetch(`${this.endpoint}/v1/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    }
    if (!response.ok) throw new Error('community relay unavailable');
    const identity = await response.json();
    return this.updateConfig((current) => ({ ...current, installationId: identity.installationId, token: identity.token, tokenExpiresAt: identity.expiresAt }));
  }

  async preview(input) {
    return normalizeCommunitySource(input);
  }

  async contribute(input) {
    const source = normalizeCommunitySource(input);
    try {
      let config = await this.config();
      if (!config.enabled) return { shared: false, reason: 'disabled' };
      if (!config.disclosed) {
        this.stderr(SOURCE_SHARING_NOTICE);
        config = await this.updateConfig((current) => ({ ...current, disclosed: true }));
        if (!config.enabled) return { shared: false, reason: 'disabled' };
      }
      config = await this.credentials(config);
      let sent = await this.sendContribution(config, source);
      if (sent.disabled) return { shared: false, reason: 'disabled' };
      let response = sent.response;
      if (response.status === 401) {
        config = await this.updateConfig((current) => ({ ...current, tokenExpiresAt: null }));
        config = await this.credentials(config);
        sent = await this.sendContribution(config, source);
        if (sent.disabled) return { shared: false, reason: 'disabled' };
        response = sent.response;
      }
      if (!response.ok) {
        return { shared: false, reason: 'unavailable' };
      }
      const result = await response.json();
      const allowed = new Set(['accepted', 'sourceId', 'publicationStatus', 'uniqueContributors']);
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some((key) => !allowed.has(key))) return { shared: false, reason: 'unavailable' };
      if (result.accepted !== true || !/^community-[0-9a-f]{16}$/.test(result.sourceId)) return { shared: false, reason: 'unavailable' };
      if (!['pending', 'published', 'rejected'].includes(result.publicationStatus)) return { shared: false, reason: 'unavailable' };
      if (!Number.isSafeInteger(result.uniqueContributors) || result.uniqueContributors < 1 || result.uniqueContributors > 1_000_000_000) return { shared: false, reason: 'unavailable' };
      return { shared: true, sourceId: result.sourceId, publicationStatus: result.publicationStatus, uniqueContributors: result.uniqueContributors };
    } catch {
      return { shared: false, reason: 'unavailable' };
    }
  }

  async sendContribution(config, source) {
    return this.withConfigLock(async () => {
      const current = await this.readConfig() ?? config;
      if (!current.enabled) return { disabled: true };
      const envelope = createSourceContributionEnvelope({ installationId: current.installationId, token: current.token, source, skillVersion: SKILL_VERSION });
      const response = await this.fetch(`${this.endpoint}/v1/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(this.timeoutMs) });
      return { disabled: false, response };
    });
  }

  async list() {
    if (this.readUnavailable) return [];
    try {
      const response = await this.fetch(`${this.endpoint}/v1/sources`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) return [];
      return validateCommunitySourceList(await response.json());
    } catch {
      this.readUnavailable = true;
      return [];
    }
  }
}
