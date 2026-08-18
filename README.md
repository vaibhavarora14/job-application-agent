# Job Application Agent — Cloud landing site

The public landing, founding-access registration, and Dodo Payments checkout
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
- `DODO_PAYMENTS_API_KEY`: Dodo server API key for checkout-session creation
- `DODO_PAYMENTS_WEBHOOK_KEY`: signing secret for the configured endpoint
- `DODO_PRODUCT_ID`: one-time founding-access product
- `DODO_PAYMENTS_ENVIRONMENT`: `test_mode` during verification, then `live_mode`

The Dodo webhook endpoint is `https://jobappagent.com/api/webhooks/dodo`.
Subscribe it to payment, successful refund, and dispute events. Keep the Site
in test mode until a checkout and signed `payment.succeeded` delivery have both
been verified.

## Release checks

```bash
npm test
npm run lint
npx tsc --noEmit
npm audit --omit=dev
```

`npm test` builds the worker and covers registration validation, checkout and
webhook normalization, public request bounds, security headers, rate limiting,
legal pages, crawler metadata, and the D1 health probe.

## Data and deployment

- `.openai/hosting.json` binds D1 as `DB`.
- Drizzle migrations live in `drizzle/`.
- The worker also creates the rate-limit table defensively before the first
  public write, so a missing migration cannot leave anonymous endpoints open.
- Runtime secrets belong in Sites environment variables, never in this repo.
- Deploy privately, verify registration and payment in Dodo test mode, then
  change access to public and repeat anonymous production smoke tests.
