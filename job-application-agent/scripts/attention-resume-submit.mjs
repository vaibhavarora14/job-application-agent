#!/usr/bin/env node
/**
 * Resume → submit loop guidance after attention-runner-poll exit 0.
 *
 * Pure decision engine over a page snapshot + session binding. Does not drive
 * the browser itself — Antigravity / Playwright / CDP injects the snapshot.
 *
 * Flow:
 *   resume_requested → renew lease → load session binding → same-tab check →
 *   re-inspect blockers → submit if clear → wait for visible confirmation →
 *   intent-confirm / ledger guidance
 *
 * Usage:
 *   node scripts/attention-resume-submit.mjs --attention-id attention-… --stdin
 *   # stdin: page snapshot JSON (see decideResumeSubmit)
 *
 * Exit:
 *   0  submitted_confirmed (ledger guidance printed)
 *  10  still_blocked (re-open / update attention)
 *  11  tab_drift / binding missing
 *  12  submit_clicked_awaiting_confirm (ambiguous — intent-sent, no retry)
 *  13  ready_to_submit (DOM clear — agent should click submit then re-probe)
 *   1  error
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  assertSameTab,
  readSessionBindingFile,
  sessionBindingPath,
  FILL_DISPLAY,
  FILL_VNC_PORT,
} from "./session-binding.mjs";
import {
  buildSubmitProbePlan,
  detectAbsoluteBlockers,
  detectConfirmation,
  resolveAtsAdapter,
} from "./ats/submit-adapters.mjs";

export const RESUME_EXIT = Object.freeze({
  SUBMITTED: 0,
  ERROR: 1,
  STILL_BLOCKED: 10,
  TAB_OR_BINDING: 11,
  AWAITING_CONFIRM: 12,
  READY_TO_SUBMIT: 13,
});

/**
 * @typedef {{
 *   pageUrl: string,
 *   pageTitle?: string,
 *   pageText?: string,
 *   visibleTexts?: string[],
 *   submitEnabled?: boolean,
 *   submitPresent?: boolean,
 *   matchedBlockerSelectors?: string[],
 *   matchedConfirmationSelectors?: string[],
 *   submitAlreadyClicked?: boolean,
 *   leaseHeld?: boolean,
 * }} ResumePageSnapshot
 */

/**
 * @param {{
 *   binding: object | null,
 *   snapshot: ResumePageSnapshot,
 *   signal?: string,
 * }} input
 */
