import { createHash, timingSafeEqual } from "node:crypto";
import { createBackup } from "./backup.mjs";

export const ALLOWLIST = new Set([
  "resume.pdf",
  "resume.json",
  "applications.ndjson",
  "outcomes.ndjson",
  "attention.ndjson",
  "rounds.ndjson",
  "friction.ndjson",
  "community-job-contribution-receipts.ndjson",
  "source-contribution-receipts.ndjson",
  "source-suggestions.ndjson",
  "autonomy.json",
  "review-policy.json",
  "postal-address.json",
  "source-sharing.json",
  "telemetry.json",
]);

export const LEDGER_SUFFIX = ".ndjson";

const REJECTED_BODY_PATTERNS = [
  /password/i,
  /cookie/i,
  /\bmfa\b/i,
  /\bssn\b/i,
  /passport/i,
  /aadhaar/i,
  /governmentId/i,
];
const REJECTED_OBJECT_KEY = /^(passwords?|passwd|cookies?|mfa(code)?|totp|ssn|passport|aadhaar|government_?id|national_?id|session_?cookie|browser_?cookies?|credentials?)$/i;

const NO_STORE = { "cache-control": "no-store" };
const PRIVATE_STREAMS = new Set([
  "applications", "outcomes", "rounds", "discovery", "attention", "reviews", "friction",
  "approved-answers", "profile-corrections", "preferences-corrections",
  "connectivity-tests",
]);
const PRIVATE_DOCUMENTS = new Set(["profile", "preferences", "autonomy", "review-policy", "postal-address"]);
const PRIVATE_FILES = new Set(["resume.pdf", "resume.json"]);
const MAX_JSON_BYTES = 256 * 1024;
const LEASE_TTL_MS = 15 * 60 * 1000;

export function fileKey(name) {
  return `files/${name}`;
}

export function profileKey() {
  return "profile.json";
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function normalizeEtag(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.replace(/^"|"$/g, "");
}

export function isAllowlistedFile(name) {
  return ALLOWLIST.has(name);
}

export function isLedgerFile(name) {
  return name.endsWith(LEDGER_SUFFIX) && ALLOWLIST.has(name);
}

export function checkAuth(request, env) {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const token = match[1];
  const expected = env.STATE_TOKEN ?? "";
  if (!token || !expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "");
  return match?.[1] ?? null;
}

export async function authenticateV2(request, env) {
  const token = bearerToken(request);
  if (!token || !env.DB) return null;
  const client = await env.DB.prepare(
    "SELECT client_id, name, created_at FROM clients WHERE token_hash = ? AND revoked_at IS NULL",
  ).bind(sha256Hex(token)).first();
  if (!client) return null;
  await env.DB.prepare("UPDATE clients SET last_seen_at = ? WHERE client_id = ?")
    .bind(new Date().toISOString(), client.client_id).run();
  return { id: client.client_id, name: client.name, createdAt: client.created_at };
}

function checkAdminAuth(request, env) {
  const token = bearerToken(request);
  const expected = env.STATE_ADMIN_TOKEN ?? "";
  if (!token || !expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bodyContainsRejectedContent(text) {
  for (const pattern of REJECTED_BODY_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

export async function readBodyText(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await request.json();
    return JSON.stringify(json);
  }
  const buf = await request.arrayBuffer();
  return new TextDecoder().decode(buf);
}

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...NO_STORE,
      ...extraHeaders,
    },
  });
}

export function errorResponse(message, status, extraHeaders = {}) {
  return jsonResponse({ error: message }, status, extraHeaders);
}

export function unauthorized() {
  return errorResponse("unauthorized", 401);
}

export function notFound(message = "not found") {
  return errorResponse(message, 404);
}

export function badRequest(message) {
  return errorResponse(message, 400);
}

export function preconditionFailed(message = "precondition failed") {
  return errorResponse(message, 412);
}

function conflict(message = "conflict") {
  return errorResponse(message, 409);
}

function gone(message) {
  return errorResponse(message, 410);
}

async function jsonBody(request, maxBytes = MAX_JSON_BYTES) {
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error("payload too large");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    if (containsForbiddenObjectKey(value)) throw new Error("body contains rejected content");
    return value;
  } catch (error) {
    if (/rejected|large|expected/.test(error.message)) throw error;
    throw new Error("invalid json");
  }
}

function containsForbiddenObjectKey(value, depth = 0) {
  if (depth > 8 || value == null) return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenObjectKey(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => REJECTED_OBJECT_KEY.test(key) || containsForbiddenObjectKey(item, depth + 1));
}

