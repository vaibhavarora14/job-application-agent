/**
 * ATS fill plans. Browser automation stays outside this module: a runner passes
 * the page HTML (or a fixture file) and receives fill instructions or an
 * attention pause.
 *
 * Greenhouse, Ashby, and Lever stay on their existing submit adapters.
 * Workday phase 1 (issue #195) only fills. It stops on Review, never clicks
 * Submit, and records nothing as submitted. Fill is fixture-tested; submit is
 * not. The public compare page stays "listed but not yet submitted to or tested".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectAbsoluteBlockers } from "./submit-adapters.mjs";

const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/workday/", import.meta.url));

/**
 * Code-level coverage note. Do not copy this onto the public compare page:
 * submit is intentionally not tested in this phase.
 */
export const WORKDAY_FILL_COVERAGE = Object.freeze({
  issue: 195,
  phase: 1,
  fillTested: true,
  submitTested: false,
  stopsBeforeSubmit: true,
  recordsSubmission: false,
  publicCompareStatus: "listed-not-submitted-or-tested",
  steps: Object.freeze([
    "my-information",
    "my-experience",
    "application-questions",
    "voluntary-disclosures",
    "review",
  ]),
  pauses: Object.freeze([
    "account-creation",
    "sign-in",
    "captcha",
    "legal",
    "demographic",
  ]),
});

const LIVE_WORKDAY_HOST = /(^|\.)myworkdayjobs\.com$|(^|\.)myworkday\.com$|(^|\.)myworkdaysite\.com$/i;

/** Pauses that use the existing attention blocker and required-action enums. */
export const FILL_PAUSE_ATTENTION = Object.freeze({
  authentication: Object.freeze({ stage: "application", blocker: "authentication", requiredActions: Object.freeze(["sign-in"]) }),
  mfa: Object.freeze({ stage: "application", blocker: "mfa", requiredActions: Object.freeze(["complete-mfa"]) }),
  captcha: Object.freeze({ stage: "application", blocker: "captcha", requiredActions: Object.freeze(["complete-captcha"]) }),
  "legal-attestation": Object.freeze({ stage: "legal", blocker: "legal-attestation", requiredActions: Object.freeze(["review-legal"]) }),
  demographic: Object.freeze({ stage: "demographic", blocker: "demographic", requiredActions: Object.freeze(["choose-demographic"]) }),
  "government-id": Object.freeze({ stage: "application", blocker: "government-id", requiredActions: Object.freeze(["provide-government-id"]) }),
  judgment: Object.freeze({ stage: "questions", blocker: "judgment", requiredActions: Object.freeze(["provide-judgment"]) }),
  "ambiguous-authorization": Object.freeze({ stage: "questions", blocker: "ambiguous-authorization", requiredActions: Object.freeze(["provide-authorization"]) }),
  "ambiguous-compensation": Object.freeze({ stage: "questions", blocker: "ambiguous-compensation", requiredActions: Object.freeze(["provide-compensation"]) }),
});

const PAUSE_PRIORITY = Object.freeze([
  "authentication",
  "mfa",
  "captcha",
  "legal-attestation",
  "demographic",
  "government-id",
  "judgment",
  "ambiguous-authorization",
  "ambiguous-compensation",
]);

/** Auth and CAPTCHA stay paused until the candidate leaves that page. */
const NEVER_AUTO_RESOLVE = new Set(["authentication", "mfa", "captcha"]);

const BLOCKER_FROM_HINT = Object.freeze({
  captcha: "captcha",
  authentication: "authentication",
  mfa: "mfa",
  "legal-attestation": "legal-attestation",
  judgment: "judgment",
  "government-id": "government-id",
  demographic: "demographic",
});

