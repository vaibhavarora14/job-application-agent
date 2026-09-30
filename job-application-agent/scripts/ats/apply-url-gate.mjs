/**
 * Apply URL allowlist + LIVE_APPLY hard-gate.
 *
 * Prove/smoke/E2E/apply runners must refuse non-allowlisted URLs unless
 * LIVE_APPLY=1 (explicit, logged). Owned fixtures are the CI default;
 * vendor-sandbox entries are optional demos, never real employers.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALLOWLIST_PATH = join(HERE, "../../fixtures/test-jobs.json");

/** Hosts that may serve owned `/fixtures/...` pages (local + production). */
export const FIXTURE_HOSTS = Object.freeze([
  "jobappagent.com",
  "www.jobappagent.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

export const APPLY_KINDS = Object.freeze(["fixture", "vendor-sandbox", "live"]);

/**
 * @typedef {{
 *   id: string,
 *   url: string,
 *   ats?: string,
 *   kind: "fixture" | "vendor-sandbox",
 *   allowSubmit?: boolean,
 *   title?: string,
 *   pathPrefixes?: string[],
 *   hostPathPrefixes?: { host: string, pathPrefix: string }[],
 *   requiresTitleContains?: string,
 * }} ApplyAllowlistEntry
 */

/** @type {ApplyAllowlistEntry[] | null} */
let cachedAllowlist = null;

/**
 * @param {string} [path]
 * @returns {ApplyAllowlistEntry[]}
 */
export function loadApplyAllowlist(path = DEFAULT_ALLOWLIST_PATH) {
  if (path === DEFAULT_ALLOWLIST_PATH && cachedAllowlist) return cachedAllowlist;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error("test-jobs.json must be an array.");
  for (const entry of raw) {
    if (!entry?.id || !entry?.url || !entry?.kind) throw new Error("Allowlist entries need id, url, and kind.");
    if (entry.kind !== "fixture" && entry.kind !== "vendor-sandbox") {
      throw new Error(`Allowlist entry ${entry.id} has invalid kind ${entry.kind}.`);
    }
  }
  if (path === DEFAULT_ALLOWLIST_PATH) cachedAllowlist = Object.freeze(raw.map((e) => Object.freeze({ ...e })));
  return path === DEFAULT_ALLOWLIST_PATH ? cachedAllowlist : raw;
}

/**
 * @param {string | URL} value
 * @returns {URL}
 */
export function parseApplyUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    throw new Error(`Invalid apply URL: ${value}`);
  }
}

/**
 * @param {string} pathname
 * @param {string} prefix
 */
