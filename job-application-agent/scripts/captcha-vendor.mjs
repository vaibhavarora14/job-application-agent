/**
 * P2 CAPTCHA vendor scaffolding — gated Off by default.
 *
 * CAPTCHA_VENDOR=off|capsolver|2captcha (default off)
 * Never call vendors unless vendor≠off AND api key present AND buyer opt-in.
 * Fail closed to attention / live panel (complete-captcha).
 *
 * No cookie/session theft: solvers get only public page URL + sitekey + type.
 * Solving CAPTCHA is never "applied" — submit + visible confirm still required.
 */

export const CAPTCHA_VENDORS = Object.freeze(["off", "capsolver", "2captcha"]);

export const CAPTCHA_FRICTION = Object.freeze({
  attempt: "captcha_vendor_attempt",
  success: "captcha_vendor_success",
  fail: "captcha_vendor_fail",
  unsupported: "captcha_vendor_unsupported",
  cap_hit: "captcha_vendor_cap_hit",
  skipped_off: "captcha_vendor_skipped_off",
});

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveCaptchaVendorConfig(env = process.env) {
  const vendorRaw = String(env.CAPTCHA_VENDOR ?? "off").trim().toLowerCase();
  const vendor = CAPTCHA_VENDORS.includes(vendorRaw) ? vendorRaw : "off";
  const apiKey = String(env.CAPTCHA_VENDOR_API_KEY ?? "").trim();
  const spendCapUsd = Number(env.CAPTCHA_SPEND_CAP_USD_MONTH ?? 5);
  const spendMonthUsd = Number(env.CAPTCHA_SPEND_MONTH_USD ?? 0);
  const buyerOptIn = String(env.CAPTCHA_BUYER_OPT_IN ?? env.CAPTCHA_ASSIST ?? "")
    .trim()
    .toLowerCase();
  const captchaAssist = buyerOptIn === "on" || buyerOptIn === "true" || buyerOptIn === "1";
  return {
    vendor,
    apiKey,
    spendCapUsd: Number.isFinite(spendCapUsd) && spendCapUsd > 0 ? spendCapUsd : 5,
    spendMonthUsd: Number.isFinite(spendMonthUsd) && spendMonthUsd >= 0 ? spendMonthUsd : 0,
    captchaAssist,
    enabled: vendor !== "off" && Boolean(apiKey) && captchaAssist,
  };
}

/**
 * Hard stop when monthly spend would exceed the cap.
 * @param {{ spendMonthUsd?: number, spendCapUsd?: number, additionalUsd?: number }} input
 */
export function checkCaptchaSpendCap(input = {}) {
  const spent = Number(input.spendMonthUsd ?? 0);
  const cap = Number(input.spendCapUsd ?? 5);
  const additional = Number(input.additionalUsd ?? 0);
  const safeSpent = Number.isFinite(spent) ? Math.max(0, spent) : 0;
  const safeCap = Number.isFinite(cap) && cap > 0 ? cap : 5;
  const safeAdditional = Number.isFinite(additional) ? Math.max(0, additional) : 0;
  if (safeSpent + safeAdditional > safeCap) {
    return {
      ok: false,
      error: "spend_cap_hit",
      friction: CAPTCHA_FRICTION.cap_hit,
      message: "CAPTCHA assist spend cap reached. Fall back to live panel (complete-captcha).",
      spendMonthUsd: safeSpent,
      spendCapUsd: safeCap,
    };
  }
  return {
    ok: true,
    spendMonthUsd: safeSpent,
    spendCapUsd: safeCap,
    remainingUsd: Math.max(0, safeCap - safeSpent),
  };
}

/**
 * Detect common challenge widgets from a page snapshot (no network).
 * @param {{
 *   pageUrl?: string,
 *   pageHtml?: string,
 *   pageText?: string,
 *   sitekey?: string,
 *   challengeType?: string,
 *   matchedBlockerSelectors?: string[],
 * }} snapshot
 */
