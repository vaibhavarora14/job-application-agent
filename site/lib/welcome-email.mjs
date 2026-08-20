export const WELCOME_MESSAGE_KIND = "purchase-welcome-v1";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FROM = /^.+\s<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/;

export function validateWelcomeEmailConfig(input) {
  const config = {
    apiKey: typeof input?.apiKey === "string" ? input.apiKey.trim() : "",
    from: typeof input?.from === "string" ? input.from.trim() : "",
    replyTo: typeof input?.replyTo === "string" ? input.replyTo.trim().toLowerCase() : "",
  };
  if (!config.apiKey.startsWith("re_") || !FROM.test(config.from) || !EMAIL.test(config.replyTo)) {
    return { ok: false, error: "Welcome email is not configured." };
  }
  return { ok: true, config };
}

function validPurchase(purchase) {
  return purchase?.status === "succeeded"
    && typeof purchase.id === "string"
    && EMAIL.test(purchase.customerEmail ?? "")
    && Number.isInteger(purchase.accessDays)
    && purchase.accessDays >= 1
    && purchase.accessDays <= 365;
}

export function buildWelcomeEmail(purchase, config) {
  if (!validPurchase(purchase)) throw new Error("Purchase is invalid.");
  const subject = "Welcome to JobAppAgent — your reservation is confirmed";
  const paragraphs = [
    "Hi there,",
    "Thank you for being one of the first people to back JobAppAgent. Your support means a lot.",
    `Your reservation is confirmed. JobAppAgent is scheduled to launch on September 18, 2026. Your ${purchase.accessDays} days of access will begin when we activate your cloud access—not on the day you paid. If access has not been activated within 60 days of payment, we’ll automatically request a full refund through Dodo Payments.`,
    "We’re building JobAppAgent to take repetitive work out of the job search while keeping you in control of the decisions that matter. We’re here to support your goal of finding and applying to the right roles with less busywork.",
    "If you have a question—or want to tell us about the roles, locations, or application challenge you’re focused on—reply directly. We’re here to help.",
    `Thanks again,\nVaibhav\nJobAppAgent\n${config.replyTo}`,
    "This is a one-time transactional email about your JobAppAgent purchase. You will not be added to marketing emails without separate permission.",
  ];
  const htmlParagraphs = paragraphs.map((paragraph, index) => {
    const content = paragraph.replaceAll("\n", "<br>");
    const style = index === paragraphs.length - 1
      ? "font-size:12px;line-height:1.6;color:#73867f;margin:28px 0 0"
      : "font-size:16px;line-height:1.7;color:#243a32;margin:0 0 20px";
    return `<p style="${style}">${content}</p>`;
  }).join("");
  return {
    from: config.from,
    to: purchase.customerEmail,
    replyTo: config.replyTo,
    subject,
    text: paragraphs.join("\n\n"),
    html: `<!doctype html><html><body style="margin:0;background:#f4efe5"><div style="display:none;max-height:0;overflow:hidden">Your JobAppAgent reservation is confirmed.</div><div style="max-width:600px;margin:0 auto;padding:40px 24px"><main style="background:#fffdf8;border:1px solid #d8ccb7;border-radius:16px;padding:36px">${htmlParagraphs}</main></div></body></html>`,
  };
}

export async function deliverPurchaseWelcome({ purchase, config, claimDelivery, sendEmail, markAccepted, markFailed }) {
  if (!validPurchase(purchase) || !validateWelcomeEmailConfig(config).ok) {
    return { ok: false, error: "invalid_purchase" };
  }
  const key = { purchaseId: purchase.id, messageKind: WELCOME_MESSAGE_KIND };
  if (!await claimDelivery(key)) return { ok: true, sent: false, duplicate: true };
  let providerMessageId;
  try {
    const sent = await sendEmail(buildWelcomeEmail(purchase, config), {
      idempotencyKey: `${WELCOME_MESSAGE_KIND}/${purchase.id}`,
    });
    if (typeof sent?.id !== "string" || !sent.id) throw new Error("Email was not accepted.");
    providerMessageId = sent.id;
  } catch {
    try { await markFailed(key); } catch { /* The stale claim remains retryable. */ }
    return { ok: false, error: "delivery_failed" };
  }
  try {
    await markAccepted({ ...key, providerMessageId });
  } catch {
    return { ok: false, error: "delivery_failed" };
  }
  return { ok: true, sent: true, providerMessageId };
}
