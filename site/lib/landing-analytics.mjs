/**
 * Lightweight browser PostHog capture (no posthog-js SDK).
 * Anonymous distinct_id only — no email, forms, résumés, or cookies beyond localStorage.
 */

import { getOrCreateLandingSessionId, resetLandingSessionForTests } from "./landing-session.mjs";
import {
  BROWSER_POSTHOG_INGEST_PATH,
  FOUNDING_EVENTS,
  UTM_KEYS,
  buildPostHogCaptureBody,
  extractUtmParams,
  isCustomPostHogApiHost,
  postHogCaptureUrl,
  resolveCaptureHost,
} from "./posthog.mjs";

export { FOUNDING_EVENTS, UTM_KEYS, extractUtmParams };
export {
  LANDING_SESSION_IDLE_MS,
  LANDING_SESSION_MAX_MS,
  LANDING_SESSION_STORAGE_KEY,
  getOrCreateLandingSessionId,
  resetLandingSessionForTests,
} from "./landing-session.mjs";
export { isUuidV7, uuidv7 } from "./uuidv7.mjs";

const DISTINCT_ID_KEY = "jaa_ph_distinct_id";

/** @type {string | null} */
let pageleaveSentKey = null;

/**
 * @returns {string}
 */
export function getOrCreateAnonymousDistinctId() {
  try {
    const existing = window.localStorage.getItem(DISTINCT_ID_KEY);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(DISTINCT_ID_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * @param {string} [search]
 */
export function readUtmFromLocation(search = typeof window !== "undefined" ? window.location.search : "") {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  /** @type {Record<string, string>} */
  const raw = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value) raw[key] = value;
  }
  return extractUtmParams(raw);
}

/**
 * @param {Record<string, unknown> | undefined} properties
 * @param {{
 *   apiHost?: string,
 *   pageHost?: string,
 *   sessionId?: string,
 *   sessionStore?: { getItem(key: string): string | null, setItem(key: string, value: string): void } | null,
 *   now?: number,
 * }} [options]
 */
export function withLandingCaptureProperties(properties = {}, options = {}) {
  const apiHost = resolveCaptureHost(options.apiHost);
  const pageHost = options.pageHost
    ?? (typeof window !== "undefined" ? window.location.host : undefined);
  const sessionId = options.sessionId
    ?? getOrCreateLandingSessionId({ sessionStore: options.sessionStore, now: options.now });
  /** @type {Record<string, unknown>} */
  const next = { ...properties };
  if (next.$session_id == null) next.$session_id = sessionId;
  if (pageHost && next.$host == null) next.$host = pageHost;
  if (isCustomPostHogApiHost(apiHost) && next.$lib_custom_api_host == null) {
    next.$lib_custom_api_host = apiHost;
  }
  return next;
}

/**
 * @param {string} url
 * @param {Record<string, unknown>} body
 * @param {{
 *   fetchFn?: typeof fetch,
 *   sendBeacon?: (url: string, data: Blob) => boolean,
 *   transport?: "fetch" | "beacon",
 * }} [options]
 */
export async function sendLandingCapture(url, body, options = {}) {
  const payload = JSON.stringify(body);
  if (options.transport === "beacon") {
    const sendBeacon = options.sendBeacon
      ?? (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
        ? navigator.sendBeacon.bind(navigator)
        : undefined);
    if (typeof sendBeacon === "function") {
      try {
        const blob = new Blob([payload], { type: "application/json" });
        if (sendBeacon(url, blob)) return { ok: true, skipped: false, transport: "beacon" };
      } catch {
        /* Fall through to keepalive fetch. */
      }
    }
  }

  const fetchFn = options.fetchFn ?? fetch;
  const mode = url.startsWith("/") ? "same-origin" : "cors";
  try {
    const upstream = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
      mode,
      credentials: "omit",
    });
    if (!upstream.ok) return { ok: false, skipped: false, status: upstream.status, transport: "fetch" };
    return { ok: true, skipped: false, transport: "fetch" };
  } catch {
    return { ok: false, skipped: false, transport: "fetch" };
  }
}

/**
 * @param {{
 *   apiKey: string,
 *   host?: string,
 *   event: string,
 *   properties?: Record<string, unknown>,
 *   distinctId?: string,
 *   fetchFn?: typeof fetch,
 *   sendBeacon?: (url: string, data: Blob) => boolean,
 *   transport?: "fetch" | "beacon",
 *   pageHost?: string,
 *   sessionId?: string,
 *   sessionStore?: { getItem(key: string): string | null, setItem(key: string, value: string): void } | null,
 *   now?: number,
 * }} input
 */
