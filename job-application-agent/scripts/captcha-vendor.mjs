/**
 * CAPTCHA vendor adapters — gated Off by default.
 *
 * CAPTCHA_VENDOR=off|capsolver|2captcha (default off)
 * Never call vendors unless vendor≠off AND api key present AND buyer opt-in.
 * Fail closed to attention / live panel (complete-captcha).
 *
 * No cookie/session theft: solvers get only public page URL + sitekey + type.
 * Solving CAPTCHA is never "applied" — submit + visible confirm still required.
 * Never store CAPTCHA tokens in cloud state / logs / friction telemetry.
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

/** Default poll wall-clock before fail-closed. */
export const CAPTCHA_POLL_TIMEOUT_MS = 120_000;

/** Estimated USD per solve (planning / spend-cap headroom; not billed amounts). */
const ESTIMATED_COST_USD = Object.freeze({
  capsolver: Object.freeze({ recaptcha_v2: 0.0008, turnstile: 0.0012 }),
  "2captcha": Object.freeze({ recaptcha_v2: 0.003, turnstile: 0.0015 }),
});

const CAPSOLVER_CREATE_URL = "https://api.capsolver.com/createTask";
const CAPSOLVER_RESULT_URL = "https://api.capsolver.com/getTaskResult";
const TWOCAPTCHA_CREATE_URL = "https://api.2captcha.com/createTask";
const TWOCAPTCHA_RESULT_URL = "https://api.2captcha.com/getTaskResult";

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
 * @param {string} vendor
 * @param {string} type
 */
export function estimateCaptchaCostUsd(vendor, type) {
  const byVendor = ESTIMATED_COST_USD[vendor];
  if (!byVendor) return 0.01;
  const cost = byVendor[type];
  return Number.isFinite(cost) ? cost : 0.01;
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
 *   enterprise?: boolean,
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
    return {
      present: false,
      type: null,
      sitekey: null,
      pageurl: snapshot.pageUrl ?? null,
      enterprise: false,
    };
  }

  const sitekey = String(
    snapshot.sitekey
      ?? haystack.match(/data-sitekey=["']([^"']+)["']/i)?.[1]
      ?? "",
  ).trim() || null;

  const enterprise = snapshot.enterprise === true
    || /recaptcha\/enterprise|google\.com\/recaptcha\/enterprise/i.test(haystack);

  return {
    present: true,
    type,
    sitekey,
    pageurl: snapshot.pageUrl ?? null,
    enterprise: Boolean(enterprise && type === "recaptcha_v2"),
  };
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {object} body
 */
async function postJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

/**
 * @param {object} task
 * @param {ReturnType<typeof resolveCaptchaVendorConfig>} config
 */
function validatePublicTask(task) {
  const type = String(task?.type ?? "").trim();
  const sitekey = String(task?.sitekey ?? "").trim();
  const pageurl = String(task?.pageurl ?? "").trim();
  if (!sitekey || !pageurl) {
    return {
      ok: false,
      error: "missing_sitekey_or_pageurl",
      friction: CAPTCHA_FRICTION.fail,
      message: "CAPTCHA assist needs public page URL + sitekey only. Fall back to live panel.",
    };
  }
  if (type !== "recaptcha_v2" && type !== "turnstile") {
    return {
      ok: false,
      error: "unsupported_type",
      friction: CAPTCHA_FRICTION.unsupported,
      message: `Unsupported challenge type: ${type || "unknown"}. Fall back to live panel.`,
    };
  }
  return { ok: true, type, sitekey, pageurl, enterprise: Boolean(task?.enterprise) };
}

