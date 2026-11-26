/**
 * Personless PostHog capture for public /jobs surfaces.
 * Reuses the SDK-free landing helper. Never sends referrer URLs, board-filter
 * query strings, clipboard contents, or Google search queries.
 */

import { captureLandingEvent } from "./landing-analytics.mjs";
import {
  BROWSER_POSTHOG_INGEST_PATH,
  extractUtmParams,
  resolveBrowserPostHogHost,
} from "./posthog.mjs";

export const JOBS_EVENTS = Object.freeze({
  GOOGLE_FOR_JOBS_LANDING: "google_for_jobs_landing",
  COPY_CLICKED: "jobs_copy_clicked",
});

export const JOBS_COPY_KINDS = Object.freeze({
  PROMPT: "prompt",
  COMMAND: "command",
});

/** Derived label sent on jobs events. Raw UTM values never leave the client. */
export const JOBS_SOURCE_GOOGLE_FOR_JOBS = "google_for_jobs";

/** Keys read locally for Google-for-Jobs classification. Not copied onto events. */
export const JOBS_UTM_KEYS = Object.freeze(["utm_source", "utm_medium", "utm_campaign"]);

/**
 * Cross-chunk browser config. CopyButton and JobsAnalytics can land in separate
 * client graphs; module-local `browserConfig` would then never be visible to clicks.
 */
export const JOBS_ANALYTICS_WINDOW_KEY = "__JAA_JOBS_ANALYTICS__";
const JOBS_COPY_QUEUE_WINDOW_KEY = "__JAA_JOBS_COPY_QUEUE__";

const GOOGLE_JOBS_SOURCES = new Set([
  "google",
  "google_jobs",
  "googlejobs",
  "google_for_jobs",
  "google_jobs_apply",
]);

const PAID_MEDIUMS = new Set([
  "cpc",
  "ppc",
  "paid",
  "paidsearch",
  "display",
  "cpm",
  "cpv",
  "ads",
  "ad",
  "paid_search",
  "google_ads",
  "sem",
]);

/** Google UTM counts as organic only for these media (empty = unset). */
const ORGANIC_GOOGLE_MEDIUMS = new Set(["", "organic", "referral"]);

const MAX_PENDING_COPY_CLICKS = 8;

/** @type {{ apiKey: string, host?: string } | null} */
let browserConfig = null;
let googleLandingSent = false;
/** @type {{ search: string, referrer: string } | null} */
let documentTouch = null;
/** @type {{ copyKind: "prompt" | "command", pathname: string, origin: string }[]} */
let pendingCopyClicks = [];

function jobsWindow() {
  return typeof globalThis !== "undefined" && globalThis.window ? globalThis.window : undefined;
}

function readBrowserConfig() {
  const win = jobsWindow();
  const fromWindow = win ? win[JOBS_ANALYTICS_WINDOW_KEY] : null;
  if (fromWindow && typeof fromWindow.apiKey === "string" && fromWindow.apiKey.trim()) {
    return { apiKey: fromWindow.apiKey.trim(), host: fromWindow.host };
  }
  return browserConfig;
}

function writeBrowserConfig(config) {
  browserConfig = config;
  const win = jobsWindow();
  if (!win) return;
  if (config) win[JOBS_ANALYTICS_WINDOW_KEY] = config;
  else delete win[JOBS_ANALYTICS_WINDOW_KEY];
}

function pendingCopyQueue() {
  const win = jobsWindow();
  if (win) {
    if (!Array.isArray(win[JOBS_COPY_QUEUE_WINDOW_KEY])) win[JOBS_COPY_QUEUE_WINDOW_KEY] = [];
    return win[JOBS_COPY_QUEUE_WINDOW_KEY];
  }
  return pendingCopyClicks;
}

function enqueueCopyClick(payload) {
  const queue = pendingCopyQueue();
  if (queue.length >= MAX_PENDING_COPY_CLICKS) return;
  queue.push(payload);
}

