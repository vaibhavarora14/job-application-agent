import { createHash, timingSafeEqual } from "node:crypto";

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

const NO_STORE = { "cache-control": "no-store" };

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

export async function headObject(bucket, key) {
  return bucket.head(key);
}

export async function getObject(bucket, key) {
  return bucket.get(key);
}

export async function putObject(bucket, key, body, customMetadata = {}) {
  return bucket.put(key, body, { customMetadata });
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
  if (!checkAuth(request, env)) {
    return unauthorized();
  }

  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/healthz") {
    return jsonResponse({ ok: true });
  }

  if (method === "GET" && pathname === "/v1/manifest") {
    const manifest = await buildManifest(env.STATE);
    return jsonResponse(manifest);
  }

  const fileMatch = pathname.match(/^\/v1\/files\/([^/]+)$/);
  if (fileMatch) {
    const name = decodeURIComponent(fileMatch[1]);
    if (method === "GET") return handleGetFile(env.STATE, name);
    if (method === "PUT") return handlePutFile(env.STATE, name, request);
  }

  const ledgerMatch = pathname.match(/^\/v1\/ledgers\/([^/]+)$/);
  if (ledgerMatch && method === "POST") {
    const name = decodeURIComponent(ledgerMatch[1]);
    return handlePostLedger(env.STATE, name, request);
  }

  if (pathname === "/v1/profile") {
    if (method === "GET") return handleGetProfile(env.STATE);
    if (method === "PUT") return handlePutProfile(env.STATE, request);
  }

  return notFound();
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
