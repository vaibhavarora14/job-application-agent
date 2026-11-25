/**
 * Personless PostHog capture for public /jobs surfaces.
 * Reuses the SDK-free landing helper. Never sends referrer URLs, board-filter
 * query strings, clipboard contents, or Google search queries.
 */

import { captureLandingEvent, readUtmFromLocation } from "./landing-analytics.mjs";

export const JOBS_EVENTS = Object.freeze({
  GOOGLE_FOR_JOBS_LANDING: "google_for_jobs_landing",
  COPY_CLICKED: "jobs_copy_clicked",
});

export const JOBS_COPY_KINDS = Object.freeze({
  PROMPT: "prompt",
  COMMAND: "command",
});

const GOOGLE_JOBS_SOURCES = new Set([
  "google",
  "google_jobs",
  "google-jobs",
  "googlejobs",
  "google for jobs",
  "google-for-jobs",
  "google_for_jobs",
]);

const PAID_MEDIUMS = new Set([
  "cpc",
  "ppc",
  "paid",
  "display",
  "cpm",
  "cpv",
  "ads",
  "ad",
  "paid_search",
  "paid-search",
  "google_ads",
  "sem",
]);

/** @type {{ apiKey: string, host?: string } | null} */
let browserConfig = null;
let googleLandingSent = false;

/**
 * @param {{ apiKey: string, host?: string } | null} config
 */
export function setJobsAnalyticsBrowserConfig(config) {
  browserConfig = config && config.apiKey ? { apiKey: config.apiKey, host: config.host } : null;
}

export function resetJobsAnalyticsForTests() {
  browserConfig = null;
  googleLandingSent = false;
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
 * @param {Record<string, string>} utm
 * @param {string | undefined} search
 */
function isPaidAcquisition(utm, search) {
  const medium = (utm.utm_medium ?? "").trim().toLowerCase();
  if (PAID_MEDIUMS.has(medium)) return true;
  if (typeof search !== "string" || !search) return false;
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  return Boolean(params.get("gclid") || params.get("gbraid") || params.get("wbraid"));
}

/**
 * True for Google Search / Google for Jobs organic landings. Never returns the referrer.
 *
 * @param {{
 *   referrer?: string,
 *   search?: string,
 *   utm?: Record<string, string>,
 * }} [input]
 */
export function detectGoogleForJobsLanding(input = {}) {
  const utm = input.utm ?? readUtmFromLocation(input.search ?? "");
  if (isPaidAcquisition(utm, input.search)) return false;
  const source = (utm.utm_source ?? "").trim().toLowerCase();
  if (GOOGLE_JOBS_SOURCES.has(source)) return true;
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

  const pathname = normalizeJobsPathname(input.pathname);
  const currentUrl = jobsCaptureUrl({
    origin: input.origin,
    pathname,
    href: input.href,
  });
  const utm = readUtmFromLocation(input.search);
  const googleForJobs = !googleLandingSent && detectGoogleForJobsLanding({
    referrer: input.referrer,
    search: input.search,
    utm,
  });

  /** @type {Record<string, unknown>} */
  const properties = {
    $current_url: currentUrl,
    $pathname: pathname,
    path: pathname,
    surface,
    ...utm,
  };
  if (googleForJobs) properties.googleForJobs = true;

  const pageview = await captureLandingEvent({
    apiKey: input.apiKey,
    host: input.host,
    event: "$pageview",
    properties,
    distinctId: input.distinctId,
    fetchFn: input.fetchFn,
  });

  if (!googleForJobs) return pageview;

  googleLandingSent = true;
  await captureLandingEvent({
    apiKey: input.apiKey,
    host: input.host,
    event: JOBS_EVENTS.GOOGLE_FOR_JOBS_LANDING,
    properties: {
      $current_url: currentUrl,
      $pathname: pathname,
      path: pathname,
      surface,
      ...utm,
    },
    distinctId: input.distinctId,
    fetchFn: input.fetchFn,
  });
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
    host: input.host,
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
  if (!browserConfig?.apiKey) return;
  if (!isJobsCopyKind(copyKind)) return;
  if (typeof window === "undefined") return;
  void captureJobsCopyClicked({
    apiKey: browserConfig.apiKey,
    host: browserConfig.host,
    copyKind,
    pathname: window.location.pathname,
    origin: window.location.origin,
  });
}
