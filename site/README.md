# Job Application Agent — Cloud landing site

The public landing, community dashboard, and Dodo Payments checkout
surface for [jobappagent.com](https://jobappagent.com). It runs on Sites using
vinext, Cloudflare Workers, and D1.

## Local development

Requires Node.js `>=22.13.0`.

```bash
cp .env.example .env.local
npm ci
npm run dev
```

Payment settings are server-only. Never prefix them with `NEXT_PUBLIC_` or
commit populated environment files.

## Required production environment

- `PUBLIC_SITE_URL`: canonical HTTPS origin, currently `https://jobappagent.com`
- `RATE_LIMIT_SALT`: unique random secret used to pseudonymize rate-limit keys
- `COMMUNITY_STATS_UPSTREAM`: validated aggregate telemetry endpoint
- `COMMUNITY_JOBS_UPSTREAM`: maintainer-reviewed public job endpoint
- `REFUND_CRON_SECRET`: bearer secret shared with the daily refund workflow
- `ATTENTION_NOTIFY_SECRET`: bearer secret for attention notify + runner signal poll
- `ATTENTION_MAGIC_LINK_SECRET`: HMAC secret for `/attention/:id` magic links
- `RESEND_API_KEY`: Resend key for attention email (notify fails closed when unset)
- `RESEND_FROM_EMAIL`: optional From override for attention mail
- `ATTENTION_LIVE_SESSION_BASE_URL`: public noVNC/live-view base (agent-box port 6080); attention page embeds this after magic-link verify (required for buyer live panel)
- `ATTENTION_NOVNC_PASSWORD`: optional VNC password for Worker embed/redirect fragment only (never emailed)
- `ATTENTION_IAP_HELPER_COMMAND`: optional IAP tunnel one-liner for **founder/dev docs/ops only** (never shown in buyer UI)
- `ATTENTION_WAKE_URL`: optional webhook for on-demand agent-box wake (`gcloud compute instances start` outside the Worker)
- `ATTENTION_WAKE_INSTRUCTIONS`: optional wake instruction text for **internal/ops** wake API when wake URL is unset (never buyer UI)
- `DODO_PAYMENTS_API_KEY`: Dodo server API key for checkout-session creation
- `DODO_PAYMENTS_WEBHOOK_KEY`: signing secret for the configured endpoint
- `DODO_PRODUCT_ID`: one-time founding-access product
- `DODO_PAYMENTS_ENVIRONMENT`: `test_mode` during verification, then `live_mode`

Attention / resume MVP details: [`docs/ATTENTION.md`](docs/ATTENTION.md).
The Dodo webhook endpoint is `https://jobappagent.com/api/webhooks/dodo`.
Subscribe it to payment, successful refund, and dispute events. Checkout
collects the customer email; the landing page does not require a lead form.
Keep the Site in test mode until a checkout and signed `payment.succeeded`
delivery have both been verified.

Paid access is activated separately from payment. The 90-day entitlement starts
at activation. `.github/workflows/refund-unactivated-purchases.yml` calls the
protected refund endpoint daily and requests full, idempotent refunds for paid
purchases that remain unactivated after 60 days.

`stats.jobappagent.com` is attached to the same Sites project. Host-aware routing
serves the community dashboard at that origin while the telemetry Worker remains
the ingestion and aggregate-data service.

## Release checks

```bash
npm test
npm run lint
npx tsc --noEmit
npm audit --omit=dev
```

`npm test` builds the worker and covers community response validation, checkout
and webhook normalization, purchase activation/refund rules, public request
bounds, security headers, rate limiting, legal pages, crawler metadata, and the
D1 health probe.

## Data and deployment

- Automated deployment on every commit merge to `main` is handled by `.github/workflows/deploy-site.yml`.
- Builds with `vinext build` and deploys using `wrangler deploy --config site/wrangler.jsonc` to Cloudflare Workers.
- Uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets with the `site-production` environment.
- `.openai/hosting.json` binds D1 as `DB`.
- Drizzle migrations live in `drizzle/`.
- The worker also creates the rate-limit table defensively before the first
  public write, so a missing migration cannot leave anonymous endpoints open.
