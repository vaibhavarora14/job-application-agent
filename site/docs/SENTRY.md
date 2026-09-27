# Sentry ops (site Worker)

Org: **jobappagent**. One Sentry project covers the site Worker (and future pilots); distinguish with tags (`service`, `environment`, `release`).

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

## Release tagging

`deploy-site.yml` passes `--var SENTRY_RELEASE:$GITHUB_SHA` on every Worker deploy. `siteSentryOptions` reads that binding so Issues are grouped by git SHA.

Source maps for Cloudflare Workers are **out of scope for P0** — release tagging alone is enough to know which deploy introduced an error. Uploading Worker source maps can be revisited later if stack readability becomes a priority.

## What is instrumented

- `@sentry/cloudflare` `withSentry` on `site/worker/index.ts` — unhandled exceptions
- Explicit `captureException` on money-path API catches: `/api/checkout`, `/api/checkout/status`, `/api/webhooks/dodo`
- Other `/api/*` 5xx responses reported as messages when no exception was already captured
- Tag: `service: site`
- Release: git SHA when `SENTRY_RELEASE` is set on deploy

## Out of scope

- Telemetry Worker (observability intentionally off)
- npm package / Agent Skill client (privacy: no raw agent errors)
- Worker source-map upload (P0 = release tag only)

## Verify

1. Confirm `SENTRY_DSN` is set: `npx wrangler secret list --config wrangler.jsonc`
2. After a `deploy-site` run, confirm the Worker var `SENTRY_RELEASE` matches the deploy commit
3. Trigger a controlled 5xx (e.g. temporarily clear payment secrets and `POST /api/checkout`)
4. Open the Sentry project Issues view and filter `service:site`; the issue should show the release SHA
5. Restore production secrets after the test
