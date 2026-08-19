import { TELEMETRY_SCHEMA_VERSION, TELEMETRY_MAX_BYTES, validateTelemetryEnvelope } from '../../job-application-agent/scripts/telemetry-schema.mjs';
import { publicStatsResponse, recordPublicAggregate } from './public-stats.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 24) throw new Error('Signing secret is not configured.');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createToken(installationId, secret, now = new Date(), ttlSeconds = TOKEN_TTL_SECONDS) {
  if (!UUID.test(installationId)) throw new Error('Invalid installation ID.');
  const payload = base64url(encoder.encode(JSON.stringify({ v: 1, installationId, exp: Math.floor(now.getTime() / 1000) + ttlSeconds })));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyToken(token, secret, now = new Date(), { allowExpired = false } = {}) {
  if (typeof token !== 'string' || token.length > 2048) throw new Error('Invalid token.');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new Error('Invalid token.');
  const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), unbase64url(signature), encoder.encode(payload));
  if (!valid) throw new Error('Invalid token.');
  let decoded;
  try { decoded = JSON.parse(decoder.decode(unbase64url(payload))); } catch { throw new Error('Invalid token.'); }
  if (decoded.v !== 1 || !UUID.test(decoded.installationId) || !Number.isInteger(decoded.exp)) throw new Error('Invalid token.');
  if (!allowExpired && decoded.exp <= Math.floor(now.getTime() / 1000)) throw new Error('Token expired.');
  return decoded;
}

function response(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
}

async function readJson(request, maxBytes) {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > maxBytes) throw Object.assign(new Error('Payload too large.'), { status: 413 });
  const text = await request.text();
  if (encoder.encode(text).length > maxBytes) throw Object.assign(new Error('Payload too large.'), { status: 413 });
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

async function allowed(rateLimiter, key) {
  if (!rateLimiter?.limit) return true;
  return (await rateLimiter.limit({ key })).success;
}

async function install(request, env) {
  if (!await allowed(env.INSTALL_RATE_LIMITER, 'anonymous-install')) return response({ error: 'rate_limited' }, 429);
  const input = await readJson(request, 1024);
  const allowedKeys = new Set(['installationId', 'token']);
  for (const key of Object.keys(input)) if (!allowedKeys.has(key)) return response({ error: 'invalid_install_request' }, 400);
  let installationId = crypto.randomUUID();
  if (input.installationId || input.token) {
    if (!input.installationId || !input.token || !UUID.test(input.installationId)) return response({ error: 'invalid_install_request' }, 400);
    let identity;
    try { identity = await verifyToken(input.token, env.SIGNING_SECRET, new Date(), { allowExpired: true }); } catch { return response({ error: 'invalid_token' }, 401); }
    if (identity.installationId !== input.installationId) return response({ error: 'invalid_token' }, 401);
    installationId = identity.installationId;
  }
  const now = new Date();
  const token = await createToken(installationId, env.SIGNING_SECRET, now);
  return response({ installationId, token, expiresAt: new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000).toISOString() }, 201);
}

async function events(request, env) {
  const input = await readJson(request, TELEMETRY_MAX_BYTES);
  let envelope;
  try { envelope = validateTelemetryEnvelope(input); } catch { return response({ error: 'invalid_event' }, 400); }
  let identity;
  try { identity = await verifyToken(envelope.token, env.SIGNING_SECRET); } catch (error) { return response({ error: /expired/i.test(error.message) ? 'token_expired' : 'invalid_token' }, 401); }
  if (identity.installationId !== envelope.installationId) return response({ error: 'invalid_token' }, 401);
  if (!await allowed(env.EVENT_RATE_LIMITER, envelope.installationId)) return response({ error: 'rate_limited' }, 429);

  const eventId = crypto.randomUUID();
  const posthog = {
    api_key: env.POSTHOG_PROJECT_TOKEN,
    event: envelope.event,
    distinct_id: envelope.installationId,
    uuid: eventId,
    timestamp: new Date().toISOString(),
    properties: { ...envelope.properties, schemaVersion: envelope.schemaVersion, skillVersion: envelope.skillVersion, $process_person_profile: false, $geoip_disable: true },
  };
  const fetchFn = env.POSTHOG_FETCH ?? fetch;
  let upstream;
  try {
    upstream = await fetchFn(`${env.POSTHOG_HOST ?? 'https://us.i.posthog.com'}/i/v0/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(posthog) });
  } catch {
    return response({ error: 'upstream_unavailable' }, 503);
  }
  if (!upstream.ok) return response({ error: 'upstream_unavailable' }, 503);
  try { await recordPublicAggregate(env.PUBLIC_STATS_DB, envelope, env.SIGNING_SECRET); } catch { /* Public aggregates are best effort. */ }
  return response({ accepted: true, eventId }, 202);
}

export async function handleRequest(request, env) {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/') return Response.redirect('https://stats.jobappagent.com/', 308);
  if (request.method === 'GET' && pathname === '/healthz') return response({ ok: true, schemaVersion: TELEMETRY_SCHEMA_VERSION });
  if (pathname === '/api/public-stats') return publicStatsResponse(request, env);
  if (request.method === 'POST' && pathname === '/v1/install') return install(request, env);
  if (request.method === 'POST' && pathname === '/v1/events') return events(request, env);
  return response({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    try { return await handleRequest(request, env); }
    catch (error) { return response({ error: error?.status === 413 ? 'payload_too_large' : 'bad_request' }, error?.status ?? 400); }
  },
};
