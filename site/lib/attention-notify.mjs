/**
 * Attention notify orchestration: validate payload → magic link → email.
 * Fail-closed when secrets or mailer are missing.
 */

import {
  buildAttentionMagicLinkUrl,
  signAttentionMagicLink,
} from "./attention-magic-link.mjs";
import { sendAttentionEmail } from "./attention-mail.mjs";
import {
  detectAiAssistanceDiscouraged,
  normalizeAttentionQuestions,
} from "./attention-questions.mjs";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {unknown} input
 */
export function validateAttentionNotifyRequest(input) {
  const value = input && typeof input === "object" ? input : null;
  if (!value) return { ok: false, error: "invalid_body", status: 400 };

  const attentionId = typeof value.attentionId === "string" ? value.attentionId.trim() : "";
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  const company = typeof value.company === "string" ? value.company.trim() : "";
  const role = typeof value.role === "string" ? value.role.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const stage = typeof value.stage === "string" ? value.stage.trim().toLowerCase() : "";
  const blocker = typeof value.blocker === "string" ? value.blocker.trim().toLowerCase() : "";
  const requiredActions = Array.isArray(value.requiredActions)
    ? value.requiredActions.map((item) => String(item).trim().toLowerCase()).filter(Boolean).slice(0, 8)
    : [];
  const questions = normalizeAttentionQuestions(value.questions);
  const postingText = typeof value.postingText === "string" ? value.postingText.slice(0, 20_000) : "";
  const aiAssistanceDiscouraged = value.aiAssistanceDiscouraged === true
    || detectAiAssistanceDiscouraged(postingText);

  if (!attentionId || attentionId.length > 180) return { ok: false, error: "attention_id_invalid", status: 400 };
  if (!emailPattern.test(email)) return { ok: false, error: "email_invalid", status: 400 };
  if (!company || company.length > 200) return { ok: false, error: "company_invalid", status: 400 };
  if (!role || role.length > 200) return { ok: false, error: "role_invalid", status: 400 };
  if (url && url.length > 2048) return { ok: false, error: "url_invalid", status: 400 };
  if (!blocker || blocker.length > 60) return { ok: false, error: "blocker_invalid", status: 400 };

  return {
    ok: true,
    data: {
      attentionId,
      email,
      company,
      role,
      url,
      stage,
      blocker,
      requiredActions,
      questions,
      aiAssistanceDiscouraged,
    },
  };
}

/**
 * @param {object} request
 * @param {object} config
 */
export async function notifyAttentionOpened(request, config) {
  const validated = validateAttentionNotifyRequest(request);
  if (!validated.ok) return validated;

  const magicSecret = typeof config?.magicLinkSecret === "string" ? config.magicLinkSecret : "";
  const publicSiteUrl = typeof config?.publicSiteUrl === "string" ? config.publicSiteUrl : "";
  if (!magicSecret || magicSecret.length < 16) {
    config?.logger?.error?.("[attention-notify] ATTENTION_MAGIC_LINK_SECRET missing; fail-closed");
    return { ok: false, error: "magic_link_unconfigured", status: 503 };
  }
  if (!publicSiteUrl) {
    config?.logger?.error?.("[attention-notify] PUBLIC_SITE_URL missing; fail-closed");
    return { ok: false, error: "site_url_unconfigured", status: 503 };
  }

  const signed = await signAttentionMagicLink(validated.data, magicSecret, {
    ttlSeconds: config?.ttlSeconds ?? 2700,
  });
  if (!signed.ok) {
    config?.logger?.error?.(`[attention-notify] magic link sign failed: ${signed.error}`);
    return { ok: false, error: signed.error, status: 503 };
  }

  let magicLinkUrl;
  try {
    magicLinkUrl = buildAttentionMagicLinkUrl(publicSiteUrl, validated.data.attentionId, signed.token);
  } catch {
    config?.logger?.error?.("[attention-notify] PUBLIC_SITE_URL invalid; fail-closed");
    return { ok: false, error: "site_url_unconfigured", status: 503 };
  }

  const mailed = await sendAttentionEmail({
    to: validated.data.email,
    company: validated.data.company,
    role: validated.data.role,
    blocker: validated.data.blocker,
    requiredActions: validated.data.requiredActions,
    magicLinkUrl,
  }, {
    apiKey: config?.resendApiKey,
    from: config?.resendFrom,
    fetchImpl: config?.fetchImpl,
    logger: config?.logger,
  });

  if (!mailed.ok) {
    return { ok: false, error: mailed.error, status: mailed.error === "recipient_invalid" ? 400 : 503 };
  }

  return {
    ok: true,
    attentionId: validated.data.attentionId,
    emailId: mailed.id,
    subject: mailed.subject,
    expiresAt: signed.expiresAt,
    magicLinkUrl,
    questions: validated.data.questions,
    aiAssistanceDiscouraged: validated.data.aiAssistanceDiscouraged,
  };
}
