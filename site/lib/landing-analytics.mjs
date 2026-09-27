/**
 * Lightweight browser PostHog capture (no posthog-js SDK).
 * Anonymous distinct_id only — no email, forms, résumés, or cookies beyond localStorage.
 */

import {
  DEFAULT_POSTHOG_HOST,
  FOUNDING_EVENTS,
  UTM_KEYS,
  buildPostHogCaptureBody,
  extractUtmParams,
  resolvePostHogHost,
} from "./posthog.mjs";

export { FOUNDING_EVENTS, UTM_KEYS, extractUtmParams };

const DISTINCT_ID_KEY = "jaa_ph_distinct_id";

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
 * @param {{
 *   apiKey: string,
 *   host?: string,
 *   event: string,
 *   properties?: Record<string, unknown>,
 *   distinctId?: string,
 *   fetchFn?: typeof fetch,
 * }} input
 */
export async function captureLandingEvent(input) {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) return { ok: false, skipped: true };

  const host = resolvePostHogHost(input.host ?? DEFAULT_POSTHOG_HOST);
  const distinctId = input.distinctId ?? getOrCreateAnonymousDistinctId();
  const body = buildPostHogCaptureBody({
    apiKey,
    event: input.event,
    distinctId,
    properties: input.properties,
  });
  const fetchFn = input.fetchFn ?? fetch;
  try {
    const upstream = await fetchFn(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
      mode: "cors",
      credentials: "omit",
    });
    if (!upstream.ok) return { ok: false, skipped: false, status: upstream.status };
    return { ok: true, skipped: false };
  } catch {
    return { ok: false, skipped: false };
  }
}

/**
 * @param {{ apiKey: string, host?: string, pathname?: string, search?: string, href?: string, fetchFn?: typeof fetch }} input
 */
export function captureLandingPageview(input) {
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
  });
}
