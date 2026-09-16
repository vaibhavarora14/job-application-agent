#!/usr/bin/env node
/**
 * GCP / Antigravity hosted-runner poll loop for attention resume signals.
 *
 * Polls GET /api/internal/attention-signals/:id with ATTENTION_NOTIFY_SECRET.
 * Exit codes are stable for shell loops / Antigravity task graphs:
 *
 *   0  resume_requested — renew lease, re-inspect ATS, submit only on visible confirm
 *  10  skipped          — resolve attention, no submit, continue round
 *  11  aborted          — release lease, end round
 *  20  timeout          — still waiting when --timeout elapsed
 *   1  hard error       — missing env, HTTP/auth failure, invalid args
 *
 * Env:
 *   ATTENTION_NOTIFY_SECRET  (required) Bearer for internal poll
 *   PUBLIC_SITE_URL          site origin, default https://jobappagent.com
 *   ATTENTION_NOTIFY_URL     optional; origin derived if PUBLIC_SITE_URL unset
 *
 * Usage:
 *   node scripts/attention-runner-poll.mjs --attention-id attention-…
 *   node scripts/attention-runner-poll.mjs --attention-id attention-… --interval 5 --timeout 3600
 */

import { pathToFileURL } from "node:url";

export const EXIT = Object.freeze({
  RESUME: 0,
  ERROR: 1,
  SKIPPED: 10,
  ABORTED: 11,
  TIMEOUT: 20,
});

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = { attentionId: "", intervalSec: 5, timeoutSec: 3600, once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--attention-id" || flag === "--id") {
      args.attentionId = String(next ?? "").trim();
      i += 1;
    } else if (flag === "--interval") {
      args.intervalSec = Number(next);
      i += 1;
    } else if (flag === "--timeout") {
      args.timeoutSec = Number(next);
      i += 1;
    } else if (flag === "--once") {
      args.once = true;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else if (flag.startsWith("-")) {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return args;
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function resolvePollConfig(env = process.env) {
  const secret = String(env.ATTENTION_NOTIFY_SECRET ?? "").trim();
  let siteUrl = String(env.PUBLIC_SITE_URL ?? env.ATTENTION_SITE_URL ?? "").trim();
  if (!siteUrl && env.ATTENTION_NOTIFY_URL) {
    try {
      siteUrl = new URL(env.ATTENTION_NOTIFY_URL).origin;
    } catch {
      siteUrl = "";
    }
  }
  if (!siteUrl) siteUrl = "https://jobappagent.com";
  return { secret, siteUrl };
}

/**
 * @param {string} siteUrl
 * @param {string} attentionId
 */
export function buildSignalPollUrl(siteUrl, attentionId) {
  const origin = new URL(siteUrl).origin;
  return new URL(`/api/internal/attention-signals/${encodeURIComponent(attentionId)}`, origin).toString();
}

/**
 * @param {object} poll
 */
export function interpretPoll(poll) {
  if (!poll || typeof poll !== "object") {
    return { done: false, waiting: true, action: "wait", message: "Empty poll body; keep waiting." };
  }
  if (poll.resumeRequested || poll.signal === "resume_requested") {
    return {
      done: true,
      exitCode: EXIT.RESUME,
      signal: "resume_requested",
      action: "resume",
      message: [
        "Signal: resume_requested",
        "Next: renew cloud lease → re-inspect the ATS page in the live browser →",
        "submit ONLY with visible confirmation → ledger intent-confirm.",
        "filled ≠ applied. If unsure, re-open attention honestly.",
      ].join(" "),
    };
  }
  if (poll.skipped || poll.signal === "skipped") {
    return {
      done: true,
      exitCode: EXIT.SKIPPED,
      signal: "skipped",
      action: "skip",
      message: [
        "Signal: skipped",
        "Next: attention resolve (no submit) → continue the round on other roles.",
      ].join(" "),
    };
  }
  if (poll.aborted || poll.signal === "aborted") {
    return {
      done: true,
      exitCode: EXIT.ABORTED,
      signal: "aborted",
      action: "abort",
      message: [
        "Signal: aborted",
        "Next: cloud lease-release → end the round. Do not submit.",
      ].join(" "),
    };
  }
  return {
    done: false,
    waiting: true,
    action: "wait",
    message: "No candidate signal yet (pending/null). Keep polling while lease held.",
  };
}

/**
 * @param {{
 *   attentionId: string,
 *   siteUrl: string,
 *   secret: string,
 *   intervalSec?: number,
 *   timeoutSec?: number,
 *   once?: boolean,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 */
export async function pollAttentionSignal(options) {
  const {
    attentionId,
    siteUrl,
    secret,
    intervalSec = 5,
    timeoutSec = 3600,
    once = false,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    log = console.log,
  } = options;

  if (!attentionId) return { ok: false, exitCode: EXIT.ERROR, error: "attention_id_required" };
  if (!secret) return { ok: false, exitCode: EXIT.ERROR, error: "ATTENTION_NOTIFY_SECRET missing" };

  let pollUrl;
  try {
    pollUrl = buildSignalPollUrl(siteUrl, attentionId);
  } catch {
    return { ok: false, exitCode: EXIT.ERROR, error: "site_url_invalid" };
  }

  const started = now();
  const deadline = started + Math.max(1, timeoutSec) * 1000;
  const intervalMs = Math.max(1, intervalSec) * 1000;

  log(`[attention-poll] watching ${attentionId}`);
  log(`[attention-poll] GET ${pollUrl} every ${intervalSec}s (timeout ${timeoutSec}s)`);

  while (true) {
    let response;
    try {
      response = await fetchImpl(pollUrl, {
        method: "GET",
        headers: {
          authorization: `Bearer ${secret}`,
          accept: "application/json",
        },
      });
    } catch (error) {
      return {
        ok: false,
        exitCode: EXIT.ERROR,
        error: `poll_request_failed: ${error instanceof Error ? error.message : "unknown"}`,
      };
    }

    if (response.status === 401) {
      return { ok: false, exitCode: EXIT.ERROR, error: "unauthorized — check ATTENTION_NOTIFY_SECRET" };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        exitCode: EXIT.ERROR,
        error: `poll_http_${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      };
    }

    const poll = await response.json().catch(() => null);
    const interpreted = interpretPoll(poll);
    if (interpreted.done) {
      log(`[attention-poll] ${interpreted.message}`);
      return {
        ok: true,
        exitCode: interpreted.exitCode,
        signal: interpreted.signal,
        action: interpreted.action,
        poll,
        message: interpreted.message,
      };
    }

    log(`[attention-poll] waiting… (${poll?.signal ?? "null"})`);
    if (once) {
      return {
        ok: true,
        exitCode: EXIT.TIMEOUT,
        action: "wait",
        poll,
        message: "No signal on --once poll.",
      };
    }
    if (now() >= deadline) {
      log("[attention-poll] timeout — still no resume/skip/abort signal");
      return {
        ok: false,
        exitCode: EXIT.TIMEOUT,
        error: "timeout",
        message: "Timeout waiting for candidate signal. Renew lease or re-notify.",
      };
    }
    await sleep(intervalMs);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/attention-runner-poll.mjs --attention-id <id> [options]

Options:
  --interval <sec>   Poll interval (default 5)
  --timeout <sec>    Max wait (default 3600)
  --once             Single poll then exit 20 if still waiting

Exit codes:
  0  resume_requested
 10  skipped
 11  aborted
 20  timeout / still waiting
  1  error

Env: ATTENTION_NOTIFY_SECRET, PUBLIC_SITE_URL (or ATTENTION_NOTIFY_URL origin)
`);
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`[attention-poll] ${error instanceof Error ? error.message : error}`);
    process.exitCode = EXIT.ERROR;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.attentionId) {
    console.error("[attention-poll] --attention-id is required");
    printHelp();
    process.exitCode = EXIT.ERROR;
    return;
  }
  if (!Number.isFinite(args.intervalSec) || args.intervalSec <= 0) {
    console.error("[attention-poll] --interval must be a positive number");
    process.exitCode = EXIT.ERROR;
    return;
  }
  if (!Number.isFinite(args.timeoutSec) || args.timeoutSec <= 0) {
    console.error("[attention-poll] --timeout must be a positive number");
    process.exitCode = EXIT.ERROR;
    return;
  }

  const { secret, siteUrl } = resolvePollConfig(process.env);
  const result = await pollAttentionSignal({
    attentionId: args.attentionId,
    siteUrl,
    secret,
    intervalSec: args.intervalSec,
    timeoutSec: args.timeoutSec,
    once: args.once,
  });

  if (!result.ok && result.error) {
    console.error(`[attention-poll] ${result.error}`);
  }
  process.exitCode = result.exitCode;
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  || process.argv[1]?.endsWith("attention-runner-poll.mjs");

if (isDirect) {
  main().catch((error) => {
    console.error(`[attention-poll] ${error instanceof Error ? error.message : error}`);
    process.exitCode = EXIT.ERROR;
  });
}
