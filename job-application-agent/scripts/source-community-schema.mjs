const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_ID = /^community-[0-9a-f]{16}$/;
export const SOURCE_KINDS = new Set(['direct-employer', 'professional-network', 'social-feed', 'startup-network', 'community-thread', 'job-board', 'curated-board', 'inbound', 'user-supplied']);

function record(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object.`);
  return value;
}

function boundedString(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string no longer than ${max} characters.`);
  return value.trim();
}

function containsIdentityLike(value) {
  return /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d\s().-]{7,}/i.test(value);
}

function terms(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) throw new Error(`${label} must be a non-empty array with at most 12 values.`);
  const normalized = value.map((item, index) => boundedString(item, `${label}[${index}]`, 40).toLowerCase());
  if (normalized.some((item) => containsIdentityLike(item) || /https?:\/\//i.test(item))) throw new Error(`${label} must not contain identity-like content.`);
  return [...new Set(normalized)].sort();
}

function looksPersonal(url) {
  return (/(^|\.)linkedin\.com$/i.test(url.hostname) && /^\/in\//i.test(url.pathname))
    || (/(^|\.)github\.com$/i.test(url.hostname) && /^\/[^/]+\/?$/i.test(url.pathname))
    || (/(^|\.)x\.com$/i.test(url.hostname) && /^\/(?!home(?:\/|$)|jobs(?:\/|$)|search(?:\/|$)|i\/)[^/]+(?:\/|$)/i.test(url.pathname));
}

function looksIdentityPath(pathname) {
  const segments = pathname.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
  const namespaces = new Set(['user', 'users', 'profile', 'profiles', 'member', 'members', 'author', 'authors', 'person', 'people']);
  return segments.some((segment, index) => namespaces.has(segment) && index < segments.length - 1);
}

function decodedPathname(pathname) {
  let current = pathname;
  for (let pass = 0; pass < 5; pass += 1) {
    let decoded;
    try { decoded = decodeURIComponent(current); } catch { throw new Error('community source.baseUrl path encoding is invalid.'); }
    if (decoded === current) return decoded;
    current = decoded;
  }
  throw new Error('community source.baseUrl path encoding is too deeply nested.');
}

function looksCredentialLikePath(pathname) {
  return pathname.split('/').filter(Boolean).some((segment) => {
    const opaque = segment.replace(/=+$/, '');
    if (!/^[A-Za-z0-9_-]{20,}$/.test(opaque)) return false;
    return (/[a-z]/.test(opaque) && /[A-Z]/.test(opaque)) || /\d/.test(opaque) || /[-_]/.test(opaque);
  });
}

function isPublicHostname(hostname) {
  const value = hostname.toLowerCase();
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') || value.endsWith('.internal')) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.startsWith('[')) return false;
  return value.includes('.');
}

function hostnameMatches(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function isRepeatableCommunitySourceRoute(url) {
  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
  if (segments.length === 0) return true;

  const path = `/${segments.join('/')}`;
  const last = segments.at(-1) ?? '';
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
  if (uuid.test(path) || /^\d{4,}(?:[-_].*)?$/.test(last) || segments.some((segment) => /^(apply|application)$/.test(segment))) return false;

  if (hostnameMatches(hostname, 'myworkdayjobs.com') && segments.some((segment, index) => segment === 'job' && index < segments.length - 1)) return false;
  if (hostnameMatches(hostname, 'linkedin.com') && segments[0] === 'jobs' && segments[1] === 'view') return false;
  if (hostnameMatches(hostname, 'greenhouse.io') && segments.some((segment, index) => segment === 'jobs' && index < segments.length - 1)) return false;
  if (hostname === 'jobs.lever.co' && segments.length >= 2) return false;
  if (hostname === 'jobs.ashbyhq.com' && segments.length >= 2) return false;
  if (hostname === 'apply.workable.com' && segments.some((segment, index) => segment === 'j' && index < segments.length - 1)) return false;
  if (hostname === 'jobs.smartrecruiters.com' && segments.length >= 2) return false;
  if (segments.some((segment, index) => segment === 'job' && index < segments.length - 1)) return false;

  if (hostnameMatches(hostname, 'myworkdayjobs.com')) return segments.includes('jobs') || ['external', 'internal', 'careers'].includes(last);
  if (hostnameMatches(hostname, 'linkedin.com')) return segments[0] === 'jobs' && (segments.length === 1 || ['search', 'collections'].includes(segments[1]));
  if (hostnameMatches(hostname, 'greenhouse.io')) return segments.length === 1 || last === 'jobs';
  if (hostname === 'jobs.lever.co' || hostname === 'jobs.ashbyhq.com' || hostname === 'jobs.smartrecruiters.com') return segments.length === 1;
  if (hostname === 'apply.workable.com') return segments.length === 1 || last === 'jobs';

  if (/\.(?:rss|atom|xml|json)$/i.test(last)) return /(?:feed|jobs?|openings|careers)/i.test(path);
  const collectionCues = new Set(['careers', 'openings', 'positions', 'vacancies', 'opportunities', 'jobs', 'job-search', 'job-listings', 'job-index', 'directory', 'feed', 'rss', 'atom', 'open-roles', 'available-jobs']);
  const collectionQualifiers = new Set(['search', 'list', 'index', 'directory', 'feed', 'openings', 'engineering', 'product', 'design', 'sales', 'marketing', 'operations', 'finance', 'legal', 'people', 'remote']);
  return segments.some((segment, index) => collectionCues.has(segment)
    && (index === segments.length - 1 || (index === segments.length - 2 && collectionQualifiers.has(segments[index + 1]))));
}

export function normalizeCommunitySource(input) {
  const value = record(input, 'community source');
  const allowed = new Set(['name', 'baseUrl', 'kind', 'regions', 'roleFamilies', 'requiresSession']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown community source property: ${key}.`);
  const name = boundedString(value.name, 'community source.name', 120);
  if (containsIdentityLike(name) || /https?:\/\//i.test(name)) throw new Error('community source.name must not contain identity-like content.');
  const url = new URL(boundedString(value.baseUrl, 'community source.baseUrl', 1000));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('community source.baseUrl must be a public HTTPS URL.');
  url.hostname = url.hostname.replace(/\.+$/, '');
  if (!isPublicHostname(url.hostname)) throw new Error('community source.baseUrl must use a public internet hostname.');
  if (containsIdentityLike(url.hostname)) throw new Error('community source.baseUrl must not contain identity-like content.');
  const decodedPath = decodedPathname(url.pathname);
  if (containsIdentityLike(decodedPath)) throw new Error('community source.baseUrl must not contain identity-like content.');
  if (looksIdentityPath(decodedPath)) throw new Error('community source.baseUrl must not contain an identity-like path.');
  url.pathname = decodedPath;
  if (looksPersonal(url)) throw new Error('community source.baseUrl must not be a profile or personal URL.');
  if (!isRepeatableCommunitySourceRoute(url)) throw new Error('community source.baseUrl must identify a repeatable discovery surface, not a one-off job.');
  if (looksCredentialLikePath(decodedPath)) throw new Error('community source.baseUrl must not contain credential-like path segments.');
  url.search = '';
  url.hash = '';
  const kind = boundedString(value.kind, 'community source.kind', 40).toLowerCase();
  if (!SOURCE_KINDS.has(kind)) throw new Error('community source.kind is invalid.');
  if (typeof value.requiresSession !== 'boolean') throw new Error('community source.requiresSession must be a Boolean.');
  return {
    name,
    baseUrl: url.toString().replace(/\/$/, ''),
    kind,
    regions: terms(value.regions, 'community source.regions'),
    roleFamilies: terms(value.roleFamilies, 'community source.roleFamilies'),
    requiresSession: value.requiresSession,
  };
}

export function createSourceContributionEnvelope({ installationId, token, source, skillVersion }) {
  return validateSourceContributionEnvelope({ schemaVersion: 1, skillVersion, installationId, token, source });
}

export function validateSourceContributionEnvelope(input) {
  const value = record(input, 'source contribution');
  const allowed = new Set(['schemaVersion', 'skillVersion', 'installationId', 'token', 'source']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown source contribution property: ${key}.`);
  if (value.schemaVersion !== 1) throw new Error('Unsupported source contribution schema version.');
  const installationId = boundedString(value.installationId, 'source contribution.installationId', 36);
  if (!UUID.test(installationId)) throw new Error('source contribution.installationId is invalid.');
  return {
    schemaVersion: 1,
    skillVersion: boundedString(value.skillVersion, 'source contribution.skillVersion', 40),
    installationId,
    token: boundedString(value.token, 'source contribution.token', 2048),
    source: normalizeCommunitySource(value.source),
  };
}

export async function communitySourceId(source) {
  const normalized = normalizeCommunitySource(source);
  const bytes = new TextEncoder().encode(normalized.baseUrl);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `community-${[...digest].map((value) => value.toString(16).padStart(2, '0')).join('').slice(0, 16)}`;
}

export function validateCommunitySourceList(input) {
  const value = record(input, 'community source list');
  for (const key of Object.keys(value)) if (!['version', 'sources'].includes(key)) throw new Error(`Unknown community source list property: ${key}.`);
  if (value.version !== 1 || !Array.isArray(value.sources) || value.sources.length > 500) throw new Error('Invalid community source list.');
  return value.sources.map((entry) => {
    const source = record(entry, 'community source entry');
    const allowed = new Set(['sourceId', 'name', 'baseUrl', 'kind', 'regions', 'roleFamilies', 'requiresSession', 'registryStatus', 'contributionCount']);
    for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`Unknown community source entry property: ${key}.`);
    if (!SOURCE_ID.test(source.sourceId)) throw new Error('community source entry.sourceId is invalid.');
    if (source.registryStatus !== 'community-reviewed') throw new Error('community source entry.registryStatus is invalid.');
    if (!Number.isSafeInteger(source.contributionCount) || source.contributionCount < 1 || source.contributionCount > 1_000_000_000) throw new Error('community source entry.contributionCount is invalid.');
    const normalized = normalizeCommunitySource(Object.fromEntries(['name', 'baseUrl', 'kind', 'regions', 'roleFamilies', 'requiresSession'].map((key) => [key, source[key]])));
    return { sourceId: source.sourceId, ...normalized, registryStatus: source.registryStatus, contributionCount: source.contributionCount };
  });
}
