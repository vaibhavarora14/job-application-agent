# Sentry ops (site Worker)

Org: **jobappagent**. One Sentry project covers the site Worker (and future pilots); distinguish with tags (`service`, `environment`).

## Set the secret

Never commit the DSN. On the production Worker:

```bash
cd site
npx wrangler secret put SENTRY_DSN --config wrangler.jsonc
```

Optional:

```bash
npx wrangler secret put SENTRY_ENVIRONMENT --config wrangler.jsonc
```

Redeploy (or wait for the next `deploy-site` workflow) after setting secrets.

## What is instrumented

- `@sentry/cloudflare` `withSentry` on `site/worker/index.ts` — unhandled exceptions
- Explicit `captureException` on money-path API catches: `/api/checkout`, `/api/checkout/status`, `/api/webhooks/dodo`
- Other `/api/*` 5xx responses reported as messages when no exception was already captured
- Tag: `service: site`

## Out of scope

- Telemetry Worker (observability intentionally off)
- npm package / Agent Skill client (privacy: no raw agent errors)

## Verify

1. Confirm `SENTRY_DSN` is set: `npx wrangler secret list --config wrangler.jsonc`
2. Trigger a controlled 5xx (e.g. temporarily clear payment secrets and `POST /api/checkout`)
3. Open the Sentry project Issues view and filter `service:site`
4. Restore production secrets after the test
