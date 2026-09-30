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
- `RESEND_API_KEY`: Resend key for attention email and founding Support pay-success alerts (attention notify fails closed when unset; founding alert still structured-logs)
- `RESEND_FROM_EMAIL`: optional From override for attention / ops mail
- `FOUNDING_SUPPORT_ALERT_EMAIL`: optional Support inbox for founding `payment.succeeded` alerts (default `founders@jobappagent.com`)
- `ATTENTION_LIVE_SESSION_BASE_URL`: public noVNC/live-view base (agent-box port 6080); attention page embeds this after magic-link verify (required for buyer live panel)
- `ATTENTION_NOVNC_PASSWORD`: optional VNC password for Worker embed/redirect fragment only (never emailed)
- `ATTENTION_IAP_HELPER_COMMAND`: optional IAP tunnel one-liner for **founder/dev docs/ops only** (never shown in buyer UI)
- `ATTENTION_WAKE_URL`: optional webhook for on-demand agent-box wake (`gcloud compute instances start` outside the Worker)
- `ATTENTION_WAKE_INSTRUCTIONS`: optional wake instruction text for **internal/ops** wake API when wake URL is unset (never buyer UI)
- `DODO_PAYMENTS_API_KEY`: Dodo server API key for checkout-session creation
- `DODO_PAYMENTS_WEBHOOK_KEY`: signing secret for the configured endpoint
- `DODO_PRODUCT_ID`: one-time founding-access product
- `DODO_PAYMENTS_ENVIRONMENT`: `test_mode` during verification, then `live_mode`
- `SENTRY_DSN`: Sentry project DSN for Worker error monitoring (secret; see below)
- `SENTRY_ENVIRONMENT`: optional environment tag; defaults to `production` when `PUBLIC_SITE_URL` is jobappagent.com
- `SENTRY_RELEASE`: git SHA stamped by `deploy-site.yml` (`--var SENTRY_RELEASE:$GITHUB_SHA`)
- `POSTHOG_PROJECT_API_KEY`: PostHog project API key for server-side founding funnel capture (secret; project 556627)
- `POSTHOG_HOST`: PostHog ingest host (var; default `https://us.i.posthog.com`)
- `PUBLIC_POSTHOG_KEY`: public project API key for landing `$pageview` / CTA client capture (Worker var; `PUBLIC_*` vinext pattern; never commit)
- `PUBLIC_POSTHOG_HOST`: optional browser PostHog host override

### Sentry (error monitoring)

The site Worker uses [`@sentry/cloudflare`](https://docs.sentry.io/platforms/javascript/guides/cloudflare/) with tag `service: site`. Unhandled exceptions are captured automatically. Swallowed money-path failures (`/api/checkout`, `/api/checkout/status`, `/api/webhooks/dodo`) call `captureException`, and other `/api/*` 5xx responses are reported as messages. Deploys stamp `SENTRY_RELEASE` from `GITHUB_SHA` so Issues are release-tagged. Worker source maps are out of scope for P0 — see [`docs/SENTRY.md`](docs/SENTRY.md).

Set the DSN as a Wrangler secret (never commit the value):

```bash
cd site
npx wrangler secret put SENTRY_DSN --config wrangler.jsonc
```

Optional environment override:

```bash
npx wrangler secret put SENTRY_ENVIRONMENT --config wrangler.jsonc
# or a non-secret var in the Cloudflare dashboard
```

**Verify:** after deploy with the secret set, force a controlled 5xx (for example briefly unset `DODO_PAYMENTS_API_KEY` and `POST /api/checkout`, or throw once in a throwaway preview). Confirm an Issue appears in the shared Sentry project (org `jobappagent`) tagged `service:site` with the deploy release SHA. Clear/restore the secret after the test. Leave `SENTRY_DSN` unset locally to keep Sentry disabled.

Do not add Sentry to the npm skill / agent client — privacy posture forbids shipping raw agent errors.

### PostHog (founding buyer + landing)

Server-side events on checkout create and payment webhook confirmation use `POSTHOG_PROJECT_API_KEY`. Landing pageviews, UTM, and founding CTA clicks use `PUBLIC_POSTHOG_KEY` from the browser (CSP allows `https://us.i.posthog.com`). Properties stay privacy-tight: `purchaseIdHash` only, never buyer email. Full ops notes: [`docs/POSTHOG.md`](docs/POSTHOG.md).

```bash
cd site
npx wrangler secret put POSTHOG_PROJECT_API_KEY --config wrangler.jsonc
# Set PUBLIC_POSTHOG_KEY as a Worker var (same project key is client-safe).
```

Attention / resume MVP details: [`docs/ATTENTION.md`](docs/ATTENTION.md).
The Dodo webhook endpoint is `https://jobappagent.com/api/webhooks/dodo`.
Subscribe it to payment, successful refund, and dispute events. Checkout
collects the customer email; the landing page does not require a lead form.
Keep the Site in test mode until a checkout and signed `payment.succeeded`
delivery have both been verified.

Paid access is activated separately from payment (ops emails hosted access
details after a verified founding purchase; `activatePurchase` starts the
90-day window when the seat is actually handed over). Verified
`payment.succeeded` persists D1 `succeeded` and alerts Support — see
[`docs/FOUNDING_ACTIVATION.md`](docs/FOUNDING_ACTIVATION.md). The public site
never promises instant self-serve dashboard access or automatic refunds.
Internal `.github/workflows/refund-unactivated-purchases.yml` calls the
protected refund endpoint for ops only.

Dodo checkout **product name/description** are dashboard-owned (Checkout Session
API cannot override them). Ops must keep the founding SKU on Hosted wording —
see [`docs/DODO_PRODUCT.md`](docs/DODO_PRODUCT.md). Design can recheck the
post-pay success UI without a card charge at `/checkout/return?design=success`.

`stats.jobappagent.com` is attached to the same Sites Worker via the Vercel
proxy (`site-proxy/`). Host-aware routing serves the community dashboard at that
origin while the telemetry Worker remains the ingestion and aggregate-data
service. Keep the `stats` DNS `CNAME` on `cname.vercel-dns.com` (not
`custom-domains.chatgpt.site`) so founding CTA copy stays in lockstep with
`jobappagent.com`.

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