function takePendingCopyClicks() {
  const win = jobsWindow();
  if (win) {
    const queued = Array.isArray(win[JOBS_COPY_QUEUE_WINDOW_KEY]) ? win[JOBS_COPY_QUEUE_WINDOW_KEY] : [];
    win[JOBS_COPY_QUEUE_WINDOW_KEY] = [];
    return queued;
  }
  const queued = pendingCopyClicks;
  pendingCopyClicks = [];
  return queued;
}

function flushPendingCopyClicks() {
  const config = readBrowserConfig();
  if (!config?.apiKey) return;
  const queued = takePendingCopyClicks();
  for (const item of queued) {
    void captureJobsCopyClicked({
      apiKey: config.apiKey,
      host: config.host,
      copyKind: item.copyKind,
      pathname: item.pathname,
      origin: item.origin,
    });
  }
}

/**
 * @param {{ apiKey: string, host?: string } | null} config
 */
export function setJobsAnalyticsBrowserConfig(config) {
  writeBrowserConfig(config && config.apiKey ? { apiKey: config.apiKey, host: config.host } : null);
  flushPendingCopyClicks();
}

/**
 * First search/referrer on this document. Classification reads these raw values;
 * capture never copies them onto the event.
 *
 * @param {{ search?: string, referrer?: string }} [input]
 */
export function rememberJobsDocumentTouch(input = {}) {
  if (!documentTouch) {
    documentTouch = {
      search: typeof input.search === "string" ? input.search : "",
      referrer: typeof input.referrer === "string" ? input.referrer : "",
    };
  }
  return documentTouch;
}

export function resetJobsAnalyticsForTests() {
  browserConfig = null;
  googleLandingSent = false;
  documentTouch = null;
  pendingCopyClicks = [];
  const win = jobsWindow();
  if (win) {
    delete win[JOBS_ANALYTICS_WINDOW_KEY];
    delete win[JOBS_COPY_QUEUE_WINDOW_KEY];
  }
}

/**
 * Browser capture must POST same-origin so CSP `connect-src 'self'` holds.
 * PostHog ingest origins are remapped to `/ingest`; any other non-relative
 * host is also pinned to `/ingest` so the jobs client cannot open a new origin.
 *
 * @param {string | undefined} host
 */
export function jobsCaptureHost(host) {
  const resolved = resolveBrowserPostHogHost(host);
  return resolved.startsWith("/") ? resolved : BROWSER_POSTHOG_INGEST_PATH;
}

/**
 * @param {unknown} value
 * @returns {value is "prompt" | "command"}
 */
export function isJobsCopyKind(value) {
  return value === JOBS_COPY_KINDS.PROMPT || value === JOBS_COPY_KINDS.COMMAND;
}

/**
 * @param {string | undefined} pathname
 */
export function normalizeJobsPathname(pathname) {
  if (typeof pathname !== "string" || !pathname) return "/";
  const trimmed = pathname.split("?")[0].split("#")[0];
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}

/**
 * @param {string | undefined} pathname
 * @returns {"board" | "job_page" | null}
 */
export function classifyJobsSurface(pathname) {
  const path = normalizeJobsPathname(pathname);
  if (path === "/jobs") return "board";
  if (path.startsWith("/jobs/alerts")) return null;
  const match = /^\/jobs\/([^/]+)$/.exec(path);
  if (match?.[1]) return "job_page";
  return null;
}

/**
 * @param {string | undefined} hostname
 */
export function isGoogleJobsReferrerHost(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  const stripped = host.startsWith("www.") ? host.slice(4) : host;
  if (!stripped) return false;
  if (stripped === "jobs.google.com") return true;
  if (stripped === "google.com") return true;
  return /^google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(stripped);
}

/**
 * Hostname only — used for classification, never copied onto events.
 *
 * @param {string | undefined} referrer
 */
export function referrerHostname(referrer) {
  if (typeof referrer !== "string" || !referrer) return "";
  try {
    const url = new URL(referrer);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.hostname;
  } catch {
    return "";
  }
}

/**
 * @param {string | undefined} value
 */