function validIso(value, fallback = new Date().toISOString()) {
  const candidate = value ?? fallback;
  if (typeof candidate !== "string" || Number.isNaN(Date.parse(candidate))) throw new Error("occurredAt must be an ISO date");
  return candidate;
}

function revisionHeader(request) {
  const raw = normalizeEtag(request.headers.get("If-Match"));
  if (raw == null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

async function documentGet(env, name) {
  if (!PRIVATE_DOCUMENTS.has(name)) return notFound("document not allowlisted");
  const row = await env.DB.prepare("SELECT revision, payload_json, sha256, updated_at FROM documents WHERE name = ?").bind(name).first();
  if (!row) return notFound("document not found");
  return jsonResponse({ name, revision: row.revision, sha256: row.sha256, updatedAt: row.updated_at, value: JSON.parse(row.payload_json) }, 200, { etag: String(row.revision) });
}

async function documentPut(request, env, client, name) {
  if (!PRIVATE_DOCUMENTS.has(name)) return notFound("document not allowlisted");
  let body;
  try { body = await jsonBody(request); } catch (error) { return badRequest(error.message); }
  if (!("value" in body) || !body.value || typeof body.value !== "object" || Array.isArray(body.value)) return badRequest("value must be a JSON object");
  const expected = revisionHeader(request);
  if (expected == null) return conflict("If-Match revision required");
  const current = await env.DB.prepare("SELECT revision FROM documents WHERE name = ?").bind(name).first();
  const currentRevision = current?.revision ?? 0;
  if (expected !== currentRevision) return conflict("revision mismatch");
  const payload = JSON.stringify(body.value);
  const now = new Date().toISOString();
  const revision = currentRevision + 1;
  const hash = sha256Hex(payload);
  if (current) {
    const result = await env.DB.prepare("UPDATE documents SET revision = ?, payload_json = ?, sha256 = ?, updated_at = ?, updated_by = ? WHERE name = ? AND revision = ?")
      .bind(revision, payload, hash, now, client.id, name, currentRevision).run();
    if (!result.meta?.changes) return conflict("revision changed during update");
  } else {
    try {
      await env.DB.prepare("INSERT INTO documents (name, revision, payload_json, sha256, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(name, revision, payload, hash, now, client.id).run();
    } catch { return conflict("document was created concurrently"); }
  }
  return jsonResponse({ name, revision, sha256: hash, updatedAt: now }, current ? 200 : 201, { etag: String(revision) });
}

async function streamList(url, env, stream) {
  if (!PRIVATE_STREAMS.has(stream)) return notFound("stream not allowlisted");
  const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? 500) || 500));
  const rows = await env.DB.prepare(
    "SELECT r.sequence, r.record_key, r.idempotency_key, r.payload_json, r.occurred_at, r.received_at, r.client_id, r.provenance FROM records r LEFT JOIN record_corrections c ON c.record_sequence = r.sequence WHERE r.stream = ? AND r.sequence > ? AND c.record_sequence IS NULL ORDER BY r.sequence ASC LIMIT ?",
  ).bind(stream, after, limit).all();
  const records = rows.results.map((row) => ({ sequence: row.sequence, recordKey: row.record_key, idempotencyKey: row.idempotency_key, value: JSON.parse(row.payload_json), occurredAt: row.occurred_at, receivedAt: row.received_at, clientId: row.client_id, provenance: row.provenance }));
  return jsonResponse({ stream, records, nextCursor: records.at(-1)?.sequence ?? after });
}