export function decideResumeSubmit(input) {
  const snapshot = input.snapshot && typeof input.snapshot === "object" ? input.snapshot : null;
  if (!snapshot || !String(snapshot.pageUrl ?? "").trim()) {
    return {
      action: "error",
      exitCode: RESUME_EXIT.ERROR,
      message: "pageUrl is required on the resume page snapshot.",
    };
  }

  if (input.signal && input.signal !== "resume_requested") {
    return {
      action: "ignore_signal",
      exitCode: RESUME_EXIT.ERROR,
      message: `Expected resume_requested signal; got ${input.signal}.`,
    };
  }

  if (snapshot.leaseHeld === false) {
    return {
      action: "session_expired",
      exitCode: RESUME_EXIT.TAB_OR_BINDING,
      message: "Lease lost during attention wait. Open new attention session-expired; fail closed. Do not submit.",
      next: [
        "attention add --stdin with blocker site-error / requiredActions review-form (or session-expired note in evidence path)",
        "Do not invent ledger success",
      ],
    };
  }

  const binding = input.binding;
  if (!binding) {
    return {
      action: "binding_missing",
      exitCode: RESUME_EXIT.TAB_OR_BINDING,
      message: [
        "Session binding missing for this attention id.",
        "Cannot prove same-tab fill session. Refuse cold navigation.",
        `Record binding at pause: display=${FILL_DISPLAY} vncPort=${FILL_VNC_PORT} browserProfilePath + jobUrl.`,
      ].join(" "),
    };
  }

  const tab = assertSameTab(binding.jobUrl, snapshot.pageUrl, binding.tabHint ?? {});
  if (!tab.ok) {
    return {
      action: "tab_drift",
      exitCode: RESUME_EXIT.TAB_OR_BINDING,
      message: tab.message,
      reason: tab.reason,
      binding,
      next: [
        "Focus the paused filled ATS tab (same Chrome profile / CDP session)",
        "Do not open a fresh jobs listing",
        "Re-run resume probe once the bound tab is focused",
      ],
    };
  }

  const adapter = resolveAtsAdapter(snapshot.pageUrl);
  const probe = buildSubmitProbePlan(snapshot.pageUrl);
  const confirmation = detectConfirmation(snapshot, adapter);
  if (confirmation.confirmed) {
    return {
      action: "submitted_confirmed",
      exitCode: RESUME_EXIT.SUBMITTED,
      message: "Visible ATS confirmation detected. Confirm intent / ledger only now. filled ≠ applied until this point.",
      confirmation,
      adapterId: adapter.id,
      binding,
      next: [
        "cloud intent-confirm --stdin (with cloudIntentId + leaseId) OR ledger add with cloudIntentId + cloudLeaseId",
        "attention resolve --stdin",
        "Continue round or release lease per policy",
      ],
    };
  }

  const blockers = detectAbsoluteBlockers(snapshot, { mode: "resume" });
  if (blockers.blocked) {
    return {
      action: "still_blocked",
      exitCode: RESUME_EXIT.STILL_BLOCKED,
      message: `Absolute blockers still present: ${blockers.blockers.join(", ")}. Update attention honestly; stay paused.`,
      blockers: blockers.blockers,
      adapterId: adapter.id,
      binding,
      probe,
      next: [
        "attention add/update with remaining blockers + requiredActions",
        "Keep same-tab session binding; renew lease while waiting",
        "Do not submit",
      ],
    };
  }

  if (snapshot.submitAlreadyClicked) {
    return {
      action: "submit_ambiguous",
      exitCode: RESUME_EXIT.AWAITING_CONFIRM,
      message: "Submit was clicked but confirmation is not visible. Mark intent-sent / sent-unverified. Never retry until verified.",
      adapterId: adapter.id,
      binding,
      probe,
      next: [
        "cloud intent-sent --stdin",
        "Do not click submit again",
        "Re-open attention if the candidate must check email/ATS manually",
      ],
    };
  }

  const submitPresent = snapshot.submitPresent !== false;
  const submitEnabled = snapshot.submitEnabled !== false;
  if (submitPresent && submitEnabled) {
    return {
      action: "ready_to_submit",
      exitCode: RESUME_EXIT.READY_TO_SUBMIT,
      message: "Re-inspect clear — submit if possible (golden-path bias). Click submit, then re-probe for confirmation.",
      adapterId: adapter.id,
      binding,
      probe,
      sameTab: tab,
      next: [
        `Click first enabled submit control matching: ${probe.submitSelectors.join(" | ")}`,
        "Wait for confirmation selectors / URL patterns",
        "Re-run this decision with matchedConfirmationSelectors or updated pageText",
        "Only after visible confirm: intent-confirm / ledger add",
      ],
    };
  }

  return {
    action: "submit_unavailable",
    exitCode: RESUME_EXIT.STILL_BLOCKED,
    message: "No enabled submit control after re-inspect. Stay paused / update attention — do not invent success.",
    adapterId: adapter.id,
    binding,
    probe,
    next: [
      "Verify the live tab is still the filled application form",
      "If fields were wiped, refill verified profile facts then re-probe",
      "If a new absolute gate appeared, record attention honestly",
    ],
  };
}

/**
 * Checklist printed for agents when poll exits 0 (even without a snapshot).
 */
export function resumeSubmitChecklist() {
  return [
    "1. cloud lease-renew (fail closed if lease lost → session-expired attention)",
    `2. Load session binding (display=${FILL_DISPLAY}, vncPort=${FILL_VNC_PORT}, browserProfilePath, jobUrl)`,
    "3. Focus the SAME filled ATS tab — never navigate to a cold jobs listing",
    "4. Re-inspect live DOM (blockers, required fields). Do not trust prior fill memory.",
    "5. If still blocked → update attention honestly; keep binding; do not submit",
    "6. If clear → SUBMIT (no extra in-app confirm). Prefer Ashby/generic submit selectors.",
    "7. Wait for visible confirmation surface (selectors / thank-you URL)",
    "8. Only then: cloud intent-confirm / ledger add. filled ≠ applied.",
    "9. If submit ambiguous → intent-sent; never retry until verified",
    "10. attention resolve; continue round or release lease",
  ];
}

