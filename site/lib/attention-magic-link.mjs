/**
 * HMAC-signed magic links for attention deep-links.
 * Tokens prove access to a single attention id for a short TTL.
 * Never embeds VNC passwords or session cookies.
 */

import {
  detectAiAssistanceDiscouraged,
  normalizeAttentionQuestions,
} from "./attention-questions.mjs";

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  const binary = typeof Buffer !== "undefined"
    ? Buffer.from(bytes).toString("base64")
    : btoa(String.fromCharCode(...bytes));
  return binary.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(padded, "base64"));
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signBytes(secret, payloadBytes) {
  const key = await importHmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes));
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return [...new Set(actions.map((item) => String(item).trim().toLowerCase()).filter(Boolean))].slice(0, 8);
}

/**
 * @param {object} input
 * @param {string} secret
 * @param {{ ttlSeconds?: number, now?: number }} [options]
 */
export async function signAttentionMagicLink(input, secret, options = {}) {
  if (typeof secret !== "string" || secret.length < 16) {
    return { ok: false, error: "magic_link_secret_invalid" };
  }
  const attentionId = typeof input?.attentionId === "string" ? input.attentionId.trim() : "";
  if (!attentionId || attentionId.length > 180) return { ok: false, error: "attention_id_invalid" };

  const now = Number.isFinite(options.now) ? options.now : Math.floor(Date.now() / 1000);
  const ttlSeconds = Number.isFinite(options.ttlSeconds) ? Math.max(60, Math.min(options.ttlSeconds, 3600)) : 2700;
  const questions = normalizeAttentionQuestions(input?.questions);
  const aiAssistanceDiscouraged = Boolean(input?.aiAssistanceDiscouraged)
    || detectAiAssistanceDiscouraged(input?.postingText ?? "");
  const payload = {
    v: 1,
    aid: attentionId,
    company: String(input?.company ?? "").trim().slice(0, 200),
    role: String(input?.role ?? "").trim().slice(0, 200),
    url: String(input?.url ?? "").trim().slice(0, 2048),
    stage: String(input?.stage ?? "").trim().toLowerCase().slice(0, 40),
    blocker: String(input?.blocker ?? "").trim().toLowerCase().slice(0, 60),
    requiredActions: normalizeActions(input?.requiredActions),
    questions,
    aiAssistanceDiscouraged,
    iat: now,
    exp: now + ttlSeconds,
  };

  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const signature = await signBytes(secret, payloadBytes);
  const token = `${toBase64Url(payloadBytes)}.${toBase64Url(signature)}`;
  return { ok: true, token, payload, expiresAt: payload.exp };
}

/**
 * @param {string} token
 * @param {string} secret
 * @param {{ attentionId?: string, now?: number }} [options]
 */
export async function verifyAttentionMagicLink(token, secret, options = {}) {
  if (typeof secret !== "string" || secret.length < 16) {
    return { ok: false, error: "magic_link_secret_invalid" };
  }
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, error: "token_invalid" };
  }

  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart || token.split(".").length !== 2) {
    return { ok: false, error: "token_invalid" };
  }

  let payloadBytes;
  let providedSignature;
  try {
    payloadBytes = fromBase64Url(payloadPart);
    providedSignature = fromBase64Url(signaturePart);
  } catch {
    return { ok: false, error: "token_invalid" };
  }

  const expectedSignature = await signBytes(secret, payloadBytes);
  if (!timingSafeEqual(providedSignature, expectedSignature)) {
    return { ok: false, error: "token_invalid" };
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, error: "token_invalid" };
  }

  if (payload?.v !== 1 || typeof payload.aid !== "string" || !payload.aid) {
    return { ok: false, error: "token_invalid" };
  }

  const now = Number.isFinite(options.now) ? options.now : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp < now) {
    return { ok: false, error: "token_expired" };
  }

  if (options.attentionId && options.attentionId !== payload.aid) {
    return { ok: false, error: "token_mismatch" };
  }

  return {
    ok: true,
    payload: {
      attentionId: payload.aid,
      company: String(payload.company ?? ""),
      role: String(payload.role ?? ""),
      url: String(payload.url ?? ""),
      stage: String(payload.stage ?? ""),
      blocker: String(payload.blocker ?? ""),
      requiredActions: normalizeActions(payload.requiredActions),
      questions: normalizeAttentionQuestions(payload.questions),
      aiAssistanceDiscouraged: Boolean(payload.aiAssistanceDiscouraged),
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    },
  };
}

/**
 * @param {string} publicSiteUrl
 * @param {string} attentionId
 * @param {string} token
 */
export function buildAttentionMagicLinkUrl(publicSiteUrl, attentionId, token) {
  const origin = new URL(publicSiteUrl).origin;
  const url = new URL(`/attention/${encodeURIComponent(attentionId)}`, origin);
  url.searchParams.set("token", token);
  return url.toString();
}