const FILL_RULES = Object.freeze([
  { key: "firstName", re: /first name|given name/i, category: "contact" },
  { key: "lastName", re: /last name|family name|surname/i, category: "contact" },
  { key: "email", re: /e-?mail/i, category: "contact" },
  { key: "phone", re: /\bphone\b|\bmobile\b/i, category: "contact" },
  { key: "postalCode", re: /postal|zip code/i, category: "location" },
  { key: "country", re: /\bcountry\b/i, category: "location" },
  { key: "location", re: /address line|\bcity\b|\blocation\b/i, category: "location" },
  { key: "linkedin", re: /linkedin/i, category: "links" },
  { key: "resume", re: /r[eé]sum[eé]|curriculum vitae|\bcv\b/i, category: "resume", upload: true },
  { key: "workAuthorization", re: /authorized to work|legally authorized|work authorization/i, category: "authorization", choice: "authorization" },
  { key: "sponsorship", re: /sponsor/i, category: "authorization", choice: "sponsorship" },
  { key: "jobTitle", re: /job title|position title/i, category: "experience" },
  { key: "company", re: /\bcompany\b|\bemployer\b/i, category: "experience" },
  { key: "startDate", re: /start date/i, category: "experience" },
  { key: "school", re: /\bschool\b|\buniversity\b|\binstitution\b/i, category: "experience" },
  { key: "degree", re: /\bdegree\b/i, category: "experience" },
]);

const STEP_FROM_TEXT = Object.freeze([
  ["create-account", /create account/i],
  ["sign-in", /sign in|log in/i],
  ["my-information", /my information/i],
  ["my-experience", /my experience/i],
  ["application-questions", /application questions/i],
  ["voluntary-disclosures", /voluntary disclosures|self-identification/i],
  ["review", /\breview\b/i],
]);

/**
 * @param {string} url
 */
export function assertNotLiveWorkdayTenant(url) {
  let host = "";
  try {
    host = new URL(String(url)).hostname;
  } catch {
    return;
  }
  if (LIVE_WORKDAY_HOST.test(host)) {
    throw new Error(
      `Refusing live Workday tenant ${host}. Fixture runs must use local HTML under fixtures/workday/.`,
    );
  }
}

/**
 * @param {string} [fixturesDir]
 */
export function loadWorkdayFixtures(fixturesDir = FIXTURE_DIR) {
  const read = (name) => readFileSync(join(fixturesDir, name), "utf8");
  const page = (name, url) => {
    assertNotLiveWorkdayTenant(url);
    return { url, html: read(name) };
  };
  const base = "https://jobappagent.com/fixtures/workday";
  return {
    createAccount: page("index.html", `${base}/`),
    signIn: page("sign-in.html", `${base}/sign-in.html`),
    captcha: page("captcha.html", `${base}/captcha.html`),
    legal: page("application-questions-legal.html", `${base}/application-questions-legal.html`),
    judgment: page("application-questions-judgment.html", `${base}/application-questions-judgment.html`),
    steps: WORKDAY_FILL_COVERAGE.steps.map((step) => page(`${step}.html`, `${base}/${step}.html`)),
  };
}

/**
 * @param {string} html
 */
function textContent(html) {
  return String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} raw
 */
function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s"'=<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
  let match;
  while ((match = re.exec(String(raw ?? "")))) {
    const key = match[1].toLowerCase();
    if (match[2] !== undefined) attrs[key] = match[2];
    else if (match[3] !== undefined) attrs[key] = match[3];
    else attrs[key] = "";
  }
  return attrs;
}

/**
 * @param {string} label
 */
function cleanLabel(label) {
  return textContent(label).replace(/\s*\*$/, "").trim();
}

/**
 * @param {string} html
 */
function stepFromText(html) {
  const text = textContent(html);
  for (const [step, pattern] of STEP_FROM_TEXT) {
    if (pattern.test(text)) return step;
  }
  return "unknown";
}

/**
 * @param {string} html
 */
function labelMap(html) {
  const map = new Map();
  const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = parseAttrs(match[1]);
    if (/<input\b|<select\b|<textarea\b/i.test(match[2])) continue;
    if (attrs.for) map.set(attrs.for, cleanLabel(match[2]));
  }
  return map;
}

/**
 * @param {string} inner
 */
