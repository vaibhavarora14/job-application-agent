// How this skill tree was obtained, as a closed enum safe to put on analytics events.
// Detection stays on the machine. The returned object never includes a path, cache key,
// registry URL, git remote, owner, or version specifier.
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PACKAGE_NAME = 'job-application-agent';
export const OFFICIAL_REPO = 'vaibhavarora14/job-application-agent';
export const OFFICIAL_CLAWHUB_OWNER = 'vaibhavarora14';
export const VENDOR_SKILL_DIRS = ['.codex/skills', '.claude/skills', '.cursor/skills', '.copilot/skills', '.gemini/skills'];
export const NPX_FRESH_WINDOW_MS = 3 * 60 * 1000;

export const INSTALL_SOURCES = [
  'npx-latest',
  'npx-name',
  'npx-pinned',
  'npx-other',
  'npm-global',
  'npm-local',
  'local-checkout',
  'unpacked-package',
  'skill-add',
  'skill-add-pinned',
  'skill-add-local',
  'skill-add-other',
  'clawhub',
  'clawhub-other',
  'managed-unrecorded',
  'stale-copy',
  'copied-tree',
  'unknown',
];

const INSTALL_SOURCE_SET = new Set(INSTALL_SOURCES);
const NPX_SOURCES = new Set(['npx-latest', 'npx-name', 'npx-pinned', 'npx-other']);
const FLOATING_REFS = new Set(['main', 'master', 'HEAD', 'head']);
const SKILL_LAYOUTS = ['skills', '.agents/skills', ...VENDOR_SKILL_DIRS];
const JSON_LIMIT = 65536;
const ORIGIN_LIMIT = 8192;

export function npxCacheKey(specifiers) {
  const list = (Array.isArray(specifiers) ? specifiers : [specifiers]).map((item) => String(item));
  return createHash('sha512')
    .update(list.sort((a, b) => a.localeCompare(b, 'en')).join('\n'))
    .digest('hex')
    .slice(0, 16);
}

export function npxCacheHashFromPath(packageRoot, pathApi = path) {
  let dir = pathApi.resolve(packageRoot);
  for (let i = 0; i < 8; i += 1) {
    const parent = pathApi.dirname(dir);
    if (parent === dir) return null;
    if (pathApi.basename(parent) === '_npx' && /^[0-9a-f]{16}$/.test(pathApi.basename(dir))) return pathApi.basename(dir);
    dir = parent;
  }
  return null;
}

// `fresh` is a package directory created within three minutes before the installer
// process started. Missing or epoch creation times are omitted rather than guessed.
export function cacheFreshness(birthtimeMs, processStartMs, freshWindowMs = NPX_FRESH_WINDOW_MS) {
  if (!Number.isFinite(birthtimeMs) || birthtimeMs <= 0 || !Number.isFinite(processStartMs)) return undefined;
  const age = processStartMs - birthtimeMs;
  if (age < -5000) return undefined;
  return age <= freshWindowMs ? 'fresh' : 'cached';
}

export function publicInstallOrigin(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const origin = {};
  if (INSTALL_SOURCE_SET.has(input.installSource)) origin.installSource = input.installSource;
  if ((input.installCache === 'fresh' || input.installCache === 'cached') && NPX_SOURCES.has(origin.installSource)) {
    origin.installCache = input.installCache;
  }
  return origin;
}

export function skillRootFromScript(scriptPath, pathApi = path) {
  const resolved = pathApi.resolve(scriptPath);
  const parent = pathApi.dirname(resolved);
  if (pathApi.basename(parent) === 'scripts') return pathApi.dirname(parent);
  if (pathApi.basename(resolved) === 'scripts') return parent;
  return resolved;
}

function looksLikePath(value) {
  return typeof value === 'string' && (value.startsWith('/') || value.startsWith('~') || value.startsWith('file:') || value.includes('\\') || /^[A-Za-z]:[\\/]/.test(value));
}

export function isOfficialSkillSource(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300 || looksLikePath(trimmed)) return false;
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase() === OFFICIAL_REPO;
  if (!trimmed.includes('://') && !trimmed.includes('@')) return trimmed.replace(/\.git$/i, '').toLowerCase() === OFFICIAL_REPO;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return false;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return false;
    return `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`.toLowerCase() === OFFICIAL_REPO;
  } catch {
    return false;
  }
}

function classifyNpxHash(hash, packageVersion) {
  if (hash === npxCacheKey(`${PACKAGE_NAME}@latest`)) return 'npx-latest';
  if (hash === npxCacheKey(PACKAGE_NAME)) return 'npx-name';
  if (typeof packageVersion === 'string' && packageVersion && hash === npxCacheKey(`${PACKAGE_NAME}@${packageVersion}`)) return 'npx-pinned';
  return 'npx-other';
}

