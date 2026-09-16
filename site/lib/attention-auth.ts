import { env } from "cloudflare:workers";

async function digest(value: string) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** Timing-safe bearer compare for internal attention endpoints. */
export async function authorizedAttentionInternal(request: Request) {
  const expected = env.ATTENTION_NOTIFY_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const [left, right] = await Promise.all([digest(expected), digest(supplied)]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function attentionEnv() {
  return {
    magicLinkSecret: env.ATTENTION_MAGIC_LINK_SECRET ?? "",
    notifySecret: env.ATTENTION_NOTIFY_SECRET ?? "",
    resendApiKey: env.RESEND_API_KEY ?? "",
    resendFrom: env.RESEND_FROM_EMAIL ?? "JobAppAgent <attention@jobappagent.com>",
    publicSiteUrl: env.PUBLIC_SITE_URL ?? "https://jobappagent.com",
    liveSessionBaseUrl: env.ATTENTION_LIVE_SESSION_BASE_URL ?? "",
  };
}