function normalizeJobsUtmToken(value) {
  return String(value ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");
}

/**
 * @param {string | undefined} value
 */
function isGoogleJobsUtmToken(value) {
  const token = normalizeJobsUtmToken(value);
  if (!token) return false;
  if (GOOGLE_JOBS_SOURCES.has(token)) return true;
  return token.startsWith("google_jobs_");
}

/**
 * Local classification helper. Return value is not an event payload.
 *
 * @param {string} [search]
 */
export function readJobsUtmFromLocation(search = "") {
  const rawSearch = typeof search === "string" ? search : "";
  const params = new URLSearchParams(rawSearch.startsWith("?") || rawSearch.startsWith("&") ? rawSearch : `?${rawSearch}`);
  /** @type {Record<string, string>} */
  const raw = {};
  for (const key of JOBS_UTM_KEYS) {
    const value = params.get(key);
    if (value) raw[key] = value;
  }
  return extractUtmParams(raw);
}

/**
 * @param {Record<string, string>} utm
 * @param {string | undefined} search
 */
function isPaidAcquisition(utm, search) {
  const medium = normalizeJobsUtmToken(utm.utm_medium);
  if (PAID_MEDIUMS.has(medium)) return true;
  if (typeof search !== "string" || !search) return false;
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  return Boolean(params.get("gclid") || params.get("gbraid") || params.get("wbraid"));
}

/**
 * True for Google Search / Google for Jobs organic landings. Never returns the referrer.
 *
 * Google for Jobs appends `utm_source=google_jobs_apply` (and usually
 * `utm_campaign=google_jobs_apply` + `utm_medium=organic`). A non-Google
 * `utm_source` opts out of the referrer-host fallback.
 *
 * @param {{
 *   referrer?: string,
 *   search?: string,
 *   utm?: Record<string, string>,
 * }} [input]
 */
export function detectGoogleForJobsLanding(input = {}) {
  const utm = input.utm ?? readJobsUtmFromLocation(input.search ?? "");
  if (isPaidAcquisition(utm, input.search)) return false;
  const source = normalizeJobsUtmToken(utm.utm_source);
  const campaign = normalizeJobsUtmToken(utm.utm_campaign);
  if (isGoogleJobsUtmToken(source) || isGoogleJobsUtmToken(campaign)) {
    return ORGANIC_GOOGLE_MEDIUMS.has(normalizeJobsUtmToken(utm.utm_medium));
  }
  if (source) return false;
  return isGoogleJobsReferrerHost(referrerHostname(input.referrer));
}

/**
 * Origin + pathname only. Drops search and hash so board filters and UTMs
 * are not copied into `$current_url`.
 *
 * @param {{ origin?: string, pathname?: string, href?: string }} [input]
 */
export function jobsCaptureUrl(input = {}) {
  const path = normalizeJobsPathname(input.pathname);
  if (typeof input.origin === "string" && input.origin) {
    try {
      const url = new URL(input.origin);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return `${url.origin}${path}`;
      }
    } catch {
      /* fall through */
    }
  }
  if (typeof input.href === "string" && input.href) {
    try {
      const url = new URL(input.href);
      if (url.protocol === "http:" || url.protocol === "https:") {
        const hrefPath = normalizeJobsPathname(url.pathname);
        return `${url.origin}${hrefPath}`;
      }
    } catch {
      /* ignore */
    }
  }
  return path;
}

/**
 * Derived source label only. Classification uses raw search/referrer; the
 * payload never includes UTM values, query strings, or a referrer host.
 *
 * @param {{ search?: string, referrer?: string, utm?: Record<string, string> }} [input]
 */
export function jobsAttributionProperties(input = {}) {
  if (!detectGoogleForJobsLanding(input)) return {};
  return { jobsSource: JOBS_SOURCE_GOOGLE_FOR_JOBS };
}

/**
 * @param {{
 *   apiKey: string,
 *   host?: string,
 *   pathname?: string,
 *   search?: string,
 *   origin?: string,
 *   href?: string,
 *   referrer?: string,
 *   distinctId?: string,
 *   fetchFn?: typeof fetch,
 * }} input
 */
