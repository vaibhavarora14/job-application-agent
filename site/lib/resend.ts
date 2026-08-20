import { env } from "cloudflare:workers";
import { Resend } from "resend";
import { validateWelcomeEmailConfig } from "./welcome-email.mjs";

export function getWelcomeEmailConfig() {
  return validateWelcomeEmailConfig({
    apiKey: env.RESEND_API_KEY,
    from: env.WELCOME_EMAIL_FROM,
    replyTo: env.SUPPORT_EMAIL,
  });
}

export async function sendWelcomeEmail(
  config: { apiKey: string },
  message: { from: string; to: string; replyTo: string; subject: string; text: string; html: string },
  options: { idempotencyKey: string },
) {
  const { data, error } = await new Resend(config.apiKey).emails.send(message, options);
  if (error || !data?.id) throw new Error("Welcome email was not accepted.");
  return { id: data.id };
}
