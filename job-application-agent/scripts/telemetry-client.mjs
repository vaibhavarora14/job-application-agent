import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTelemetryEnvelope, jobIdentity, validateEvent, validateTelemetryIdentity } from './telemetry-schema.mjs';
import { SKILL_VERSION } from './version.mjs';

export { SKILL_VERSION };

export const PRODUCTION_TELEMETRY_ENDPOINT = 'https://job-application-agent-telemetry.varora1406.workers.dev';
// Unroutable local port: connections are refused immediately and nothing leaves the machine.
export const TEST_RUNNER_TELEMETRY_ENDPOINT = 'http://127.0.0.1:9';

/**
 * True inside a GitHub Actions job. GitHub sets GITHUB_ACTIONS=true on every runner step.
 * Deliberately NOT keyed on the generic CI variable: agent runtimes and sandboxes that real
 * candidates use (non-interactive shells, hosted coding agents) commonly export CI=true, and
 * treating those as CI would silently drop real usage analytics.
 * Reads only GITHUB_ACTIONS (to stay quiet on CI runners); no environment value is sent.
 */
export function isGitHubActions(env = process.env) {
  const value = String(env.GITHUB_ACTIONS ?? '').trim().toLowerCase();
  return value !== '' && value !== 'false' && value !== '0';
}

function truthyFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized !== '' && normalized !== 'false' && normalized !== '0';
}

// npm lifecycle scripts that run this repository's test suite (npm sets npm_lifecycle_event).
const TEST_LIFECYCLE_EVENTS = new Set(['test', 'pretest', 'posttest', 'prepack', 'prepublishOnly', 'privacy-audit']);
const TEST_ENTRYPOINT = /(^|[\\/])[^\\/]+[._-]test\.[cm]?js$/i;

/**
 * True when this process belongs to a test run. Test runs never reach the production relay
 * unless JAA_TEST_LIVE_TELEMETRY=1 is set explicitly.
 * - NODE_TEST_CONTEXT: set by `node --test` and inherited by CLIs that tests spawn.
 * - GITHUB_ACTIONS: every GitHub Actions step. Deliberately not the generic CI variable, which
 *   real candidates' agent runtimes commonly export.
 * - JAA_TEST: set by the repository's test setup (tests/support/no-live-telemetry.mjs) and
 *   inherited by spawned CLIs.
 * - npm_lifecycle_event: `npm test`, `npm run prepack`, and friends.
 * - argv[1] is a *.test.mjs file: a test file run directly with `node file.test.mjs`.
 */
export function isTestRun(env = process.env, argv = process.argv) {
  if (env.NODE_TEST_CONTEXT) return true;
  if (isGitHubActions(env)) return true;
  if (truthyFlag(env.JAA_TEST)) return true;
  if (TEST_LIFECYCLE_EVENTS.has(String(env.npm_lifecycle_event ?? ''))) return true;
  return TEST_ENTRYPOINT.test(String(argv?.[1] ?? ''));
}

/** Explicit opt-in for a test run that must talk to the production relay. */
export function liveTelemetryAllowedInTests(env = process.env) {
  return String(env.JAA_TEST_LIVE_TELEMETRY ?? '').trim() === '1';
}

/**
 * Relay endpoint for this process. An explicit JOB_APPLICATION_AGENT_TELEMETRY_URL always wins.
 * Otherwise a test run (see isTestRun) uses an unroutable local endpoint, never production,
 * unless JAA_TEST_LIVE_TELEMETRY=1. Test runs were registering throwaway installations and
 * fixture ledger events in the production relay, PostHog, and the public installation count.
 */
export function defaultTelemetryEndpoint(env = process.env, argv = process.argv) {
  if (env.JOB_APPLICATION_AGENT_TELEMETRY_URL) return env.JOB_APPLICATION_AGENT_TELEMETRY_URL;
  if (isTestRun(env, argv) && !liveTelemetryAllowedInTests(env)) return TEST_RUNNER_TELEMETRY_ENDPOINT;
  return PRODUCTION_TELEMETRY_ENDPOINT;
}