async function streamAppend(request, env, client, stream) {
  if (!PRIVATE_STREAMS.has(stream)) return notFound("stream not allowlisted");
  let body;
  try { body = await jsonBody(request); } catch (error) { return badRequest(error.message); }
  const recordKey = typeof body.recordKey === "string" && body.recordKey.length <= 300 ? body.recordKey : null;
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length <= 300 ? body.idempotencyKey : null;
  if (!recordKey || !idempotencyKey || !("value" in body)) return badRequest("recordKey, idempotencyKey, and value are required");
  const payload = JSON.stringify(body.value);
  if (bodyContainsRejectedContent(payload)) return badRequest("body contains rejected content");
  let occurredAt;
  try { occurredAt = validIso(body.occurredAt); } catch (error) { return badRequest(error.message); }
  const receivedAt = new Date().toISOString();
  const provenance = typeof body.provenance === "string" ? body.provenance.slice(0, 80) : "live";
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO records (stream, record_key, idempotency_key, payload_json, occurred_at, received_at, client_id, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(stream, recordKey, idempotencyKey, payload, occurredAt, receivedAt, client.id, provenance).run();
  const row = await env.DB.prepare("SELECT sequence, record_key, payload_json, occurred_at, received_at, client_id, provenance FROM records WHERE stream = ? AND idempotency_key = ?")
    .bind(stream, idempotencyKey).first();
  return jsonResponse({ stream, sequence: row.sequence, recordKey: row.record_key, duplicate: !result.meta?.changes, value: JSON.parse(row.payload_json), occurredAt: row.occurred_at, receivedAt: row.received_at, clientId: row.client_id, provenance: row.provenance }, result.meta?.changes ? 201 : 200);
}

async function streamBatchAppend(request, env, client, stream) {
  if (!PRIVATE_STREAMS.has(stream)) return notFound("stream not allowlisted");
  let body;
  try { body = await jsonBody(request, 2 * 1024 * 1024); } catch (error) { return badRequest(error.message); }
  if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 100) return badRequest("records must contain 1 to 100 items");
  const receivedAt = new Date().toISOString();
  const statements = [];
  try {
    for (const item of body.records) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("each record must be an object");
      const recordKey = typeof item.recordKey === "string" && item.recordKey.length <= 300 ? item.recordKey : null;
      const idempotencyKey = typeof item.idempotencyKey === "string" && item.idempotencyKey.length <= 300 ? item.idempotencyKey : null;
      if (!recordKey || !idempotencyKey || !("value" in item)) throw new Error("each record requires recordKey, idempotencyKey, and value");
      if (containsForbiddenObjectKey(item.value)) throw new Error("body contains rejected content");
      const occurredAt = validIso(item.occurredAt);
      const provenance = typeof item.provenance === "string" ? item.provenance.slice(0, 80) : "live";
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO records (stream, record_key, idempotency_key, payload_json, occurred_at, received_at, client_id, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(stream, recordKey, idempotencyKey, JSON.stringify(item.value), occurredAt, receivedAt, client.id, provenance));
    }
  } catch (error) { return badRequest(error.message); }
  const results = await env.DB.batch(statements);
  const inserted = results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0);
  return jsonResponse({ stream, attempted: statements.length, inserted, duplicates: statements.length - inserted }, inserted ? 201 : 200);
}

async function leaseAction(request, env, client) {
  let body;
  try { body = await jsonBody(request); } catch (error) { return badRequest(error.message); }
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
  const current = await env.DB.prepare("SELECT lease_id, holder_client_id, acquired_at, renewed_at, expires_at FROM leases WHERE name = 'application-run'").first();
  if (body.action === "acquire") {
    if (current && Date.parse(current.expires_at) > now.getTime() && current.holder_client_id !== client.id) return conflict("application run is held by another client");
    const leaseId = current?.holder_client_id === client.id && Date.parse(current.expires_at) > now.getTime() ? current.lease_id : crypto.randomUUID();
    await env.DB.prepare("INSERT INTO leases (name, lease_id, holder_client_id, acquired_at, renewed_at, expires_at) VALUES ('application-run', ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET lease_id = excluded.lease_id, holder_client_id = excluded.holder_client_id, acquired_at = excluded.acquired_at, renewed_at = excluded.renewed_at, expires_at = excluded.expires_at WHERE leases.expires_at <= ? OR leases.holder_client_id = ?")
      .bind(leaseId, client.id, nowIso, nowIso, expiresAt, nowIso, client.id).run();
    const stored = await env.DB.prepare("SELECT lease_id, holder_client_id, acquired_at, renewed_at, expires_at FROM leases WHERE name = 'application-run'").first();
    if (stored.holder_client_id !== client.id) return conflict("application run is held by another client");
    return jsonResponse({ leaseId: stored.lease_id, holderClientId: stored.holder_client_id, acquiredAt: stored.acquired_at, renewedAt: stored.renewed_at, expiresAt: stored.expires_at }, current ? 200 : 201);
  }
  if (body.action === "renew") {
    if (!current || current.holder_client_id !== client.id || current.lease_id !== body.leaseId || Date.parse(current.expires_at) <= now.getTime()) return conflict("lease is missing, expired, or owned by another client");
    await env.DB.prepare("UPDATE leases SET renewed_at = ?, expires_at = ? WHERE name = 'application-run' AND lease_id = ? AND holder_client_id = ?")
      .bind(nowIso, expiresAt, body.leaseId, client.id).run();
    return jsonResponse({ leaseId: body.leaseId, holderClientId: client.id, acquiredAt: current.acquired_at, renewedAt: nowIso, expiresAt });
  }
  if (body.action === "release") {
    if (!current || current.holder_client_id !== client.id || current.lease_id !== body.leaseId) return conflict("lease is missing or owned by another client");
    await env.DB.prepare("DELETE FROM leases WHERE name = 'application-run' AND lease_id = ? AND holder_client_id = ?").bind(body.leaseId, client.id).run();
    return jsonResponse({ released: true });
  }
  return badRequest("action must be acquire, renew, or release");
}

