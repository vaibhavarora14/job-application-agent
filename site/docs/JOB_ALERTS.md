# Job search alerts

Visitors save the current `/jobs` filters with an email and a daily or weekly cadence. Nothing is emailed until they open the confirmation link. Unsubscribing deletes that row. Unconfirmed rows are deleted after 7 days.

Stored columns: `email`, `filter_query`, `cadence`, `confirm_token_hash`, `unsubscribe_token`, and the timestamps `created_at`, `confirm_expires_at`, `confirmed_at`, `last_sent_at`, `watermark_at`, `updated_at`. The live feed stores `firstSeenAt` at UTC midnight. Confirmation sets the watermark to the end of the previous UTC day, so that day's roles are still new. After a digest the watermark moves to the start of the UTC day just sent. Alerts include only open roles newer than the watermark that still match the filters. Each role links to `https://jobappagent.com/jobs/<slug>` (the page with Copy prompt). Emails are text and HTML with no images and no tracking pixels.

Mail uses the Resend API key the site already uses for founding ops alerts. With `RESEND_API_KEY` unset, subscribe returns “Email alerts are not available yet” and writes no row.

## Before it sends live

1. Apply the D1 migration (the Worker also runs `CREATE TABLE IF NOT EXISTS` on the first request):

   ```bash
   npx wrangler d1 migrations apply job-application-agent-public-stats --remote --config site/wrangler.jsonc
   ```

2. Worker secrets and vars, if they are not already set for founding mail:

   - `RESEND_API_KEY` — existing Resend key. No new account.
   - `RESEND_FROM_EMAIL` or `JOB_ALERTS_FROM_EMAIL` — a sender on the domain Resend already verifies. Default `JobAppAgent <attention@updates.jobappagent.com>`.
   - `JOB_ALERTS_CRON_SECRET` — long random bearer for `POST /api/internal/job-alerts`. `npx wrangler secret put JOB_ALERTS_CRON_SECRET --config site/wrangler.jsonc`
   - `RATE_LIMIT_SALT` — already required for public forms. Subscribe, confirm, and unsubscribe use it.
   - `PUBLIC_SITE_URL` — already `https://jobappagent.com`. Confirmation and role links use it.

3. In the GitHub `site-production` environment, add secret `JOB_ALERTS_CRON_SECRET` with the same value. The workflow `.github/workflows/job-alerts.yml` runs at 13:17 UTC every day, matches roles in Node (Workers Free cron CPU is 10 ms; board matching does not fit), and asks the Worker to send. Until the GitHub secret is set, the workflow logs `job alerts disabled` and exits 0.

4. In Resend, turn off open and click tracking for this sender so the provider does not add a tracking pixel or rewrite links.

No new paid service, binding, or account. The digest does not run inside the Worker cron.