export const DEFAULT_TELEMETRY_ENDPOINT = defaultTelemetryEndpoint();
export const TELEMETRY_NOTICE = 'Usage analytics are enabled by default. They include structured job and workflow metrics without candidate name, email, phone, or résumé content in analytics events. We also store your saved name and email privately (separate from analytics events) so we can support you and send product updates. Run `telemetry contact disable` to stop contact sharing, or `telemetry disable` to stop all analytics and contact sharing. Run `telemetry preview` to inspect an analytics event.\n';
export const IDENTITY_NOTICE = 'Contact sharing uses your saved profile name and email for support and product updates. It is not attached to analytics events. Run `telemetry contact disable` to stop contact sharing, or `telemetry disable` to stop all analytics.\n';

const CONFIG_VERSION = 1;
const CONFIG_FILE = 'telemetry.json';
const QUEUE_FILE = 'telemetry-queue.ndjson';
const QUARANTINE_FILE = 'telemetry-quarantine.ndjson';
const DEDUPE_FILE = 'telemetry-attempt-dedupe.json';
const OPT_OUT_FILE = 'telemetry.opt-out';
const CONTACT_OPT_OUT_FILE = 'telemetry.contact.opt-out';
const EVENTS_WITH_DOMAIN = new Set(['job_discovered', 'job_assessed', 'application_submitted', 'outcome_recorded']);
const DEDUPED_LIFECYCLE_EVENTS = new Set(['application_started', 'application_paused']);
const QUEUE_MAX_ITEMS = 50;
const QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const QUARANTINE_MAX_ITEMS = 50;
// 4xx statuses that are about the request context rather than the event itself, so retrying can
// succeed: 401 (token; already refreshed once in-band), 408 (timeout), 425 (too early), 429 (rate).
const RETRYABLE_CLIENT_STATUSES = new Set([401, 408, 425, 429]);
const DEDUPE_MAX_KEYS = 500;
const RETRY_DELAYS_MS = [50, 150];

/**
 * True when the relay refused this specific payload (malformed, unknown property, too large).
 * Retrying the same bytes can never succeed, so the item must not hold up the queue.
 * 5xx, network errors, and the retryable 4xx statuses above keep retry/backoff.
 */
export function isPermanentRejection(status) {
  return Number.isInteger(status) && status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status);
}

async function relayErrorCode(response) {
  try {
    const body = await response.clone().json();
    return typeof body?.error === 'string' && /^[a-z0-9_]{1,64}$/.test(body.error) ? body.error : null;
  } catch {
    return null;
  }
}

export function lifecycleDedupeKey(event) {
  if (!event || !DEDUPED_LIFECYCLE_EVENTS.has(event.event)) return null;
  const jobHash = event.properties?.jobHash;
  if (typeof jobHash !== 'string' || !jobHash) return null;
  if (event.event === 'application_started') return `application_started:${jobHash}`;
  return `application_paused:${jobHash}:${event.properties.stage}:${event.properties.reason}`;
}

/**
 * Keep events sendable to relays that reject unknown properties. 3.7.9 always attached
 * thinSubmissionOverrideUsed (usually false) to application_submitted; relays deployed before
 * that key existed reject the whole event, and the local queue retried it forever. A false value
 * carries no information (absent means false), so drop it; true is kept.
 */
export function relayCompatibleEvent(event) {
  if (event?.event !== 'application_submitted' || !event.properties) return event;
  if (event.properties.thinSubmissionOverrideUsed !== false) return event;
  const { thinSubmissionOverrideUsed: _unused, ...properties } = event.properties;
  return { ...event, properties };
}

/**
 * application_submitted without the optional profileOneClick key, or null when the event has none.
 * Used once after a relay that predates the key (strict allowlist) answers 400 invalid_event, so
 * a CLI released before the relay is deployed still gets its submissions counted.
 */
export function withoutProfileOneClick(event) {
  if (event?.event !== 'application_submitted' || !event.properties || !('profileOneClick' in event.properties)) return null;
  const { profileOneClick: _unused, ...properties } = event.properties;
  return { ...event, properties };
}

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

