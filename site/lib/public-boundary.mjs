const encoder = new TextEncoder();

export async function readJsonRequest(request, maxBytes) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { ok: false, status: 415, error: "Send this request as JSON." };
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, status: 413, error: "That request is too large." };
  }
  const rawBody = await request.text();
  if (encoder.encode(rawBody).byteLength > maxBytes) {
    return { ok: false, status: 413, error: "That request is too large." };
  }
  try {
    return { ok: true, data: JSON.parse(rawBody) };
  } catch {
    return { ok: false, status: 400, error: "We could not read that request." };
  }
}

export async function readTextRequest(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, status: 413, error: "That request is too large." };
  }
  const data = await request.text();
  if (encoder.encode(data).byteLength > maxBytes) {
    return { ok: false, status: 413, error: "That request is too large." };
  }
  return { ok: true, data };
}

export function publicSecurityHeaders() {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "upgrade-insecure-requests",
    ].join("; "),
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

/**
 * Same-origin attention live-session embed shell may be framed by the attention
 * page and may itself frame public noVNC.
 *
 * @param {string[]} [frameSrcOrigins]
 */
export function liveSessionEmbedSecurityHeaders(frameSrcOrigins = ["'self'"]) {
  const frameSrc = frameSrcOrigins.length ? frameSrcOrigins.join(" ") : "'self'";
  return {
    "content-security-policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
      `frame-src ${frameSrc}`,
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "upgrade-insecure-requests",
    ].join("; "),
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
  };
}

/**
 * @param {string} pathname
 * @param {URLSearchParams} [searchParams]
 */
export function isAttentionLiveSessionEmbedPath(pathname, searchParams) {
  if (!/^\/api\/attention\/[^/]+\/live-session\/?$/.test(pathname)) return false;
  if (!searchParams) return false;
  const embed = (searchParams.get("embed") ?? "").trim().toLowerCase();
  return embed === "1" || embed === "true" || embed === "yes";
}

export async function hashRateLimitKey(address, scope, salt) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}:${scope}:${address}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function consumeRateLimit(db, key, { limit, windowSeconds, now = Math.floor(Date.now() / 1000) }) {
  const cutoff = now - windowSeconds;
  const row = await db.prepare(`INSERT INTO public_rate_limits (key,window_start,count,updated_at)
    VALUES (?,?,1,?) ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN public_rate_limits.window_start<=? THEN 1 ELSE public_rate_limits.count+1 END,
    window_start=CASE WHEN public_rate_limits.window_start<=? THEN excluded.window_start ELSE public_rate_limits.window_start END,
    updated_at=excluded.updated_at RETURNING count,window_start AS windowStart`)
    .bind(key, now, now, cutoff, cutoff).first();
  await db.prepare("DELETE FROM public_rate_limits WHERE updated_at<?")
    .bind(now - Math.max(windowSeconds * 4, 86_400)).run();
  const count = Number(row?.count ?? limit + 1);
  const windowStart = Number(row?.windowStart ?? now);
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfter: Math.max(1, windowStart + windowSeconds - now),
  };
}
