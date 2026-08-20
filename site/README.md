# JobAppAgent — Cloud landing site

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
- `REFUND_CRON_SECRET`: bearer secret shared with the daily refund workflow
- `DODO_PAYMENTS_API_KEY`: Dodo server API key for checkout-session creation
- `DODO_PAYMENTS_WEBHOOK_KEY`: signing secret for the configured endpoint
- `DODO_PRODUCT_ID`: one-time founding-access product. The live product uses
  Dodo `by_country` localized pricing: USD $49 by default and INR ₹3,388.98
  before 18% GST for India, producing a ₹3,999 tax-inclusive checkout total.
- `DODO_PAYMENTS_ENVIRONMENT`: `test_mode` during verification, then `live_mode`
- `RESEND_API_KEY`: send-only key restricted to `updates.jobappagent.com`
- `WELCOME_EMAIL_FROM`: `Vaibhav at JobAppAgent <vaibhav@updates.jobappagent.com>`
- `SUPPORT_EMAIL`: reply-capable address, currently `support@jobappagent.com`

The Dodo webhook endpoint is `https://jobappagent.com/api/webhooks/dodo`.
Subscribe it to payment, successful refund, and dispute events. Checkout
collects the customer email; the landing page does not require a lead form.
Keep the Site in test mode until a checkout and signed `payment.succeeded`
delivery have both been verified.

Each signed `payment.succeeded` webhook also claims one versioned delivery row
and sends the purchase welcome through Resend. D1 provides permanent
deduplication across webhook replays; Resend receives the stable
`purchase-welcome-v1/<purchase-id>` idempotency key for retry safety. A provider
or persistence failure returns `503` so Dodo can retry fulfillment. The email
uses the purchase's stored `access_days` value rather than current landing-page
copy.

Paid access is activated separately from payment. New purchases store a 30-day
entitlement, while purchases made under the earlier offer retain their stored
90 days; either period starts at activation. `.github/workflows/refund-unactivated-purchases.yml` calls the
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

- `.openai/hosting.json` binds D1 as `DB`.
- Drizzle migrations live in `drizzle/`.
- The worker also creates the rate-limit table defensively before the first
  public write, so a missing migration cannot leave anonymous endpoints open.
- Runtime secrets belong in Sites environment variables, never in this repo.
- Deploy privately, verify checkout and payment in Dodo test mode, then
  change access to public and repeat anonymous production smoke tests.

## Transactional email setup

Use a dedicated Resend account because the free plan permits one verified
domain and the existing account already serves another product. Keep the
existing default CLI profile untouched:

```bash
resend login --profile jobappagent
resend domains create --profile jobappagent --name updates.jobappagent.com --tls enforced --json
resend domains verify --profile jobappagent <domain-id> --json
resend api-keys create --profile jobappagent --name "JobAppAgent production" --permission sending_access --domain-id <domain-id> --json
```

Add the SPF and DKIM records returned by the domain-create command before
verification. Leave open and click tracking disabled. Store the API token when
it is created—it cannot be retrieved again—and add it directly to the Site's
`RESEND_API_KEY` secret. Configure Cloudflare Email Routing so
`support@jobappagent.com` forwards to an owner-controlled, verified destination.
