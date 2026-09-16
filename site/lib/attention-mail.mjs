/**
 * Attention email templates and Resend delivery.
 * Fails closed when the mailer is unconfigured or upstream errors.
 */

const BLOCKER_COPY = {
  captcha: "Prove you're human in the live browser session.",
  authentication: "Sign in or approve access in the live browser session.",
  mfa: "Complete multi-factor approval on your phone or device.",
  "legal-attestation": "Read and acknowledge the legal attestation in the live browser.",
  judgment: "Answer the judgment or narrative question in your own voice.",
  demographic: "We paused on a demographic question — choose only what you are willing to share.",
  "government-id": "A government ID field appeared; handle it yourself in the live session.",
  "ambiguous-authorization": "Work authorization needs your judgment.",
  "ambiguous-compensation": "Compensation needs your judgment.",
  "unverifiable-claim": "We don't have a verified fact for a required field.",
  video: "A video prompt needs you in the live session.",
  upload: "An upload gate needs you in the live session.",
  "site-error": "The site hit an error; inspect and decide in the live session.",
  other: "The hosted run paused and needs you.",
};

const ACTION_LABELS = {
  "sign-in": "Sign in",
  "complete-mfa": "Complete MFA",
  "complete-captcha": "Complete CAPTCHA",
  "review-legal": "Review legal attestation",
  "choose-demographic": "Choose demographic response",
  "provide-government-id": "Handle government ID",
  "provide-authorization": "Provide work authorization",
  "provide-compensation": "Provide compensation",
  "verify-claim": "Verify missing fact",
  "provide-judgment": "Provide judgment answer",
  "record-video": "Record video",
  "enable-upload": "Complete upload",
  "retry-site": "Retry site",
};

/**
 * @param {object} input
 */
export function buildAttentionEmail(input) {
  const company = String(input?.company ?? "Company").trim() || "Company";
  const role = String(input?.role ?? "Role").trim() || "Role";
  const blocker = String(input?.blocker ?? "other").trim().toLowerCase();
  const why = BLOCKER_COPY[blocker] ?? BLOCKER_COPY.other;
  const actions = Array.isArray(input?.requiredActions) ? input.requiredActions : [];
  const checklist = actions.length
    ? actions.map((action) => `- ${ACTION_LABELS[action] ?? action}`).join("\n")
    : "- Open the live session and finish the paused step";
  const magicLinkUrl = String(input?.magicLinkUrl ?? "").trim();
  const subject = `Action needed: ${company} — ${role}`;
  const text = [
    `JobAppAgent paused while applying to ${role} at ${company}.`,
    "",
    why,
    "",
    "Required actions:",
    checklist,
    "",
    magicLinkUrl ? `Open live session: ${magicLinkUrl}` : "Open live session: (link unavailable)",
    "",
    "This link expires in about 45–60 minutes. It does not include any VNC password.",
    "filled ≠ applied until the agent sees a visible confirmation after you resume.",
  ].join("\n");

  const checklistHtml = actions.length
    ? `<ul>${actions.map((action) => `<li>${escapeHtml(ACTION_LABELS[action] ?? action)}</li>`).join("")}</ul>`
    : "<ul><li>Open the live session and finish the paused step</li></ul>";

  const html = [
    `<p>JobAppAgent paused while applying to <strong>${escapeHtml(role)}</strong> at <strong>${escapeHtml(company)}</strong>.</p>`,
    `<p>${escapeHtml(why)}</p>`,
    "<p><strong>Required actions</strong></p>",
    checklistHtml,
    magicLinkUrl
      ? `<p><a href="${escapeAttribute(magicLinkUrl)}">Open live session</a></p>`
      : "<p>Open live session: (link unavailable)</p>",
    "<p>This link expires in about 45–60 minutes. It does not include any VNC password.</p>",
    "<p>filled ≠ applied until the agent sees a visible confirmation after you resume.</p>",
  ].join("");

  return { subject, text, html, why };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/**
 * @param {object} input
 * @param {{ apiKey?: string, from?: string, fetchImpl?: typeof fetch, logger?: { error: Function, warn: Function } }} [config]
 */
export async function sendAttentionEmail(input, config = {}) {
  const logger = config.logger ?? console;
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const from = typeof config.from === "string" && config.from.trim()
    ? config.from.trim()
    : "JobAppAgent <attention@jobappagent.com>";
  const to = typeof input?.to === "string" ? input.to.trim().toLowerCase() : "";
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!apiKey) {
    logger.error?.("[attention-mail] RESEND_API_KEY missing; notify fail-closed");
    return { ok: false, error: "mailer_unconfigured" };
  }
  if (!emailPattern.test(to)) {
    logger.error?.("[attention-mail] recipient email invalid; notify fail-closed");
    return { ok: false, error: "recipient_invalid" };
  }

  const template = buildAttentionEmail(input);
  const fetchImpl = config.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: template.subject,
        text: template.text,
        html: template.html,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.error?.(`[attention-mail] Resend rejected notify (${response.status}): ${detail.slice(0, 200)}`);
      return { ok: false, error: "mailer_failed", status: response.status };
    }

    const body = await response.json().catch(() => ({}));
    return { ok: true, id: typeof body?.id === "string" ? body.id : null, subject: template.subject };
  } catch (error) {
    logger.error?.(`[attention-mail] Resend request failed: ${error instanceof Error ? error.message : "unknown"}`);
    return { ok: false, error: "mailer_failed" };
  }
}

export { BLOCKER_COPY, ACTION_LABELS };
