/**
 * Worker bindings for saved-search routes. Imported only by request handlers.
 */
import { env } from "cloudflare:workers";
import { createJobAlertMailer } from "./job-alerts-mail.mjs";
import { createSqlAlertStore, ensureSavedSearchSchema } from "./job-alerts-store.mjs";

let schemaReady;

export function jobAlertRuntime() {
  const origin = String(env.PUBLIC_SITE_URL || "https://jobappagent.com").replace(/\/$/, "");
  schemaReady ??= ensureSavedSearchSchema(env.DB);
  return {
    origin,
    ready: schemaReady,
    store: createSqlAlertStore(env.DB),
    mailer: createJobAlertMailer({
      apiKey: env.RESEND_API_KEY ?? "",
      from: env.JOB_ALERTS_FROM_EMAIL || env.RESEND_FROM_EMAIL || "",
    }),
    cronSecret: env.JOB_ALERTS_CRON_SECRET ?? "",
  };
}