async function privateFileGet(env, name) {
  if (!PRIVATE_FILES.has(name)) return notFound("file not allowlisted");
  const meta = await env.DB.prepare("SELECT revision, sha256, size, updated_at FROM files WHERE name = ?").bind(name).first();
  if (!meta) return notFound("file not found");
  const bucket = stateBucket(env);
  if (!bucket) return errorResponse("private blob storage is unavailable", 503);
  const object = await bucket.get(`private/${name}`);
  if (!object) return errorResponse("file metadata exists but object is unavailable", 503);
  const bytes = await object.arrayBuffer();
  return new Response(bytes, { status: 200, headers: { ...NO_STORE, etag: String(meta.revision), "x-sha256": meta.sha256, "content-type": name.endsWith(".pdf") ? "application/pdf" : "application/json" } });
}

async function privateFilePut(request, env, client, name) {
  if (!PRIVATE_FILES.has(name)) return notFound("file not allowlisted");
  const bytes = Buffer.from(await request.arrayBuffer());
  if (name === "resume.pdf" && !bytes.subarray(0, 4).equals(Buffer.from("%PDF"))) return badRequest("resume.pdf must contain a PDF");
  if (name !== "resume.pdf" && bodyContainsRejectedContent(bytes.toString("utf8"))) return badRequest("body contains rejected content");
  const hash = sha256Hex(bytes);
  if (request.headers.get("x-content-sha256") !== hash) return badRequest("checksum mismatch");
  const expected = revisionHeader(request);
  if (expected == null) return conflict("If-Match revision required");
  const current = await env.DB.prepare("SELECT revision FROM files WHERE name = ?").bind(name).first();
  const currentRevision = current?.revision ?? 0;
  if (expected !== currentRevision) return conflict("revision mismatch");
  const revision = currentRevision + 1;
  const now = new Date().toISOString();
  const bucket = stateBucket(env);
  if (!bucket) return errorResponse("private blob storage is unavailable", 503);
  await bucket.put(`private/${name}`, bytes, { customMetadata: { sha256: hash } });
  if (current) {
    const result = await env.DB.prepare("UPDATE files SET revision = ?, sha256 = ?, size = ?, updated_at = ?, updated_by = ? WHERE name = ? AND revision = ?")
      .bind(revision, hash, bytes.length, now, client.id, name, currentRevision).run();
    if (!result.meta?.changes) return conflict("revision changed during update");
  } else {
    try { await env.DB.prepare("INSERT INTO files (name, revision, sha256, size, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)").bind(name, revision, hash, bytes.length, now, client.id).run(); }
    catch { return conflict("file was created concurrently"); }
  }
  return jsonResponse({ name, revision, sha256: hash, size: bytes.length, updatedAt: now }, current ? 200 : 201, { etag: String(revision) });
}

async function createIntent(request, env, client) {
  let body;
  try { body = await jsonBody(request); } catch (error) { return badRequest(error.message); }
  for (const key of ["applicationId", "canonicalUrl", "leaseId"]) if (typeof body[key] !== "string" || !body[key]) return badRequest(`${key} is required`);
  const lease = await env.DB.prepare("SELECT lease_id, holder_client_id, expires_at FROM leases WHERE name = 'application-run'").first();
  if (!lease || lease.lease_id !== body.leaseId || lease.holder_client_id !== client.id || Date.parse(lease.expires_at) <= Date.now()) return conflict("active application lease required");
  const duplicate = await env.DB.prepare("SELECT r.sequence FROM records r LEFT JOIN record_corrections c ON c.record_sequence = r.sequence WHERE r.stream = 'applications' AND r.record_key = ? AND c.record_sequence IS NULL LIMIT 1").bind(body.applicationId).first();
  if (duplicate) return conflict("application already recorded");
  const open = await env.DB.prepare("SELECT intent_id, status FROM application_intents WHERE application_id = ? AND status IN ('prepared', 'sent-unverified') LIMIT 1").bind(body.applicationId).first();
  if (open) return conflict(`application already has ${open.status} intent`);
  const intentId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO application_intents (intent_id, application_id, round_id, canonical_url, status, payload_json, client_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?)")
    .bind(intentId, body.applicationId, body.roundId ?? null, body.canonicalUrl, JSON.stringify(body.value ?? {}), client.id, now, now).run();
  return jsonResponse({ intentId, applicationId: body.applicationId, status: "prepared", createdAt: now }, 201);
}

