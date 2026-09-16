#!/usr/bin/env node
/**
 * Hosted fill session binding — local-only contract so a paused attention run
 * can reattach to the same headed Chrome tab / display / VNC path.
 *
 * Never syncs to cloud state (browser profile paths stay on the runner host).
 *
 * Hard product rule: live noVNC must share the fill display
 *   DISPLAY=:99 → x11vnc → localhost:5900
 * TigerVNC :1 / 5901 is a product failure (cold desktop / wrong session).
 *
 * Usage:
 *   node scripts/session-binding.mjs write --stdin
 *   node scripts/session-binding.mjs read --attention-id attention-…
 *   node scripts/session-binding.mjs check --stdin
 *   node scripts/session-binding.mjs path --attention-id attention-…
 */

import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const SESSION_BINDING_VERSION = 1;

/** Fill display on agent-box (Xvfb). */
export const FILL_DISPLAY = ":99";

/** x11vnc port that mirrors FILL_DISPLAY. */
export const FILL_VNC_PORT = 5900;

/** TigerVNC default — must never be the live panel target. */
export const FORBIDDEN_VNC_PORT = 5901;

/** TigerVNC display — never the fill/live share. */
export const FORBIDDEN_DISPLAY = ":1";

/**
 * @typedef {{
 *   version: number,
 *   attentionId: string,
 *   jobUrl: string,
 *   applicationId?: string,
 *   roundId?: string,
 *   browserProfilePath: string,
 *   display: string,
 *   vncPort: number,
 *   tabHint?: { title?: string, urlContains?: string },
 *   createdAt: string,
 *   pausedAt?: string,
 * }} SessionBinding
 */

/**
 * @param {unknown} input
 * @returns {{ ok: true, binding: SessionBinding } | { ok: false, error: string }}
 */
export function validateSessionBinding(input) {
  const value = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : null;
  if (!value) return { ok: false, error: "session_binding_required" };

  const attentionId = trimString(value.attentionId);
  const jobUrl = trimString(value.jobUrl ?? value.url);
  const browserProfilePath = trimString(value.browserProfilePath);
  const display = normalizeDisplay(value.display ?? FILL_DISPLAY);
  const vncPort = normalizePort(value.vncPort ?? FILL_VNC_PORT);
  const applicationId = optionalTrim(value.applicationId);
  const roundId = optionalTrim(value.roundId);
  const createdAt = optionalTrim(value.createdAt) || new Date().toISOString();
  const pausedAt = optionalTrim(value.pausedAt) || createdAt;

  if (!attentionId) return { ok: false, error: "attentionId_required" };
  if (!jobUrl) return { ok: false, error: "jobUrl_required" };
  if (!isHttpUrl(jobUrl)) return { ok: false, error: "jobUrl_invalid" };
  if (!browserProfilePath) return { ok: false, error: "browserProfilePath_required" };
  if (browserProfilePath.length > 1024) return { ok: false, error: "browserProfilePath_too_long" };
  if (!display) return { ok: false, error: "display_required" };
  if (display === FORBIDDEN_DISPLAY) {
    return { ok: false, error: "display_forbidden_tiger_vnc_use_fill_display_:99" };
  }
  if (display !== FILL_DISPLAY) {
    return { ok: false, error: `display_must_be_${FILL_DISPLAY}` };
  }
  if (vncPort == null) return { ok: false, error: "vncPort_invalid" };
  if (vncPort === FORBIDDEN_VNC_PORT) {
    return { ok: false, error: "vncPort_forbidden_5901_use_fill_x11vnc_5900" };
  }
  if (vncPort !== FILL_VNC_PORT) {
    return { ok: false, error: `vncPort_must_be_${FILL_VNC_PORT}` };
  }

  /** @type {SessionBinding["tabHint"] | undefined} */
  let tabHint;
  if (value.tabHint != null) {
    if (typeof value.tabHint !== "object") return { ok: false, error: "tabHint_invalid" };
    const hint = /** @type {Record<string, unknown>} */ (value.tabHint);
    const title = optionalTrim(hint.title);
    const urlContains = optionalTrim(hint.urlContains ?? hint.urlPattern);
    if (title || urlContains) {
      tabHint = {
        ...(title ? { title } : {}),
        ...(urlContains ? { urlContains } : {}),
      };
    }
  }

  /** @type {SessionBinding} */
  const binding = {
    version: SESSION_BINDING_VERSION,
    attentionId,
    jobUrl,
    browserProfilePath,
    display,
    vncPort,
    createdAt,
    pausedAt,
    ...(applicationId ? { applicationId } : {}),
    ...(roundId ? { roundId } : {}),
    ...(tabHint ? { tabHint } : {}),
  };

  // P1.5: optional judgment prompts for resume inject (never candidate responses).
  if (Array.isArray(value.questions) && value.questions.length) {
    binding.questions = value.questions
      .slice(0, 8)
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const id = trimString(item.id).slice(0, 120);
        const prompt = trimString(item.prompt).slice(0, 800);
        if (!id || !prompt) return null;
        return {
          id,
          prompt,
          kind: trimString(item.kind || "judgment").slice(0, 40) || "judgment",
          required: item.required !== false,
        };
      })
      .filter(Boolean);
  }
  if (value.aiAssistanceDiscouraged === true) {
    binding.aiAssistanceDiscouraged = true;
  }

  return { ok: true, binding };
}

