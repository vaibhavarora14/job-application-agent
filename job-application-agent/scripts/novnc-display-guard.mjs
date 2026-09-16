#!/usr/bin/env node
/**
 * Guard: live noVNC / websockify must target the fill x11vnc port (5900),
 * never TigerVNC (5901). Product failure if the buyer live panel shows a
 * cold XFCE / jobs listing instead of the paused filled ATS form.
 *
 * Usage:
 *   node scripts/novnc-display-guard.mjs
 *   node scripts/novnc-display-guard.mjs --unit /etc/systemd/system/novnc.service
 *   node scripts/novnc-display-guard.mjs --text "websockify ... localhost:5900"
 *   node scripts/novnc-display-guard.mjs --warn   # warn-only (exit 0 with warning)
 *
 * Exit: 0 ok · 1 misconfigured / forbidden target · 2 usage
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FILL_DISPLAY,
  FILL_VNC_PORT,
  FORBIDDEN_DISPLAY,
  FORBIDDEN_VNC_PORT,
} from "./session-binding.mjs";

export const NOVNC_GUARD_EXIT = Object.freeze({
  OK: 0,
  FAIL: 1,
  USAGE: 2,
});

/**
 * Inspect free-form service / command text for websockify VNC targets.
 * @param {string} text
 */
