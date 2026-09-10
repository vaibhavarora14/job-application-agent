import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTelemetryEnvelope, jobIdentity, validateEvent, validateTelemetryIdentity } from './telemetry-schema.mjs';
import { SKILL_VERSION } from './version.mjs';

export { SKILL_VERSION };

export const DEFAULT_TELEMETRY_ENDPOINT = process.env.JOB_APPLICATION_AGENT_TELEMETRY_URL ?? 'https://job-application-agent-telemetry.varora1406.workers.dev';
export const TELEMETRY_NOTICE = 'Usage analytics are enabled by default. They include structured job and workflow metrics. Name and email sharing has a separate disclosure and opt-out. Resume content, other profile fields, prompts, form answers, browser data, and raw errors are never sent. Run `telemetry disable` to stop all analytics or `telemetry preview` to inspect an event.\n';
export const IDENTITY_NOTICE = 'Name and email sharing is enabled by default. Starting with the next command, JobAgent shares the name and email explicitly saved in your candidate profile with the maintainer through private PostHog usage analytics for support and product improvement. Run `telemetry identity disable` to keep future analytics anonymous, or `telemetry disable` to stop all analytics. Opting out rotates the analytics ID; previously collected data is retained under the analytics retention policy.\n';

const CONFIG_VERSION = 1;
const CONFIG_FILE = 'telemetry.json';
const EVENTS_WITH_DOMAIN = new Set(['job_discovered', 'job_assessed', 'application_submitted', 'outcome_recorded']);

export async function prepareTelemetryInput(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') return validateEvent(input);
  for (const key of Object.keys(input)) if (!['event', 'properties'].includes(key)) throw new Error(`Unknown telemetry input property: ${key}.`);
  const properties = { ...(input.properties ?? {}) };
  if ('jobUrl' in properties) {
    const identity = await jobIdentity(properties.jobUrl);
    delete properties.jobUrl;
    properties.jobHash = identity.jobHash;
    if (EVENTS_WITH_DOMAIN.has(input.event)) properties.domain = identity.domain;
  }
  return validateEvent({ event: input.event, properties });
}