export function detectChallenge(snapshot = {}) {
  const html = String(snapshot.pageHtml ?? snapshot.pageText ?? "");
  const selectors = Array.isArray(snapshot.matchedBlockerSelectors)
    ? snapshot.matchedBlockerSelectors.join(" ")
    : "";
  const haystack = `${html}\n${selectors}`;
  const explicit = String(snapshot.challengeType ?? "").trim().toLowerCase();

  let type = "unknown";
  if (explicit) type = explicit;
  else if (/cf-turnstile|turnstile/i.test(haystack)) type = "turnstile";
  else if (/recaptcha\/enterprise|google\.com\/recaptcha\/enterprise/i.test(haystack)) type = "recaptcha_v2";
  else if (/recaptcha|g-recaptcha|grecaptcha/i.test(haystack)) type = "recaptcha_v2";
  else if (/hcaptcha/i.test(haystack)) type = "hcaptcha";
  else if (/captcha/i.test(haystack)) type = "unknown";
  else {
    return { present: false, type: null, sitekey: null, pageurl: snapshot.pageUrl ?? null };
  }

  const sitekey = String(
    snapshot.sitekey
      ?? haystack.match(/data-sitekey=["']([^"']+)["']/i)?.[1]
      ?? "",
  ).trim() || null;

  return {
    present: true,
    type,
    sitekey,
    pageurl: snapshot.pageUrl ?? null,
  };
}

/**
 * CapSolver adapter stub — refuses unless fully enabled.
 * @param {object} task
 * @param {ReturnType<typeof resolveCaptchaVendorConfig>} config
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export async function capsolverCreateTask(task, config, options = {}) {
  if (config.vendor !== "capsolver") {
    return { ok: false, error: "vendor_mismatch", friction: CAPTCHA_FRICTION.skipped_off };
  }
  if (!config.enabled) {
    return {
      ok: false,
      error: config.apiKey ? "buyer_opt_in_required" : "api_key_missing",
      friction: CAPTCHA_FRICTION.fail,
      message: "CapSolver refuse: vendor enabled only with API key + buyer captchaAssist=on.",
    };
  }
  // Scaffold only — no real network in this slice.
  void options.fetchImpl;
  void task;
  return {
    ok: false,
    error: "adapter_stub",
    friction: CAPTCHA_FRICTION.unsupported,
    message: "CapSolver adapter is scaffolded Off. Spike implementation gated until explicit go.",
  };
}

/**
 * 2Captcha adapter stub — refuses unless fully enabled.
 * @param {object} task
 * @param {ReturnType<typeof resolveCaptchaVendorConfig>} config
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export async function twocaptchaCreateTask(task, config, options = {}) {
  if (config.vendor !== "2captcha") {
    return { ok: false, error: "vendor_mismatch", friction: CAPTCHA_FRICTION.skipped_off };
  }
  if (!config.enabled) {
    return {
      ok: false,
      error: config.apiKey ? "buyer_opt_in_required" : "api_key_missing",
      friction: CAPTCHA_FRICTION.fail,
      message: "2Captcha refuse: vendor enabled only with API key + buyer captchaAssist=on.",
    };
  }
  void options.fetchImpl;
  void task;
  return {
    ok: false,
    error: "adapter_stub",
    friction: CAPTCHA_FRICTION.unsupported,
    message: "2Captcha adapter is scaffolded Off. Spike implementation gated until explicit go.",
  };
}

/**
 * Poll stub — always fail-closed (no network).
 * @param {string} taskId
 * @param {ReturnType<typeof resolveCaptchaVendorConfig>} config
 */
export async function pollCaptchaTask(taskId, config) {
  void taskId;
  if (!config.enabled) {
    return { ok: false, error: "vendor_off", friction: CAPTCHA_FRICTION.skipped_off };
  }
  return {
    ok: false,
    error: "adapter_stub",
    friction: CAPTCHA_FRICTION.unsupported,
    message: "CAPTCHA poll stub — no vendor calls until spike is approved.",
  };
}