function parseOptions(inner) {
  const options = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let match;
  while ((match = re.exec(inner))) {
    const attrs = parseAttrs(match[1]);
    const label = textContent(match[2]);
    options.push({ value: attrs.value ?? label, label });
  }
  return options;
}

/**
 * @param {Record<string, string>} attrs
 * @param {string} label
 * @param {{ kind: string, options?: { value: string, label: string }[] }} extra
 */
function controlFrom(attrs, label, extra) {
  return {
    kind: extra.kind,
    id: attrs.id ?? "",
    name: attrs.name ?? "",
    label,
    required: Object.hasOwn(attrs, "required"),
    inputType: (attrs.type ?? extra.kind).toLowerCase(),
    options: extra.options ?? [],
  };
}

/**
 * @param {string} inner
 */
function parseFieldset(inner) {
  const legend = inner.match(/<legend\b[^>]*>([\s\S]*?)<\/legend>/i);
  const label = legend ? cleanLabel(legend[1]) : "";
  const options = [];
  let name = "";
  let id = "";
  let required = false;
  let kind = "radio";
  const labelRe = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let match;
  while ((match = labelRe.exec(inner))) {
    const input = match[2].match(/<input\b([^>]*?)\/?>/i);
    if (!input) continue;
    const attrs = parseAttrs(input[1]);
    const type = (attrs.type ?? "text").toLowerCase();
    if (type !== "radio" && type !== "checkbox") continue;
    kind = type === "checkbox" ? "checkbox" : "radio";
    name = name || attrs.name || "";
    id = id || attrs.id || "";
    if (Object.hasOwn(attrs, "required")) required = true;
    options.push({
      value: attrs.value ?? "on",
      label: cleanLabel(match[2].replace(/<input\b[^>]*\/?>/i, " ")),
    });
  }
  if (!options.length) return null;
  return {
    kind: options.length > 1 && kind === "checkbox" ? "radio" : kind,
    id,
    name,
    label,
    required,
    inputType: kind,
    options,
  };
}

/**
 * @param {string} scope
 */
export function parseFormControls(scope) {
  const controls = [];
  let rest = scope.replace(/<fieldset\b[^>]*>([\s\S]*?)<\/fieldset>/gi, (full, inner) => {
    const control = parseFieldset(inner);
    if (control) controls.push(control);
    return "";
  });

  rest = rest.replace(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi, (full, attrText, inner) => {
    if (!/<input\b/i.test(inner)) return full;
    const attrs = parseAttrs((inner.match(/<input\b([^>]*?)\/?>/i) ?? [, ""])[1]);
    const type = (attrs.type ?? "text").toLowerCase();
    const label = cleanLabel(inner.replace(/<input\b[^>]*\/?>/i, " "));
    const kind = type === "checkbox" || type === "radio"
      ? type
      : type === "file"
        ? "file"
        : type === "password"
          ? "password"
          : "text";
    controls.push(controlFrom(attrs, label, {
      kind,
      options: kind === "checkbox" || kind === "radio"
        ? [{ value: attrs.value ?? "on", label }]
        : [],
    }));
    return "";
  });

  const labels = labelMap(rest);
  const labelFor = (attrs) => labels.get(attrs.id ?? "") || labels.get(attrs.name ?? "") || attrs.name || attrs.id || "";

  rest.replace(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi, (full, attrText, inner) => {
    const attrs = parseAttrs(attrText);
    controls.push(controlFrom(attrs, labelFor(attrs), { kind: "select", options: parseOptions(inner) }));
    return "";
  });
  rest.replace(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi, (full, attrText) => {
    const attrs = parseAttrs(attrText);
    controls.push(controlFrom(attrs, labelFor(attrs), { kind: "textarea" }));
    return "";
  });
  rest.replace(/<input\b([^>]*?)\/?>/gi, (full, attrText) => {
    const attrs = parseAttrs(attrText);
    const type = (attrs.type ?? "text").toLowerCase();
    if (type === "hidden" || type === "submit" || type === "button") return "";
    const kind = type === "file" ? "file" : type === "password" ? "password" : type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : "text";
    controls.push(controlFrom(attrs, labelFor(attrs), { kind }));
    return "";
  });
  return controls;
}