async function exists(file) {
  try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function writePrivate(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export class TelemetryClient {
  constructor({ stateDir, endpoint = DEFAULT_TELEMETRY_ENDPOINT, fetch: fetchFn = globalThis.fetch, stderr = (value) => process.stderr.write(value), now = () => new Date(), timeoutMs = Number(process.env.JOB_APPLICATION_AGENT_TELEMETRY_TIMEOUT_MS ?? 3000), readIdentity = () => undefined }) {
    this.stateDir = stateDir;
    this.endpoint = endpoint.replace(/\/$/, '');
    this.fetch = fetchFn;
    this.stderr = stderr;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.readIdentity = readIdentity;
  }

  get configPath() { return join(this.stateDir, CONFIG_FILE); }

  async ensureDirectory() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
  }

  async readConfig() {
    try {
      const value = JSON.parse(await readFile(this.configPath, 'utf8'));
      return { version: CONFIG_VERSION, enabled: value.enabled !== false, disclosed: value.disclosed === true, graceConsumed: value.graceConsumed === true, installationEventPending: value.installationEventPending === true, installationId: value.installationId ?? null, token: value.token ?? null, tokenExpiresAt: value.tokenExpiresAt ?? null, identityEnabled: value.identityEnabled !== false, identityDisclosed: value.identityDisclosed === true };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return { version: CONFIG_VERSION, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false, installationId: null, token: null, tokenExpiresAt: null };
    }
  }

  async saveConfig(config) {
    await this.ensureDirectory();
    await writePrivate(this.configPath, config);
  }

  async hasExistingPrivateState() {
    await this.ensureDirectory();
    const names = await readdir(this.stateDir);
    return names.some((name) => name !== CONFIG_FILE && !name.endsWith('.tmp'));
  }

  async beginCommand(command) {
    let config = await this.readConfig();
    let allowSend = true;
    if (!config) {
      const existing = await this.hasExistingPrivateState();
      config = { version: CONFIG_VERSION, enabled: true, disclosed: true, graceConsumed: !existing, installationEventPending: !existing, installationId: null, token: null, tokenExpiresAt: null };
      this.stderr(TELEMETRY_NOTICE);
      await this.saveConfig(config);
      if (existing) {
        allowSend = false;
        config.graceConsumed = true;
        await this.saveConfig(config);
      }
    } else if (!config.disclosed) {
      this.stderr(TELEMETRY_NOTICE);
      config.disclosed = true;
      if (!config.graceConsumed) {
        allowSend = false;
        config.graceConsumed = true;
      }
      await this.saveConfig(config);
    } else if (!config.graceConsumed) {
      allowSend = false;
      config.graceConsumed = true;
      await this.saveConfig(config);
    }
    const allowIdentity = config.identityEnabled !== false && config.identityDisclosed === true;
    if (config.enabled && config.identityEnabled !== false && !config.identityDisclosed) {
      this.stderr(IDENTITY_NOTICE);
      config.identityDisclosed = true;
      await this.saveConfig(config);
    }
    return { command, enabled: config.enabled, allowSend: config.enabled && allowSend, allowIdentity, installationEventPending: config.installationEventPending === true };
  }

  async credentials(config) {
    if (config.installationId && config.token && config.tokenExpiresAt && Date.parse(config.tokenExpiresAt) > this.now().getTime() + 60_000) return config;
    const body = config.installationId && config.token ? { installationId: config.installationId, token: config.token } : {};
    const response = await this.fetch(`${this.endpoint}/v1/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error('relay unavailable');
    const identity = await response.json();
    const next = { ...config, installationId: identity.installationId, token: identity.token, tokenExpiresAt: identity.expiresAt };
    await this.saveConfig(next);
    return next;
  }

  async record(input, session = { enabled: true, allowSend: true }, { strict = false } = {}) {
    let event;
    try {
      event = await prepareTelemetryInput(input);
    } catch (error) {
      if (strict) throw error;
      return { sent: false, reason: 'invalid' };
    }
    try {
      if (!session.enabled || !session.allowSend) return { sent: false, reason: session.enabled ? 'grace' : 'disabled' };
      if (session.unavailable) return { sent: false, reason: 'unavailable' };
      let config = await this.readConfig();
      if (!config?.enabled) return { sent: false, reason: 'disabled' };
      let identity;
      if (session.allowIdentity === true && config.identityEnabled !== false && config.identityDisclosed === true) {
        try { identity = validateTelemetryIdentity(await this.readIdentity()); } catch { /* Missing or invalid identity never blocks anonymous analytics. */ }
      }
      config = await this.credentials(config);
      const payload = createTelemetryEnvelope({ installationId: config.installationId, token: config.token, event, skillVersion: SKILL_VERSION, identity });
      let response = await this.fetch(`${this.endpoint}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.status === 401) {
        config.tokenExpiresAt = null;
        config = await this.credentials(config);
        response = await this.fetch(`${this.endpoint}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createTelemetryEnvelope({ installationId: config.installationId, token: config.token, event, skillVersion: SKILL_VERSION, identity })), signal: AbortSignal.timeout(this.timeoutMs) });
      }
      if (!response.ok) {
        session.unavailable = true;
        return { sent: false, reason: 'unavailable' };
      }
      if (event.event === 'installation_started' && config.installationEventPending) {
        config.installationEventPending = false;
        await this.saveConfig(config);
        session.installationEventPending = false;
      }
      return { sent: true };
    } catch {
      session.unavailable = true;
      return { sent: false, reason: 'unavailable' };
    }
  }

  async status() {
    const config = await this.readConfig();
    return { enabled: config?.enabled ?? true, disclosed: config?.disclosed ?? false, hasInstallationId: Boolean(config?.installationId), installationId: config?.installationId ?? null, identityEnabled: config?.identityEnabled ?? true, identityDisclosed: config?.identityDisclosed ?? false, endpoint: this.endpoint, schemaVersion: 1 };
  }

  async configureIdentity(action) {
    if (action === 'status') return this.status();
    if (!['enable', 'disable'].includes(action)) throw new Error('Identity action must be status, enable, or disable.');
    const current = await this.readConfig() ?? { version: CONFIG_VERSION, enabled: true, disclosed: false, graceConsumed: true, installationEventPending: true };
    const enabled = action === 'enable';
    // Rotate at both boundaries to avoid identifying an earlier anonymous period.
    if (enabled !== (current.identityEnabled !== false)) {
      Object.assign(current, { installationId: null, token: null, tokenExpiresAt: null });
    }
    if (enabled && current.identityEnabled === false) current.identityDisclosed = false;
    current.identityEnabled = enabled;
    await this.saveConfig(current);
    return this.status();
  }

  async configure(action) {
    const current = await this.readConfig() ?? { version: CONFIG_VERSION, enabled: true, disclosed: false, graceConsumed: true, installationEventPending: true, installationId: null, token: null, tokenExpiresAt: null };
    if (action === 'status') return this.status();
    if (action === 'enable') {
      current.enabled = true;
      if (!current.installationId) current.installationEventPending = true;
    }
    else if (action === 'disable') current.enabled = false;
    else if (action === 'reset') Object.assign(current, { enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false, installationId: null, token: null, tokenExpiresAt: null });
    else throw new Error('Telemetry action must be status, enable, disable, or reset.');
    current.disclosed = true;
    await this.saveConfig(current);
    return this.status();
  }

  async preview(input) {
    return prepareTelemetryInput(input);
  }
}