export function inspectNovncTargetText(text) {
  const raw = String(text ?? "");
  const findings = {
    fillPortMentions: [],
    forbiddenPortMentions: [],
    fillDisplayMentions: [],
    forbiddenDisplayMentions: [],
    websockifyTargets: [],
  };

  const portRe = /(?::|localhost\s+)\s*(5900|5901)\b|(?:^|[\s=])(5900|5901)\b/gi;
  let match;
  while ((match = portRe.exec(raw)) !== null) {
    const port = Number(match[1] || match[2]);
    if (port === FILL_VNC_PORT) findings.fillPortMentions.push(match[0].trim());
    if (port === FORBIDDEN_VNC_PORT) findings.forbiddenPortMentions.push(match[0].trim());
  }

  if (/(?:DISPLAY=):?99\b|(?:^|[\s]) :99\b/i.test(raw)) {
    findings.fillDisplayMentions.push(FILL_DISPLAY);
  }
  if (/(?:DISPLAY=):1\b|(?:listen|rfbport).*:1\b/i.test(raw)) {
    findings.forbiddenDisplayMentions.push(FORBIDDEN_DISPLAY);
  }

  // Scan host:port pairs on active websockify / proxy lines (skip comment-only).
  for (const line of raw.split(/\r?\n/)) {
    const active = line.replace(/#.*$/, "").trim();
    if (!active || !/websockify|novnc|vnc/i.test(active)) continue;
    const hostPort = active.match(/(127\.0\.0\.1|localhost|\[::1\])[:\s]+(5900|5901)\b/i);
    if (hostPort) {
      findings.websockifyTargets.push({
        host: hostPort[1],
        port: Number(hostPort[2]),
        line: active,
      });
    }
  }

  return findings;
}

/**
 * Decide pass/fail from inspect findings + optional explicit target.
 * @param {{
 *   text?: string,
 *   targetHost?: string,
 *   targetPort?: number,
 *   display?: string,
 * }} input
 */
export function evaluateNovncDisplayGuard(input = {}) {
  const text = String(input.text ?? "");
  const findings = text ? inspectNovncTargetText(text) : {
    fillPortMentions: [],
    forbiddenPortMentions: [],
    fillDisplayMentions: [],
    forbiddenDisplayMentions: [],
    websockifyTargets: [],
  };

  const forbiddenTargets = findings.websockifyTargets.filter((t) => t.port === FORBIDDEN_VNC_PORT);
  const fillTargets = findings.websockifyTargets.filter((t) => t.port === FILL_VNC_PORT);

  const targetPort = input.targetPort != null
    ? Number(input.targetPort)
    : (forbiddenTargets[0]?.port ?? fillTargets[0]?.port ?? findings.websockifyTargets[0]?.port);
  const targetHost = input.targetHost
    ?? forbiddenTargets[0]?.host
    ?? fillTargets[0]?.host
    ?? findings.websockifyTargets[0]?.host
    ?? null;
  const display = input.display
    ?? (findings.fillDisplayMentions[0] || findings.forbiddenDisplayMentions[0] || null);

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (forbiddenTargets.length || (input.targetPort != null && Number(input.targetPort) === FORBIDDEN_VNC_PORT)) {
    errors.push(
      `Live noVNC must not target TigerVNC port ${FORBIDDEN_VNC_PORT}. Use fill x11vnc localhost:${FILL_VNC_PORT} (DISPLAY=${FILL_DISPLAY}).`,
    );
  }
  if (findings.forbiddenDisplayMentions.length || display === FORBIDDEN_DISPLAY) {
    errors.push(
      `Display ${FORBIDDEN_DISPLAY} is TigerVNC — never the buyer live panel. Fill + live share DISPLAY=${FILL_DISPLAY}.`,
    );
  }

  if (targetPort != null && Number.isFinite(targetPort)) {
    if (targetPort === FORBIDDEN_VNC_PORT) {
      if (!errors.some((e) => e.includes(String(FORBIDDEN_VNC_PORT)))) {
        errors.push(`websockify target port ${FORBIDDEN_VNC_PORT} is forbidden.`);
      }
    } else if (targetPort !== FILL_VNC_PORT) {
      errors.push(`websockify target port must be ${FILL_VNC_PORT} (got ${targetPort}).`);
    }
  } else if (text && findings.websockifyTargets.length === 0 && findings.fillPortMentions.length === 0) {
    warnings.push(
      `No localhost:${FILL_VNC_PORT} websockify target found in unit/text — confirm novnc.service proxies fill x11vnc.`,
    );
  }

  // Mentions of 5901 in comments are fine when ExecStart clearly targets 5900.
  if (findings.forbiddenPortMentions.length && !forbiddenTargets.length && fillTargets.length) {
    warnings.push(
      `Text mentions ${FORBIDDEN_VNC_PORT} but websockify target is ${FILL_VNC_PORT} — OK if the mention is a "never use" comment.`,
    );
  } else if (findings.forbiddenPortMentions.length && !forbiddenTargets.length && !fillTargets.length && input.targetPort == null) {
    errors.push(
      `Live noVNC must not target TigerVNC port ${FORBIDDEN_VNC_PORT}. Use fill x11vnc localhost:${FILL_VNC_PORT} (DISPLAY=${FILL_DISPLAY}).`,
    );
  }

  if (targetHost && !/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(targetHost)) {
    warnings.push(`websockify host is ${targetHost}; prefer localhost/127.0.0.1 for fill x11vnc.`);
  }

  if (display && display !== FILL_DISPLAY && display !== FORBIDDEN_DISPLAY) {
    warnings.push(`Unexpected display ${display}; fill contract is ${FILL_DISPLAY}.`);
  }

  const ok = errors.length === 0;
  return {
    ok,
    hardRule: `live noVNC → localhost:${FILL_VNC_PORT} / DISPLAY=${FILL_DISPLAY} (never ${FORBIDDEN_VNC_PORT} / ${FORBIDDEN_DISPLAY})`,
    targetHost: targetHost ?? null,
    targetPort: targetPort ?? null,
    display: display ?? null,
    errors,
    warnings,
    findings,
  };
}

/**
 * @param {string[]} argv
 */
export function parseNovncGuardArgs(argv) {
  const args = { warnOnly: false, help: false, unitPath: "", text: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--unit" || flag === "--file") {
      args.unitPath = String(next ?? "").trim();
      i += 1;
    } else if (flag === "--text") {
      args.text = String(next ?? "");
      i += 1;
    } else if (flag === "--target-port") {
      args.targetPort = Number(next);
      i += 1;
    } else if (flag === "--target-host") {
      args.targetHost = String(next ?? "").trim();
      i += 1;
    } else if (flag === "--display") {
      args.display = String(next ?? "").trim();
      i += 1;
    } else if (flag === "--warn" || flag === "--warn-only") {
      args.warnOnly = true;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else if (flag.startsWith("-")) {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/novnc-display-guard.mjs [options]

Options:
  --unit <path>         systemd unit (or any file) to scan for websockify targets
  --text <string>       inspect inline command text
  --target-port <port>  explicit VNC backend port
  --target-host <host>  explicit VNC backend host
  --display <dpy>       explicit DISPLAY (expect ${FILL_DISPLAY})
  --warn                warn-only: print issues but exit 0 unless --target-port is forbidden

Hard rule: websockify → localhost:${FILL_VNC_PORT} (fill DISPLAY=${FILL_DISPLAY}).
Never ${FORBIDDEN_VNC_PORT} / TigerVNC ${FORBIDDEN_DISPLAY}.
`);
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseNovncGuardArgs(argv);
  } catch (error) {
    console.error(`[novnc-guard] ${error instanceof Error ? error.message : error}`);
    process.exitCode = NOVNC_GUARD_EXIT.USAGE;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }

  let text = args.text || "";
  if (args.unitPath) {
    try {
      text = await readFile(args.unitPath, "utf8");
    } catch (error) {
      console.error(`[novnc-guard] cannot read ${args.unitPath}: ${error instanceof Error ? error.message : error}`);
      process.exitCode = NOVNC_GUARD_EXIT.FAIL;
      return;
    }
  }

  if (!text && args.targetPort == null && !args.display) {
    // Default: check common agent-box unit path, else print rule + usage hint.
    const exampleUnit = fileURLToPath(new URL("../references/agent-box/novnc.service.example", import.meta.url));
    const defaults = [
      "/etc/systemd/system/novnc.service",
      "/etc/systemd/system/websockify.service",
      exampleUnit,
    ];
    for (const candidate of defaults) {
      try {
        text = await readFile(candidate, "utf8");
        console.error(`[novnc-guard] scanning ${candidate}`);
        break;
      } catch {
        /* try next */
      }
    }
  }

  if (!text && args.targetPort == null) {
    printHelp();
    console.error(`[novnc-guard] provide --unit, --text, or --target-port`);
    process.exitCode = NOVNC_GUARD_EXIT.USAGE;
    return;
  }

  const result = evaluateNovncDisplayGuard({
    text,
    targetPort: args.targetPort,
    targetHost: args.targetHost,
    display: args.display,
  });

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    for (const err of result.errors) console.error(`[novnc-guard] FAIL: ${err}`);
    process.exitCode = args.warnOnly ? NOVNC_GUARD_EXIT.OK : NOVNC_GUARD_EXIT.FAIL;
    return;
  }
  for (const warn of result.warnings) console.error(`[novnc-guard] WARN: ${warn}`);
  console.error(`[novnc-guard] OK — ${result.hardRule}`);
  process.exitCode = NOVNC_GUARD_EXIT.OK;
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  || process.argv[1]?.endsWith("novnc-display-guard.mjs");

if (isDirect) {
  main().catch((error) => {
    console.error(`[novnc-guard] ${error instanceof Error ? error.message : error}`);
    process.exitCode = NOVNC_GUARD_EXIT.FAIL;
  });
}