export async function captureJobsPageview(input) {
  const surface = classifyJobsSurface(input.pathname);
  if (!surface) return { ok: false, skipped: true };

  const touch = rememberJobsDocumentTouch({
    search: input.search ?? "",
    referrer: input.referrer ?? "",
  });
  const pathname = normalizeJobsPathname(input.pathname);
  const currentUrl = jobsCaptureUrl({
    origin: input.origin,
    pathname,
    href: input.href,
  });
  const utm = readJobsUtmFromLocation(touch.search);
  const googleForJobs = !googleLandingSent && detectGoogleForJobsLanding({
    referrer: touch.referrer,
    search: touch.search,
    utm,
  });
  if (googleForJobs) googleLandingSent = true;

  const host = jobsCaptureHost(input.host);
  const source = googleForJobs
    ? jobsAttributionProperties({
      referrer: touch.referrer,
      search: touch.search,
      utm,
    })
    : {};

  /** @type {Record<string, unknown>} */
  const properties = {
    $current_url: currentUrl,
    $pathname: pathname,
    path: pathname,
    surface,
    ...source,
  };
  if (googleForJobs) properties.googleForJobs = true;

  const pageviewPromise = captureLandingEvent({
    apiKey: input.apiKey,
    host,
    event: "$pageview",
    properties,
    distinctId: input.distinctId,
    fetchFn: input.fetchFn,
  });

  if (!googleForJobs) return pageviewPromise;

  /** @type {Record<string, unknown>} */
  const landingProperties = {
    $current_url: currentUrl,
    $pathname: pathname,
    path: pathname,
    surface,
    ...source,
  };

  // Fire the landing event in the same turn as `$pageview`. Waiting on pageview
  // first dropped google_for_jobs_landing when the visitor left for the ATS.
  const [pageview] = await Promise.all([
    pageviewPromise,
    captureLandingEvent({
      apiKey: input.apiKey,
      host,
      event: JOBS_EVENTS.GOOGLE_FOR_JOBS_LANDING,
      properties: landingProperties,
      distinctId: input.distinctId,
      fetchFn: input.fetchFn,
    }),
  ]);
  return pageview;
}

/**
 * @param {{
 *   apiKey: string,
 *   host?: string,
 *   copyKind: "prompt" | "command",
 *   pathname?: string,
 *   origin?: string,
 *   href?: string,
 *   distinctId?: string,
 *   fetchFn?: typeof fetch,
 * }} input
 */
export function captureJobsCopyClicked(input) {
  switch (input.copyKind) {
    case JOBS_COPY_KINDS.PROMPT:
    case JOBS_COPY_KINDS.COMMAND:
      break;
    default: {
      return Promise.resolve({ ok: false, skipped: true });
    }
  }

  const surface = classifyJobsSurface(input.pathname);
  if (!surface) return Promise.resolve({ ok: false, skipped: true });

  const pathname = normalizeJobsPathname(input.pathname);
  return captureLandingEvent({
    apiKey: input.apiKey,
    host: jobsCaptureHost(input.host),
    event: JOBS_EVENTS.COPY_CLICKED,
    properties: {
      $current_url: jobsCaptureUrl({
        origin: input.origin,
        pathname,
        href: input.href,
      }),
      $pathname: pathname,
      path: pathname,
      surface,
      copyKind: input.copyKind,
    },
    distinctId: input.distinctId,
    fetchFn: input.fetchFn,
  });
}

/**
 * @param {"prompt" | "command"} copyKind
 */
export function trackJobsCopyClicked(copyKind) {
  if (!isJobsCopyKind(copyKind)) return;
  const win = jobsWindow();
  if (!win?.location) return;
  const payload = {
    copyKind,
    pathname: String(win.location.pathname ?? ""),
    origin: String(win.location.origin ?? ""),
  };
  const config = readBrowserConfig();
  if (!config?.apiKey) {
    enqueueCopyClick(payload);
    return;
  }
  void captureJobsCopyClicked({
    apiKey: config.apiKey,
    host: config.host,
    copyKind: payload.copyKind,
    pathname: payload.pathname,
    origin: payload.origin,
  });
}
