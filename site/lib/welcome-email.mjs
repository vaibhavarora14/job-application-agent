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
    "Thank you for being one of the first people to back JobAppAgent. Your reservation is confirmed, and your support means a lot.",
    `JobAppAgent is scheduled to launch on September 18, 2026. Your ${purchase.accessDays} days of access will begin when we activate your cloud access—not on the day you paid. If access has not been activated within 60 days of payment, we’ll automatically request a full refund through Dodo Payments.`,
    "Want to continue now? Use our open-source package with your local AI agent to keep your job search and application journey moving:",
    "npx job-application-agent@latest install\nhttps://www.npmjs.com/package/job-application-agent",
    "We’re here to support your goal of finding and applying to the right roles with less busywork. Reply directly with any questions.",
    `Thanks again,\nVaibhav\nJobAppAgent\n${config.replyTo}`,
    "This is a one-time transactional email about your JobAppAgent purchase. You will not be added to marketing emails without separate permission.",
  ];
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f2e9d8;color:#173f35">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">Your JobAppAgent reservation is confirmed. Your ${purchase.accessDays} days of access begin when cloud access is activated.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f2e9d8" style="width:100%;background:#f2e9d8">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;border-collapse:separate">
<tr><td bgcolor="#173f35" style="padding:24px 28px;background:#173f35;border-radius:16px 16px 0 0">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
  <td width="44" height="44" align="center" valign="middle" bgcolor="#f2e9d8" style="width:44px;height:44px;background:#f2e9d8;border-radius:12px">
    <table role="presentation" width="26" cellspacing="0" cellpadding="0" border="0" aria-hidden="true" style="width:26px">
      <tr><td width="7" height="7" bgcolor="#173f35" style="width:7px;height:7px;background:#173f35;border-radius:7px 7px 0 0"></td><td width="12"></td><td width="7" height="7" bgcolor="#63b995" style="width:7px;height:7px;background:#63b995;border-radius:50%"></td></tr>
      <tr><td width="7" height="11" bgcolor="#173f35" style="width:7px;height:11px;background:#173f35"></td><td></td><td width="7" height="11" bgcolor="#173f35" style="width:7px;height:11px;background:#173f35"></td></tr>
      <tr><td colspan="3" height="7" bgcolor="#173f35" style="height:7px;background:#173f35;border-radius:0 0 7px 7px"></td></tr>
    </table>
  </td>
  <td width="14" style="width:14px"></td>
  <td valign="middle"><div aria-label="JobAppAgent" style="font-family:Georgia,'Times New Roman',serif;font-size:21px;line-height:1.2;color:#fffaf0">JobAppAgent</div><div style="margin-top:4px;font-family:Arial,sans-serif;font-size:11px;line-height:1.3;letter-spacing:1.5px;text-transform:uppercase;color:#a9d8c3">A calmer way to job hunt</div></td>
  </tr></table>
</td></tr>
<tr><td bgcolor="#fffaf0" style="padding:42px 36px 36px;background:#fffaf0;border-right:1px solid #d8ccb7;border-left:1px solid #d8ccb7">
  <div style="font-family:'Courier New',monospace;font-size:11px;line-height:1.4;letter-spacing:1.6px;text-transform:uppercase;color:#2f6f5b">Reservation confirmed</div>
  <h1 style="margin:10px 0 24px;font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.22;font-weight:400;color:#173f35">Your place is reserved.</h1>
  <p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;color:#486159">Hi there,</p>
  <p style="margin:0 0 26px;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;color:#486159">Thank you for being one of the first people to back JobAppAgent. Your reservation is confirmed, and your support means a lot.</p>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#e5f2eb" style="width:100%;background:#e5f2eb;border-left:4px solid #63b995;border-radius:10px">
    <tr><td style="padding:22px 24px"><div style="font-family:'Courier New',monospace;font-size:11px;line-height:1.4;letter-spacing:1.4px;text-transform:uppercase;color:#2f6f5b">Your access</div><div style="margin-top:6px;font-family:Georgia,'Times New Roman',serif;font-size:27px;line-height:1.25;color:#173f35">${purchase.accessDays} days of access</div><div style="margin-top:7px;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#486159">Starts when cloud access is activated—not on the day you paid.</div></td></tr>
  </table>
  <p style="margin:26px 0 0;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;color:#486159">JobAppAgent is scheduled to launch on <strong style="color:#173f35">September 18, 2026</strong>. If access has not been activated within 60 days of payment, we’ll automatically request a full refund through Dodo Payments.</p>
  <div style="height:1px;margin:32px 0;background:#d8ccb7"></div>
  <h2 style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:23px;line-height:1.35;font-weight:400;color:#173f35">Start locally today.</h2>
  <p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:15px;line-height:1.65;color:#486159">Use our open-source package with your local AI agent to continue your job search and application journey right away.</p>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#173f35" style="width:100%;background:#173f35;border-radius:10px">
    <tr><td style="padding:20px 22px"><div style="font-family:'Courier New',monospace;font-size:11px;line-height:1.4;letter-spacing:1.4px;text-transform:uppercase;color:#a9d8c3">Install</div><div style="margin:8px 0 12px;font-family:'Courier New',monospace;font-size:14px;line-height:1.5;color:#fffaf0">npx job-application-agent@latest install</div><a href="https://www.npmjs.com/package/job-application-agent" style="font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#a9d8c3;text-decoration:underline">View the open-source package →</a></td></tr>
  </table>
  <p style="margin:26px 0 0;font-family:Arial,sans-serif;font-size:15px;line-height:1.65;color:#486159">We’re here to support your goal of finding and applying to the right roles with less busywork. Reply directly with any questions.</p>
  <p style="margin:24px 0 0;font-family:Arial,sans-serif;font-size:15px;line-height:1.65;color:#486159">Thanks again,<br><strong style="color:#173f35">Vaibhav</strong><br>JobAppAgent<br><a href="mailto:${config.replyTo}" style="color:#173f35;text-decoration:underline">${config.replyTo}</a></p>
</td></tr>
<tr><td bgcolor="#f2e9d8" style="padding:22px 28px;background:#f2e9d8;border:1px solid #d8ccb7;border-top:0;border-radius:0 0 16px 16px">
  <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#73867f">This is a one-time transactional email about your JobAppAgent purchase. You will not be added to marketing emails without separate permission.</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return {
    from: config.from,
    to: purchase.customerEmail,
    replyTo: config.replyTo,
    subject,
    text: paragraphs.join("\n\n"),
    html,
  };
}

export async function deliverPurchaseWelcome({ purchase, config, claimDelivery, sendEmail, markAccepted, markFailed }) {
  if (!validPurchase(purchase) || !validateWelcomeEmailConfig(config).ok) {
    return { ok: false, error: "invalid_purchase" };
  }
  const key = { purchaseId: purchase.id, messageKind: WELCOME_MESSAGE_KIND };
  const claim = await claimDelivery(key);
  if (claim === "accepted") return { ok: true, sent: false, duplicate: true };
  if (claim !== "claimed") return { ok: false, error: "delivery_in_progress" };
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
    const accepted = await markAccepted({ ...key, providerMessageId });
    if (!accepted) throw new Error("Email acceptance was not persisted.");
  } catch {
    return { ok: false, error: "delivery_failed" };
  }
  return { ok: true, sent: true, providerMessageId };
}