async function readJsonLimited(file, maxBytes, statFn, readFileFn) {
  try {
    const info = await statFn(file);
    if (typeof info.isFile === 'function' && !info.isFile()) return null;
    if (typeof info.size === 'number' && info.size > maxBytes) return null;
    const text = await readFileFn(file, 'utf8');
    if (text.length > maxBytes) return null;
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function readPackageName(dir, readFileFn, pathApi) {
  const parsed = await readJsonLimited(pathApi.join(dir, 'package.json'), JSON_LIMIT, stat, readFileFn);
  return typeof parsed?.name === 'string' ? parsed.name : '';
}

async function pathExists(file, statFn) {
  try {
    await statFn(file);
    return true;
  } catch {
    return false;
  }
}

export async function classifyPackageRoot(packageRoot, {
  packageVersion,
  pathApi = path,
  stat: statFn = stat,
  readFile: readFileFn = readFile,
  processStartMs = Date.now() - process.uptime() * 1000,
} = {}) {
  const root = pathApi.resolve(packageRoot);
  const hash = npxCacheHashFromPath(root, pathApi);
  if (hash) {
    const version = packageVersion || (await readJsonLimited(pathApi.join(root, 'package.json'), JSON_LIMIT, stat, readFileFn))?.version;
    const installSource = classifyNpxHash(hash, typeof version === 'string' ? version : '');
    let birthtimeMs;
    try {
      const info = await statFn(root);
      birthtimeMs = Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : undefined;
    } catch {
      birthtimeMs = undefined;
    }
    const installCache = cacheFreshness(birthtimeMs, processStartMs);
    return publicInstallOrigin(installCache ? { installSource, installCache } : { installSource });
  }
  if (pathApi.basename(pathApi.dirname(root)) === 'node_modules') {
    const projectName = await readPackageName(pathApi.dirname(pathApi.dirname(root)), readFileFn, pathApi);
    return { installSource: projectName && projectName !== PACKAGE_NAME ? 'npm-local' : 'npm-global' };
  }
  if (await readPackageName(root, readFileFn, pathApi) === PACKAGE_NAME) {
    const git = await pathExists(pathApi.join(root, '.git'), statFn);
    return { installSource: git ? 'local-checkout' : 'unpacked-package' };
  }
  return { installSource: 'unknown' };
}

function isoMs(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function classifyLockEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const source = entry.source;
  const sourceUrl = entry.sourceUrl;
  let installSource;
  if (entry.sourceType === 'local' || looksLikePath(source) || looksLikePath(sourceUrl)) installSource = 'skill-add-local';
  else if (isOfficialSkillSource(source) || isOfficialSkillSource(sourceUrl)) {
    const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
    installSource = ref && !FLOATING_REFS.has(ref) ? 'skill-add-pinned' : 'skill-add';
  } else installSource = 'skill-add-other';
  return { installSource, updatedAtMs: isoMs(entry.updatedAt) ?? isoMs(entry.installedAt) };
}

function agentHomeFrom(homeDir, env, pathApi) {
  const override = typeof env?.JOB_APPLICATION_AGENT_HOME === 'string' ? env.JOB_APPLICATION_AGENT_HOME.trim() : '';
  return override || pathApi.join(homeDir, '.agents');
}

function knownSkillRoots(homeDir, env, pathApi) {
  const roots = [pathApi.join(agentHomeFrom(homeDir, env, pathApi), 'skills', PACKAGE_NAME)];
  for (const relative of VENDOR_SKILL_DIRS) roots.push(pathApi.join(homeDir, ...relative.split('/'), PACKAGE_NAME));
  return roots;
}

async function samePath(left, right) {
  const resolveExisting = async (value) => {
    try { return await realpath(value); } catch { return path.resolve(value); }
  };
  const [a, b] = await Promise.all([resolveExisting(left), resolveExisting(right)]);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function lockOwnsSkill(lockDir, skillRoot, pathApi) {
  const skill = pathApi.resolve(skillRoot);
  return SKILL_LAYOUTS.some((relative) => pathApi.resolve(pathApi.join(lockDir, ...relative.split('/'), PACKAGE_NAME)) === skill);
}

async function findProjectLock(skillRoot, pathApi, statFn, readFileFn) {
  let dir = pathApi.resolve(skillRoot);
  for (let i = 0; i < 8; i += 1) {
    const parsed = await readJsonLimited(pathApi.join(dir, 'skills-lock.json'), JSON_LIMIT, statFn, readFileFn);
    const classified = classifyLockEntry(parsed?.skills?.[PACKAGE_NAME]);
    if (classified && lockOwnsSkill(dir, skillRoot, pathApi)) return classified;
    const parent = pathApi.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readGlobalLock(homeDir, env, pathApi, statFn, readFileFn) {
  const candidates = [pathApi.join(agentHomeFrom(homeDir, env, pathApi), '.skill-lock.json')];
  if (typeof env?.XDG_STATE_HOME === 'string' && pathApi.isAbsolute(env.XDG_STATE_HOME)) {
    candidates.push(pathApi.join(env.XDG_STATE_HOME, 'skills', '.skill-lock.json'));
  }
  for (const file of candidates) {
    const parsed = await readJsonLimited(file, JSON_LIMIT, statFn, readFileFn);
    const classified = classifyLockEntry(parsed?.skills?.[PACKAGE_NAME]);
    if (classified) return classified;
  }
  return null;
}

async function classifyClawhub(skillRoot, statFn, readFileFn) {
  for (const dir of ['.clawhub', '.clawdhub']) {
    const marker = path.join(skillRoot, dir);
    if (!(await pathExists(marker, statFn))) continue;
    const origin = await readJsonLimited(path.join(marker, 'origin.json'), ORIGIN_LIMIT, statFn, readFileFn);
    const slug = typeof origin?.slug === 'string' ? origin.slug.trim().toLowerCase() : '';
    const owner = typeof origin?.ownerHandle === 'string' ? origin.ownerHandle.trim().toLowerCase() : '';
    const valid = origin?.version === 1 && slug && typeof origin.installedVersion === 'string' && typeof origin.installedAt === 'number';
    if (valid && slug === PACKAGE_NAME && (owner === '' || owner === OFFICIAL_CLAWHUB_OWNER)) return 'clawhub';
    return 'clawhub-other';
  }
  return null;
}

function readInstallRecord(config) {
  if (!config || config.installed !== true) return null;
  return {
    version: typeof config.installedVersion === 'string' ? config.installedVersion : '',
    updatedAtMs: isoMs(config.updatedAt),
    origin: publicInstallOrigin({ installSource: config.installSource, installCache: config.installCache }),
  };
}

function originForManagedTree(record, lock, packageVersion) {
  const lockNewer = Boolean(lock && lock.updatedAtMs != null && (record == null || record.updatedAtMs == null || lock.updatedAtMs > record.updatedAtMs));
  if (lock && (record == null || lockNewer)) return { installSource: lock.installSource };
  if (!record) return { installSource: 'copied-tree' };
  if (record.version !== packageVersion) return { installSource: 'stale-copy' };
  if (!record.origin.installSource) return { installSource: 'managed-unrecorded' };
  return record.origin;
}

export async function resolveSkillInstallOrigin({
  scriptPath,
  packageVersion,
  homeDir = os.homedir(),
  env = process.env,
  pathApi = path,
  stat: statFn = stat,
  readFile: readFileFn = readFile,
  processStartMs = Date.now() - process.uptime() * 1000,
} = {}) {
  if (typeof scriptPath !== 'string' || !scriptPath.trim()) return { installSource: 'unknown' };
  const skillRoot = skillRootFromScript(scriptPath, pathApi);
  if (await readPackageName(pathApi.dirname(skillRoot), readFileFn, pathApi) === PACKAGE_NAME) {
    return classifyPackageRoot(pathApi.dirname(skillRoot), { packageVersion, pathApi, stat: statFn, readFile: readFileFn, processStartMs });
  }
  const clawhub = await classifyClawhub(skillRoot, statFn, readFileFn);
  if (clawhub) return { installSource: clawhub };
  const projectLock = await findProjectLock(skillRoot, pathApi, statFn, readFileFn);
  const known = (await Promise.all(knownSkillRoots(homeDir, env, pathApi).map((root) => samePath(skillRoot, root)))).some(Boolean);
  const lock = projectLock || (known ? await readGlobalLock(homeDir, env, pathApi, statFn, readFileFn) : null);
  if (known) {
    const configPath = pathApi.join(agentHomeFrom(homeDir, env, pathApi), PACKAGE_NAME, 'install.json');
    return originForManagedTree(readInstallRecord(await readJsonLimited(configPath, JSON_LIMIT, statFn, readFileFn)), lock, packageVersion);
  }
  if (lock) return { installSource: lock.installSource };
  if (await pathExists(pathApi.join(skillRoot, 'SKILL.md'), statFn)) return { installSource: 'copied-tree' };
  return { installSource: 'unknown' };
}
