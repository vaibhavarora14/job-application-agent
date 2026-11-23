/**
 * Privacy-tight PostHog capture for the site Worker (founding buyer funnel).
 *
 * Server events use POSTHOG_PROJECT_API_KEY (wrangler secret). Never log the key,
 * never attach buyer email / PII, and never invent buyer↔skill joins.
 */

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Same-origin ingest path proxied by the site Worker to DEFAULT_POSTHOG_HOST. */
export const BROWSER_POSTHOG_INGEST_PATH = "/ingest";

/** Hosts allowed in CSP connect-src for browser capture. Same-origin `/ingest` uses `'self'`. */
export const POSTHOG_CONNECT_SRC = Object.freeze([]);

export const FOUNDING_EVENTS = Object.freeze({
  CTA_CLICKED: "founding_cta_clicked",
  CHECKOUT_CREATED: "founding_checkout_created",
  CHECKOUT_RETURNED: "founding_checkout_returned",
  PAYMENT_CONFIRMED: "founding_payment_confirmed",
});

export const UTM_KEYS = Object.freeze([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
]);

const encoder = new TextEncoder();

/**
 * @param {unknown} source
 * @returns {Record<string, string>}
 */
export function extractUtmParams(source) {
  if (!source || typeof source !== "object") return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of UTM_KEYS) {
    const raw = /** @type {Record<string, unknown>} */ (source)[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") continue;
    const trimmed = value.trim().slice(0, 200);
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/**
 * Pseudonymous purchase reference — SHA-256 hex, never the raw UUID on events.
 * @param {string} purchaseId
 */
export async function hashPurchaseId(purchaseId) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`purchase:${String(purchaseId ?? "").trim()}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {{
 *   apiKey: string,
 *   event: string,
 *   distinctId: string,
 *   properties?: Record<string, unknown>,
 *   timestamp?: string,
 *   uuid?: string,
 * }} input
 */
export function buildPostHogCaptureBody(input) {
  return {
    api_key: input.apiKey,
    event: input.event,
    distinct_id: input.distinctId,
    ...(input.uuid ? { uuid: input.uuid } : {}),
    timestamp: input.timestamp ?? new Date().toISOString(),
    properties: {
      ...(input.properties ?? {}),
      $process_person_profile: false,
      $geoip_disable: true,
    },
  };
}

/**
 * @param {string | undefined} host
 */
export function resolvePostHogHost(host) {
  const trimmed = host?.trim();
  if (!trimmed) return DEFAULT_POSTHOG_HOST;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return DEFAULT_POSTHOG_HOST;
    return url.origin;
  } catch {
    return DEFAULT_POSTHOG_HOST;
  }
}

/**
 * Browser capture host. Relative same-origin paths are kept; PostHog ingest
 * origins are remapped to `/ingest` so ad blockers cannot see us.i.posthog.com.
 * @param {string | undefined} host
 */
export function resolveBrowserPostHogHost(host) {
  const trimmed = host?.trim();
  if (!trimmed) return BROWSER_POSTHOG_INGEST_PATH;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed.replace(/\/+$/, "") || BROWSER_POSTHOG_INGEST_PATH;
  }
  const resolved = resolveCaptureHost(trimmed);
  return isCustomPostHogApiHost(resolved) ? resolved : BROWSER_POSTHOG_INGEST_PATH;
}

/**
 * Resolve a capture endpoint for the landing client. Unlike
 * `resolveBrowserPostHogHost`, an explicit PostHog ingest origin is kept so
 * tests can mock `https://us.i.posthog.com`.
 * @param {string | undefined} host
 */
export function resolveCaptureHost(host) {
  const trimmed = host?.trim();
  if (!trimmed) return BROWSER_POSTHOG_INGEST_PATH;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed.replace(/\/+$/, "") || BROWSER_POSTHOG_INGEST_PATH;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return BROWSER_POSTHOG_INGEST_PATH;
    return url.origin;
  } catch {
    return BROWSER_POSTHOG_INGEST_PATH;
  }
}

/**
 * @param {string | undefined} host
 */
export function isCustomPostHogApiHost(host) {
  const resolved = resolveCaptureHost(host);
  if (resolved.startsWith("/")) return true;
  try {
    const { hostname } = new URL(resolved);
    return hostname !== "us.i.posthog.com" && hostname !== "eu.i.posthog.com";
  } catch {
    return true;
  }
}

/**
 * @param {string | undefined} host
 * @param {string} [path]
 */
export function postHogCaptureUrl(host, path = "/i/v0/e/") {
  const resolved = resolveCaptureHost(host);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${resolved}${suffix}`;
}

/**
 * Best-effort capture. Never throws into the money path.
 * @param {{
 *   POSTHOG_PROJECT_API_KEY?: string,
 *   POSTHOG_HOST?: string,
 *   POSTHOG_FETCH?: typeof fetch,
 * }} env
 * @param {{
 *   event: string,
 *   distinctId: string,
 *   properties?: Record<string, unknown>,
 * }} input
 */
export async function captureSitePostHogEvent(env, input) {
  const apiKey = env.POSTHOG_PROJECT_API_KEY?.trim();
  if (!apiKey) return { ok: false, skipped: true };

  const host = resolvePostHogHost(env.POSTHOG_HOST);
  const body = buildPostHogCaptureBody({
    apiKey,
    event: input.event,
    distinctId: input.distinctId,
    properties: input.properties,
    uuid: crypto.randomUUID(),
  });
  const fetchFn = env.POSTHOG_FETCH ?? fetch;
  try {
    const upstream = await fetchFn(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!upstream.ok) return { ok: false, skipped: false, status: upstream.status };
    return { ok: true, skipped: false };
  } catch {
    return { ok: false, skipped: false };
  }
}

/**
 * @param {string} purchaseId
 * @param {Record<string, unknown>} [extra]
 */
export async function foundingEventProperties(purchaseId, extra = {}) {
  const purchaseIdHash = await hashPurchaseId(purchaseId);
  return {
    purchaseIdHash,
    offer: "founding_90_days",
    ...extra,
  };
}
