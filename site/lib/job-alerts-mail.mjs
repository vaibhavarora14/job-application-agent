/**
 * Job-alert mail through the Resend key the site already uses for ops mail.
 * With no API key the sender is disabled and nothing is stored as sent.
 * Messages are the text and HTML we build. No images, no tracking pixels.
 */
import { redactLogDetail } from "./log-redaction.mjs";

const DEFAULT_FROM = "JobAppAgent <attention@updates.jobappagent.com>";

/**
 * @param {{ apiKey?: string, from?: string, fetchImpl?: typeof fetch, logger?: { warn?: Function, error?: Function } }} [config]
 */
export function createJobAlertMailer(config = {}) {
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const from = typeof config.from === "string" && config.from.trim() ? config.from.trim() : DEFAULT_FROM;
  const fetchImpl = config.fetchImpl ?? fetch;
  const logger = config.logger ?? console;
  return {
    enabled: Boolean(apiKey),
    /**
     * @param {{ to: string, subject: string, text: string, html: string, headers?: Record<string, string> }} message
     */
    async send(message) {
      if (!apiKey) return { ok: false, error: "disabled" };
      try {
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            headers: message.headers ?? {},
          }),
        });
        if (!response.ok) {
          logger.error?.(`[job-alerts] Resend rejected (${response.status})`);
          return { ok: false, error: "mail_failed" };
        }
        return { ok: true, channel: "resend" };
      } catch (error) {
        logger.error?.(`[job-alerts] Resend request failed: ${redactLogDetail(error instanceof Error ? error.message : "unknown")}`);
        return { ok: false, error: "mail_failed" };
      }
    },
  };
}
