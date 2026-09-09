import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ALLOWED_FILES,
  LEDGER_FILES,
  fileContentType,
  forbiddenFieldReason,
  isLedgerFile,
  isReplaceableFile,
  scanStoredContent,
} from './names.mjs';

export const DEFAULT_CLOUD_URL = 'https://job-application-agent-state.varora1406.workers.dev';
export const DEFAULT_SECRET_SERVICE = 'com.vaibhavarora.job-application-agent';
export const LEGACY_SECRET_SERVICE = 'com.openai.codex.job-application-agent';
export const PROFILE_ACCOUNT = 'profile';

export function defaultStateDir(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'job-application-agent');
}

export function defaultCloudDir(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'job-application-agent-cloud');
}

export function defaultConfigPath(home = homedir()) {
  return join(defaultCloudDir(home), 'config.json');
}

export function generateToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenSuffix(token) {
  if (typeof token !== 'string' || token.length < 4) return '****';
  return token.slice(-4);
}

export function sha256Buffer(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalProfileBytes(raw) {
  const parsed = JSON.parse(String(raw));
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored profile is not a JSON object.');
  }
  const forbidden = forbiddenFieldReason(parsed);
  if (forbidden) throw new Error(`Profile contains forbidden field: ${forbidden}`);
  return Buffer.from(JSON.stringify(parsed));
}

