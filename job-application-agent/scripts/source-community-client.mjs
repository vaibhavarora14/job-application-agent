import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SKILL_VERSION } from './telemetry-client.mjs';
import { createSourceContributionEnvelope, normalizeCommunitySource, validateCommunitySourceList } from './source-community-schema.mjs';

export const DEFAULT_SOURCE_COMMUNITY_ENDPOINT = process.env.JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL ?? process.env.JOB_APPLICATION_AGENT_TELEMETRY_URL ?? 'https://job-application-agent-telemetry.varora1406.workers.dev';
export const SOURCE_SHARING_NOTICE = 'Community source sharing is enabled by default. Repeatable public job boards and hiring feeds are shared anonymously after removing personal and referral data. Run `sources sharing disable` to opt out.\n';

const CONFIG_FILE = 'source-sharing.json';

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

  async saveConfig(config) {
    await this.ensureDirectory();
    await writePrivate(this.configPath, config);
  }

  async config() {
    let config = await this.readConfig();
    if (!config) {
      config = { version: 1, enabled: true, disclosed: false, installationId: null, token: null, tokenExpiresAt: null };
      await this.saveConfig(config);
    }
    return config;
  }

  async status() {
    const config = await this.readConfig();
    return { enabled: config?.enabled ?? true, disclosed: config?.disclosed ?? false, hasInstallationId: Boolean(config?.installationId), endpoint: this.endpoint, schemaVersion: 1 };
  }

  async configure(action) {
    const config = await this.config();
    if (action === 'status') return this.status();
    if (action === 'enable') config.enabled = true;
    else if (action === 'disable') config.enabled = false;
    else if (action === 'reset') Object.assign(config, { enabled: false, disclosed: true, installationId: null, token: null, tokenExpiresAt: null });
    else throw new Error('Source sharing action must be status, enable, disable, or reset.');
    config.disclosed = true;
    await this.saveConfig(config);
    return this.status();
  }

  async credentials(config) {
    if (config.installationId && config.token && config.tokenExpiresAt && Date.parse(config.tokenExpiresAt) > this.now().getTime() + 60_000) return config;
    const body = config.installationId && config.token ? { installationId: config.installationId, token: config.token } : {};
    const response = await this.fetch(`${this.endpoint}/v1/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error('community relay unavailable');
    const identity = await response.json();
    const next = { ...config, installationId: identity.installationId, token: identity.token, tokenExpiresAt: identity.expiresAt };
    await this.saveConfig(next);
    return next;
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
        config.disclosed = true;
        await this.saveConfig(config);
      }
      config = await this.credentials(config);
      const envelope = createSourceContributionEnvelope({ installationId: config.installationId, token: config.token, source, skillVersion: SKILL_VERSION });
      let response = await this.fetch(`${this.endpoint}/v1/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.status === 401) {
        config.tokenExpiresAt = null;
        config = await this.credentials(config);
        response = await this.fetch(`${this.endpoint}/v1/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createSourceContributionEnvelope({ installationId: config.installationId, token: config.token, source, skillVersion: SKILL_VERSION })), signal: AbortSignal.timeout(this.timeoutMs) });
      }
      if (!response.ok) {
        this.unavailable = true;
        return { shared: false, reason: 'unavailable' };
      }
      const result = await response.json();
      if (!/^community-[0-9a-f]{16}$/.test(result.sourceId)) return { shared: false, reason: 'unavailable' };
      return { shared: true, sourceId: result.sourceId };
    } catch {
      this.unavailable = true;
      return { shared: false, reason: 'unavailable' };
    }
  }

  async list() {
    if (this.unavailable) return [];
    try {
      const response = await this.fetch(`${this.endpoint}/v1/sources`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) return [];
      return validateCommunitySourceList(await response.json());
    } catch {
      this.unavailable = true;
      return [];
    }
  }
}