async function updateIntent(request, env, client, intentId, action) {
  let body;
  try { body = await jsonBody(request); } catch (error) { return badRequest(error.message); }
  const intent = await env.DB.prepare("SELECT * FROM application_intents WHERE intent_id = ?").bind(intentId).first();
  if (!intent || intent.client_id !== client.id) return notFound("intent not found");
  const lease = await env.DB.prepare("SELECT lease_id, holder_client_id, expires_at FROM leases WHERE name = 'application-run'").first();
  if (!lease || lease.lease_id !== body.leaseId || lease.holder_client_id !== client.id || Date.parse(lease.expires_at) <= Date.now()) return conflict("active application lease required");
  const now = new Date().toISOString();
  if (action === "sent-unverified") {
    if (intent.status !== "prepared") return conflict("only prepared intent may be marked sent-unverified");
    await env.DB.prepare("UPDATE application_intents SET status = 'sent-unverified', updated_at = ? WHERE intent_id = ?").bind(now, intentId).run();
    return jsonResponse({ intentId, status: "sent-unverified", requiresVerification: true });
  }
  if (action === "confirm") {
    if (!["prepared", "sent-unverified"].includes(intent.status)) return conflict("intent is not confirmable");
    if (!body.application || typeof body.application !== "object") return badRequest("application is required");
    const appPayload = JSON.stringify(body.application);
    const appKey = body.application.id ?? intent.application_id;
    const idem = body.idempotencyKey ?? `intent:${intentId}:application`;
    const occurredAt = validIso(body.application.submittedAt, now);
    const statements = [
      env.DB.prepare("INSERT OR IGNORE INTO records (stream, record_key, idempotency_key, payload_json, occurred_at, received_at, client_id, provenance) VALUES ('applications', ?, ?, ?, ?, ?, ?, 'live')").bind(appKey, idem, appPayload, occurredAt, now, client.id),
      env.DB.prepare("UPDATE application_intents SET status = 'confirmed', updated_at = ? WHERE intent_id = ? AND status IN ('prepared', 'sent-unverified')").bind(now, intentId),
    ];
    if (intent.round_id) {
      const roundValue = { type: "submission-confirmed", roundId: intent.round_id, applicationId: appKey, occurredAt };
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO records (stream, record_key, idempotency_key, payload_json, occurred_at, received_at, client_id, provenance) VALUES ('rounds', ?, ?, ?, ?, ?, ?, 'live')")
        .bind(intent.round_id, `intent:${intentId}:round`, JSON.stringify(roundValue), occurredAt, now, client.id));
    }
    await env.DB.batch(statements);
    return jsonResponse({ intentId, status: "confirmed", applicationId: appKey });
  }
  return badRequest("unknown intent action");
}

async function v2Status(env, client) {
  const revisions = await env.DB.prepare("SELECT name, revision, updated_at FROM documents ORDER BY name").all();
  const files = await env.DB.prepare("SELECT name, revision, sha256, updated_at FROM files ORDER BY name").all();
  const lease = await env.DB.prepare("SELECT holder_client_id, lease_id, renewed_at, expires_at FROM leases WHERE name = 'application-run'").first();
  const counts = await env.DB.prepare("SELECT r.stream, COUNT(*) AS rows, COUNT(DISTINCT r.record_key) AS unique_records, MAX(r.sequence) AS latest_revision FROM records r LEFT JOIN record_corrections c ON c.record_sequence = r.sequence WHERE c.record_sequence IS NULL GROUP BY r.stream ORDER BY r.stream").all();
  const blobBackend = env.STATE ? "r2" : env.STATE_KV ? "kv" : "unavailable";
  return jsonResponse({ backend: `cloudflare-d1-${blobBackend}`, apiVersion: 2, client, documents: revisions.results, files: files.results, streams: counts.results, lease: lease && Date.parse(lease.expires_at) > Date.now() ? { holderClientId: lease.holder_client_id, renewedAt: lease.renewed_at, expiresAt: lease.expires_at, heldByThisClient: lease.holder_client_id === client.id } : null });
}