/**
 * Build a binding from attention pause fields (skill helper).
 * @param {{
 *   attentionId: string,
 *   jobUrl: string,
 *   browserProfilePath: string,
 *   applicationId?: string,
 *   roundId?: string,
 *   display?: string,
 *   vncPort?: number,
 *   tabHint?: { title?: string, urlContains?: string },
 *   createdAt?: string,
 * }} fields
 */
export function createSessionBinding(fields) {
  const result = validateSessionBinding({
    ...fields,
    display: fields.display ?? FILL_DISPLAY,
    vncPort: fields.vncPort ?? FILL_VNC_PORT,
  });
  if (!result.ok) throw new Error(result.error);
  return result.binding;
}

/**
 * Compare live page URL against bound jobUrl. Refuse resume on drift.
 * @param {string} boundJobUrl
 * @param {string} livePageUrl
 * @param {{ urlContains?: string }} [tabHint]
 */
export function assertSameTab(boundJobUrl, livePageUrl, tabHint = {}) {
  const bound = trimString(boundJobUrl);
  const live = trimString(livePageUrl);
  if (!bound || !live) {
    return { ok: false, reason: "url_missing", message: "Bound jobUrl and live page URL are required." };
  }
  let boundOriginPath;
  let liveOriginPath;
  try {
    boundOriginPath = canonicalizeUrlForTab(bound);
    liveOriginPath = canonicalizeUrlForTab(live);
  } catch {
    return { ok: false, reason: "url_invalid", message: "Could not parse bound or live URL." };
  }

  const hint = trimString(tabHint?.urlContains);
  if (hint && !live.toLowerCase().includes(hint.toLowerCase())) {
    return {
      ok: false,
      reason: "tab_hint_mismatch",
      message: `Live URL does not contain tabHint.urlContains (${hint}). Refuse resume — do not open a cold listing.`,
    };
  }

  if (boundOriginPath === liveOriginPath) {
    return { ok: true, reason: "exact", message: "Live tab matches bound jobUrl." };
  }

  // Confirmation pages may append a path segment or query onto the filled form URL.
  // Never accept a shorter listing URL as a match (that is cold-tab drift).
  const boundBase = boundOriginPath.split("?")[0];
  const liveBase = liveOriginPath.split("?")[0];
  if (
    liveBase === boundBase
    || liveBase.startsWith(`${boundBase}/`)
    || (liveOriginPath.startsWith(`${boundBase}?`) && liveBase === boundBase)
  ) {
    return { ok: true, reason: "same_application_path", message: "Live tab is on the same application path family." };
  }

  return {
    ok: false,
    reason: "tab_drift",
    message: [
      "Live tab URL drifted from the paused filled form.",
      `bound=${boundOriginPath}`,
      `live=${liveOriginPath}`,
      "Refuse resume submit. Re-open the filled application tab or fail closed.",
    ].join(" "),
  };
}

/**
 * Default local path for a binding (never cloud).
 * @param {string} stateDir
 * @param {string} attentionId
 */
export function sessionBindingPath(stateDir, attentionId) {
  const id = trimString(attentionId);
  if (!id) throw new Error("attentionId_required");
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(stateDir, "session-bindings", `${safe}.json`);
}

/**
 * @param {string} filePath
 * @param {SessionBinding} binding
 */
export async function writeSessionBindingFile(filePath, binding) {
  const checked = validateSessionBinding(binding);
  if (!checked.ok) throw new Error(checked.error);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(checked.binding, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => {});
  return checked.binding;
}

/**
 * @param {string} filePath
 * @returns {Promise<SessionBinding | null>}
 */
export async function readSessionBindingFile(filePath) {
  try {
    await access(filePath);
  } catch {
    return null;
  }
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  const checked = validateSessionBinding(raw);
  if (!checked.ok) throw new Error(`invalid_session_binding: ${checked.error}`);
  return checked.binding;
}