export async function captureLandingEvent(input) {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) return { ok: false, skipped: true };

  const host = resolveCaptureHost(input.host ?? BROWSER_POSTHOG_INGEST_PATH);
  const distinctId = input.distinctId ?? getOrCreateAnonymousDistinctId();
  const body = buildPostHogCaptureBody({
    apiKey,
    event: input.event,
    distinctId,
    properties: withLandingCaptureProperties(input.properties, {
      apiHost: host,
      pageHost: input.pageHost,
      sessionId: input.sessionId,
      sessionStore: input.sessionStore,
      now: input.now,
    }),
  });
  return sendLandingCapture(postHogCaptureUrl(host), body, {
    fetchFn: input.fetchFn,
    sendBeacon: input.sendBeacon,
    transport: input.transport,
  });
}

/**
 * @param {{
 *   apiKey: string,
 *   host?: string,
 *   pathname?: string,
 *   search?: string,
 *   href?: string,
 *   fetchFn?: typeof fetch,
 *   pageHost?: string,
 *   sessionId?: string,
 *   sessionStore?: { getItem(key: string): string | null, setItem(key: string, value: string): void } | null,
 *   now?: number,
 * }} input
 */
export function captureLandingPageview(input) {
  resetLandingPageleaveGuard();
  const utm = readUtmFromLocation(input.search);
  const pathname = input.pathname
    ?? (typeof window !== "undefined" ? window.location.pathname : "/");
  const href = input.href
    ?? (typeof window !== "undefined" ? window.location.href : pathname);
  return captureLandingEvent({
    apiKey: input.apiKey,
    host: input.host,
    event: "$pageview",
    properties: {
      $current_url: href,
      $pathname: pathname,
      path: pathname,
      ...utm,
    },
    fetchFn: input.fetchFn,
    pageHost: input.pageHost,
    sessionId: input.sessionId,
    sessionStore: input.sessionStore,
    now: input.now,
  });
}

/**
 * @param {string} href
 * @param {string} sessionId
 */
function pageleaveKey(href, sessionId) {
  return `${sessionId}:${href}`;
}

export function resetLandingPageleaveGuard() {
  pageleaveSentKey = null;
}

/**
 * @param {{
 *   apiKey: string,
 *   host?: string,
 *   pathname?: string,
 *   href?: string,
 *   fetchFn?: typeof fetch,
 *   sendBeacon?: (url: string, data: Blob) => boolean,
 *   pageHost?: string,
 *   sessionId?: string,
 *   sessionStore?: { getItem(key: string): string | null, setItem(key: string, value: string): void } | null,
 *   now?: number,
 * }} input
 */
export function captureLandingPageleave(input) {
  const pathname = input.pathname
    ?? (typeof window !== "undefined" ? window.location.pathname : "/");
  const href = input.href
    ?? (typeof window !== "undefined" ? window.location.href : pathname);
  const sessionId = input.sessionId
    ?? getOrCreateLandingSessionId({ sessionStore: input.sessionStore, now: input.now });
  const key = pageleaveKey(href, sessionId);
  if (pageleaveSentKey === key) return Promise.resolve({ ok: true, skipped: true, duplicate: true });
  pageleaveSentKey = key;
  return captureLandingEvent({
    apiKey: input.apiKey,
    host: input.host,
    event: "$pageleave",
    properties: {
      $current_url: href,
      $pathname: pathname,
    },
    fetchFn: input.fetchFn,
    sendBeacon: input.sendBeacon,
    transport: "beacon",
    pageHost: input.pageHost,
    sessionId,
    sessionStore: input.sessionStore,
    now: input.now,
  });
}

/**
 * @param {{
 *   apiKey: string,
 *   host?: string,
 *   fetchFn?: typeof fetch,
 *   sendBeacon?: (url: string, data: Blob) => boolean,
 *   pageHost?: string,
 *   sessionStore?: { getItem(key: string): string | null, setItem(key: string, value: string): void } | null,
 *   target?: Pick<Window, "addEventListener" | "removeEventListener"> & { document?: Document },
 * }} input
 */
export function bindLandingPageleave(input) {
  const target = input.target
    ?? (typeof window !== "undefined" ? window : undefined);
  const pageDocument = target && "document" in target && target.document
    ? target.document
    : (typeof document !== "undefined" ? document : undefined);
  if (!target || !pageDocument) return () => {};

  const send = () => {
    void captureLandingPageleave({
      apiKey: input.apiKey,
      host: input.host,
      pathname: typeof window !== "undefined" ? window.location.pathname : undefined,
      href: typeof window !== "undefined" ? window.location.href : undefined,
      fetchFn: input.fetchFn,
      sendBeacon: input.sendBeacon,
      pageHost: input.pageHost,
      sessionStore: input.sessionStore,
    });
  };
  const onVisibility = () => {
    if (pageDocument.visibilityState === "hidden") send();
  };
  target.addEventListener("pagehide", send);
  pageDocument.addEventListener("visibilitychange", onVisibility);
  return () => {
    target.removeEventListener("pagehide", send);
    pageDocument.removeEventListener("visibilitychange", onVisibility);
  };
}

export function resetLandingAnalyticsStateForTests() {
  resetLandingPageleaveGuard();
  resetLandingSessionForTests();
}