/**
 * Token inject guidance — never runs when vendor off.
 * @param {{ token?: string, type?: string }} result
 * @param {ReturnType<typeof resolveCaptchaVendorConfig>} config
 */
export function injectCaptchaToken(result, config) {
  if (!config.enabled) {
    return {
      ok: false,
      error: "vendor_off",
      friction: CAPTCHA_FRICTION.skipped_off,
      message: "CAPTCHA vendor Off — use attention complete-captcha / live panel.",
    };
  }
  if (!result?.token) {
    return { ok: false, error: "token_missing", friction: CAPTCHA_FRICTION.fail };
  }
  return {
    ok: false,
    error: "adapter_stub",
    friction: CAPTCHA_FRICTION.unsupported,
    message: "Token inject stubbed. Fail closed to live panel.",
    guidance: {
      note: "When implemented: set textarea/input for g-recaptcha-response / cf-turnstile-response; never store token in cloud state.",
      type: result.type ?? null,
    },
  };
}

/**
 * Single call-site helper for resume / re-inspect.
 * When Off (default): identical to today — needs human complete-captcha.
 *
 * @param {{
 *   snapshot?: object,
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 * }} [input]
 */
export async function tryCaptchaVendorAssist(input = {}) {
  const config = resolveCaptchaVendorConfig(input.env ?? process.env);
  const challenge = detectChallenge(input.snapshot ?? {});

  if (!challenge.present) {
    return { ok: true, assisted: false, reason: "no_challenge", challenge };
  }

  if (config.vendor === "off") {
    return {
      ok: false,
      assisted: false,
      reason: "vendor_off",
      friction: CAPTCHA_FRICTION.skipped_off,
      challenge,
      fallback: "complete-captcha",
      message: "CAPTCHA_VENDOR=off (default). Use live panel / attention complete-captcha.",
    };
  }

  if (!config.apiKey) {
    return {
      ok: false,
      assisted: false,
      reason: "api_key_missing",
      friction: CAPTCHA_FRICTION.fail,
      challenge,
      fallback: "complete-captcha",
      message: "CAPTCHA vendor key missing — fail closed to human.",
    };
  }

  if (!config.captchaAssist) {
    return {
      ok: false,
      assisted: false,
      reason: "buyer_opt_in_required",
      friction: CAPTCHA_FRICTION.fail,
      challenge,
      fallback: "complete-captcha",
      message: "Buyer captchaAssist is off — fail closed to human.",
    };
  }

  const cap = checkCaptchaSpendCap({
    spendMonthUsd: config.spendMonthUsd,
    spendCapUsd: config.spendCapUsd,
    additionalUsd: 0.01,
  });
  if (!cap.ok) {
    return {
      ok: false,
      assisted: false,
      reason: "spend_cap_hit",
      friction: CAPTCHA_FRICTION.cap_hit,
      challenge,
      fallback: "complete-captcha",
      message: cap.message,
    };
  }

  const supported = new Set(["recaptcha_v2", "turnstile"]);
  if (!supported.has(challenge.type)) {
    return {
      ok: false,
      assisted: false,
      reason: "unsupported_type",
      friction: CAPTCHA_FRICTION.unsupported,
      challenge,
      fallback: "complete-captcha",
      message: `Unsupported challenge type: ${challenge.type}. Fall back to live panel.`,
    };
  }

  const task = {
    type: challenge.type,
    sitekey: challenge.sitekey,
    pageurl: challenge.pageurl,
  };

  const created = config.vendor === "2captcha"
    ? await twocaptchaCreateTask(task, config, { fetchImpl: input.fetchImpl })
    : await capsolverCreateTask(task, config, { fetchImpl: input.fetchImpl });

  return {
    ok: false,
    assisted: false,
    reason: created.error ?? "adapter_stub",
    friction: created.friction ?? CAPTCHA_FRICTION.fail,
    challenge,
    fallback: "complete-captcha",
    message: created.message ?? "CAPTCHA vendor assist failed closed.",
    // Network was not used by stubs; keep this explicit for tests.
    networkCalled: false,
  };
}
