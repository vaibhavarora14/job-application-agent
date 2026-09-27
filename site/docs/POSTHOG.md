# PostHog ops (site — founding buyer + landing)

Prefer PostHog project **556627** (JobAppAgent). Events are personless (`$process_person_profile: false`) with GeoIP disabled. Never send buyer email, résumé content, form bodies, or buyer↔skill/installation joins.

## Secrets and vars

Server-side money-path capture (Worker):

```bash
cd site
npx wrangler secret put POSTHOG_PROJECT_API_KEY --config wrangler.jsonc
```

`POSTHOG_HOST` defaults to `https://us.i.posthog.com` via `wrangler.jsonc` vars (override only if the project host changes).

Landing client capture (public project API key — safe for the browser, still never commit):

```bash
# Cloudflare dashboard → Worker → Settings → Variables, or:
npx wrangler secret put NEXT_PUBLIC_POSTHOG_KEY --config wrangler.jsonc
# Prefer a plain Worker var (not a secret) once set: same phc_ project key is designed for client use.
```

Optional browser host override: `NEXT_PUBLIC_POSTHOG_HOST` (defaults to `POSTHOG_HOST` / US Cloud).

The landing client loads `{ apiKey, host }` from `GET /api/analytics-config` (204 when unset), then captures `$pageview` / CTA / return events. CSP allows `connect-src` to `https://us.i.posthog.com`.

Leave keys unset locally to disable capture. Redeploy after setting production values.

| Event | Where | Distinct id | Notes |
|---|---|---|---|
| `$pageview` | Landing client | anonymous UUID in `localStorage` | path + UTM when present |
| `founding_cta_clicked` | Landing client (CTA) | anonymous UUID | offer + UTM |
| `founding_checkout_created` | `POST /api/checkout` | `purchaseIdHash` | status, reused, UTM from JSON body |
| `founding_checkout_returned` | `/checkout/return` client | anonymous UUID | `purchaseIdHash` + polled status |
| `founding_payment_confirmed` | Dodo webhook on `succeeded` | `purchaseIdHash` | amount/currency when present — **no email** |

`purchaseIdHash` is SHA-256 of `purchase:{uuid}` — never the raw purchase id or buyer email.

## Verify ingest

1. Set `POSTHOG_PROJECT_API_KEY` (and optionally `NEXT_PUBLIC_POSTHOG_KEY`) on the Worker; redeploy.
2. Open `https://jobappagent.com/?utm_source=verify` — confirm `$pageview` in PostHog Live events.
3. Click **Reserve founding access** — confirm `founding_cta_clicked` then `founding_checkout_created`.
4. Complete a test-mode checkout and return — confirm `founding_checkout_returned`, then webhook `founding_payment_confirmed`.
5. Spot-check event properties: no `email`, no raw `purchaseId`, UTM only when present.

## Out of scope

- Hosted-apply / skill funnel events
- Telemetry Worker identity fields on these site events
- Cookie-consent banners beyond anonymous first-party distinct_id storage
