export const REPLACEABLE_FILES = Object.freeze([
  'resume.pdf',
  'resume.json',
  'autonomy.json',
  'postal-address.json',
  'review-policy.json',
  'source-sharing.json',
  'telemetry.json',
]);

export const LEDGER_FILES = Object.freeze([
  'applications.ndjson',
  'attention.ndjson',
  'community-job-contribution-receipts.ndjson',
  'friction.ndjson',
  'outcomes.ndjson',
  'rounds.ndjson',
  'source-contribution-receipts.ndjson',
  'source-suggestions.ndjson',
]);

export const ALLOWED_FILES = Object.freeze([...REPLACEABLE_FILES, ...LEDGER_FILES]);
export const PROFILE_OBJECT_KEY = 'profile';

export const FORBIDDEN_NAME_RE = /password|passwd|cookie|cookies|mfa|totp|secret|credential|ssn|passport|aadhaar|government[-_]?id/i;

export const FORBIDDEN_OBJECT_KEYS = Object.freeze(new Set([
  'password',
  'passwords',
  'passwd',
  'cookie',
  'cookies',
  'mfa',
  'mfaCode',
  'totp',
  'ssn',
  'passport',
  'aadhaar',
  'governmentId',
  'governmentID',
  'nationalId',
  'sessionCookie',
  'browserCookies',
  'credential',
  'credentials',
]));

const REPLACEABLE_SET = new Set(REPLACEABLE_FILES);
const LEDGER_SET = new Set(LEDGER_FILES);
const ALLOWED_SET = new Set(ALLOWED_FILES);

export function isReplaceableFile(name) {
  return REPLACEABLE_SET.has(name);
}

export function isLedgerFile(name) {
  return LEDGER_SET.has(name);
}

export function isAllowedFile(name) {
  return ALLOWED_SET.has(name);
}

export function isAllowedFileName(name) {
  return typeof name === 'string' && ALLOWED_SET.has(name) && !FORBIDDEN_NAME_RE.test(name);
}

export function fileContentType(name) {
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.ndjson')) return 'application/x-ndjson';
  return 'application/octet-stream';
}

export const contentTypeFor = fileContentType;

export function normalizeLedgerName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (FORBIDDEN_NAME_RE.test(name)) return null;
  if (LEDGER_SET.has(name)) return name;
  const withExt = `${name}.ndjson`;
  if (LEDGER_SET.has(withExt)) return withExt;
  return null;
}

export function isAllowedLedgerName(name) {
  return Boolean(normalizeLedgerName(name));
}

export function ledgerFileName(name) {
  return normalizeLedgerName(name);
}

export function normalizeEtag(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value.trim().replaceAll('"', '');
}

export async function sha256Hex(bytes) {
  const data = bytes instanceof Uint8Array
    ? bytes
    : typeof bytes === 'string'
      ? new TextEncoder().encode(bytes)
      : new Uint8Array(bytes);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function walkForbidden(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = walkForbidden(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) return key;
    const hit = walkForbidden(value[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function forbiddenKeysIn(value) {
  return walkForbidden(value);
}

export function forbiddenFieldReason(value) {
  return walkForbidden(value);
}

export function scanStoredContent(name, text) {
  if (name.endsWith('.pdf')) return null;
  if (name.endsWith('.ndjson')) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return 'invalid json';
      }
      const reason = forbiddenFieldReason(parsed);
      if (reason) return reason;
    }
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'invalid json';
  }
  return forbiddenFieldReason(parsed);
}
