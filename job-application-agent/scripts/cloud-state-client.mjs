import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export const CLOUD_STREAM_FILES = Object.freeze({
  applications: 'applications.ndjson',
  outcomes: 'outcomes.ndjson',
  rounds: 'rounds.ndjson',
  discovery: 'discovery.ndjson',
  attention: 'attention.ndjson',
  reviews: 'reviews.ndjson',
  friction: 'friction.ndjson',
});

const CLOUD_DOCUMENT_FILES = Object.freeze({
  profile: 'cloud-profile-cache.json',
  autonomy: 'autonomy.json',
  'review-policy': 'review-policy.json',
  'postal-address': 'postal-address.json',
});

const FORBIDDEN_KEYS = /^(password|passwd|cookie|cookies|mfa|mfaCode|totp|ssn|passport|aadhaar|governmentId|governmentID|nationalId|sessionCookie|browserCookies|credential|credentials)$/i;

export function defaultCloudConfigPath(home = homedir()) {
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'job-application-agent-cloud', 'config.json');
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'job-application-agent-cloud', 'config.json');
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'job-application-agent', 'cloud.json');
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function scanForbidden(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = scanForbidden(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) return key;
    const found = scanForbidden(item, depth + 1);
    if (found) return found;
  }
  return null;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function privateWrite(path, contents) {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function fileExists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function saveCloudConfig(input, { configPath = defaultCloudConfigPath() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Cloud configuration must be a JSON object.');
  const url = String(input.url ?? '').replace(/\/+$/, '');
  const token = String(input.token ?? '');
  if (!/^https:\/\//i.test(url)) throw new Error('Cloud URL must use HTTPS.');
  if (token.length < 32) throw new Error('Cloud token must be at least 32 characters.');
  const config = {
    version: 2,
    url,
    token,
    ...(input.clientId ? { clientId: String(input.clientId) } : {}),
    ...(input.clientName ? { clientName: String(input.clientName) } : {}),
    configuredAt: new Date().toISOString(),
  };
  await privateWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { ...config, token: tokenSuffix(token) };
}

export async function enableCloudUpdateGuard({ home = homedir(), agentHome = process.env.JOB_APPLICATION_AGENT_HOME } = {}) {
  const root = agentHome || join(home, '.agents');
  const path = join(root, 'job-application-agent', 'install.json');
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { guarded: false, reason: 'managed-install-not-found' }; throw error; }
  const required = new Set(config.requiredCapabilities ?? []);
  required.add('cloud-state-v2');
  await privateWrite(path, `${JSON.stringify({ ...config, requiredCapabilities: [...required].sort() }, null, 2)}\n`);
  return { guarded: true, capability: 'cloud-state-v2' };
}

function tokenSuffix(token) {
  return token.length >= 4 ? `****${token.slice(-4)}` : '****';
}

export async function loadCloudConfig({ configPath = defaultCloudConfigPath(), optional = false } = {}) {
  try {
    const value = JSON.parse(await readFile(configPath, 'utf8'));
    const url = String(value.url ?? '').replace(/\/+$/, '');
    const token = String(value.token ?? '');
    if (!/^https:\/\//i.test(url) || token.length < 24) throw new Error('Cloud configuration is malformed.');
    return { ...value, url, token };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.code === 'ENOENT') throw new Error(`Cloud configuration is missing at ${configPath}. Run cloud configure --stdin.`);
    throw error;
  }
}

async function responseError(response) {
  try { return (await response.json()).error ?? `HTTP ${response.status}`; } catch { return `HTTP ${response.status}`; }
}

export class CloudStateClient {
  constructor({ stateDir, configPath = defaultCloudConfigPath(), fetchImpl = fetch } = {}) {
    if (!stateDir) throw new Error('stateDir is required.');
    this.stateDir = stateDir;
    this.configPath = configPath;
    this.fetchImpl = fetchImpl;
  }

  async config(optional = false) {
    return loadCloudConfig({ configPath: this.configPath, optional });
  }

  async configured() {
    return (await this.config(true))?.version === 2;
  }

  async request(path, init = {}) {
    const config = await this.config();
    if (config.version !== 2) throw new Error('Cloud configuration uses the retired whole-file protocol. Run cloud configure --stdin with a v2 client credential.');
    let response;
    try {
      response = await this.fetchImpl(`${config.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${config.token}`, ...(init.headers ?? {}) },
      });
    } catch (error) {
      throw new Error(`Cloud state unavailable: ${error.message}`);
    }
    if (!response.ok) throw new Error(`Cloud state request failed (${response.status}): ${await responseError(response)}`);
    return response;
  }

  async status() {
    const config = await this.config(true);
    if (!config) return { configured: false, backend: 'local', pendingLocalWrites: 0 };
    const pending = await this.pendingWrites();
    const remote = await (await this.request('/v2/status')).json();
    return { configured: true, url: config.url, configuredClient: { id: config.clientId ?? null, name: config.clientName ?? null, token: tokenSuffix(config.token) }, pendingLocalWrites: pending.length, ...remote };
  }

  async getDocument(name) {
    const response = await this.request(`/v2/documents/${encodeURIComponent(name)}`);
    return response.json();
  }

  async putDocument(name, value, revision) {
    const forbidden = scanForbidden(value);
    if (forbidden) throw new Error(`Cloud document contains forbidden field: ${forbidden}`);
    const response = await this.request(`/v2/documents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': String(revision) },
      body: JSON.stringify({ value }),
    });
    return response.json();
  }

  async putDocumentCurrent(name, value) {
    let revision = 0;
    try { revision = (await this.getDocument(name)).revision; }
    catch (error) { if (!/\(404\)/.test(error.message)) throw error; }
    return this.putDocument(name, value, revision);
  }

  async listStream(stream) {
    const records = [];
    let cursor = 0;
    do {
      const page = await (await this.request(`/v2/streams/${encodeURIComponent(stream)}?after=${cursor}&limit=1000`)).json();
      records.push(...page.records);
      if (page.nextCursor === cursor || page.records.length === 0) break;
      cursor = page.nextCursor;
    } while (true);
    return records;
  }

  async appendRecord(stream, value, { recordKey, idempotencyKey, occurredAt, provenance = 'live', queueOnFailure = false } = {}) {
    const forbidden = scanForbidden(value);
    if (forbidden) throw new Error(`Cloud record contains forbidden field: ${forbidden}`);
    const payload = {
      recordKey: String(recordKey ?? value?.id ?? value?.roundId ?? randomUUID()),
      idempotencyKey: String(idempotencyKey ?? `${stream}:${hash(JSON.stringify(value))}`),
      occurredAt: occurredAt ?? value?.occurredAt ?? value?.submittedAt ?? new Date().toISOString(),
      provenance,
      value,
    };
    try {
      return await (await this.request(`/v2/streams/${encodeURIComponent(stream)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json();
    } catch (error) {
      if (!queueOnFailure) throw error;
      await this.queueWrite({ type: 'append-record', stream, payload, queuedAt: new Date().toISOString() });
      return { queued: true, error: 'cloud_unavailable' };
    }
  }

  async appendRecordBatch(stream, records) {
    if (!Array.isArray(records) || records.length < 1 || records.length > 100) throw new Error('Cloud record batch must contain 1 to 100 records.');
    const response = await this.request(`/v2/streams/${encodeURIComponent(stream)}/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records }) });
    return response.json();
  }

  async queueWrite(event) {
    await ensurePrivateDirectory(this.stateDir);
    const path = join(this.stateDir, 'cloud-pending.ndjson');
    await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }

  async pendingWrites() {
    try { return (await readFile(join(this.stateDir, 'cloud-pending.ndjson'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async putFile(name, bytes, revision) {
    const body = Buffer.from(bytes);
    const response = await this.request(`/v2/files/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': name.endsWith('.pdf') ? 'application/pdf' : 'application/json', 'if-match': String(revision), 'x-content-sha256': hash(body) }, body });
    return response.json();
  }

  async putFileCurrent(name, bytes) {
    let revision = 0;
    try {
      const status = await this.status();
      revision = status.files?.find((file) => file.name === name)?.revision ?? 0;
    } catch (error) { if (!/\(404\)/.test(error.message)) throw error; }
    return this.putFile(name, bytes, revision);
  }

  async fetchResume() {
    const response = await this.request('/v2/files/resume.pdf');
    const bytes = Buffer.from(await response.arrayBuffer());
    const expected = response.headers.get('x-sha256');
    const actual = hash(bytes);
    if (!expected || expected !== actual) throw new Error('Cloud resume checksum verification failed.');
    if (!bytes.subarray(0, 4).equals(Buffer.from('%PDF'))) throw new Error('Cloud resume is not a PDF.');
    const path = join(this.stateDir, 'resume.pdf');
    await privateWrite(path, bytes);
    return { path, sha256: actual, bytes: bytes.length };
  }

  async refreshProfileCache() {
    const document = await this.getDocument('profile');
    await privateWrite(join(this.stateDir, 'cloud-profile-cache.json'), `${JSON.stringify(document.value)}\n`);
    return document.value;
  }

  async refreshDocumentCaches() {
    const refreshed = {};
    for (const [name, filename] of Object.entries(CLOUD_DOCUMENT_FILES)) {
      let document;
      try { document = await this.getDocument(name); }
      catch (error) { if (/\(404\)/.test(error.message)) continue; throw error; }
      await privateWrite(join(this.stateDir, filename), `${JSON.stringify(document.value)}\n`);
      refreshed[name] = { revision: document.revision, updatedAt: document.updatedAt ?? null };
    }
    return refreshed;
  }

  async acquireLease() {
    return (await this.request('/v2/leases/application-run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acquire' }) })).json();
  }

  async renewLease(leaseId) {
    return (await this.request('/v2/leases/application-run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'renew', leaseId }) })).json();
  }

  async releaseLease(leaseId) {
    return (await this.request('/v2/leases/application-run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'release', leaseId }) })).json();
  }

  async createIntent(value) {
    return (await this.request('/v2/intents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })).json();
  }

  async markIntentSentUnverified(intentId, leaseId) {
    return (await this.request(`/v2/intents/${encodeURIComponent(intentId)}/sent-unverified`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseId }) })).json();
  }

  async confirmIntent(intentId, application, leaseId, idempotencyKey) {
    return (await this.request(`/v2/intents/${encodeURIComponent(intentId)}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ application, leaseId, idempotencyKey }) })).json();
  }

  async reconcile({ dryRun = true, provenance = 'local-reconcile' } = {}) {
    const report = { dryRun, streams: {}, imported: 0, downloaded: 0 };
    for (const [stream, filename] of Object.entries(CLOUD_STREAM_FILES)) {
      const local = await readNdjson(join(this.stateDir, filename));
      const cloudRecords = await this.listStream(stream);
      const cloud = cloudRecords.map((record) => record.value);
      const localCounts = multiset(local);
      const cloudCounts = multiset(cloud);
      const localOnly = multisetDifference(local, cloudCounts);
      const cloudOnly = multisetDifference(cloud, localCounts);
      report.streams[stream] = { localRows: local.length, cloudRows: cloud.length, localOnly: localOnly.length, cloudOnly: cloudOnly.length, unionRows: local.length + cloudOnly.length };
      if (!dryRun) {
        const prepared = localOnly.map(({ value, index }) => ({
          recordKey: String(value?.id ?? value?.roundId ?? value?.applicationId ?? `${stream}-${index}`),
          idempotencyKey: `reconcile:${hash(JSON.stringify(value))}:${index}`,
          occurredAt: value?.occurredAt ?? value?.submittedAt ?? new Date().toISOString(),
          provenance,
          value,
        }));
        for (let offset = 0; offset < prepared.length; offset += 100) {
          const result = await this.appendRecordBatch(stream, prepared.slice(offset, offset + 100));
          report.imported += result.inserted;
        }
        if (cloudOnly.length) {
          await ensurePrivateDirectory(this.stateDir);
          const path = join(this.stateDir, filename);
          for (const { value } of cloudOnly) await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
          await chmod(path, 0o600);
          report.downloaded += cloudOnly.length;
        }
      }
    }
    return report;
  }

  async exportTo(path) {
    const status = await this.status();
    const documents = {};
    for (const item of status.documents ?? []) documents[item.name] = await this.getDocument(item.name);
    const streams = {};
    for (const stream of Object.keys(CLOUD_STREAM_FILES)) streams[stream] = await this.listStream(stream);
    const output = path ?? join(this.stateDir, `cloud-export-${new Date().toISOString().replaceAll(':', '-')}.json`);
    await privateWrite(output, `${JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), backend: status.backend, documents, streams, files: status.files ?? [] })}\n`);
    return { path: output, documents: Object.keys(documents).length, records: Object.values(streams).reduce((sum, rows) => sum + rows.length, 0) };
  }
}

async function readNdjson(path) {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function key(value) {
  return JSON.stringify(value);
}

function multiset(values) {
  const counts = new Map();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return counts;
}

function multisetDifference(values, otherCounts) {
  const remaining = new Map(otherCounts);
  const result = [];
  values.forEach((value, index) => {
    const itemKey = key(value);
    const count = remaining.get(itemKey) ?? 0;
    if (count > 0) remaining.set(itemKey, count - 1);
    else result.push({ value, index });
  });
  return result;
}

export async function readCachedCloudProfile(stateDir) {
  try { return JSON.parse(await readFile(join(stateDir, 'cloud-profile-cache.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function cloudDocumentFile(name) {
  return CLOUD_DOCUMENT_FILES[name] ?? null;
}
