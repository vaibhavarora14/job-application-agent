// Minimum client version gate for the telemetry relay.
//
// Every client generation (1.1.0 onward) puts its version in the JSON body as `skillVersion`
// (`createTelemetryEnvelope` throws without it), and the community job/source and contact payloads
// carry the same field. The relay reads it from the raw body before schema validation so that an
// outdated payload is refused with an upgrade message instead of a generic `invalid_event`.
//
// Response choice, per client generation (see the PR description for the code archaeology):
// - 1.x .. 3.7.2 have no retry queue. Any non-2xx except 401 marks the relay unavailable for the
//   rest of that command (`session.unavailable = true`), so nothing else is sent until the next
//   command; 401 alone triggers a token refresh and one resend. A 2xx would instead let the client
//   keep sending every event, so a non-401 4xx is the strongest "stop" we can give them.
// - 3.7.11+ quarantine (never retry) any 4xx other than 401/408/425/429 and print the relay error
//   code once; 5xx/429/network errors are retried with backoff.
// - 3.7.3 .. 3.7.10 queue every non-2xx and resend it at the head of the queue on every later
//   command, so for them ONLY a 2xx stops the resend. If the minimum is ever raised into that band,
//   those clients get a 202 whose body says the event was dropped.
// Hence: 426 Upgrade Required (a non-retryable 4xx for every generation that treats status codes
// differently), except 202-and-drop for the 3.7.3 .. 3.7.10 queue band.

export const DEFAULT_MIN_CLIENT_VERSION = '2.0.0';
export const UPGRADE_MESSAGE = 'Please upgrade: npx job-application-agent@latest';
export const UPGRADE_ERROR_CODE = 'client_upgrade_required';

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const STAGING = /(?:^|[.-])staging(?:[.-]|$)/i;
// Clients whose persistent queue resends ANY non-2xx forever (fixed by the 3.7.11 quarantine).
const LEGACY_QUEUE_FIRST = [3, 7, 3];
const LEGACY_QUEUE_FIXED = [3, 7, 11];

export function parseClientVersion(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = VERSION.exec(value);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? null, raw: value };
}

/** Numeric major/minor/patch comparison (never lexical: 3.7.10 > 3.7.9). */
export function compareVersionCores(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** Staging harness versions (`1.1.0-staging`, `3.2.0-staging`) are never real installs. */
export function isStagingVersion(version) {
  return Boolean(version?.prerelease && STAGING.test(version.prerelease));
}

/**
 * MIN_CLIENT_VERSION env var, falling back to the default. A blank or malformed value falls back
 * too (fail safe: a typo must not lock out every client). "0.0.0" disables the gate.
 */
export function minimumClientVersion(env) {
  const configured = typeof env?.MIN_CLIENT_VERSION === 'string' ? env.MIN_CLIENT_VERSION.trim() : '';
  return parseClientVersion(configured) ?? parseClientVersion(DEFAULT_MIN_CLIENT_VERSION);
}

/**
 * Returns a gate decision for a client-reported version:
 * - `{ action: 'allow' }` for current, staging-tagged, missing, or unparseable versions.
 *   Missing/unparseable is left to the existing schema validation (400): every shipped client sends
 *   a valid `skillVersion`, so its absence means a malformed request, not an old client.
 * - `{ action: 'reject', status: 426 }` for outdated clients.
 * - `{ action: 'drop', status: 202 }` for outdated 3.7.3–3.7.10 clients (only a 2xx clears their queue).
 * Prerelease tags other than staging compare by major.minor.patch only.
 */
export function clientVersionDecision(skillVersion, env) {
  const version = parseClientVersion(skillVersion);
  if (!version || isStagingVersion(version)) return { action: 'allow' };
  const minimum = minimumClientVersion(env);
  if (compareVersionCores(version.core, minimum.core) >= 0) return { action: 'allow' };
  const queueBand = compareVersionCores(version.core, LEGACY_QUEUE_FIRST) >= 0 && compareVersionCores(version.core, LEGACY_QUEUE_FIXED) < 0;
  return { action: queueBand ? 'drop' : 'reject', status: queueBand ? 202 : 426, minimum: minimum.raw, clientVersion: version.raw };
}

export function upgradeRequiredBody(decision) {
  const body = { error: UPGRADE_ERROR_CODE, message: UPGRADE_MESSAGE, minimumVersion: decision.minimum, clientVersion: decision.clientVersion };
  return decision.action === 'drop' ? { accepted: false, dropped: true, ...body } : body;
}