/**
 * CapSolver createTask — public URL + sitekey only.
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

  const validated = validatePublicTask(task);
  if (!validated.ok) return validated;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      error: "fetch_unavailable",
      friction: CAPTCHA_FRICTION.fail,
      message: "CapSolver createTask failed — fetch unavailable. Fall back to live panel.",
    };
  }

  const vendorTaskType = validated.type === "turnstile"
    ? "AntiTurnstileTaskProxyLess"
    : validated.enterprise
      ? "ReCaptchaV2EnterpriseTaskProxyLess"
      : "ReCaptchaV2TaskProxyLess";

  try {
    const { response, json } = await postJson(fetchImpl, CAPSOLVER_CREATE_URL, {
      clientKey: config.apiKey,
      task: {
        type: vendorTaskType,
        websiteURL: validated.pageurl,
        websiteKey: validated.sitekey,
      },
    });

    if (!response.ok || !json || Number(json.errorId) > 0 || !json.taskId) {
      return {
        ok: false,
        error: "create_failed",
        friction: CAPTCHA_FRICTION.fail,
        message: "CapSolver createTask failed. Fall back to live panel.",
        networkCalled: true,
        httpStatus: response.status,
        vendorErrorCode: json?.errorCode ?? null,
      };
    }

    return {
      ok: true,
      taskId: String(json.taskId),
      vendor: "capsolver",
      type: validated.type,
      networkCalled: true,
      // Immediate ready is rare for token tasks but honor it.
      solution: json.status === "ready" ? json.solution ?? null : null,
      status: json.status ?? null,
    };
  } catch {
    return {
      ok: false,
      error: "network_error",
      friction: CAPTCHA_FRICTION.fail,
      message: "CapSolver createTask network error. Fall back to live panel.",
      networkCalled: true,
    };
  }
}

/**
 * 2Captcha createTask — public URL + sitekey only.
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

  const validated = validatePublicTask(task);
  if (!validated.ok) return validated;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      error: "fetch_unavailable",
      friction: CAPTCHA_FRICTION.fail,
      message: "2Captcha createTask failed — fetch unavailable. Fall back to live panel.",
    };
  }

  const vendorTaskType = validated.type === "turnstile"
    ? "TurnstileTaskProxyless"
    : validated.enterprise
      ? "RecaptchaV2EnterpriseTaskProxyless"
      : "RecaptchaV2TaskProxyless";

  try {
    const { response, json } = await postJson(fetchImpl, TWOCAPTCHA_CREATE_URL, {
      clientKey: config.apiKey,
      task: {
        type: vendorTaskType,
        websiteURL: validated.pageurl,
        websiteKey: validated.sitekey,
      },
    });

    if (!response.ok || !json || Number(json.errorId) > 0 || json.taskId == null) {
      const vendorErrorCode = String(json?.errorCode ?? "").trim() || null;
      return {
        ok: false,
        error: mapTwoCaptchaCreateError(vendorErrorCode),
        friction: CAPTCHA_FRICTION.fail,
        message: twoCaptchaCreateFailMessage(vendorErrorCode),
        networkCalled: true,
        httpStatus: response.status,
        vendorErrorCode,
      };
    }

    return {
      ok: true,
      taskId: String(json.taskId),
      vendor: "2captcha",
      type: validated.type,
      networkCalled: true,
    };
  } catch {
    return {
      ok: false,
      error: "network_error",
      friction: CAPTCHA_FRICTION.fail,
      message: "2Captcha createTask network error. Fall back to live panel.",
      networkCalled: true,
    };
  }
}

/**
 * @param {string | null} code
 */
function mapTwoCaptchaCreateError(code) {
  switch (code) {
    case "ERROR_ZERO_BALANCE":
      return "zero_balance";
    case "ERROR_KEY_DOES_NOT_EXIST":
    case "ERROR_WRONG_USER_KEY":
      return "api_key_invalid";
    case "ERROR_NO_SLOT_AVAILABLE":
      return "no_slot";
    default:
      return "create_failed";
  }
}

/**
 * @param {string | null} code
 */
function twoCaptchaCreateFailMessage(code) {
  switch (code) {
    case "ERROR_ZERO_BALANCE":
      return "2Captcha balance empty. Fall back to live panel.";
    case "ERROR_KEY_DOES_NOT_EXIST":
    case "ERROR_WRONG_USER_KEY":
      return "2Captcha API key rejected. Fall back to live panel.";
    case "ERROR_NO_SLOT_AVAILABLE":
      return "2Captcha has no workers available. Fall back to live panel.";
    default:
      return "2Captcha createTask failed. Fall back to live panel.";
  }
}

/**
 * Extract token from vendor solution payload without logging it.
 * @param {object | null | undefined} solution
 * @param {string} type
 */
function extractSolutionToken(solution, type) {
  if (!solution || typeof solution !== "object") return null;
  if (type === "turnstile") {
    const token = String(solution.token ?? solution.gRecaptchaResponse ?? "").trim();
    return token || null;
  }
  const token = String(solution.gRecaptchaResponse ?? solution.token ?? "").trim();
  return token || null;
}

/**
 * @param {number} ms
 * @param {(ms: number) => Promise<void>} [sleepImpl]
 */