/**
 * Extract optional local-only binding fields from an attention add payload.
 * These must never be appended to the cloud attention event.
 * @param {Record<string, unknown>} value
 */
export function extractSessionBindingFields(value) {
  const keys = ["browserProfilePath", "display", "vncPort", "tabHint"];
  /** @type {Record<string, unknown>} */
  const out = {};
  let present = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] != null) {
      out[key] = value[key];
      present = true;
    }
  }
  return present ? out : null;
}

export const SESSION_BINDING_ATTENTION_KEYS = Object.freeze([
  "browserProfilePath",
  "display",
  "vncPort",
  "tabHint",
]);

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalTrim(value) {
  const s = trimString(value);
  return s || undefined;
}

function normalizeDisplay(value) {
  const raw = trimString(value);
  if (!raw) return "";
  return raw.startsWith(":") ? raw : `:${raw}`;
}

function normalizePort(value) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalizeUrlForTab(value) {
  const url = new URL(value);
  url.hash = "";
  // Drop common tracking params; keep ATS path identity.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) url.searchParams.delete(key);
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.origin}${path}${url.search}`;
}

function resolveStateDir(env = process.env) {
  return trimString(env.JOB_APPLICATION_AGENT_STATE_DIR)
    || join(trimString(env.HOME) || "/tmp", ".job-application-agent");
}

/**
 * @param {string[]} argv
 */
export function parseSessionBindingArgs(argv) {
  const args = { command: "", attentionId: "", help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (!args.command && !flag.startsWith("-")) {
      args.command = flag;
    } else if (flag === "--attention-id" || flag === "--id") {
      args.attentionId = String(next ?? "").trim();
      i += 1;
    } else if (flag === "--stdin") {
      args.stdin = true;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else if (flag.startsWith("-")) {
      throw new Error(`Unknown flag: ${flag}`);
    } else {
      rest.push(flag);
    }
  }
  args.rest = rest;
  return args;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("stdin_json_required");
  return JSON.parse(text);
}

function printHelp() {
  console.log(`Usage:
  node scripts/session-binding.mjs write --stdin
  node scripts/session-binding.mjs read --attention-id <id>
  node scripts/session-binding.mjs check --stdin
  node scripts/session-binding.mjs path --attention-id <id>

write stdin JSON:
  { "attentionId", "jobUrl", "browserProfilePath",
    "applicationId?", "roundId?", "display?" (default :99),
    "vncPort?" (default 5900), "tabHint?" }

Hard rule: display=:99, vncPort=5900. Never 5901 / :1.
Bindings are local-only under $JOB_APPLICATION_AGENT_STATE_DIR/session-bindings/.
`);
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseSessionBindingArgs(argv);
  } catch (error) {
    console.error(`[session-binding] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }
  if (args.help || !args.command) {
    printHelp();
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const stateDir = resolveStateDir();

  if (args.command === "check") {
    const input = args.stdin ? await readStdinJson() : {};
    const result = validateSessionBinding(input);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (args.command === "path") {
    if (!args.attentionId) {
      console.error("[session-binding] --attention-id is required");
      process.exitCode = 1;
      return;
    }
    console.log(sessionBindingPath(stateDir, args.attentionId));
    return;
  }

  if (args.command === "read") {
    if (!args.attentionId) {
      console.error("[session-binding] --attention-id is required");
      process.exitCode = 1;
      return;
    }
    const file = sessionBindingPath(stateDir, args.attentionId);
    const binding = await readSessionBindingFile(file);
    if (!binding) {
      console.error(`[session-binding] not found: ${file}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(binding, null, 2));
    return;
  }

  if (args.command === "write") {
    const input = args.stdin ? await readStdinJson() : {};
    if (args.attentionId && !input.attentionId) input.attentionId = args.attentionId;
    const checked = validateSessionBinding(input);
    if (!checked.ok) {
      console.error(`[session-binding] ${checked.error}`);
      process.exitCode = 1;
      return;
    }
    const file = sessionBindingPath(stateDir, checked.binding.attentionId);
    await writeSessionBindingFile(file, checked.binding);
    console.log(JSON.stringify({ ok: true, path: file, binding: checked.binding }, null, 2));
    return;
  }

  console.error(`[session-binding] unknown command: ${args.command}`);
  printHelp();
  process.exitCode = 1;
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  || process.argv[1]?.endsWith("session-binding.mjs");

if (isDirect) {
  main().catch((error) => {
    console.error(`[session-binding] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
