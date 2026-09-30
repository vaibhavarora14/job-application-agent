/**
 * Attention email templates and Resend delivery.
 * Fails closed when the mailer is unconfigured or upstream errors.
 */

import { normalizeAttentionQuestions } from "./attention-questions.mjs";

/** Buyer mail exists only for actual employer questions, never technical actions. */
export function buildAttentionEmail(input) {
  const company = String(input?.company ?? "Company").trim() || "Company";
  const role = String(input?.role ?? "Role").trim() || "Role";
  const questions = normalizeAttentionQuestions(input?.questions);
  if (!questions.length) return null;
  const magicLinkUrl = String(input?.magicLinkUrl ?? "").trim();
  const subject = `Needs your answer: ${company} — ${role}`;
  const why = questions.length === 1
    ? "One question from the employer needs your input before we continue applying."
    : "A few questions from the employer need your input before we continue applying.";
  const text = [
    `${role} at ${company}`,
    "", why, "",
    ...questions.map((question) => `- ${question.prompt}`),
    "",
    magicLinkUrl ? `Continue applying: ${magicLinkUrl}` : "Open your newest JobAppAgent link to answer.",
    "", "This secure link expires in about 45 minutes.",
  ].join("\n");
  const html = [
    `<p><strong>${escapeHtml(role)}</strong> at <strong>${escapeHtml(company)}</strong></p>`,
    `<p>${escapeHtml(why)}</p>`,
    `<ul>${questions.map((q) => `<li>${escapeHtml(q.prompt)}</li>`).join("")}</ul>`,
    magicLinkUrl ? `<p><a href="${escapeAttribute(magicLinkUrl)}">Continue applying</a></p>` : "",
    "<p>This secure link expires in about 45 minutes.</p>",
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
  if (!template) return { ok: false, error: "no_employer_questions" };
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
