#!/usr/bin/env node
/**
 * Resume → submit loop guidance after attention-runner-poll exit 0.
 *
 * Pure decision engine over a page snapshot + session binding. Does not drive
 * the browser itself — Antigravity / Playwright / CDP injects the snapshot.
 *
 * Flow:
 *   resume_requested → renew lease → load session binding → same-tab check →
 *   inject approved answers (P1.5) → re-inspect blockers →
 *   optional CAPTCHA vendor (default Off) → submit if clear →
 *   wait for visible confirmation → intent-confirm / ledger guidance
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
 *  14  inject_answers (fill approved narrative textareas, then re-probe)
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
import {
  buildAnswerInjectPlan,
  shouldInjectAnswersBeforeSubmit,
} from "./ats/answer-inject.mjs";
import { tryCaptchaVendorAssist } from "./captcha-vendor.mjs";

export const RESUME_EXIT = Object.freeze({
  SUBMITTED: 0,
  ERROR: 1,
  STILL_BLOCKED: 10,
  TAB_OR_BINDING: 11,
  AWAITING_CONFIRM: 12,
  READY_TO_SUBMIT: 13,
  INJECT_ANSWERS: 14,
});

/**
 * @typedef {{
 *   pageUrl: string,
 *   pageTitle?: string,
 *   pageText?: string,
 *   pageHtml?: string,
 *   visibleTexts?: string[],
 *   submitEnabled?: boolean,
 *   submitPresent?: boolean,
 *   matchedBlockerSelectors?: string[],
 *   matchedConfirmationSelectors?: string[],
 *   submitAlreadyClicked?: boolean,
 *   leaseHeld?: boolean,
 *   answersInjected?: boolean,
 *   narrativeFields?: object[],
 *   sitekey?: string,
 *   challengeType?: string,
 * }} ResumePageSnapshot
 */