function envPath(env, key, fallback) {
  const value = env?.[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function resolveConfigPath({ env = process.env, home = homedir() } = {}) {
  return envPath(env, 'JOB_APPLICATION_AGENT_CLOUD_CONFIG', defaultConfigPath(home));
}

export function resolveStateDir({ env = process.env, home = homedir() } = {}) {
  return envPath(env, 'JOB_APPLICATION_AGENT_STATE_DIR', defaultStateDir(home));
}

export function resolveSecretService(env = process.env) {
  return envPath(env, 'JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE', DEFAULT_SECRET_SERVICE);
}

async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function writePrivate(path, contents, mode = 0o600) {
  await ensurePrivateDir(dirname(path));
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function flag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

export async function loadConfig({ env = process.env, home = homedir(), path } = {}) {
  const configPath = path ?? resolveConfigPath({ env, home });
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Cloud config missing at ${configPath}. Run: node state-worker/bin/sync.mjs enable --url <url> --token <token>`);
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed.url !== 'string' || !/^https:\/\//i.test(parsed.url)) throw new Error('Cloud config url must be an https URL.');
  if (typeof parsed.token !== 'string' || parsed.token.length < 24) throw new Error('Cloud config token is missing or too short.');
  return { ...parsed, url: parsed.url.replace(/\/+$/, ''), path: configPath };
}

export async function saveConfig(config, { env = process.env, home = homedir(), path } = {}) {
  const configPath = path ?? resolveConfigPath({ env, home });
  const body = {
    url: String(config.url).replace(/\/+$/, ''),
    token: String(config.token),
    updatedAt: new Date().toISOString(),
  };
  await writePrivate(configPath, `${JSON.stringify(body, null, 2)}\n`);
  return { ...body, path: configPath };
}

function darwinFind(exec, service, account) {
  try {
    return exec('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function decodeSecret(value) {
  const trimmed = String(value ?? '').trim();
  return /^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0 ? Buffer.from(trimmed, 'hex').toString('utf8') : trimmed;
}

export function createDarwinProfileStore({
  execFileSync: exec = execFileSync,
  service,
  legacyService = LEGACY_SECRET_SERVICE,
  account = PROFILE_ACCOUNT,
} = {}) {
  return {
    readProfile() {
      const current = darwinFind(exec, service, account);
      if (current != null && current.length > 0) return decodeSecret(current);
      if (legacyService && legacyService !== service) {
        const legacy = darwinFind(exec, legacyService, account);
        if (legacy != null && legacy.length > 0) return decodeSecret(legacy);
      }
      throw new Error('The stored profile is missing or unreadable. Run profile set again.');
    },
    writeProfile(raw) {
      try {
        exec('security', ['add-generic-password', '-a', account, '-s', service, '-U', '-w', raw], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        throw new Error('Keychain could not store the profile. Unlock macOS Keychain and retry; no profile data was logged.');
      }
    },
  };
}

export function defaultSecretStore({ env = process.env, execFileSync: exec = execFileSync } = {}) {
  return createDarwinProfileStore({ execFileSync: exec, service: resolveSecretService(env) });
}

function readProfileOrNull(secretStore) {
  try {
    return secretStore.readProfile();
  } catch {
    return null;
  }
}

export async function listLocalAllowedFiles(stateDir) {
  const found = [];
  for (const name of ALLOWED_FILES) {
    const path = join(stateDir, name);
    if (await exists(path)) found.push({ name, path });
  }
  return found;
}

function authHeaders(config, extra = {}) {
  return {
    authorization: `Bearer ${config.token}`,
    ...extra,
  };
}

async function parseError(response) {
  try {
    const body = await response.json();
    if (body?.error) return String(body.error);
  } catch {
    // Ignore non-JSON error bodies.
  }
  return `request_failed_${response.status}`;
}

async function api(config, path, { method = 'GET', headers, body, fetchImpl = fetch } = {}) {
  return fetchImpl(`${config.url}${path}`, { method, headers: authHeaders(config, headers), body });
}

function isPrefix(local, remote) {
  if (remote.length === 0) return true;
  if (local.length < remote.length) return false;
  return local.subarray(0, remote.length).equals(remote);
}

function suffixAfterPrefix(local, remote) {
  if (remote.length === 0) return local;
  if (!isPrefix(local, remote)) return null;
  let offset = remote.length;
  if (local.length > offset && remote[remote.length - 1] !== 10 && local[offset] === 10) offset += 1;
  return local.subarray(offset);
}

export async function push({
  env = process.env,
  home = homedir(),
  stateDir,
  config,
  secretStore,
  fetchImpl = fetch,
} = {}) {
  const resolvedConfig = config ?? await loadConfig({ env, home });
  const dir = stateDir ?? resolveStateDir({ env, home });
  const store = secretStore ?? defaultSecretStore({ env });
  const results = [];

  for (const { name, path } of await listLocalAllowedFiles(dir)) {
    const bytes = await readFile(path);
    if (!name.endsWith('.pdf')) {
      const reason = scanStoredContent(name, bytes.toString('utf8'));
      if (reason) throw new Error(`Local ${name} contains forbidden content: ${reason}`);
    }
    const localHash = sha256Buffer(bytes);
    const current = await api(resolvedConfig, `/v1/files/${encodeURIComponent(name)}`, { fetchImpl });
    if (current.status === 401) throw new Error('Cloud state worker rejected the bearer token.');
    if (isReplaceableFile(name) || (isLedgerFile(name) && current.status === 404)) {
      if (current.status === 200) {
        const remoteBytes = Buffer.from(await current.arrayBuffer());
        if (sha256Buffer(remoteBytes) === localHash) {
          results.push({ name, action: 'skip', sha256: localHash });
          continue;
        }
      }
      const put = await api(resolvedConfig, `/v1/files/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: {
          'content-type': fileContentType(name),
          ...(current.status === 200 ? { 'if-match': current.headers.get('etag') } : {}),
        },
        body: bytes,
        fetchImpl,
      });
      if (!put.ok) throw new Error(`Failed to upload ${name} (${await parseError(put)}).`);
      const payload = await put.json();
      results.push({ name, action: current.status === 404 ? 'create' : 'replace', sha256: payload.sha256 });
      continue;
    }
    if (isLedgerFile(name) && current.status === 200) {
      const remoteBytes = Buffer.from(await current.arrayBuffer());
      if (sha256Buffer(remoteBytes) === localHash) {
        results.push({ name, action: 'skip', sha256: localHash });
        continue;
      }
      const extra = suffixAfterPrefix(bytes, remoteBytes);
      if (extra == null) throw new Error(`Ledger ${name} diverged from cloud. Pull first, then retry push.`);
      if (extra.length === 0) {
        results.push({ name, action: 'skip', sha256: sha256Buffer(remoteBytes) });
        continue;
      }
      const append = await api(resolvedConfig, `/v1/ledgers/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body: extra,
        fetchImpl,
      });
      if (!append.ok) throw new Error(`Failed to append ${name} (${await parseError(append)}).`);
      const payload = await append.json();
      results.push({ name, action: 'append', sha256: payload.sha256, appended: extra.length });
      continue;
    }
    if (current.status !== 404) throw new Error(`Failed to read ${name} (${await parseError(current)}).`);
  }

  const profileRaw = readProfileOrNull(store);
  if (profileRaw) {
    const profileBytes = canonicalProfileBytes(profileRaw);
    const localHash = sha256Buffer(profileBytes);
    const current = await api(resolvedConfig, '/v1/profile', { fetchImpl });
    if (current.status === 200) {
      const remoteBytes = Buffer.from(await current.arrayBuffer());
      if (sha256Buffer(remoteBytes) === localHash) {
        results.push({ name: 'profile', action: 'skip', sha256: localHash });
      } else {
        const put = await api(resolvedConfig, '/v1/profile', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'if-match': current.headers.get('etag') },
          body: profileBytes,
          fetchImpl,
        });
        if (!put.ok) throw new Error(`Failed to upload profile (${await parseError(put)}).`);
        const payload = await put.json();
        results.push({ name: 'profile', action: 'replace', sha256: payload.sha256 });
      }
    } else if (current.status === 404) {
      const put = await api(resolvedConfig, '/v1/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: profileBytes,
        fetchImpl,
      });
      if (!put.ok) throw new Error(`Failed to upload profile (${await parseError(put)}).`);
      const payload = await put.json();
      results.push({ name: 'profile', action: 'create', sha256: payload.sha256 });
    } else {
      throw new Error(`Failed to read profile (${await parseError(current)}).`);
    }
  }

  return { url: resolvedConfig.url, stateDir: dir, results };
}

export async function pull({
  env = process.env,
  home = homedir(),
  stateDir,
  config,
  secretStore,
  fetchImpl = fetch,
} = {}) {
  const resolvedConfig = config ?? await loadConfig({ env, home });
  const dir = stateDir ?? resolveStateDir({ env, home });
  const store = secretStore ?? defaultSecretStore({ env });
  await ensurePrivateDir(dir);
  const manifestResponse = await api(resolvedConfig, '/v1/manifest', { fetchImpl });
  if (!manifestResponse.ok) throw new Error(`Failed to read manifest (${await parseError(manifestResponse)}).`);
  const manifest = await manifestResponse.json();
  const results = [];

  for (const file of manifest.files ?? []) {
    if (!ALLOWED_FILES.includes(file.name)) continue;
    const response = await api(resolvedConfig, `/v1/files/${encodeURIComponent(file.name)}`, { fetchImpl });
    if (!response.ok) throw new Error(`Failed to download ${file.name} (${await parseError(response)}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writePrivate(join(dir, file.name), bytes);
    results.push({ name: file.name, action: 'write', sha256: sha256Buffer(bytes) });
  }

  const profileResponse = await api(resolvedConfig, '/v1/profile', { fetchImpl });
  if (profileResponse.status === 200) {
    const bytes = Buffer.from(await profileResponse.arrayBuffer());
    store.writeProfile(bytes.toString('utf8'));
    results.push({ name: 'profile', action: 'write', sha256: sha256Buffer(bytes) });
  } else if (profileResponse.status !== 404) {
    throw new Error(`Failed to download profile (${await parseError(profileResponse)}).`);
  }

  return { url: resolvedConfig.url, stateDir: dir, results, manifest };
}

function compareHash(local, remote) {
  if (!local && !remote) return 'absent';
  if (!local) return 'remote_only';
  if (!remote) return 'local_only';
  return local === remote ? 'in_sync' : 'diverged';
}

export async function status({
  env = process.env,
  home = homedir(),
  stateDir,
  config,
  secretStore,
  fetchImpl = fetch,
} = {}) {
  const resolvedConfig = config ?? await loadConfig({ env, home });
  const dir = stateDir ?? resolveStateDir({ env, home });
  const store = secretStore ?? defaultSecretStore({ env });
  const manifestResponse = await api(resolvedConfig, '/v1/manifest', { fetchImpl });
  if (!manifestResponse.ok) throw new Error(`Failed to read manifest (${await parseError(manifestResponse)}).`);
  const manifest = await manifestResponse.json();
  const remoteFiles = new Map((manifest.files ?? []).map((file) => [file.name, file]));
  const files = [];

  for (const name of ALLOWED_FILES) {
    const path = join(dir, name);
    const local = (await exists(path)) ? sha256Buffer(await readFile(path)) : null;
    const remote = remoteFiles.get(name)?.sha256 ?? null;
    files.push({ name, local, remote, status: compareHash(local, remote) });
  }

  let localProfile = null;
  const raw = readProfileOrNull(store);
  if (raw) localProfile = sha256Buffer(canonicalProfileBytes(raw));
  const remoteProfile = manifest.profile?.sha256 ?? null;

  return {
    url: resolvedConfig.url,
    configPath: resolvedConfig.path,
    stateDir: dir,
    files,
    profile: {
      local: localProfile,
      remote: remoteProfile,
      status: compareHash(localProfile, remoteProfile),
    },
  };
}

export function ledgerLineSet(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return new Set(lines);
}

export async function uniqueLegacyLedgerRows(currentDir, legacyDir) {
  const unique = [];
  for (const name of LEDGER_FILES) {
    const currentPath = join(currentDir, name);
    const legacyPath = join(legacyDir, name);
    if (!(await exists(legacyPath))) continue;
    const current = (await exists(currentPath)) ? ledgerLineSet(await readFile(currentPath, 'utf8')) : new Set();
    const legacyLines = String(await readFile(legacyPath, 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const extras = legacyLines.filter((line) => !current.has(line));
    if (extras.length > 0) unique.push({ name, count: extras.length, lines: extras });
  }
  return unique;
}

function formatStatus(report) {
  const lines = [
    `Cloud ${report.url}`,
    `State ${report.stateDir}`,
    `Config ${report.configPath}`,
  ];
  let matched = 0;
  for (const file of report.files) {
    if (file.status === 'absent') continue;
    const hash = (file.local || file.remote || '').slice(0, 8);
    if (file.status === 'in_sync') matched += 1;
    lines.push(`${file.name}  ${file.status.replaceAll('_', ' ')}  ${hash}`);
  }
  const profileHash = (report.profile.local || report.profile.remote || '').slice(0, 8);
  lines.push(`profile  ${report.profile.status.replaceAll('_', ' ')}  ${profileHash}`);
  if (matched > 0 && report.profile.status === 'in_sync') lines.push(`${matched} files in sync; profile hashes match.`);
  else if (matched > 0) lines.push(`${matched} files in sync.`);
  return `${lines.join('\n')}\n`;
}

export async function runSync(argv = process.argv.slice(2), {
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  secretStore,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const [command, ...rest] = argv;
    const store = secretStore ?? defaultSecretStore({ env });
    if (command === 'enable') {
      const url = flag(rest, '--url') || env.JOB_APPLICATION_AGENT_CLOUD_URL;
      const token = flag(rest, '--token') || env.JOB_APPLICATION_AGENT_CLOUD_TOKEN;
      if (!url || !token) throw usageError('enable requires --url and --token');
      if (!/^https:\/\//i.test(url)) throw usageError('enable --url must be an https URL');
      if (token.length < 24) throw usageError('enable --token is too short');
      const saved = await saveConfig({ url, token }, { env, home });
      stdout.write(`Cloud sync enabled for ${saved.url}\n`);
      stdout.write(`Config written to ${saved.path} (mode 0600). Token ends with ${tokenSuffix(token)}.\n`);
      return 0;
    }
    if (command === 'push') {
      const result = await push({ env, home, fetchImpl, secretStore: store, stateDir: flag(rest, '--dir') });
      stdout.write(`Pushed ${result.results.length} objects to ${result.url}\n`);
      return 0;
    }
    if (command === 'pull') {
      const result = await pull({ env, home, fetchImpl, secretStore: store, stateDir: flag(rest, '--dir') });
      stdout.write(`Pulled ${result.results.length} objects into ${result.stateDir}\n`);
      return 0;
    }
    if (command === 'status') {
      const report = await status({ env, home, fetchImpl, secretStore: store, stateDir: flag(rest, '--dir') });
      stdout.write(formatStatus(report));
      return 0;
    }
    throw usageError('Usage: node state-worker/bin/sync.mjs enable|push|pull|status [--url <https-url>] [--token <token>] [--dir <state-dir>]');
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}