function envTelemetryDisabled(env = process.env) {
  const disabledFlag = String(env.JOB_APPLICATION_AGENT_TELEMETRY_DISABLED ?? '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(disabledFlag)) return true;
  const telemetry = String(env.JOB_APPLICATION_AGENT_TELEMETRY ?? '').toLowerCase();
  return ['0', 'false', 'off', 'disabled'].includes(telemetry);
}

function envContactDisabled(env = process.env) {
  const flag = String(env.JOB_APPLICATION_AGENT_CONTACT_DISABLED ?? '').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(flag);
}

function defaultConfig({ enabled = true, disclosed = false, graceConsumed = true, installationEventPending = true, contactEnabled = true, contactDisclosed = false } = {}) {
  return {
    version: CONFIG_VERSION,
    enabled,
    disclosed,
    graceConsumed,
    installationEventPending,
    installationId: null,
    token: null,
    tokenExpiresAt: null,
    identityEnabled: false,
    identityDisclosed: true,
    contactEnabled,
    contactDisclosed,
    contactFingerprint: null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contactFingerprint(payload) {
  return createHash('sha256')
    .update(JSON.stringify({
      name: payload.candidateName ?? null,
      email: payload.candidateEmail ?? null,
      skillVersion: payload.skillVersion,
    }))
    .digest('hex');
}

export class TelemetryClient {
  constructor({
    stateDir,
    endpoint = DEFAULT_TELEMETRY_ENDPOINT,
    fetch: fetchFn = globalThis.fetch,
    stderr = (value) => process.stderr.write(value),
    now = () => new Date(),
    timeoutMs = Number(process.env.JOB_APPLICATION_AGENT_TELEMETRY_TIMEOUT_MS ?? 3000),
    readIdentity = () => undefined,
    debug = (value) => { if (process.env.JOB_APPLICATION_AGENT_TELEMETRY_DEBUG) process.stderr.write(value); },
    env = process.env,
  } = {}) {
    this.stateDir = stateDir;
    this.endpoint = endpoint.replace(/\/$/, '');
    this.fetch = fetchFn;
    this.stderr = stderr;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.readIdentity = readIdentity;
    this.debug = debug;
    this.env = env;
  }

  get configPath() { return join(this.stateDir, CONFIG_FILE); }
  get queuePath() { return join(this.stateDir, QUEUE_FILE); }
  get dedupePath() { return join(this.stateDir, DEDUPE_FILE); }
  get quarantinePath() { return join(this.stateDir, QUARANTINE_FILE); }
  get optOutPath() { return join(this.stateDir, OPT_OUT_FILE); }
  get contactOptOutPath() { return join(this.stateDir, CONTACT_OPT_OUT_FILE); }

  debugLog(message) {
    this.debug(`[telemetry] ${message}\n`);
  }

  async ensureDirectory() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
  }

  async readLifecycleState() {
    try {
      const value = JSON.parse(await readFile(this.dedupePath, 'utf8'));
      const keys = Array.isArray(value?.keys) ? value.keys.filter((key) => typeof key === 'string') : [];
      const startedEntries = value?.startedAtByJobHash && typeof value.startedAtByJobHash === 'object' && !Array.isArray(value.startedAtByJobHash)
        ? Object.entries(value.startedAtByJobHash).filter(([jobHash, at]) => typeof jobHash === 'string' && typeof at === 'string' && !Number.isNaN(Date.parse(at)))
        : [];
      return {
        keys: keys.slice(-DEDUPE_MAX_KEYS),
        startedAtByJobHash: Object.fromEntries(startedEntries.slice(-DEDUPE_MAX_KEYS)),
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') this.debugLog(`lifecycle state unreadable (${error.message}); resetting`);
      return { keys: [], startedAtByJobHash: {} };
    }
  }

  async readLifecycleDedupe() {
    return (await this.readLifecycleState()).keys;
  }

  async rememberLifecycleDedupe(key, { applicationStartedAt } = {}) {
    if (!key && !applicationStartedAt) return;
    await this.ensureDirectory();
    const state = await this.readLifecycleState();
    const keys = [...state.keys];
    if (key && !keys.includes(key)) keys.push(key);
    const startedAtByJobHash = { ...state.startedAtByJobHash };
    if (applicationStartedAt?.jobHash && applicationStartedAt?.at) {
      startedAtByJobHash[applicationStartedAt.jobHash] = applicationStartedAt.at;
    }
    const prunedStarted = Object.fromEntries(Object.entries(startedAtByJobHash).slice(-DEDUPE_MAX_KEYS));
    await writePrivate(this.dedupePath, {
      version: 1,
      keys: keys.slice(-DEDUPE_MAX_KEYS),
      startedAtByJobHash: prunedStarted,
    });
  }

  /** ISO timestamp when application_started was recorded for this job hash, if known locally. */
  async applicationStartedAt(jobHash) {
    if (typeof jobHash !== 'string' || !jobHash) return null;
    const state = await this.readLifecycleState();
    return state.startedAtByJobHash[jobHash] ?? null;
  }

  async explicitOptOut() {
    if (envTelemetryDisabled(this.env)) return true;
    if (await exists(this.optOutPath)) return true;
    return false;
  }

  async explicitContactOptOut() {
    if (envContactDisabled(this.env)) return true;
    if (await exists(this.contactOptOutPath)) return true;
    return false;
  }

  normalizeConfig(value) {
    return {
      version: CONFIG_VERSION,
      enabled: value.enabled !== false,
      disclosed: value.disclosed === true,
      graceConsumed: value.graceConsumed === true,
      installationEventPending: value.installationEventPending === true,
      installationId: value.installationId ?? null,
      token: value.token ?? null,
      tokenExpiresAt: value.tokenExpiresAt ?? null,
      identityEnabled: value.identityEnabled === true,
      identityDisclosed: value.identityDisclosed === true,
      contactEnabled: value.contactEnabled !== false,
      contactDisclosed: value.contactDisclosed === true,
      contactFingerprint: typeof value.contactFingerprint === 'string' ? value.contactFingerprint : null,
    };
  }

  async readConfig() {
    try {
      const value = JSON.parse(await readFile(this.configPath, 'utf8'));
      return this.normalizeConfig(value);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      const optedOut = await this.explicitOptOut();
      const recovered = defaultConfig({
        enabled: !optedOut,
        disclosed: true,
        graceConsumed: true,
        installationEventPending: !optedOut,
        contactEnabled: !(await this.explicitContactOptOut()),
        contactDisclosed: true,
      });
      this.debugLog(`telemetry.json unreadable (${error.message}); rewriting enabled=${recovered.enabled}`);
      await this.saveConfig(recovered);
      return recovered;
    }
  }

  async saveConfig(config) {
    await this.ensureDirectory();
    await writePrivate(this.configPath, config);
  }

  async hasExistingPrivateState() {
    await this.ensureDirectory();
    const names = await readdir(this.stateDir);
    return names.some((name) => ![CONFIG_FILE, QUEUE_FILE, OPT_OUT_FILE, CONTACT_OPT_OUT_FILE].includes(name) && !name.endsWith('.tmp'));
  }

  async readQueue() {
    try {
      const lines = (await readFile(this.queuePath, 'utf8')).split('\n').filter(Boolean);
      return lines.map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      this.debugLog(`queue unreadable (${error.message}); resetting`);
      return [];
    }
  }

  async writeQueue(items) {
    await this.ensureDirectory();
    const temporary = `${this.queuePath}.${process.pid}.tmp`;
    const body = items.length ? `${items.map((item) => JSON.stringify(item)).join('\n')}\n` : '';
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, this.queuePath);
    await chmod(this.queuePath, 0o600);
  }

  normalizeQueueItem(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.type === 'contact' && item.contact) return item;
    if (item.type === 'event' && item.event) return item;
    if (item.event && typeof item.queuedAt === 'string') return { ...item, type: 'event' };
    return null;
  }

  pruneQueue(items, nowMs = this.now().getTime()) {
    const normalized = items.map((item) => this.normalizeQueueItem(item)).filter(Boolean);
    const kept = normalized
      .filter((item) => nowMs - Date.parse(item.queuedAt) <= QUEUE_MAX_AGE_MS)
      .slice(-QUEUE_MAX_ITEMS);
    const dropped = items.length - kept.length;
    if (dropped > 0) this.debugLog(`dropped ${dropped} queued item(s) (age or size bound)`);
    return kept;
  }

  async enqueue(item, reason) {
    const items = this.pruneQueue(await this.readQueue());
    if (items.length >= QUEUE_MAX_ITEMS) {
      const removed = items.shift();
      this.debugLog(`queue full; dropped oldest type=${removed?.type ?? 'unknown'} reason=${reason}`);
    }
    const queued = { queuedAt: this.now().toISOString(), ...item };
    items.push(queued);
    await this.writeQueue(items);
    this.debugLog(`queued type=${queued.type} reason=${reason}`);
  }

  async enqueueEvent(event, reason) {
    await this.enqueue({ type: 'event', event }, reason);
  }

  async enqueueContact(contact, reason) {
    await this.enqueue({ type: 'contact', contact }, reason);
  }

  async readQuarantine() {
    try {
      return (await readFile(this.quarantinePath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code !== 'ENOENT') this.debugLog(`quarantine unreadable (${error.message}); resetting`);
      return [];
    }
  }

  /**
   * Set aside an item the relay permanently refused so it never blocks the queue again. Local only
   * (0600, bounded). Event payloads are the same schema-validated analytics already queued locally;
   * contact payloads are never copied here, only that one was refused.
   */
  async quarantine(item, { status = null, error = null } = {}) {
    try {
      await this.ensureDirectory();
      const entry = {
        quarantinedAt: this.now().toISOString(),
        type: item.type,
        status,
        error,
        ...(item.type === 'event' ? { event: item.event } : {}),
      };
      const items = [...await this.readQuarantine(), entry].slice(-QUARANTINE_MAX_ITEMS);
      const temporary = `${this.quarantinePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${items.map((value) => JSON.stringify(value)).join('\n')}\n`, { mode: 0o600 });
      await rename(temporary, this.quarantinePath);
      await chmod(this.quarantinePath, 0o600);
    } catch (quarantineError) {
      this.debugLog(`quarantine write failed (${quarantineError.message})`);
    }
  }

  warnRejected(type, name, { status = null, error = null } = {}) {
    const detail = [status ? `HTTP ${status}` : null, error].filter(Boolean).join(' ');
    // Event name and relay error code only: never properties, identity, or contact values.
    this.stderr(`[telemetry] warning: the analytics relay rejected a ${name ?? type}${detail ? ` (${detail})` : ''}; it was set aside in ${QUARANTINE_FILE} and will not be retried. Other analytics continue.\n`);
  }

  async flushQueue(session, config) {
    const items = this.pruneQueue(await this.readQueue());
    if (!items.length) return config;
    const remaining = [];
    let current = config;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      let result;
      if (item.type === 'contact') {
        result = await this.sendContact(item.contact, session, current, { queueOnFailure: false });
      } else {
        result = await this.sendValidated(item.event, session, current, { queueOnFailure: false });
      }
      if (result.sent) {
        current = result.config ?? current;
        continue;
      }
      if (result.reason === 'rejected') {
        // Already quarantined and warned about; one bad item must not block the rest.
        current = result.config ?? current;
        continue;
      }
      remaining.push(item);
      this.debugLog(`queue retry deferred type=${item.type} reason=${result.reason}`);
      if (result.reason === 'unavailable') {
        // Relay unreachable: stop for now but keep every item not yet attempted.
        remaining.push(...items.slice(index + 1));
        break;
      }
    }
    await this.writeQueue(remaining);
    return current;
  }

  async beginCommand(command) {
    if (await this.explicitOptOut()) {
      const current = await this.readConfig();
      if (!current || current.enabled !== false) {
        const disabled = { ...(current ?? defaultConfig({ disclosed: true, graceConsumed: true, installationEventPending: false })), enabled: false, disclosed: true, graceConsumed: true };
        await this.saveConfig(disabled);
      }
      return { command, enabled: false, allowSend: false, allowIdentity: false, allowContact: false, installationEventPending: false };
    }

    let config = await this.readConfig();
    if (!config) {
      const existing = await this.hasExistingPrivateState();
      const contactOptedOut = await this.explicitContactOptOut();
      config = defaultConfig({
        enabled: true,
        disclosed: true,
        graceConsumed: true,
        installationEventPending: true,
        contactEnabled: !contactOptedOut,
        contactDisclosed: true,
      });
      this.stderr(TELEMETRY_NOTICE);
      await this.saveConfig(config);
      if (existing) this.debugLog('upgrade without telemetry.json; sending immediately including install event');
    } else if (!config.disclosed) {
      this.stderr(TELEMETRY_NOTICE);
      config.disclosed = true;
      config.contactDisclosed = true;
      config.graceConsumed = true;
      await this.saveConfig(config);
    } else if (!config.graceConsumed) {
      config.graceConsumed = true;
      await this.saveConfig(config);
    }

    if (await this.explicitContactOptOut()) {
      if (config.contactEnabled !== false) {
        config.contactEnabled = false;
        await this.saveConfig(config);
      }
    }

    if (config.enabled && config.contactEnabled !== false && !config.contactDisclosed) {
      this.stderr(IDENTITY_NOTICE);
      config.contactDisclosed = true;
      await this.saveConfig(config);
    }

    if (config.enabled) {
      try { config = await this.flushQueue({ enabled: true, allowSend: true, allowContact: config.contactEnabled !== false }, config); } catch (error) {
        this.debugLog(`queue flush failed (${error.message})`);
      }
    }

    const session = {
      command,
      enabled: config.enabled,
      allowSend: config.enabled,
      allowIdentity: false,
      allowContact: config.enabled && config.contactEnabled !== false,
      installationEventPending: config.installationEventPending === true,
    };
    if (session.allowContact) {
      try { await this.syncContact(session); } catch (error) {
        this.debugLog(`contact sync failed (${error.message})`);
      }
    }
    return session;
  }

  async credentials(config) {
    if (config.installationId && config.token && config.tokenExpiresAt && Date.parse(config.tokenExpiresAt) > this.now().getTime() + 60_000) return config;
    const body = config.installationId && config.token ? { installationId: config.installationId, token: config.token } : {};
    const response = await this.fetchWithRetry(`${this.endpoint}/v1/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('relay unavailable');
    const identity = await response.json();
    const next = { ...config, installationId: identity.installationId, token: identity.token, tokenExpiresAt: identity.expiresAt };
    await this.saveConfig(next);
    return next;
  }

  async fetchWithRetry(url, options) {
    let lastError;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await this.fetch(url, { ...options, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) {
        lastError = error;
        if (attempt === RETRY_DELAYS_MS.length) break;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastError;
  }

  async readContactPayload() {
    let identity;
    try { identity = validateTelemetryIdentity(await this.readIdentity()); } catch { return null; }
    const payload = {
      candidateName: identity.name ?? null,
      candidateEmail: identity.email ?? null,
      skillVersion: SKILL_VERSION,
      updatedAt: this.now().toISOString(),
    };
    if (!payload.candidateName && !payload.candidateEmail) return null;
    return payload;
  }

  async syncContact(session = { enabled: true, allowContact: true }) {
    if (!session.enabled || session.allowContact === false) return { sent: false, reason: 'disabled' };
    if (await this.explicitOptOut() || await this.explicitContactOptOut()) return { sent: false, reason: 'disabled' };
    const config = await this.readConfig();
    if (!config?.enabled || config.contactEnabled === false) return { sent: false, reason: 'disabled' };
    const contact = await this.readContactPayload();
    if (!contact) return { sent: false, reason: 'missing' };
    const fingerprint = contactFingerprint(contact);
    if (config.contactFingerprint === fingerprint) return { sent: false, reason: 'unchanged' };
    return this.sendContact(contact, session, config, { queueOnFailure: true });
  }

  async sendContact(contact, session, config, { queueOnFailure = true } = {}) {
    try {
      if (!session.enabled || session.allowContact === false || !config?.enabled || config.contactEnabled === false) {
        this.debugLog('drop contact reason=disabled');
        return { sent: false, reason: 'disabled' };
      }
      let next = await this.credentials(config);
      const body = {
        installId: next.installationId,
        token: next.token,
        candidateName: contact.candidateName,
        candidateEmail: contact.candidateEmail,
        skillVersion: contact.skillVersion ?? SKILL_VERSION,
        updatedAt: contact.updatedAt ?? this.now().toISOString(),
      };
      let response = await this.fetchWithRetry(`${this.endpoint}/v1/contact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        next = { ...next, tokenExpiresAt: null };
        next = await this.credentials(next);
        body.installId = next.installationId;
        body.token = next.token;
        response = await this.fetchWithRetry(`${this.endpoint}/v1/contact`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!response.ok) {
        if (isPermanentRejection(response.status)) {
          const error = await relayErrorCode(response);
          await this.quarantine({ type: 'contact' }, { status: response.status, error });
          this.warnRejected('contact', 'contact update', { status: response.status, error });
          return { sent: false, reason: 'rejected', status: response.status, config: next };
        }
        if (queueOnFailure) await this.enqueueContact(contact, `http_${response.status}`);
        this.debugLog(`contact send failed status=${response.status}`);
        return { sent: false, reason: 'unavailable', config: next };
      }
      next = { ...next, contactFingerprint: contactFingerprint(contact), contactDisclosed: true };
      await this.saveConfig(next);
      return { sent: true, config: next };
    } catch (error) {
      if (queueOnFailure) await this.enqueueContact(contact, error.message ?? 'unavailable');
      this.debugLog(`contact send error reason=${error.message ?? 'unavailable'}`);
      return { sent: false, reason: 'unavailable', config };
    }
  }

  async sendValidated(rawEvent, session, config, { queueOnFailure = true } = {}) {
    let event = relayCompatibleEvent(rawEvent);
    try {
      if (!session.enabled || !session.allowSend) {
        const reason = session.enabled ? 'grace' : 'disabled';
        this.debugLog(`drop event=${event?.event} reason=${reason}`);
        return { sent: false, reason };
      }
      if (!config?.enabled) {
        this.debugLog(`drop event=${event?.event} reason=disabled`);
        return { sent: false, reason: 'disabled' };
      }
      try {
        // A queued item written by an older client may no longer match the schema. It can never
        // be sent, so set it aside instead of letting it block the queue as "unavailable".
        event = validateEvent(event);
      } catch {
        const name = typeof event?.event === 'string' ? event.event.slice(0, 64) : 'event';
        await this.quarantine({ type: 'event', event: rawEvent }, { error: 'local_schema_invalid' });
        this.warnRejected('event', `${name} event`, { error: 'local_schema_invalid' });
        return { sent: false, reason: 'rejected', config };
      }

      let next = await this.credentials(config);
      const payload = createTelemetryEnvelope({ installationId: next.installationId, token: next.token, event, skillVersion: SKILL_VERSION });
      let response = await this.fetchWithRetry(`${this.endpoint}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) {
        next = { ...next, tokenExpiresAt: null };
        next = await this.credentials(next);
        response = await this.fetchWithRetry(`${this.endpoint}/v1/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(createTelemetryEnvelope({ installationId: next.installationId, token: next.token, event, skillVersion: SKILL_VERSION })),
        });
      }
      if (response.status === 400) {
        const legacy = withoutProfileOneClick(event);
        if (legacy && (await relayErrorCode(response)) === 'invalid_event') {
          event = legacy;
          response = await this.fetchWithRetry(`${this.endpoint}/v1/events`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(createTelemetryEnvelope({ installationId: next.installationId, token: next.token, event, skillVersion: SKILL_VERSION })),
          });
        }
      }
      if (!response.ok) {
        if (isPermanentRejection(response.status)) {
          // Never queue (or keep) a payload the relay refused: it would retry forever and, before
          // 3.7.11, block every queued event behind it.
          const error = await relayErrorCode(response);
          await this.quarantine({ type: 'event', event }, { status: response.status, error });
          this.warnRejected('event', `${event.event} event`, { status: response.status, error });
          return { sent: false, reason: 'rejected', status: response.status, config: next };
        }
        if (queueOnFailure) await this.enqueueEvent(event, `http_${response.status}`);
        this.debugLog(`send failed event=${event.event} status=${response.status}`);
        return { sent: false, reason: 'unavailable', config: next };
      }
      if (event.event === 'installation_started' && next.installationEventPending) {
        next = { ...next, installationEventPending: false };
        await this.saveConfig(next);
        session.installationEventPending = false;
      }
      return { sent: true, config: next };
    } catch (error) {
      if (queueOnFailure) await this.enqueueEvent(event, error.message ?? 'unavailable');
      this.debugLog(`send error event=${event.event} reason=${error.message ?? 'unavailable'}`);
      return { sent: false, reason: 'unavailable', config };
    }
  }

  async record(input, session = { enabled: true, allowSend: true }, { strict = false } = {}) {
    let event;
    try {
      event = await prepareTelemetryInput(input);
    } catch (error) {
      this.debugLog(`schema-invalid event dropped: ${error.message}`);
      if (strict) throw error;
      if (session?.enabled && session?.allowSend) {
        try {
          const counter = validateEvent({
            event: 'skill_error',
            properties: {
              errorCode: 'invalid_input',
              stage: 'application',
              recoverable: true,
              errorCategory: 'schema_invalid',
            },
          });
          await this.sendValidated(counter, session, await this.readConfig(), { queueOnFailure: true });
        } catch { /* counter is best effort */ }
      }
      return { sent: false, reason: 'invalid' };
    }
    const dedupeKey = lifecycleDedupeKey(event);
    if (dedupeKey && (await this.readLifecycleDedupe()).includes(dedupeKey)) {
      this.debugLog(`drop event=${event.event} reason=duplicate_attempt key=${dedupeKey}`);
      return { sent: false, reason: 'duplicate' };
    }
    const config = await this.readConfig();
    const result = await this.sendValidated(event, session, config, { queueOnFailure: true });
    if ((dedupeKey || event.event === 'application_started') && (result.sent || result.reason === 'unavailable')) {
      await this.rememberLifecycleDedupe(dedupeKey, event.event === 'application_started'
        ? { applicationStartedAt: { jobHash: event.properties.jobHash, at: this.now().toISOString() } }
        : {});
    }
    return { sent: result.sent, reason: result.reason };
  }

  async status() {
    const config = await this.readConfig();
    const optedOut = await this.explicitOptOut();
    const contactOptedOut = await this.explicitContactOptOut();
    return {
      enabled: optedOut ? false : (config?.enabled ?? true),
      disclosed: config?.disclosed ?? false,
      hasInstallationId: Boolean(config?.installationId),
      installationId: config?.installationId ?? null,
      identityEnabled: false,
      identityDisclosed: config?.identityDisclosed ?? false,
      contactEnabled: optedOut || contactOptedOut ? false : (config?.contactEnabled ?? true),
      contactDisclosed: config?.contactDisclosed ?? false,
      endpoint: this.endpoint,
      schemaVersion: 1,
    };
  }

  async configureContact(action) {
    if (action === 'status') return this.status();
    if (!['enable', 'disable'].includes(action)) throw new Error('Contact action must be status, enable, or disable.');
    const current = await this.readConfig() ?? defaultConfig({ disclosed: true, graceConsumed: true, installationEventPending: true });
    if (action === 'disable') {
      current.contactEnabled = false;
      current.contactFingerprint = null;
      await this.ensureDirectory();
      await writeFile(this.contactOptOutPath, 'opted-out\n', { mode: 0o600 });
      await chmod(this.contactOptOutPath, 0o600);
    } else {
      current.contactEnabled = true;
      current.contactDisclosed = false;
      current.contactFingerprint = null;
      try { await unlink(this.contactOptOutPath); } catch { /* ignore */ }
    }
    await this.saveConfig(current);
    return this.status();
  }

  async configureIdentity(action) {
    // Compatibility alias: identity controls now gate private contact sharing, not PostHog event props.
    if (action === 'status') return this.status();
    if (!['enable', 'disable'].includes(action)) throw new Error('Identity action must be status, enable, or disable.');
    return this.configureContact(action);
  }

  async configure(action) {
    const current = await this.readConfig() ?? defaultConfig({ disclosed: false, graceConsumed: true, installationEventPending: true });
    if (action === 'status') return this.status();
    if (action === 'enable') {
      current.enabled = true;
      if (!current.installationId) current.installationEventPending = true;
    } else if (action === 'disable') {
      current.enabled = false;
      await this.ensureDirectory();
      await writeFile(this.optOutPath, 'opted-out\n', { mode: 0o600 });
      await chmod(this.optOutPath, 0o600);
    } else if (action === 'reset') {
      Object.assign(current, defaultConfig({ enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false, contactEnabled: false, contactDisclosed: true }));
      await this.writeQueue([]);
    } else {
      throw new Error('Telemetry action must be status, enable, disable, or reset.');
    }
    if (action === 'enable') {
      try { await unlink(this.optOutPath); } catch { /* ignore missing opt-out file */ }
    }
    current.disclosed = true;
    await this.saveConfig(current);
    return this.status();
  }

  async preview(input) {
    return prepareTelemetryInput(input);
  }
}

export { validateTelemetryIdentity };
