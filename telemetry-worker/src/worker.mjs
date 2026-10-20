import { TELEMETRY_SCHEMA_VERSION, TELEMETRY_MAX_BYTES, validateTelemetryEnvelope } from '../../job-application-agent/scripts/telemetry-schema.mjs';
import { isTelemetryPiiKey, redactHomePaths } from '../../job-application-agent/scripts/telemetry-redact.mjs';
import {
  communityJobId,
  communitySourceId,
  validateCommunityJobContributionEnvelope,
  validateSourceContributionEnvelope,
} from '../../job-application-agent/scripts/source-community-schema.mjs';
import {
  publicStatsResponse,
  recordPublicAggregate,
  refreshActiveInstallations30d,
} from './public-stats.mjs';
import {
  CRON_LIVENESS_BATCH_SIZE,
  DEFAULT_LIVENESS_BATCH_SIZE,
  runJobLivenessSweep,
} from './job-liveness.mjs';

const LIVE_JOBS_CACHE_SECONDS = 5 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_MAX_BYTES = 4096;
const ADMIN_MAX_BYTES = 2048;

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function jobCursor(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('Invalid job cursor.');
  let decoded;
  try { decoded = JSON.parse(decoder.decode(unbase64url(value))); } catch { throw new Error('Invalid job cursor.'); }
  if (!decoded || Array.isArray(decoded) || typeof decoded !== 'object' || Object.keys(decoded).sort().join(',') !== 'jobId,lastSeenAt,v') throw new Error('Invalid job cursor.');
  if (decoded.v !== 1 || !/^community-job-[0-9a-f]{16}$/.test(decoded.jobId) || typeof decoded.lastSeenAt !== 'string' || Number.isNaN(Date.parse(decoded.lastSeenAt))) throw new Error('Invalid job cursor.');
  return { jobId: decoded.jobId, lastSeenAt: decoded.lastSeenAt };
}