/**
 * @param {string} html
 */
function parseButtons(html) {
  const buttons = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = parseAttrs(match[1]);
    buttons.push({
      type: (attrs.type ?? "submit").toLowerCase(),
      action: attrs["data-action"] ?? "",
      text: textContent(match[2]),
      id: attrs.id ?? "",
      automationId: attrs["data-automation-id"] ?? "",
    });
  }
  return buttons;
}

/**
 * @param {string} text
 */
function isContinueText(text) {
  return /save and continue|^continue$|^next$/i.test(String(text ?? "").trim());
}

/**
 * @param {{ action?: string, text?: string, type?: string }} button
 */
function isSubmitButton(button) {
  if (button.action === "submit" || button.action === "create-account" || button.action === "sign-in") return true;
  if (/^submit(\s+application)?$/i.test(String(button.text ?? "").trim())) return true;
  if (button.type === "submit" && !isContinueText(button.text) && button.action !== "continue") return true;
  return false;
}

/**
 * @param {{ action?: string, text?: string, type?: string }} button
 */
function buttonRole(button) {
  if (button.action === "create-account" || /create account/i.test(button.text ?? "")) return "account";
  if (button.action === "sign-in" || /^sign in$/i.test(String(button.text ?? "").trim())) return "sign-in";
  if (button.action === "continue" || isContinueText(button.text)) return "continue";
  if (isSubmitButton(button)) return "submit";
  return "other";
}

/**
 * @param {{ action?: string, text?: string, automationId?: string }} button
 */
function buttonSelector(button) {
  if (button.action) return `button[data-action="${button.action}"]`;
  if (button.automationId) return `button[data-automation-id="${button.automationId}"]`;
  if (buttonRole(button) === "submit") return 'button[type="submit"]';
  return "button";
}

/**
 * @param {{ id?: string, name?: string, kind?: string }} control
 * @param {string} [optionValue]
 */
function controlSelector(control, optionValue) {
  if ((control.kind === "radio" || control.kind === "checkbox") && control.name && optionValue != null) {
    return `input[name="${control.name}"][value="${optionValue}"]`;
  }
  if (control.id) return `#${control.id}`;
  if (control.name) return `[name="${control.name}"]`;
  return null;
}

/**
 * @param {object[]} buttons
 * @param {boolean} clickContinue
 */
function planClicks(buttons, clickContinue) {
  return buttons.map((button) => {
    const role = buttonRole(button);
    return {
      role,
      selector: buttonSelector(button),
      text: button.text,
      click: clickContinue && role === "continue",
    };
  });
}

/**
 * @param {string} label
 */
