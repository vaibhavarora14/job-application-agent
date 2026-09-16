/**
 * ATS-agnostic resume submit / confirmation helpers.
 *
 * Pure selector + classification data for the hosted resume→submit loop.
 * Browser automation (Playwright/CDP) stays outside this module — the runner
 * injects a page snapshot; these helpers decide the next action.
 *
 * Prefer submit after resume when the DOM is clear (golden-path submit bias).
 * filled ≠ applied until a visible confirmation surface is observed.
 */

/** Absolute blockers that must stay paused for a human. */
export const ABSOLUTE_BLOCKER_HINTS = Object.freeze([
  { id: "captcha", patterns: [/recaptcha/i, /hcaptcha/i, /captcha/i, /cf-turnstile/i] },
  { id: "authentication", patterns: [/sign in/i, /log in/i, /sso/i, /single sign-on/i, /verify your identity/i] },
  { id: "mfa", patterns: [/two-factor/i, /2fa/i, /authenticator/i, /enter (the )?code/i, /one-time password/i] },
  { id: "legal-attestation", patterns: [/i agree/i, /terms of use/i, /privacy policy/i, /ai policy/i, /acknowledge/i] },
  { id: "judgment", patterns: [/why (do )?you (want to )?work/i, /cover letter/i, /in your own words/i] },
  { id: "government-id", patterns: [/passport/i, /driver'?s license/i, /government (issued )?id/i] },
  { id: "demographic", patterns: [/gender identity/i, /race\/ethnicity/i, /veteran status/i, /disability status/i] },
]);

/**
 * @typedef {{
 *   id: string,
 *   matchHosts?: RegExp[],
 *   submitSelectors: string[],
 *   confirmationSelectors: string[],
 *   confirmationUrlPatterns: RegExp[],
 *   blockerSelectors?: string[],
 * }} AtsSubmitAdapter
 */

/** @type {AtsSubmitAdapter} */
export const ASHBY_ADAPTER = Object.freeze({
  id: "ashby",
  matchHosts: [/ashbyhq\.com$/i, /jobs\.ashbyhq\.com$/i],
  submitSelectors: [
    'button[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Submit application")',
    '[data-testid="submit-application"]',
    'input[type="submit"]',
  ],
  confirmationSelectors: [
    "text=/thank you for applying/i",
    "text=/application (has been )?submitted/i",
    "text=/we.?ve received your application/i",
    '[data-testid="application-submitted"]',
    ".application-submitted",
  ],
  confirmationUrlPatterns: [
    /\/application-submitted\b/i,
    /[?&]submitted=1\b/i,
    /\/confirmation\b/i,
  ],
  blockerSelectors: [
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    ".g-recaptcha",
    "[data-testid='captcha']",
  ],
});

/** @type {AtsSubmitAdapter} */
export const GENERIC_ADAPTER = Object.freeze({
  id: "generic",
  submitSelectors: [
    'button[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Submit application")',
    'input[type="submit"][value*="Submit" i]',
  ],
  confirmationSelectors: [
    "text=/thank you for applying/i",
    "text=/application (has been )?submitted/i",
    "text=/we.?ve received your application/i",
    "text=/successfully submitted/i",
  ],
  confirmationUrlPatterns: [
    /\/thanks?\b/i,
    /\/confirmation\b/i,
    /\/application-submitted\b/i,
    /[?&]submitted=1\b/i,
  ],
  blockerSelectors: [
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    ".g-recaptcha",
  ],
});

export const ATS_ADAPTERS = Object.freeze([ASHBY_ADAPTER, GENERIC_ADAPTER]);

/**
 * @param {string} pageUrl
 * @returns {AtsSubmitAdapter}
 */
export function resolveAtsAdapter(pageUrl) {
  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return GENERIC_ADAPTER;
  }
  for (const adapter of ATS_ADAPTERS) {
    if (adapter.id === "generic") continue;
    if (adapter.matchHosts?.some((re) => re.test(host))) return adapter;
  }
  return GENERIC_ADAPTER;
}

/**
 * @param {{
 *   pageUrl?: string,
 *   pageText?: string,
 *   visibleTexts?: string[],
 *   matchedBlockerSelectors?: string[],
 * }} snapshot
 * @param {{ mode?: "pause" | "resume" }} [options]
 * @returns {{ blocked: boolean, blockers: string[] }}
 */
export function detectAbsoluteBlockers(snapshot = {}, options = {}) {
  const mode = options.mode === "resume" ? "resume" : "pause";
  const blockers = new Set();
  const haystack = [
    String(snapshot.pageText ?? ""),
    ...(Array.isArray(snapshot.visibleTexts) ? snapshot.visibleTexts : []),
  ].join("\n");

  // On resume, prefer active challenge signals — static legal/"why us" copy often
  // remains visible after the candidate already acted in the live panel.
  const hints = mode === "resume"
    ? ABSOLUTE_BLOCKER_HINTS.filter((hint) => ["captcha", "authentication", "mfa", "government-id"].includes(hint.id))
    : ABSOLUTE_BLOCKER_HINTS;

  for (const hint of hints) {
    if (hint.patterns.some((re) => re.test(haystack))) blockers.add(hint.id);
  }
  if (Array.isArray(snapshot.matchedBlockerSelectors) && snapshot.matchedBlockerSelectors.length) {
    blockers.add("captcha");
  }
  return { blocked: blockers.size > 0, blockers: [...blockers] };
}

/**
 * @param {{
 *   pageUrl?: string,
 *   matchedConfirmationSelectors?: string[],
 *   pageText?: string,
 * }} snapshot
 * @param {AtsSubmitAdapter} [adapter]
 */
export function detectConfirmation(snapshot = {}, adapter) {
  const resolved = adapter ?? resolveAtsAdapter(snapshot.pageUrl ?? "");
  const url = String(snapshot.pageUrl ?? "");
  if (resolved.confirmationUrlPatterns.some((re) => re.test(url))) {
    return { confirmed: true, reason: "url_pattern", adapterId: resolved.id };
  }
  if (Array.isArray(snapshot.matchedConfirmationSelectors) && snapshot.matchedConfirmationSelectors.length) {
    return {
      confirmed: true,
      reason: "confirmation_selector",
      adapterId: resolved.id,
      matched: snapshot.matchedConfirmationSelectors,
    };
  }
  const text = String(snapshot.pageText ?? "");
  if (/thank you for applying|application (has been )?submitted|we.?ve received your application/i.test(text)) {
    return { confirmed: true, reason: "confirmation_text", adapterId: resolved.id };
  }
  return { confirmed: false, reason: "not_found", adapterId: resolved.id };
}

/**
 * Guidance payload for a browser tool (selectors only — no automation here).
 * @param {string} pageUrl
 */
export function buildSubmitProbePlan(pageUrl) {
  const adapter = resolveAtsAdapter(pageUrl);
  return {
    adapterId: adapter.id,
    submitSelectors: [...adapter.submitSelectors],
    confirmationSelectors: [...adapter.confirmationSelectors],
    blockerSelectors: [...(adapter.blockerSelectors ?? [])],
    confirmationUrlPatterns: adapter.confirmationUrlPatterns.map((re) => re.source),
    notes: [
      "Focus the same filled ATS tab from session binding (never a cold jobs listing).",
      "If absolute blockers remain, update attention honestly — do not submit.",
      "If clear, click submit (submit bias). Wait for a visible confirmation surface.",
      "Only then: cloud intent-confirm / ledger add. filled ≠ applied.",
    ],
  };
}