function encodeJobCursor(job) {
  return base64url(encoder.encode(JSON.stringify({ v: 1, lastSeenAt: job.lastSeenAt, jobId: job.jobId })));
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

function response(body, status = 200, cacheControl = 'no-store') {
  return Response.json(body, { status, headers: { 'cache-control': cacheControl, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
}

/** Constant-time string compare for Bearer admin auth (Workers have no node:crypto). */
function timingSafeEqualString(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Admin auth reuses the worker SIGNING_SECRET as a Bearer token (same secret used
 * for install HMAC). Distinct from install tokens — callers pass the raw secret.
 */
function checkAdminAuth(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const expected = env.SIGNING_SECRET ?? '';
  if (!match[1] || typeof expected !== 'string' || expected.length < 24) return false;
  return timingSafeEqualString(match[1], expected);
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

// Clients up to 3.7.2 attached `identity: { name, email }` to analytics envelopes. Those fields are
// stripped (never forwarded) rather than rejected: such clients keep no retry queue, so a 400 would
// silently drop their anonymous analytics too, while stripping keeps the event and removes the PII.
// Current clients never send these keys; anything else unknown is still rejected by the schema.
export function stripLegacyIdentity(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') return input;
  const { identity: _identity, ...rest } = input;
  for (const key of Object.keys(rest)) if (isTelemetryPiiKey(key)) delete rest[key];
  if (rest.properties && typeof rest.properties === 'object' && !Array.isArray(rest.properties)) {
    rest.properties = Object.fromEntries(Object.entries(rest.properties).filter(([key]) => !isTelemetryPiiKey(key)));
  }
  return rest;
}

// Defense in depth for every forwarded string (notably skill_error.sanitizedMessage): home-directory
// paths carry the OS username and become `~` even if an older client did not redact them.
export function redactForwardedProperties(properties) {
  const out = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (isTelemetryPiiKey(key)) continue;
    if (typeof value === 'string') out[key] = redactHomePaths(value);
    else if (Array.isArray(value)) out[key] = value.map((item) => (typeof item === 'string' ? redactHomePaths(item) : item));
    else out[key] = value;
  }
  return out;
}

async function events(request, env) {
  const input = await readJson(request, TELEMETRY_MAX_BYTES);
  let envelope;
  try { envelope = validateTelemetryEnvelope(stripLegacyIdentity(input)); } catch { return response({ error: 'invalid_event' }, 400); }
  envelope = { ...envelope, properties: redactForwardedProperties(envelope.properties) };
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
    properties: {
      ...envelope.properties,
      // candidateName/candidateEmail intentionally never forwarded (privacy as of 3.7.3+); identity envelopes rejected.
      schemaVersion: envelope.schemaVersion, skillVersion: envelope.skillVersion, $process_person_profile: false, $geoip_disable: true,
    },
  };
  const fetchFn = env.POSTHOG_FETCH ?? fetch;
  let upstream;
  try {
    upstream = await fetchFn(`${env.POSTHOG_HOST ?? 'https://us.i.posthog.com'}/i/v0/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(posthog) });
  } catch {
    return response({ error: 'upstream_unavailable' }, 503);
  }
  if (!upstream.ok) return response({ error: 'upstream_unavailable' }, 503);
  try {
    await recordPublicAggregate(env.PUBLIC_STATS_DB, { event: envelope.event, properties: envelope.properties, installationId: envelope.installationId }, env.SIGNING_SECRET);
  } catch { /* Public aggregates are best effort. */ }
  return response({ accepted: true, eventId }, 202);
}

const CONTACT_MAX_BYTES = 2048;
const CONTACT_NAME_MAX = 160;
const CONTACT_EMAIL_MAX = 254;
const CONTACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function normalizeContactField(value, label, max) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw Object.assign(new Error(`Invalid ${label}.`), { status: 400 });
  }
  return value.trim();
}

async function upsertInstallContact(database, row) {
  if (!database?.prepare) throw Object.assign(new Error('Private contacts store unavailable.'), { status: 503 });
  await database.prepare(`
    INSERT INTO install_contacts (install_id, candidate_name, candidate_email, skill_version, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(install_id) DO UPDATE SET
      candidate_name = excluded.candidate_name,
      candidate_email = excluded.candidate_email,
      skill_version = excluded.skill_version,
      updated_at = excluded.updated_at
  `).bind(row.installId, row.candidateName, row.candidateEmail, row.skillVersion, row.updatedAt, row.createdAt).run();
}

async function contact(request, env) {
  const input = await readJson(request, CONTACT_MAX_BYTES);
  const allowedKeys = new Set(['installId', 'installationId', 'token', 'candidateName', 'candidateEmail', 'skillVersion', 'updatedAt']);
  for (const key of Object.keys(input)) if (!allowedKeys.has(key)) return response({ error: 'invalid_contact' }, 400);

  const installId = input.installId ?? input.installationId;
  if (!UUID.test(String(installId ?? ''))) return response({ error: 'invalid_contact' }, 400);
  if (typeof input.token !== 'string' || input.token.length < 8) return response({ error: 'invalid_token' }, 401);

  let identity;
  try { identity = await verifyToken(input.token, env.SIGNING_SECRET); } catch (error) {
    return response({ error: /expired/i.test(error.message) ? 'token_expired' : 'invalid_token' }, 401);
  }
  if (identity.installationId !== installId) return response({ error: 'invalid_token' }, 401);
  if (!await allowed(env.CONTACT_RATE_LIMITER, installId)) return response({ error: 'rate_limited' }, 429);

  let candidateName;
  let candidateEmail;
  try {
    candidateName = normalizeContactField(input.candidateName, 'candidateName', CONTACT_NAME_MAX);
    candidateEmail = normalizeContactField(input.candidateEmail, 'candidateEmail', CONTACT_EMAIL_MAX);
  } catch (error) {
    return response({ error: 'invalid_contact' }, error.status ?? 400);
  }
  if (!candidateName && !candidateEmail) return response({ error: 'invalid_contact' }, 400);
  if (candidateEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail)) return response({ error: 'invalid_contact' }, 400);
  if (typeof input.skillVersion !== 'string' || !CONTACT_VERSION.test(input.skillVersion)) return response({ error: 'invalid_contact' }, 400);

  const updatedAt = typeof input.updatedAt === 'string' && !Number.isNaN(Date.parse(input.updatedAt))
    ? new Date(input.updatedAt).toISOString()
    : new Date().toISOString();
  const createdAt = updatedAt;

  try {
    await upsertInstallContact(env.PRIVATE_CONTACTS_DB, {
      installId,
      candidateName,
      candidateEmail,
      skillVersion: input.skillVersion,
      updatedAt,
      createdAt,
    });
  } catch (error) {
    if (error.status === 503) return response({ error: 'store_unavailable' }, 503);
    return response({ error: 'store_unavailable' }, 503);
  }
  return response({ accepted: true, installId }, 202);
}

function sourceStore(env) {
  if (env.SOURCE_STORE) return env.SOURCE_STORE;
  const database = env.PUBLIC_STATS_DB;
  if (!database?.prepare) throw Object.assign(new Error('Source store unavailable.'), { status: 503 });
  return {
    async contribute(source, contributorHash) {
      await database.batch([
        database.prepare(`
        INSERT INTO community_sources (
          source_id, name, base_url, kind, regions_json, role_families_json,
          requires_session, publication_status, review_status,
          created_at, updated_at, first_contributed_at, last_contributed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'unreviewed', ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          last_contributed_at = excluded.last_contributed_at
      `).bind(
          source.sourceId,
          source.name,
          source.baseUrl,
          source.kind,
          JSON.stringify(source.regions),
          JSON.stringify(source.roleFamilies),
          source.requiresSession ? 1 : 0,
          source.seenAt,
          source.seenAt,
          source.seenAt,
          source.seenAt,
        ),
        database.prepare(`
          INSERT INTO community_source_contributions (
            source_id, contributor_hash, first_contributed_at, last_contributed_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(source_id, contributor_hash) DO UPDATE SET
            last_contributed_at = excluded.last_contributed_at
        `).bind(source.sourceId, contributorHash, source.seenAt, source.seenAt),
      ]);
      const state = await database.prepare(`
        SELECT publication_status,
               (SELECT COUNT(*) FROM community_source_contributions WHERE source_id = ?) AS unique_contributors
        FROM community_sources
        WHERE source_id = ?
      `).bind(source.sourceId, source.sourceId).first();
      return { publicationStatus: state.publication_status, uniqueContributors: Number(state.unique_contributors) };
    },
    async listPublished() {
      const result = await database.prepare(`
        SELECT sources.source_id, sources.name, sources.base_url, sources.kind,
               sources.regions_json, sources.role_families_json, sources.requires_session,
               sources.review_status, COUNT(contributions.contributor_hash) AS contribution_count
        FROM community_sources AS sources
        JOIN community_source_contributions AS contributions ON contributions.source_id = sources.source_id
        WHERE sources.publication_status = 'published'
          AND sources.review_status = 'maintainer-reviewed'
        GROUP BY sources.source_id
        ORDER BY contribution_count DESC, sources.last_contributed_at DESC
        LIMIT 500
      `).all();
      return (result.results ?? []).map((row) => ({
        sourceId: row.source_id,
        name: row.name,
        baseUrl: row.base_url,
        kind: row.kind,
        regions: JSON.parse(row.regions_json),
        roleFamilies: JSON.parse(row.role_families_json),
        requiresSession: row.requires_session === 1,
        registryStatus: 'community-reviewed',
        contributionCount: Number(row.contribution_count),
      }));
    },
  };
}

function mapLegacyJob(row) {
  return {
    jobId: row.job_id,
    url: row.canonical_url,
    company: row.company,
    role: row.role,
    applicationChannel: row.application_channel,
    ...(row.discovery_source == null ? {} : { discoverySource: row.discovery_source }),
    providerUrl: row.provider_url,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    contributionCount: Number(row.contribution_count),
  };
}

function mapLiveJob(row) {
  return {
    ...mapLegacyJob(row),
    livenessStatus: row.liveness_status ?? 'unknown',
    lastCheckedAt: row.last_checked_at ?? null,
    closedAt: row.closed_at ?? null,
  };
}

function jobStore(env) {
  if (env.JOB_STORE) return env.JOB_STORE;
  const database = env.PUBLIC_STATS_DB;
  if (!database?.prepare) throw Object.assign(new Error('Job store unavailable.'), { status: 503 });
  return {
    async contribute(job, contributorHash) {
      await database.batch([
        database.prepare(`
          INSERT INTO community_jobs (
            job_id, canonical_url, company, role, application_channel, discovery_source,
            provider_url, first_seen_at, last_seen_at, first_skill_version, last_skill_version,
            contribution_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(job_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            last_skill_version = excluded.last_skill_version
        `).bind(job.jobId, job.url, job.company, job.role, job.applicationChannel, job.discoverySource ?? null,
          job.providerUrl, job.firstSeenAt, job.lastSeenAt, job.skillVersion, job.skillVersion),
        database.prepare(`
          INSERT INTO community_job_contributions (
            job_id, contributor_hash, first_seen_at, last_seen_at, skill_version
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(job_id, contributor_hash) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            skill_version = excluded.skill_version
        `).bind(job.jobId, contributorHash, job.firstSeenAt, job.lastSeenAt, job.skillVersion),
        database.prepare(`
          UPDATE community_jobs
          SET contribution_count = (
            SELECT COUNT(*) FROM community_job_contributions WHERE job_id = ?
          )
          WHERE job_id = ?
        `).bind(job.jobId, job.jobId),
      ]);
      const state = await database.prepare(`
        SELECT publication_status, contribution_count
        FROM community_jobs
        WHERE job_id = ?
      `).bind(job.jobId).first();
      return { publicationStatus: state.publication_status, contributionCount: Number(state.contribution_count) };
    },
    async list({ limit, cursor }) {
      const result = await database.prepare(`
        SELECT jobs.job_id, jobs.canonical_url, jobs.company, jobs.role, jobs.application_channel,
               jobs.discovery_source, jobs.provider_url, jobs.first_seen_at, jobs.last_seen_at,
               jobs.contribution_count
        FROM community_jobs AS jobs
        WHERE jobs.publication_status = 'published'
          AND jobs.review_status = 'maintainer-reviewed'
          AND (? IS NULL OR jobs.last_seen_at < ? OR (jobs.last_seen_at = ? AND jobs.job_id < ?))
        ORDER BY jobs.last_seen_at DESC, jobs.job_id DESC
        LIMIT ?
      `).bind(cursor?.lastSeenAt ?? null, cursor?.lastSeenAt ?? null, cursor?.lastSeenAt ?? null, cursor?.jobId ?? null, limit + 1).all();
      const jobs = (result.results ?? []).map((row) => mapLegacyJob(row));
      return { jobs: jobs.slice(0, limit), hasMore: jobs.length > limit };
    },
    async listLive({ limit, cursor, status = null }) {
      const result = await database.prepare(`
        SELECT jobs.job_id, jobs.canonical_url, jobs.company, jobs.role, jobs.application_channel,
               jobs.discovery_source, jobs.provider_url, jobs.first_seen_at, jobs.last_seen_at,
               jobs.liveness_status,
               jobs.last_checked_at, jobs.closed_at,
               jobs.contribution_count
        FROM community_jobs AS jobs
        WHERE jobs.publication_status = 'published'
          AND jobs.review_status = 'maintainer-reviewed'
          AND (? IS NULL OR jobs.liveness_status = ?)
          AND (? IS NULL OR jobs.last_seen_at < ? OR (jobs.last_seen_at = ? AND jobs.job_id < ?))
        ORDER BY jobs.last_seen_at DESC, jobs.job_id DESC
        LIMIT ?
      `).bind(
        status,
        status,
        cursor?.lastSeenAt ?? null,
        cursor?.lastSeenAt ?? null,
        cursor?.lastSeenAt ?? null,
        cursor?.jobId ?? null,
        limit + 1,
      ).all();
      const jobs = (result.results ?? []).map((row) => mapLiveJob(row));
      return { jobs: jobs.slice(0, limit), hasMore: jobs.length > limit };
    },
    /** Oldest-checked (nulls first via ASC) published jobs for a bounded liveness batch. */
    async listDueForLivenessCheck({ limit }) {
      const result = await database.prepare(`
        SELECT jobs.job_id, jobs.canonical_url, jobs.company, jobs.role, jobs.application_channel,
               jobs.discovery_source, jobs.provider_url, jobs.first_seen_at, jobs.last_seen_at,
               jobs.liveness_status,
               jobs.last_checked_at, jobs.closed_at,
               jobs.contribution_count
        FROM community_jobs AS jobs
        WHERE jobs.publication_status = 'published'
          AND jobs.review_status = 'maintainer-reviewed'
        ORDER BY jobs.last_checked_at ASC, jobs.job_id ASC
        LIMIT ?
      `).bind(limit + 1).all();
      const jobs = (result.results ?? []).map((row) => mapLiveJob(row));
      return { jobs: jobs.slice(0, limit), hasMore: jobs.length > limit };
    },
    async newestLastCheckedAt() {
      const row = await database.prepare(`
        SELECT newest_last_checked_at AS newest
        FROM public_liveness_meta
        WHERE id = 1
      `).first();
      return row?.newest ?? null;
    },
    async updateLiveness(jobId, { status, checkedAt, closedAt }) {
      await database.batch([
        database.prepare(`
          UPDATE community_jobs
          SET liveness_status = ?,
              last_checked_at = ?,
              closed_at = ?
          WHERE job_id = ?
        `).bind(status, checkedAt, closedAt, jobId),
        database.prepare(`
          INSERT INTO public_liveness_meta (id, newest_last_checked_at)
          VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET
            newest_last_checked_at = CASE
              WHEN public_liveness_meta.newest_last_checked_at IS NULL
                OR excluded.newest_last_checked_at > public_liveness_meta.newest_last_checked_at
              THEN excluded.newest_last_checked_at
              ELSE public_liveness_meta.newest_last_checked_at
            END
        `).bind(checkedAt),
      ]);
    },
    async updateLivenessBatch(patches) {
      if (!Array.isArray(patches) || patches.length === 0) return;
      const statements = patches.map((patch) => database.prepare(`
        UPDATE community_jobs
        SET liveness_status = ?,
            last_checked_at = ?,
            closed_at = ?
        WHERE job_id = ?
      `).bind(patch.status, patch.checkedAt, patch.closedAt, patch.jobId));
      let newest = null;
      for (const patch of patches) {
        if (patch.checkedAt && (!newest || patch.checkedAt > newest)) newest = patch.checkedAt;
      }
      if (newest) {
        statements.push(database.prepare(`
          INSERT INTO public_liveness_meta (id, newest_last_checked_at)
          VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET
            newest_last_checked_at = CASE
              WHEN public_liveness_meta.newest_last_checked_at IS NULL
                OR excluded.newest_last_checked_at > public_liveness_meta.newest_last_checked_at
              THEN excluded.newest_last_checked_at
              ELSE public_liveness_meta.newest_last_checked_at
            END
        `).bind(newest));
      }
      await database.batch(statements);
    },
  };
}

async function sourceContributorHash(sourceId, installationId, secret) {
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(`${sourceId}\0${installationId}`));
  return [...new Uint8Array(signature)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function publicReadKey(request, secret, scope) {
  const address = (request.headers.get('cf-connecting-ip') ?? 'unknown').slice(0, 128);
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(`${scope}\0${address}`));
  const digest = [...new Uint8Array(signature)].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${scope}:${digest}`;
}

async function contributeSource(request, env) {
  const input = await readJson(request, SOURCE_MAX_BYTES);
  let envelope;
  try { envelope = validateSourceContributionEnvelope(input); } catch { return response({ error: 'invalid_source' }, 400); }
  let identity;
  try { identity = await verifyToken(envelope.token, env.SIGNING_SECRET); } catch (error) { return response({ error: /expired/i.test(error.message) ? 'token_expired' : 'invalid_token' }, 401); }
  if (identity.installationId !== envelope.installationId) return response({ error: 'invalid_token' }, 401);
  if (!await allowed(env.SOURCE_RATE_LIMITER, 'source-write')) return response({ error: 'rate_limited' }, 429);
  if (!await allowed(env.SOURCE_RATE_LIMITER, envelope.installationId)) return response({ error: 'rate_limited' }, 429);

  const sourceId = await communitySourceId(envelope.source);
  const contributorHash = await sourceContributorHash(sourceId, envelope.installationId, env.SIGNING_SECRET);
  const state = await sourceStore(env).contribute({ sourceId, ...envelope.source, seenAt: new Date().toISOString() }, contributorHash);
  return response({ accepted: true, sourceId, ...state }, 202);
}

async function listSources(_request, env) {
  if (!await allowed(env.SOURCE_READ_RATE_LIMITER, 'registry')) return response({ error: 'rate_limited' }, 429);
  const sources = await sourceStore(env).listPublished();
  return response({ version: 1, sources }, 200, 'no-store');
}

async function contributeJob(request, env) {
  const input = await readJson(request, SOURCE_MAX_BYTES);
  let envelope;
  try { envelope = validateCommunityJobContributionEnvelope(input); } catch { return response({ error: 'invalid_job' }, 400); }
  let identity;
  try { identity = await verifyToken(envelope.token, env.SIGNING_SECRET); } catch (error) { return response({ error: /expired/i.test(error.message) ? 'token_expired' : 'invalid_token' }, 401); }
  if (identity.installationId !== envelope.installationId) return response({ error: 'invalid_token' }, 401);
  if (!await allowed(env.SOURCE_RATE_LIMITER, 'job-write')) return response({ error: 'rate_limited' }, 429);
  if (!await allowed(env.SOURCE_RATE_LIMITER, envelope.installationId)) return response({ error: 'rate_limited' }, 429);
  const jobId = await communityJobId(envelope.job);
  const contributorHash = await sourceContributorHash(jobId, envelope.installationId, env.SIGNING_SECRET);
  const seenAt = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const state = await jobStore(env).contribute({ jobId, ...envelope.job, firstSeenAt: seenAt, lastSeenAt: seenAt, skillVersion: envelope.skillVersion }, contributorHash);
  return response({ accepted: true, jobId, ...state }, 202);
}

const LIVE_STATUSES = new Set(['open', 'closed', 'unknown']);

async function parseJobListQuery(request) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) if (!['limit', 'cursor'].includes(key)) throw Object.assign(new Error('invalid_job_query'), { status: 400 });
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit == null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('invalid_job_query'), { status: 400 });
  let cursor;
  try { cursor = jobCursor(url.searchParams.get('cursor')); } catch { throw Object.assign(new Error('invalid_job_query'), { status: 400 }); }
  return { limit, cursor };
}

async function parseLiveJobListQuery(request) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (!['limit', 'cursor', 'status'].includes(key)) throw Object.assign(new Error('invalid_job_query'), { status: 400 });
  }
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit == null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('invalid_job_query'), { status: 400 });
  let cursor;
  try { cursor = jobCursor(url.searchParams.get('cursor')); } catch { throw Object.assign(new Error('invalid_job_query'), { status: 400 }); }
  const rawStatus = url.searchParams.get('status');
  let status = null;
  if (rawStatus != null) {
    if (!LIVE_STATUSES.has(rawStatus)) throw Object.assign(new Error('invalid_job_query'), { status: 400 });
    status = rawStatus;
  }
  return { limit, cursor, status };
}

async function listJobs(request, env) {
  if (!await allowed(env.SOURCE_READ_RATE_LIMITER, await publicReadKey(request, env.SIGNING_SECRET, 'jobs'))) return response({ error: 'rate_limited' }, 429);
  let query;
  try { query = await parseJobListQuery(request); } catch { return response({ error: 'invalid_job_query' }, 400); }
  const result = await jobStore(env).list(query);
  return response({ version: 1, jobs: result.jobs, nextCursor: result.hasMore ? encodeJobCursor(result.jobs.at(-1)) : null }, 200, 'no-store');
}

async function listLiveJobs(request, env) {
  if (!await allowed(env.SOURCE_READ_RATE_LIMITER, await publicReadKey(request, env.SIGNING_SECRET, 'jobs-live'))) return response({ error: 'rate_limited' }, 429);
  let query;
  try { query = await parseLiveJobListQuery(request); } catch { return response({ error: 'invalid_job_query' }, 400); }

  const cache = globalThis.caches?.default;
  const cacheKey = new Request(request.url, { method: 'GET' });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const store = jobStore(env);
  const result = await store.listLive(query);
  const newestLastCheckedAt = store.newestLastCheckedAt
    ? await store.newestLastCheckedAt()
    : result.jobs.reduce((newest, job) => {
      if (!job.lastCheckedAt) return newest;
      return !newest || job.lastCheckedAt > newest ? job.lastCheckedAt : newest;
    }, null);
  const body = {
    version: 1,
    jobs: result.jobs,
    nextCursor: result.hasMore ? encodeJobCursor(result.jobs.at(-1)) : null,
    meta: { newestLastCheckedAt },
  };
  const resultResponse = response(
    body,
    200,
    `public, max-age=60, s-maxage=${LIVE_JOBS_CACHE_SECONDS}, stale-while-revalidate=900`,
  );
  if (cache) await cache.put(cacheKey, resultResponse.clone());
  return resultResponse;
}

async function adminLivenessSweep(request, env) {
  if (!checkAdminAuth(request, env)) return response({ error: 'unauthorized' }, 401);
  let limit = DEFAULT_LIVENESS_BATCH_SIZE;
  if (request.method === 'POST') {
    let body = {};
    try { body = await readJson(request, ADMIN_MAX_BYTES); } catch (error) {
      return response({ error: error?.status === 413 ? 'payload_too_large' : 'invalid_json' }, error?.status ?? 400);
    }
    if (body && typeof body === 'object' && !Array.isArray(body) && body.limit != null) {
      const parsed = Number(body.limit);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) return response({ error: 'invalid_limit' }, 400);
      limit = parsed;
    }
  }
  const summary = await runJobLivenessSweep(env, {
    store: env.JOB_STORE ?? jobStore(env),
    fetchImpl: env.LIVENESS_FETCH ?? fetch,
    limit,
  });
  return response({ ok: true, ...summary }, 200);
}

export function shouldRefreshActiveInstallations(scheduledTime) {
  if (scheduledTime == null) return true;
  const minutes = new Date(scheduledTime).getUTCMinutes();
  return !Number.isFinite(minutes) || minutes % 15 === 0;
}

export async function handleRequest(request, env) {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/') return Response.redirect('https://stats.jobappagent.com/', 308);
  if (request.method === 'GET' && pathname === '/healthz') return response({ ok: true, schemaVersion: TELEMETRY_SCHEMA_VERSION });
  if (pathname === '/api/public-stats') return publicStatsResponse(request, env);
  if (request.method === 'POST' && pathname === '/v1/install') return install(request, env);
  if (request.method === 'POST' && pathname === '/v1/events') return events(request, env);
  if (request.method === 'POST' && pathname === '/v1/contact') return contact(request, env);
  // Intentionally no GET /v1/contact — private contacts are owner-only via D1.
  if (request.method === 'POST' && pathname === '/v1/sources') return contributeSource(request, env);
  if (request.method === 'GET' && pathname === '/v1/sources') return listSources(request, env);
  if (request.method === 'POST' && pathname === '/v1/jobs') return contributeJob(request, env);
  if (request.method === 'GET' && pathname === '/v1/jobs/live') return listLiveJobs(request, env);
  if (request.method === 'GET' && pathname === '/v1/jobs') return listJobs(request, env);
  if ((request.method === 'POST' || request.method === 'GET') && pathname === '/v1/admin/jobs/liveness-sweep') {
    return adminLivenessSweep(request, env);
  }
  return response({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    try { return await handleRequest(request, env); }
    catch (error) { return response({ error: error?.status === 413 ? 'payload_too_large' : 'bad_request' }, error?.status ?? 400); }
  },
  async scheduled(controller, env) {
    await runJobLivenessSweep(env, {
      store: env.JOB_STORE ?? jobStore(env),
      fetchImpl: env.LIVENESS_FETCH ?? fetch,
      limit: CRON_LIVENESS_BATCH_SIZE,
    });
    // The cron fires every 5 minutes for small liveness batches; keep the
    // 30-day active-installations refresh on its previous 15-minute cadence.
    if (env.PUBLIC_STATS_DB?.prepare && shouldRefreshActiveInstallations(controller?.scheduledTime)) {
      await refreshActiveInstallations30d(env.PUBLIC_STATS_DB);
    }
  },
};