function pathMatchesPrefix(pathname, prefix) {
  const path = pathname.replace(/\/+$/, "") || "/";
  const normalizedPrefix = prefix.replace(/\/+$/, "") || "/";
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

/**
 * @param {ApplyAllowlistEntry} entry
 * @param {URL} url
 * @param {{ pageTitle?: string }} [opts]
 */
function entryMatches(entry, url, opts = {}) {
  if (entry.requiresTitleContains) {
    const title = String(opts.pageTitle ?? "");
    if (!title.includes(entry.requiresTitleContains)) return false;
    // Title-gated sandboxes may appear on any host path for that ATS vendor
    // once the title marker is present (e.g. Ashby "[ASHBY] - For Testing Use Only").
    if (entry.ats === "ashby") {
      return /(^|\.)ashbyhq\.com$/i.test(url.hostname);
    }
    return true;
  }

  if (Array.isArray(entry.pathPrefixes) && entry.pathPrefixes.length) {
    if (!FIXTURE_HOSTS.includes(url.hostname.toLowerCase())) return false;
    return entry.pathPrefixes.some((prefix) => pathMatchesPrefix(url.pathname, prefix));
  }

  if (Array.isArray(entry.hostPathPrefixes) && entry.hostPathPrefixes.length) {
    return entry.hostPathPrefixes.some(({ host, pathPrefix }) => {
      if (url.hostname.toLowerCase() !== String(host).toLowerCase()) return false;
      return pathMatchesPrefix(url.pathname, pathPrefix);
    });
  }

  try {
    const canonical = new URL(entry.url);
    return (
      url.hostname.toLowerCase() === canonical.hostname.toLowerCase()
      && pathMatchesPrefix(url.pathname, canonical.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * @param {string | URL} url
 * @param {{ pageTitle?: string, allowlist?: ApplyAllowlistEntry[] }} [opts]
 * @returns {ApplyAllowlistEntry | null}
 */
export function findAllowlistedApply(url, opts = {}) {
  const parsed = parseApplyUrl(url);
  const allowlist = opts.allowlist ?? loadApplyAllowlist();
  for (const entry of allowlist) {
    if (entryMatches(entry, parsed, opts)) return entry;
  }
  return null;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isLiveApplyEnabled(env = process.env) {
  return env.LIVE_APPLY === "1" || env.LIVE_APPLY === "true";
}

/**
 * Whether prove/smoke/E2E/apply runners should enforce the allowlist.
 * Hosted interactive buyer sessions can set APPLY_URL_GATE=0.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function shouldEnforceApplyUrlGate(env = process.env) {
  if (env.APPLY_URL_GATE === "0" || env.APPLY_URL_GATE === "off") return false;
  if (env.APPLY_URL_GATE === "1" || env.APPLY_URL_GATE === "on") return true;
  if (env.PROVE_APPLY === "1" || env.SMOKE_APPLY === "1" || env.E2E_APPLY === "1") return true;
  return env.CI === "true" || env.CI === "1";
}

/**
 * @param {string | URL} url
 * @param {{
 *   liveApply?: boolean,
 *   pageTitle?: string,
 *   allowlist?: ApplyAllowlistEntry[],
 *   env?: NodeJS.ProcessEnv,
 *   log?: (message: string) => void,
 * }} [opts]
 * @returns {{
 *   allowed: true,
 *   entry: ApplyAllowlistEntry | null,
 *   applyKind: "fixture" | "vendor-sandbox" | "live",
 *   liveApply: boolean,
 * }}
 */
export function assertApplyUrlAllowed(url, opts = {}) {
  const env = opts.env ?? process.env;
  const liveApply = opts.liveApply ?? isLiveApplyEnabled(env);
  const log = opts.log ?? ((message) => {
    if (typeof process !== "undefined" && process.stderr) process.stderr.write(`${message}\n`);
  });
  const entry = findAllowlistedApply(url, { pageTitle: opts.pageTitle, allowlist: opts.allowlist });
  if (entry) {
    return {
      allowed: true,
      entry,
      applyKind: entry.kind,
      liveApply: false,
    };
  }
  if (liveApply) {
    log(`[LIVE_APPLY] Allowing non-allowlisted apply URL (explicit ops escape): ${url}`);
    return {
      allowed: true,
      entry: null,
      applyKind: "live",
      liveApply: true,
    };
  }
  throw new Error(
    `Apply URL is not on the fixture/vendor-sandbox allowlist: ${url}. `
    + "Use owned fixtures (see job-application-agent/fixtures/) or set LIVE_APPLY=1 for a one-off real employer apply.",
  );
}

/**
 * Soft check used when the gate is optional.
 * @param {string | URL} url
 * @param {Parameters<typeof assertApplyUrlAllowed>[1]} [opts]
 */
export function checkApplyUrlAllowed(url, opts = {}) {
  try {
    return { ok: true, ...assertApplyUrlAllowed(url, opts) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve ledger applyKind from URL (and optional explicit value).
 * @param {string | URL} url
 * @param {{ applyKind?: string, pageTitle?: string, allowlist?: ApplyAllowlistEntry[] }} [opts]
 * @returns {"fixture" | "vendor-sandbox" | "live"}
 */
export function resolveApplyKind(url, opts = {}) {
  if (opts.applyKind != null) {
    const kind = String(opts.applyKind).toLowerCase();
    if (!APPLY_KINDS.includes(kind)) throw new Error(`applyKind must be one of ${APPLY_KINDS.join(", ")}.`);
    return /** @type {"fixture" | "vendor-sandbox" | "live"} */ (kind);
  }
  const entry = findAllowlistedApply(url, opts);
  return entry?.kind ?? "live";
}

/**
 * @param {{ applyKind?: string } | null | undefined} entry
 */
export function isFixtureOrSandboxApply(entry) {
  const kind = entry?.applyKind ?? "live";
  return kind === "fixture" || kind === "vendor-sandbox";
}
