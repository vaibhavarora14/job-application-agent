/**
 * Attention wake seam for on-demand agent-box.
 *
 * Records or dispatches a wake signal so ops / Personal can start a stopped VM
 * before the candidate opens the live browser. Does not require GCP credentials
 * inside the Worker — optional ATTENTION_WAKE_URL webhook is the clean hook.
 */

/**
 * @param {unknown} input
 */
export function validateAttentionWakeRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "invalid_body", status: 400 };
  }
  const body = /** @type {Record<string, unknown>} */ (input);
  const attentionId = typeof body.attentionId === "string" ? body.attentionId.trim() : "";
  if (!attentionId || attentionId.length > 180) {
    return { ok: false, error: "attention_id_invalid", status: 400 };
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 120) : "";
  const source = typeof body.source === "string" ? body.source.trim().slice(0, 64) : "internal";
  return {
    ok: true,
    data: {
      attentionId,
      reason: reason || "live_session",
      source: source || "internal",
    },
  };
}

/**
 * Default founder wake instructions when no webhook is configured.
 * Override with ATTENTION_WAKE_INSTRUCTIONS when instance/zone/project differ.
 */
export function defaultWakeInstructions() {
  return [
    "gcloud compute instances start agent-box \\",
    "  --zone=asia-south1-a \\",
    "  --project=agent-runner-vaibhav-4500",
    "",
    "# Wait until RUNNING, then confirm Xvfb :99 + x11vnc :5900 + noVNC (:6080 → localhost:5900) before live session.",
  ].join("\n");
}

/**
 * @param {{
 *   attentionId: string,
 *   reason?: string,
 *   source?: string,
 *   now?: string,
 * }} input
 */
export function buildAttentionWakePayload(input) {
  const attentionId = String(input.attentionId ?? "").trim();
  return {
    type: "attention_wake",
    attentionId,
    reason: input.reason || "live_session",
    source: input.source || "internal",
    requestedAt: input.now || new Date().toISOString(),
  };
}

/**
 * Soft buyer-facing status for the attention live panel.
 * Never mention gcloud, IAP, SSH, or ops — wake details stay on internal APIs.
 * @param {"dispatched"|"recorded"|"failed"|"starting"|"connecting"} status
 */
export function formatWakeStatusMessage(status) {
  switch (status) {
    case "failed":
      // Soft buyer copy — never mention ops / agent-box / gcloud.
      return "Live browser is temporarily unavailable. Try again shortly.";
    case "dispatched":
    case "recorded":
    case "starting":
    case "connecting":
    default:
      return "Connecting…";
  }
}

/**
 * Dispatch wake: POST ATTENTION_WAKE_URL when set, else record + return instructions.
 * `instructions` are for internal/ops consumers only — buyer UI must never render them.
 *
 * @param {{
 *   attentionId: string,
 *   reason?: string,
 *   source?: string,
 *   wakeUrl?: string,
 *   wakeInstructions?: string,
 *   notifySecret?: string,
 *   fetchImpl?: typeof fetch,
 *   logger?: { error?: (message: string) => void, warn?: (message: string) => void },
 * }} config
 */
export async function dispatchAttentionWake(config) {
  const attentionId = String(config.attentionId ?? "").trim();
  if (!attentionId) {
    return { ok: false, error: "attention_id_invalid", status: 400 };
  }

  const payload = buildAttentionWakePayload({
    attentionId,
    reason: config.reason,
    source: config.source,
  });
  const instructions = (typeof config.wakeInstructions === "string" && config.wakeInstructions.trim())
    ? config.wakeInstructions.trim()
    : defaultWakeInstructions();

  const wakeUrl = typeof config.wakeUrl === "string" ? config.wakeUrl.trim() : "";
  if (!wakeUrl) {
    config.logger?.warn?.(`attention_wake_recorded attentionId=${attentionId} (ATTENTION_WAKE_URL unset)`);
    return {
      ok: true,
      attentionId,
      status: "recorded",
      message: formatWakeStatusMessage("recorded"),
      instructions,
      payload,
    };
  }

  let target;
  try {
    target = new URL(wakeUrl);
  } catch {
    return { ok: false, error: "wake_url_invalid", status: 503 };
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { ok: false, error: "wake_url_invalid", status: 503 };
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  try {
    const headers = { "content-type": "application/json", accept: "application/json" };
    const secret = typeof config.notifySecret === "string" ? config.notifySecret : "";
    if (secret) headers.authorization = `Bearer ${secret}`;

    const response = await fetchImpl(target.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      config.logger?.error?.(
        `attention_wake_dispatch_failed status=${response.status} attentionId=${attentionId}`,
      );
      return {
        ok: false,
        error: "wake_dispatch_failed",
        status: 502,
        attentionId,
        message: formatWakeStatusMessage("failed"),
        instructions,
        payload,
      };
    }
    return {
      ok: true,
      attentionId,
      status: "dispatched",
      message: formatWakeStatusMessage("dispatched"),
      instructions: null,
      payload,
    };
  } catch (error) {
    config.logger?.error?.(
      `attention_wake_dispatch_error attentionId=${attentionId} ${error instanceof Error ? error.message : "unknown"}`,
    );
    return {
      ok: false,
      error: "wake_dispatch_failed",
      status: 502,
      attentionId,
      message: formatWakeStatusMessage("failed"),
      instructions,
      payload,
    };
  }
}