async function adminClient(request, env, clientId, action) {
  if (!checkAdminAuth(request, env)) return unauthorized();
  if (action === "create") {
    let body;
    try { body = await jsonBody(request); } catch (error) { return badRequest(error.message); }
    if (typeof body.name !== "string" || typeof body.token !== "string" || body.token.length < 32) return badRequest("name and a token of at least 32 characters are required");
    const id = clientId || crypto.randomUUID();
    const now = new Date().toISOString();
    try { await env.DB.prepare("INSERT INTO clients (client_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").bind(id, body.name, sha256Hex(body.token), now).run(); }
    catch { return conflict("client id, name, or token already exists"); }
    return jsonResponse({ client: { id, name: body.name, createdAt: now } }, 201);
  }
  if (action === "revoke") {
    const now = new Date().toISOString();
    const result = await env.DB.prepare("UPDATE clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL").bind(now, clientId).run();
    if (!result.meta?.changes) return notFound("active client not found");
    return jsonResponse({ clientId, revokedAt: now });
  }
  return notFound();
}

async function adminCorrectRecords(request, env) {
  if (!checkAdminAuth(request, env)) return unauthorized();
  let body;
  try { body = await jsonBody(request); } catch (error) { return badRequest(error.message); }
  if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 100) return badRequest("records must contain 1 to 100 corrections");
  const now = new Date().toISOString();
  const statements = [];
  for (const item of body.records) {
    const sequence = Number(item?.sequence);
    const reason = item?.reason;
    if (!Number.isSafeInteger(sequence) || sequence < 1) return badRequest("each correction requires a positive integer sequence");
    if (!["test-fixture", "migration-error", "operator-correction"].includes(reason)) return badRequest("invalid correction reason");
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO record_corrections (correction_id, record_sequence, reason, created_at, created_by) SELECT ?, sequence, ?, ?, 'system' FROM records WHERE sequence = ?")
      .bind(`correction-${sequence}`, reason, now, sequence));
  }
  const results = await env.DB.batch(statements);
  const inserted = results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0);
  return jsonResponse({ attempted: statements.length, inserted, duplicates: statements.length - inserted }, inserted ? 201 : 200);
}

export async function headObject(bucket, key) {
  return bucket.head(key);
}

export async function getObject(bucket, key) {
  return bucket.get(key);
}

export async function putObject(bucket, key, body, customMetadata = {}) {
  return bucket.put(key, body, { customMetadata });
}

function kvBucket(namespace) {
  return {
    async head(key) {
      const entry = await namespace.getWithMetadata(key, 'arrayBuffer');
      if (!entry?.value) return null;
      return {
        etag: entry.metadata?.etag ?? entry.metadata?.sha256 ?? null,
        size: entry.value.byteLength,
        uploaded: entry.metadata?.updatedAt ?? null,
        customMetadata: entry.metadata ?? {},
      };
    },
    async get(key) {
      const entry = await namespace.getWithMetadata(key, 'arrayBuffer');
      if (!entry?.value) return null;
      const bytes = entry.value;
      return {
        etag: entry.metadata?.etag ?? entry.metadata?.sha256 ?? null,
        customMetadata: entry.metadata ?? {},
        async arrayBuffer() { return bytes; },
        async text() { return new TextDecoder().decode(bytes); },
      };
    },
    async put(key, body, options = {}) {
      const bytes = body instanceof Uint8Array ? body : typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
      const metadata = { ...(options.customMetadata ?? {}), updatedAt: new Date().toISOString() };
      metadata.etag = metadata.sha256 ?? sha256Hex(bytes);
      await namespace.put(key, bytes, { metadata });
      return { etag: metadata.etag };
    },
    async delete(key) { return namespace.delete(key); },
  };
}

function stateBucket(env) {
  if (env.STATE) return env.STATE;
  if (env.STATE_KV) return kvBucket(env.STATE_KV);
  return null;
}

export function metadataFromHead(head) {
  if (!head) return null;
  const sha256 = head.customMetadata?.sha256 ?? null;
  const updatedAt = head.uploaded?.toISOString?.() ?? head.uploaded ?? null;
  return {
    etag: head.etag,
    sha256,
    size: head.size,
    updatedAt,
  };
}