/**
 * @param {{
 *   binding: object | null,
 *   snapshot: ResumePageSnapshot,
 *   signal?: string,
 *   answers?: { questionId: string, text: string, source?: string, prompt?: string }[],
 *   captchaAssist?: object | null,
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

  const answers = Array.isArray(input.answers) ? input.answers : [];
  const injectGate = shouldInjectAnswersBeforeSubmit({ answers });
  if (injectGate.inject && !snapshot.answersInjected) {
    const questions = Array.isArray(binding.questions) ? binding.questions : [];
    const injectPlan = buildAnswerInjectPlan({
      answers,
      questions,
      fields: snapshot.narrativeFields,
      pageUrl: snapshot.pageUrl,
    });
    return {
      action: "inject_answers",
      exitCode: RESUME_EXIT.INJECT_ANSWERS,
      message: "Approved attention answers ready — inject into matching textareas on the bound tab, then re-inspect.",
      injectPlan,
      adapterId: adapter.id,
      binding,
      next: [
        "Fill mapped textareas from injectPlan.fills (Ashby textarea selectors preferred)",
        "Re-run resume probe with answersInjected:true",
        "Do not treat draft text as approved unless source is typed|draft_approved|bank",
      ],
    };
  }

  const blockers = detectAbsoluteBlockers(snapshot, { mode: "resume" });
  if (blockers.blocked) {
    const captchaAssist = input.captchaAssist ?? null;
    return {
      action: "still_blocked",
      exitCode: RESUME_EXIT.STILL_BLOCKED,
      message: `Absolute blockers still present: ${blockers.blockers.join(", ")}. Update attention honestly; stay paused.`,
      blockers: blockers.blockers,
      adapterId: adapter.id,
      binding,
      probe,
      captchaAssist: blockers.blockers.includes("captcha") ? captchaAssist : undefined,
      next: [
        "attention add/update with remaining blockers + requiredActions",
        "Keep same-tab session binding; renew lease while waiting",
        "Do not submit",
        captchaAssist && captchaAssist.reason === "vendor_off"
          ? "CAPTCHA_VENDOR=off — use live panel complete-captcha (default)"
          : null,
      ].filter(Boolean),
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
    "4. Load approved answers from poll payload (answers[]) / signal",
    "5. Inject answers into matching textareas (Ashby-first), then re-inspect",
    "6. Re-inspect live DOM (blockers, required fields). Do not trust prior fill memory.",
    "7. CAPTCHA_VENDOR=off by default — live panel for captcha; vendor assist only when explicitly enabled",
    "8. If still blocked → update attention honestly; keep binding; do not submit",
    "9. If clear → SUBMIT (no extra in-app confirm). Prefer Ashby/generic submit selectors.",
    "10. Wait for visible confirmation surface (selectors / thank-you URL)",
    "11. Only then: cloud intent-confirm / ledger add. filled ≠ applied.",
    "12. If submit ambiguous → intent-sent; never retry until verified",
    "13. attention resolve; continue round or release lease",
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
  --stdin               Page snapshot JSON on stdin (optional answers[])
  --checklist           Print resume→submit checklist and exit 0
  --signal <name>       Default resume_requested

Page snapshot fields:
  pageUrl (required), pageTitle?, pageText?, visibleTexts?[],
  submitEnabled?, submitPresent?, matchedBlockerSelectors?[],
  matchedConfirmationSelectors?[], submitAlreadyClicked?, leaseHeld?,
  answersInjected?, narrativeFields?[]

Exit codes:
  0  submitted_confirmed
 10  still_blocked / submit_unavailable
 11  tab_drift / binding missing / lease lost
 12  submit_ambiguous (awaiting confirm)
 13  ready_to_submit
 14  inject_answers (P1.5 — fill textareas then re-probe)
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
  const answers = Array.isArray(input.answers) ? input.answers : (snapshot.answers ?? []);

  // Single CAPTCHA vendor call site — no-ops when CAPTCHA_VENDOR=off (default).
  let captchaAssist = null;
  const provisionalBlockers = detectAbsoluteBlockers({
    pageUrl: snapshot.pageUrl,
    pageText: snapshot.pageText,
    pageHtml: snapshot.pageHtml,
    visibleTexts: snapshot.visibleTexts,
    matchedBlockerSelectors: snapshot.matchedBlockerSelectors,
  }, { mode: "resume" });
  if (provisionalBlockers.blockers.includes("captcha")) {
    captchaAssist = await tryCaptchaVendorAssist({
      snapshot: {
        pageUrl: snapshot.pageUrl,
        pageText: snapshot.pageText,
        pageHtml: snapshot.pageHtml,
        matchedBlockerSelectors: snapshot.matchedBlockerSelectors,
        sitekey: snapshot.sitekey,
        challengeType: snapshot.challengeType,
      },
    });
  }

  const decision = decideResumeSubmit({
    binding,
    snapshot: {
      pageUrl: snapshot.pageUrl,
      pageTitle: snapshot.pageTitle,
      pageText: snapshot.pageText,
      pageHtml: snapshot.pageHtml,
      visibleTexts: snapshot.visibleTexts,
      submitEnabled: snapshot.submitEnabled,
      submitPresent: snapshot.submitPresent,
      matchedBlockerSelectors: snapshot.matchedBlockerSelectors,
      matchedConfirmationSelectors: snapshot.matchedConfirmationSelectors,
      submitAlreadyClicked: snapshot.submitAlreadyClicked,
      leaseHeld: snapshot.leaseHeld,
      answersInjected: snapshot.answersInjected,
      narrativeFields: snapshot.narrativeFields,
    },
    signal: args.signal,
    answers,
    captchaAssist,
  });

  console.log(JSON.stringify({
    ok: decision.exitCode === RESUME_EXIT.SUBMITTED
      || decision.exitCode === RESUME_EXIT.READY_TO_SUBMIT
      || decision.exitCode === RESUME_EXIT.INJECT_ANSWERS,
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