function resolveStateDir(env = process.env) {
  const trimmed = String(env.JOB_APPLICATION_AGENT_STATE_DIR ?? "").trim();
  if (trimmed) return trimmed;
  return join(String(env.HOME ?? "/tmp").trim() || "/tmp", ".job-application-agent");
}

/**
 * @param {string[]} argv
 */
export function parseResumeSubmitArgs(argv) {
  const args = {
    attentionId: "",
    stdin: false,
    checklist: false,
    help: false,
    signal: "resume_requested",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--attention-id" || flag === "--id") {
      args.attentionId = String(next ?? "").trim();
      i += 1;
    } else if (flag === "--signal") {
      args.signal = String(next ?? "").trim();
      i += 1;
    } else if (flag === "--stdin") {
      args.stdin = true;
    } else if (flag === "--checklist") {
      args.checklist = true;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else if (flag.startsWith("-")) {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return args;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function printHelp() {
  console.log(`Usage: node scripts/attention-resume-submit.mjs [options]

Options:
  --attention-id <id>   Load local session binding for same-tab checks
  --stdin               Page snapshot JSON on stdin
  --checklist           Print resume→submit checklist and exit 0
  --signal <name>       Default resume_requested

Page snapshot fields:
  pageUrl (required), pageTitle?, pageText?, visibleTexts?[],
  submitEnabled?, submitPresent?, matchedBlockerSelectors?[],
  matchedConfirmationSelectors?[], submitAlreadyClicked?, leaseHeld?

Exit codes:
  0  submitted_confirmed
 10  still_blocked / submit_unavailable
 11  tab_drift / binding missing / lease lost
 12  submit_ambiguous (awaiting confirm)
 13  ready_to_submit
  1  error
`);
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseResumeSubmitArgs(argv);
  } catch (error) {
    console.error(`[resume-submit] ${error instanceof Error ? error.message : error}`);
    process.exitCode = RESUME_EXIT.ERROR;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }
  if (args.checklist) {
    for (const line of resumeSubmitChecklist()) console.log(line);
    return;
  }

  const input = args.stdin ? await readStdinJson() : {};
  const attentionId = args.attentionId || String(input.attentionId ?? "").trim();
  let binding = input.binding ?? null;
  if (!binding && attentionId) {
    const file = sessionBindingPath(resolveStateDir(), attentionId);
    binding = await readSessionBindingFile(file);
  }

  const snapshot = input.snapshot ?? input;
  const decision = decideResumeSubmit({
    binding,
    snapshot: {
      pageUrl: snapshot.pageUrl,
      pageTitle: snapshot.pageTitle,
      pageText: snapshot.pageText,
      visibleTexts: snapshot.visibleTexts,
      submitEnabled: snapshot.submitEnabled,
      submitPresent: snapshot.submitPresent,
      matchedBlockerSelectors: snapshot.matchedBlockerSelectors,
      matchedConfirmationSelectors: snapshot.matchedConfirmationSelectors,
      submitAlreadyClicked: snapshot.submitAlreadyClicked,
      leaseHeld: snapshot.leaseHeld,
    },
    signal: args.signal,
  });

  console.log(JSON.stringify({
    ok: decision.exitCode === RESUME_EXIT.SUBMITTED || decision.exitCode === RESUME_EXIT.READY_TO_SUBMIT,
    ...decision,
    checklist: resumeSubmitChecklist(),
  }, null, 2));
  process.exitCode = decision.exitCode;
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  || process.argv[1]?.endsWith("attention-resume-submit.mjs");

if (isDirect) {
  main().catch((error) => {
    console.error(`[resume-submit] ${error instanceof Error ? error.message : error}`);
    process.exitCode = RESUME_EXIT.ERROR;
  });
}