export async function buildManifest(bucket) {
  const entries = [];
  for (const name of ALLOWLIST) {
    const key = fileKey(name);
    const head = await headObject(bucket, key);
    if (!head) continue;
    const meta = metadataFromHead(head);
    entries.push({
      name,
      sha256: meta.sha256,
      etag: meta.etag,
      size: meta.size,
      updatedAt: meta.updatedAt,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

export async function handleGetFile(bucket, name) {
  if (!isAllowlistedFile(name)) return notFound("file not allowlisted");
  const obj = await getObject(bucket, fileKey(name));
  if (!obj) return notFound("file not found");
  const headers = {
    ...NO_STORE,
    etag: obj.etag,
  };
  if (obj.customMetadata?.sha256) {
    headers["x-sha256"] = obj.customMetadata.sha256;
  }
  const bytes = await obj.arrayBuffer();
  return new Response(bytes, { status: 200, headers });
}

export async function handlePutFile(bucket, name, request) {
  if (!isAllowlistedFile(name)) return notFound("file not allowlisted");

  const rawBuf = Buffer.from(await request.arrayBuffer());
  const bodyText = rawBuf.toString("utf8");
  if (bodyContainsRejectedContent(bodyText)) {
    return badRequest("body contains rejected content");
  }

  const key = fileKey(name);
  const existing = await headObject(bucket, key);
  const ifMatch = request.headers.get("If-Match");

  if (existing) {
    if (!ifMatch) {
      return preconditionFailed("If-Match required when object exists");
    }
    if (normalizeEtag(ifMatch) !== normalizeEtag(existing.etag)) {
      return preconditionFailed("etag mismatch");
    }
  }

  const hash = sha256Hex(rawBuf);
  const stored = await putObject(bucket, key, rawBuf, { sha256: hash });
  return jsonResponse(
    {
      name,
      sha256: hash,
      etag: stored?.etag ?? existing?.etag,
      size: rawBuf.length,
    },
    existing ? 200 : 201,
  );
}

export async function handlePostLedger(bucket, name, request) {
  if (!isLedgerFile(name)) {
    return badRequest("not a ledger file");
  }

  const contentType = request.headers.get("content-type") ?? "";
  let lines = [];

  if (contentType.includes("application/json")) {
    const bodyText = await readBodyText(request);
    if (bodyContainsRejectedContent(bodyText)) {
      return badRequest("body contains rejected content");
    }
    const parsed = JSON.parse(bodyText);
    if (!Array.isArray(parsed.lines)) {
      return badRequest("expected { lines: string[] }");
    }
    lines = parsed.lines.map((line) =>
      typeof line === "string" ? line : JSON.stringify(line),
    );
  } else {
    const raw = await readBodyText(request);
    if (bodyContainsRejectedContent(raw)) {
      return badRequest("body contains rejected content");
    }
    lines = raw.split("\n").filter((line) => line.length > 0);
  }

  const key = fileKey(name);
  const existing = await getObject(bucket, key);
  let prefix = "";
  if (existing) {
    const prev = await existing.text();
    if (prev.length > 0 && !prev.endsWith("\n")) {
      prefix = prev + "\n";
    } else {
      prefix = prev;
    }
  }

  const appendText = lines.length > 0 ? lines.join("\n") + "\n" : "";
  const combined = prefix + appendText;
  const hash = sha256Hex(Buffer.from(combined));
  const stored = await putObject(bucket, key, combined, { sha256: hash });

  return jsonResponse({
    name,
    sha256: hash,
    etag: stored?.etag,
    size: combined.length,
    appended: lines.length,
  });
}

export async function handleGetProfile(bucket) {
  const obj = await getObject(bucket, profileKey());
  if (!obj) return notFound("profile not found");
  const text = await obj.text();
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      etag: obj.etag,
      ...NO_STORE,
    },
  });
}

export async function handlePutProfile(bucket, request) {
  const bodyText = await readBodyText(request);
  if (bodyContainsRejectedContent(bodyText)) {
    return badRequest("body contains rejected content");
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return badRequest("invalid json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return badRequest("profile must be a json object");
  }

  const key = profileKey();
  const existing = await headObject(bucket, key);
  const ifMatch = request.headers.get("If-Match");

  if (existing) {
    if (!ifMatch) {
      return preconditionFailed("If-Match required when object exists");
    }
    if (normalizeEtag(ifMatch) !== normalizeEtag(existing.etag)) {
      return preconditionFailed("etag mismatch");
    }
  }

  const normalized = JSON.stringify(parsed);
  const hash = sha256Hex(Buffer.from(normalized));
  const stored = await putObject(bucket, key, normalized, { sha256: hash });

  return jsonResponse(
    { sha256: hash, etag: stored?.etag, size: normalized.length },
    existing ? 200 : 201,
  );
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  // This endpoint intentionally reveals only process liveness. Keeping it
  // public lets deploy checks distinguish an unavailable Worker from an
  // authentication problem without exposing storage or client metadata.
  if (method === "GET" && pathname === "/healthz") {
    return jsonResponse({ ok: true });
  }

  if (pathname.startsWith("/v2/admin/")) {
    if (pathname === "/v2/admin/record-corrections" && method === "POST") return adminCorrectRecords(request, env);
    const createMatch = pathname.match(/^\/v2\/admin\/clients(?:\/([^/]+))?$/);
    if (createMatch && method === "POST" && !createMatch[1]) return adminClient(request, env, null, "create");
    if (createMatch && method === "DELETE" && createMatch[1]) return adminClient(request, env, decodeURIComponent(createMatch[1]), "revoke");
    return notFound();
  }

  if (pathname.startsWith("/v2/")) {
    const client = await authenticateV2(request, env);
    if (!client) return unauthorized();
    if (method === "GET" && pathname === "/v2/status") return v2Status(env, client);

    const documentMatch = pathname.match(/^\/v2\/documents\/([^/]+)$/);
    if (documentMatch) {
      const name = decodeURIComponent(documentMatch[1]);
      if (method === "GET") return documentGet(env, name);
      if (method === "PUT") return documentPut(request, env, client, name);
    }

    const streamBatchMatch = pathname.match(/^\/v2\/streams\/([^/]+)\/batch$/);
    if (streamBatchMatch && method === "POST") return streamBatchAppend(request, env, client, decodeURIComponent(streamBatchMatch[1]));
    const streamMatch = pathname.match(/^\/v2\/streams\/([^/]+)$/);
    if (streamMatch) {
      const stream = decodeURIComponent(streamMatch[1]);
      if (method === "GET") return streamList(url, env, stream);
      if (method === "POST") return streamAppend(request, env, client, stream);
    }

    const privateFileMatch = pathname.match(/^\/v2\/files\/([^/]+)$/);
    if (privateFileMatch) {
      const name = decodeURIComponent(privateFileMatch[1]);
      if (method === "GET") return privateFileGet(env, name);
      if (method === "PUT") return privateFilePut(request, env, client, name);
    }

    if (pathname === "/v2/leases/application-run" && method === "POST") return leaseAction(request, env, client);
    if (pathname === "/v2/intents" && method === "POST") return createIntent(request, env, client);
    const intentMatch = pathname.match(/^\/v2\/intents\/([^/]+)\/(sent-unverified|confirm)$/);
    if (intentMatch && method === "POST") return updateIntent(request, env, client, decodeURIComponent(intentMatch[1]), intentMatch[2]);
    return notFound();
  }

  if (!checkAuth(request, env)) return unauthorized();

  if (method === "GET" && pathname === "/v1/manifest") {
    const manifest = await buildManifest(stateBucket(env));
    return jsonResponse(manifest);
  }

  const fileMatch = pathname.match(/^\/v1\/files\/([^/]+)$/);
  if (fileMatch) {
    const name = decodeURIComponent(fileMatch[1]);
    if (method === "GET") return handleGetFile(stateBucket(env), name);
    if (method === "PUT") return env.LEGACY_WRITES_DISABLED === "1" ? gone("legacy replacement writes are disabled") : handlePutFile(stateBucket(env), name, request);
  }

  const ledgerMatch = pathname.match(/^\/v1\/ledgers\/([^/]+)$/);
  if (ledgerMatch && method === "POST") {
    const name = decodeURIComponent(ledgerMatch[1]);
    return env.LEGACY_WRITES_DISABLED === "1" ? gone("legacy ledger writes are disabled") : handlePostLedger(stateBucket(env), name, request);
  }

  if (pathname === "/v1/profile") {
    if (method === "GET") return handleGetProfile(stateBucket(env));
    if (method === "PUT") return env.LEGACY_WRITES_DISABLED === "1" ? gone("legacy profile writes are disabled") : handlePutProfile(stateBucket(env), request);
  }

  return notFound();
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(_controller, env) {
    const bucket = stateBucket(env);
    if (!env.DB || !bucket) return;
    const generatedAt = new Date().toISOString();
    const bytes = Buffer.from(JSON.stringify(await createBackup(env.DB, generatedAt)));
    const date = generatedAt.slice(0, 10);
    const objectKey = `backups/${date}.json`;
    const hash = sha256Hex(bytes);
    await bucket.put(objectKey, bytes, { customMetadata: { sha256: hash, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
    await env.DB.prepare("INSERT OR REPLACE INTO exports (export_id, object_key, sha256, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, 'system')")
      .bind(`daily-${date}`, objectKey, hash, generatedAt, new Date(Date.now() + 30 * 86_400_000).toISOString()).run();
    const expired = await env.DB.prepare("SELECT export_id, object_key FROM exports WHERE expires_at < ?").bind(generatedAt).all();
    for (const item of expired.results) await bucket.delete(item.object_key);
    await env.DB.prepare("DELETE FROM exports WHERE expires_at < ?").bind(generatedAt).run();
  },
};