function controlPause(control) {
  if (control.kind === "password" || control.inputType === "password") return "authentication";
  const label = String(control.label ?? "");
  if (/gender|race|ethnicity|veteran|disability|hispanic|latino|voluntary disclosure|self-identif/i.test(label)) return "demographic";
  if (/i agree|terms of use|privacy policy|\backnowledge\b/i.test(label)) return "legal-attestation";
  if (/passport|government issued id|driver'?s license/i.test(label)) return "government-id";
  if (/why (?:do )?you (?:want to )?work|in your own words|cover letter/i.test(label)) return "judgment";
  if (/desired (?:salary|compensation)|compensation expectation|pay expectation/i.test(label)) return "ambiguous-compensation";
  return null;
}

/**
 * @param {string} html
 */
function hasCaptcha(html) {
  return /g-recaptcha|h-captcha|hcaptcha|cf-turnstile|data-testid=["']captcha|recaptcha/i.test(html);
}

/**
 * @param {object} profile
 */
function splitName(profile) {
  if (profile.firstName || profile.lastName) {
    return { firstName: String(profile.firstName ?? "").trim(), lastName: String(profile.lastName ?? "").trim() };
  }
  const parts = String(profile.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * @param {object} profile
 * @param {string} key
 */
function profileValue(profile, key) {
  const name = splitName(profile ?? {});
  const job = Array.isArray(profile?.experience) ? profile.experience[0] : null;
  const school = Array.isArray(profile?.education) ? profile.education[0] : null;
  const values = {
    firstName: name.firstName,
    lastName: name.lastName,
    email: profile?.email ?? "",
    phone: profile?.phone ?? "",
    location: profile?.location ?? profile?.city ?? "",
    country: profile?.country ?? "",
    postalCode: profile?.postalCode ?? "",
    linkedin: profile?.linkedin ?? "",
    jobTitle: job?.title ?? profile?.currentTitle ?? "",
    company: job?.company ?? "",
    startDate: job?.start ?? "",
    school: school?.school ?? "",
    degree: school?.degree ?? "",
  };
  return String(values[key] ?? "").trim();
}

/**
 * @param {object} profile
 */
function authorizationChoice(profile) {
  const value = String(profile?.workAuthorization ?? "").trim().toLowerCase();
  if (!value || /unclear|unknown|\bask\b/.test(value)) return null;
  if (/not authorized|no authorization|ineligible/.test(value)) return "no";
  if (/authorized|citizen|permanent resident|green card/.test(value)) return "yes";
  return null;
}

/**
 * @param {object} profile
 */
function sponsorshipChoice(profile) {
  if (profile?.requiresSponsorship === true) return "yes";
  if (profile?.requiresSponsorship === false) return "no";
  const value = String(profile?.requiresSponsorship ?? "").trim().toLowerCase();
  if (value === "yes" || value === "no") return value;
  return null;
}

/**
 * @param {{ kind: string, options?: { value: string, label: string }[] }} control
 * @param {string} desired
 */
function matchChoice(control, desired) {
  const want = String(desired).trim().toLowerCase();
  if (!want) return null;
  const options = (control.options ?? []).filter((option) => String(option.value ?? "").trim());
  const exact = options.find((option) => option.value.toLowerCase() === want || option.label.toLowerCase() === want);
  if (exact) return exact.value;
  const partial = options.find((option) => option.label.toLowerCase().includes(want) || want.includes(option.label.toLowerCase()));
  return partial?.value ?? null;
}

/**
 * @param {string} blocker
 * @param {string} step
 */
function pauseKind(blocker, step) {
  if (blocker === "authentication" && step === "create-account") return "account-creation";
  if (blocker === "authentication") return "sign-in";
  if (blocker === "legal-attestation") return "legal";
  if (blocker === "demographic") return "demographic";
  if (blocker === "captcha") return "captcha";
  return blocker;
}

/**
 * @param {string[]} blockers
 */
function highestPause(blockers) {
  for (const id of PAUSE_PRIORITY) {
    if (blockers.includes(id)) return id;
  }
  return null;
}

/**
 * @param {string} blocker
 * @param {string} step
 * @param {string} pageUrl
 * @param {{ label: string }[]} judgmentControls
 */
function attentionFor(blocker, step, pageUrl, judgmentControls) {
  const spec = FILL_PAUSE_ATTENTION[blocker] ?? FILL_PAUSE_ATTENTION.authentication;
  const questions = blocker === "judgment"
    ? judgmentControls.slice(0, 4).map((control) => ({
      prompt: control.label,
      kind: /why/i.test(control.label) ? "why-us" : "judgment",
      required: true,
    }))
    : [];
  return {
    url: pageUrl,
    stage: spec.stage,
    blocker: spec.blocker,
    requiredActions: [...spec.requiredActions],
    ...(questions.length ? { questions } : {}),
    pauseKind: pauseKind(blocker, step),
  };
}

/**
 * @param {{
 *   pageUrl?: string,
 *   pageHtml?: string,
 *   html?: string,
 *   profile?: object,
 *   resolvedBlockers?: string[],
 * }} input
 */
export function planWorkdayFill(input = {}) {
  const pageUrl = String(input.pageUrl ?? input.url ?? "");
  const html = String(input.pageHtml ?? input.html ?? "");
  const profile = input.profile ?? {};
  const resolved = new Set(Array.isArray(input.resolvedBlockers) ? input.resolvedBlockers : []);
  const main = html.match(/<main\b([^>]*)>([\s\S]*?)<\/main>/i);
  const mainAttrs = main ? parseAttrs(main[1]) : {};
  const scope = main ? main[2] : html;
  const step = mainAttrs["data-step"] || stepFromText(scope);
  const controls = parseFormControls(scope);
  const buttons = parseButtons(scope);
  const pauses = [];

  if (step === "create-account" || step === "sign-in") pauses.push("authentication");
  if (step === "voluntary-disclosures") pauses.push("demographic");
  if (hasCaptcha(scope)) pauses.push("captcha");

  const absolute = detectAbsoluteBlockers({
    pageText: textContent(scope),
    matchedBlockerSelectors: hasCaptcha(scope) ? ["captcha"] : [],
  });
  for (const hint of absolute.blockers) {
    const mapped = BLOCKER_FROM_HINT[hint];
    if (mapped) pauses.push(mapped);
  }

  const fills = [];
  const unfilledRequired = [];
  const judgmentControls = [];

  for (const control of controls) {
    const sensitive = controlPause(control);
    if (sensitive) {
      pauses.push(sensitive);
      if (sensitive === "judgment") judgmentControls.push(control);
      continue;
    }
    const rule = FILL_RULES.find((candidate) => candidate.re.test(control.label));
    if (!rule) {
      if (control.required) unfilledRequired.push({ name: control.name || control.id, label: control.label });
      continue;
    }
    if (rule.upload || control.kind === "file") {
      fills.push({
        name: control.name || control.id,
        id: control.id || null,
        label: control.label,
        category: "resume",
        action: "upload_canonical_resume",
        selector: controlSelector(control),
      });
      continue;
    }
    if (rule.choice) {
      const choice = rule.choice === "sponsorship" ? sponsorshipChoice(profile) : authorizationChoice(profile);
      const selected = choice ? matchChoice(control, choice) : null;
      if (!selected) {
        if (control.required) pauses.push("ambiguous-authorization");
        continue;
      }
      fills.push({
        name: control.name || control.id,
        id: control.id || null,
        label: control.label,
        category: rule.category,
        action: "select",
        value: selected,
        selector: controlSelector(control, selected),
      });
      continue;
    }
    const raw = profileValue(profile, rule.key);
    if (!raw) {
      if (control.required) unfilledRequired.push({ name: control.name || control.id, label: control.label });
      continue;
    }
    const selected = control.kind === "select" ? matchChoice(control, raw) : raw;
    if (!selected) {
      if (control.required) unfilledRequired.push({ name: control.name || control.id, label: control.label });
      continue;
    }
    fills.push({
      name: control.name || control.id,
      id: control.id || null,
      label: control.label,
      category: rule.category,
      action: control.kind === "select" ? "select" : "fill",
      value: selected,
      selector: controlSelector(control, control.kind === "select" ? selected : undefined),
    });
  }

  const blocker = highestPause(pauses);
  const base = {
    adapterId: "workday",
    step,
    pageUrl,
    submitted: false,
    recordSubmission: false,
    ledgerEntry: null,
    telemetryEvent: null,
    note: "Workday fill is fixture-tested (phase 1). Submit is not tested. Do not record a submission.",
  };

  if (blocker && !(resolved.has(blocker) && !NEVER_AUTO_RESOLVE.has(blocker))) {
    const blockedFills = NEVER_AUTO_RESOLVE.has(blocker) || blocker === "demographic" ? [] : fills;
    return {
      ...base,
      action: "pause",
      pauseKind: pauseKind(blocker, step),
      fills: blockedFills,
      unfilledRequired,
      clicks: planClicks(buttons, false),
      attention: attentionFor(blocker, step, pageUrl, judgmentControls),
    };
  }

  if (blocker && resolved.has(blocker)) {
    return {
      ...base,
      action: "pause_resolved_skip_sensitive",
      pauseKind: pauseKind(blocker, step),
      fills: blocker === "demographic" ? [] : fills,
      unfilledRequired: [],
      clicks: planClicks(buttons, false),
      attention: null,
    };
  }

  const submitButtons = buttons.filter((button) => buttonRole(button) === "submit");
  const continueButton = buttons.some((button) => buttonRole(button) === "continue");
  if (step === "review" || (!continueButton && submitButtons.length)) {
    return {
      ...base,
      action: "stop_before_submit",
      fills: [],
      unfilledRequired,
      clicks: planClicks(buttons, false),
      attention: null,
    };
  }

  if (unfilledRequired.length) {
    return {
      ...base,
      action: "needs_profile",
      fills,
      unfilledRequired,
      clicks: planClicks(buttons, false),
      attention: null,
    };
  }

  return {
    ...base,
    action: "fill",
    fills,
    unfilledRequired,
    clicks: planClicks(buttons, true),
    attention: null,
  };
}

/**
 * Attention payload for `attention add --stdin`. Prompts only; never answers,
 * passwords, CAPTCHA tokens, or demographic choices.
 *
 * @param {ReturnType<typeof planWorkdayFill>} plan
 * @param {{ roundId: string, applicationId: string }} ids
 */
export function toAttentionItem(plan, ids) {
  if (!plan?.attention) throw new Error("Workday plan has no attention pause.");
  const item = {
    roundId: ids.roundId,
    applicationId: ids.applicationId,
    url: plan.attention.url || plan.pageUrl,
    stage: plan.attention.stage,
    blocker: plan.attention.blocker,
    requiredActions: [...plan.attention.requiredActions],
  };
  if (plan.attention.questions?.length) item.questions = plan.attention.questions;
  return item;
}

/**
 * Walk already-loaded Workday pages. Does not fetch. Stops on an unresolved
 * pause, on a missing required profile fact, and always on Review.
 *
 * @param {{ url: string, html: string }[]} pages
 * @param {object} profile
 * @param {{ resolvedBlockers?: string[], forbidLiveTenants?: boolean }} [options]
 */
export function walkWorkdayFill(pages, profile, options = {}) {
  const steps = [];
  for (const page of pages) {
    if (options.forbidLiveTenants !== false) assertNotLiveWorkdayTenant(page.url);
    const plan = planWorkdayFill({
      pageUrl: page.url,
      pageHtml: page.html,
      profile,
      resolvedBlockers: options.resolvedBlockers,
    });
    steps.push(plan);
    if (plan.action === "pause" || plan.action === "needs_profile" || plan.action === "stop_before_submit") {
      return finishWalk(plan.action === "stop_before_submit" ? "stopped_before_submit" : plan.action, steps);
    }
  }
  return finishWalk("incomplete", steps);
}

/**
 * @param {string} status
 * @param {ReturnType<typeof planWorkdayFill>[]} steps
 */
function finishWalk(status, steps) {
  const clicks = steps.flatMap((step) => step.clicks ?? []);
  return {
    adapterId: "workday",
    status: status === "pause" ? "paused" : status,
    submitted: false,
    recordSubmission: false,
    ledgerEntry: null,
    telemetryEvent: null,
    resumeFieldPresent: steps.some((step) => step.fills?.some((fill) => fill.action === "upload_canonical_resume")),
    fieldsFilled: steps.reduce((count, step) => count + (step.fills?.length ?? 0), 0),
    steps,
    clicks,
    attention: steps.find((step) => step.action === "pause")?.attention ?? null,
    stoppedAt: steps.at(-1)?.step ?? null,
  };
}

/**
 * Fixture walk. Refuses live Workday hosts and only reads local HTML.
 *
 * @param {object} profile
 * @param {{ resolvedBlockers?: string[], fixturesDir?: string, pages?: { url: string, html: string }[] }} [options]
 */
export function runWorkdayFixtureFill(profile, options = {}) {
  const pages = options.pages ?? loadWorkdayFixtures(options.fixturesDir).steps;
  return walkWorkdayFill(pages, profile, {
    resolvedBlockers: options.resolvedBlockers,
    forbidLiveTenants: true,
  });
}
