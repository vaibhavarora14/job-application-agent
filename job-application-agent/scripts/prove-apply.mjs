#!/usr/bin/env node
/**
 * Prove/smoke helper: resolve default fixture apply URLs and hard-gate them.
 *
 * Always enforces the allowlist (PROVE_APPLY=1). Refuses real employer URLs
 * unless LIVE_APPLY=1.
 *
 *   node scripts/prove-apply.mjs
 *   node scripts/prove-apply.mjs --url https://jobappagent.com/fixtures/ashby/
 *   LIVE_APPLY=1 node scripts/prove-apply.mjs --url https://jobs.example.com/real
 */

import { pathToFileURL } from "node:url";
import {
  assertApplyUrlAllowed,
  loadApplyAllowlist,
} from "./ats/apply-url-gate.mjs";

function parseArgs(argv) {
  const out = { url: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") out.list = true;
    else if (arg === "--url") out.url = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`Usage: node scripts/prove-apply.mjs [--list] [--url <apply-url>]\n`);
    process.stdout.write(`Env: LIVE_APPLY=1 to allow a non-allowlisted real employer URL (logged).\n`);
    process.exit(0);
  }

  // Prove path always enforces; LIVE_APPLY is the only escape.
  process.env.PROVE_APPLY = "1";
  const allowlist = loadApplyAllowlist();

  if (args.list) {
    process.stdout.write(`${JSON.stringify(allowlist, null, 2)}\n`);
    return;
  }

  const defaults = allowlist.filter((e) => e.kind === "fixture" && e.allowSubmit);
  const targets = args.url ? [args.url] : defaults.map((e) => e.url);

  const results = targets.map((url) => {
    const gate = assertApplyUrlAllowed(url, { env: process.env });
    return {
      url,
      applyKind: gate.applyKind,
      allowlistId: gate.entry?.id ?? null,
      liveApply: gate.liveApply,
      allowSubmit: gate.entry?.allowSubmit ?? true,
    };
  });

  process.stdout.write(`${JSON.stringify({ ok: true, count: results.length, results }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