async function sleepMs(ms, sleepImpl) {
  if (typeof sleepImpl === "function") {
    await sleepImpl(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll vendor getTaskResult until ready, failed, or timeout (~120s).
 * @param {string} taskId
 * @param {ReturnType<typeof resolveCaptchaVendorConfig>} config
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 *   type?: string,
 *   initialDelayMs?: number,
 * }} [options]
 */
export async function pollCaptchaTask(taskId, config, options = {}) {
  if (!config.enabled) {
    return { ok: false, error: "vendor_off", friction: CAPTCHA_FRICTION.skipped_off };
  }
  const id = String(taskId ?? "").trim();
  if (!id) {
    return {
      ok: false,
      error: "task_id_missing",
      friction: CAPTCHA_FRICTION.fail,
      message: "CAPTCHA poll missing taskId. Fall back to live panel.",
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      error: "fetch_unavailable",
      friction: CAPTCHA_FRICTION.fail,
      message: "CAPTCHA poll failed — fetch unavailable. Fall back to live panel.",
    };
  }

  const vendor = config.vendor;
  const resultUrl = vendor === "2captcha" ? TWOCAPTCHA_RESULT_URL : CAPSOLVER_RESULT_URL;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : CAPTCHA_POLL_TIMEOUT_MS;
  const type = String(options.type ?? "recaptcha_v2");
  const started = Date.now();
  // 2Captcha docs: re-poll every ~5–10s. CapSolver is typically faster (~1–3s).
  const defaultInitial = vendor === "2captcha" ? 5000 : 2000;
  const maxDelay = vendor === "2captcha" ? 10_000 : 8000;
  let delayMs = Number.isFinite(options.initialDelayMs)
    ? Math.max(0, options.initialDelayMs)
    : defaultInitial;
  let networkCalled = false;

  while (Date.now() - started < timeoutMs) {
    if (delayMs > 0) await sleepMs(delayMs, options.sleepImpl);

    try {
      const { response, json } = await postJson(fetchImpl, resultUrl, {
        clientKey: config.apiKey,
        // 2Captcha taskId is numeric; CapSolver uses UUID strings.
        taskId: vendor === "2captcha" && /^\d+$/.test(id) ? Number(id) : id,
      });
      networkCalled = true;

      if (!response.ok || !json) {
        delayMs = Math.min(Math.max(delayMs * 1.5, defaultInitial), maxDelay);
        continue;
      }

      if (Number(json.errorId) > 0) {
        const vendorErrorCode = String(json.errorCode ?? "").trim() || null;
        return {
          ok: false,
          error: vendorErrorCode === "ERROR_CAPTCHA_UNSOLVABLE" ? "unsolvable" : "poll_failed",
          friction: CAPTCHA_FRICTION.fail,
          message: vendorErrorCode === "ERROR_CAPTCHA_UNSOLVABLE"
            ? "2Captcha could not solve the challenge. Fall back to live panel."
            : "CAPTCHA vendor poll failed. Fall back to live panel.",
          networkCalled: true,
          vendorErrorCode,
        };
      }

      const status = String(json.status ?? "").toLowerCase();
      if (status === "ready") {
        const token = extractSolutionToken(json.solution, type);
        if (!token) {
          return {
            ok: false,
            error: "token_missing",
            friction: CAPTCHA_FRICTION.fail,
            message: "CAPTCHA vendor returned ready without token. Fall back to live panel.",
            networkCalled: true,
          };
        }
        const costRaw = json.cost ?? json.solution?.cost;
        const estimatedCostUsd = costRaw != null && Number.isFinite(Number(costRaw))
          ? Number(costRaw)
          : estimateCaptchaCostUsd(vendor, type);
        return {
          ok: true,
          token,
          type,
          status: "ready",
          networkCalled: true,
          estimatedCostUsd,
          friction: CAPTCHA_FRICTION.success,
        };
      }

      if (status === "failed") {
        return {
          ok: false,
          error: "solve_failed",
          friction: CAPTCHA_FRICTION.fail,
          message: "CAPTCHA vendor reported failed. Fall back to live panel.",
          networkCalled: true,
        };
      }

      // processing / idle / unknown → backoff
      delayMs = Math.min(Math.max(delayMs * 1.35, defaultInitial), maxDelay);
    } catch {
      networkCalled = true;
      delayMs = Math.min(Math.max(delayMs * 1.5, defaultInitial), maxDelay);
    }
  }

  return {
    ok: false,
    error: "poll_timeout",
    friction: CAPTCHA_FRICTION.fail,
    message: "CAPTCHA vendor poll timed out. Fall back to live panel.",
    networkCalled,
  };
}

/**
 * Build Playwright-injectable guidance for a solved token.
 * No network — caller sets fields and invokes grecaptcha/turnstile callbacks if present.
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
  const token = String(result?.token ?? "").trim();
  if (!token) {
    return { ok: false, error: "token_missing", friction: CAPTCHA_FRICTION.fail };
  }

  const type = String(result?.type ?? "recaptcha_v2").trim().toLowerCase();
  /** @type {string[]} */
  let selectors;
  /** @type {string[]} */
  let fieldNames;

  if (type === "turnstile") {
    selectors = [
      'textarea[name="cf-turnstile-response"]',
      'input[name="cf-turnstile-response"]',
      "[name=\"cf-turnstile-response\"]",
    ];
    fieldNames = ["cf-turnstile-response"];
  } else {
    selectors = [
      'textarea[name="g-recaptcha-response"]',
      'input[name="g-recaptcha-response"]',
      "#g-recaptcha-response",
      "[name=\"g-recaptcha-response\"]",
    ];
    fieldNames = ["g-recaptcha-response"];
  }

  return {
    ok: true,
    selectors,
    fieldNames,
    token,
    type,
    guidance: {
      note: "Set textarea/input values for the listed selectors; call grecaptcha callback / turnstile callback if present. Never store token in cloud state or friction telemetry.",
      setValue: true,
      invokeCallback: type === "turnstile" ? "turnstile_callback_if_present" : "grecaptcha_callback_if_present",
      doNotPersistToken: true,
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
 *   sleepImpl?: (ms: number) => Promise<void>,
 *   pollTimeoutMs?: number,
 *   pollInitialDelayMs?: number,
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

  const estimatedCostUsd = estimateCaptchaCostUsd(config.vendor, challenge.type);
  const cap = checkCaptchaSpendCap({
    spendMonthUsd: config.spendMonthUsd,
    spendCapUsd: config.spendCapUsd,
    additionalUsd: estimatedCostUsd,
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

  if (!challenge.sitekey || !challenge.pageurl) {
    return {
      ok: false,
      assisted: false,
      reason: "missing_sitekey_or_pageurl",
      friction: CAPTCHA_FRICTION.fail,
      challenge,
      fallback: "complete-captcha",
      message: "CAPTCHA assist needs public page URL + sitekey. Fall back to live panel.",
      networkCalled: false,
    };
  }

  const task = {
    type: challenge.type,
    sitekey: challenge.sitekey,
    pageurl: challenge.pageurl,
    enterprise: challenge.enterprise,
  };

  const created = config.vendor === "2captcha"
    ? await twocaptchaCreateTask(task, config, { fetchImpl: input.fetchImpl })
    : await capsolverCreateTask(task, config, { fetchImpl: input.fetchImpl });

  if (!created.ok) {
    return {
      ok: false,
      assisted: false,
      reason: created.error ?? "create_failed",
      friction: created.friction ?? CAPTCHA_FRICTION.fail,
      challenge,
      fallback: "complete-captcha",
      message: created.message ?? "CAPTCHA vendor assist failed closed.",
      networkCalled: Boolean(created.networkCalled),
    };
  }

  // CapSolver may return solution inline on create; otherwise poll.
  let polled;
  const inlineToken = extractSolutionToken(created.solution, challenge.type);
  if (inlineToken) {
    polled = {
      ok: true,
      token: inlineToken,
      type: challenge.type,
      networkCalled: true,
      estimatedCostUsd,
      friction: CAPTCHA_FRICTION.success,
    };
  } else {
    polled = await pollCaptchaTask(created.taskId, config, {
      fetchImpl: input.fetchImpl,
      sleepImpl: input.sleepImpl,
      timeoutMs: input.pollTimeoutMs,
      initialDelayMs: input.pollInitialDelayMs,
      type: challenge.type,
    });
  }

  if (!polled.ok) {
    return {
      ok: false,
      assisted: false,
      reason: polled.error ?? "poll_failed",
      friction: polled.friction ?? CAPTCHA_FRICTION.fail,
      challenge,
      fallback: "complete-captcha",
      message: polled.message ?? "CAPTCHA vendor assist failed closed.",
      networkCalled: Boolean(polled.networkCalled ?? created.networkCalled),
    };
  }

  const inject = injectCaptchaToken(
    { token: polled.token, type: challenge.type },
    config,
  );

  return {
    ok: true,
    assisted: true,
    token: polled.token,
    type: challenge.type,
    challenge,
    networkCalled: true,
    estimatedCostUsd: polled.estimatedCostUsd ?? estimatedCostUsd,
    friction: CAPTCHA_FRICTION.success,
    inject,
    fallback: "complete-captcha",
    message: "CAPTCHA vendor assist succeeded — inject token in-page, then re-inspect. Never persist the token.",
  };
}
