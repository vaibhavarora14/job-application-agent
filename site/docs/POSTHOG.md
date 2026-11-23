# PostHog ops (site — founding buyer + landing)

Prefer PostHog project **556627** (JobAppAgent). Ingest host: `https://us.i.posthog.com` (US Cloud capture; `us.posthog.com` is the app UI). Events are personless (`$process_person_profile: false`) with GeoIP disabled. Never send buyer email, résumé content, form bodies, or buyer↔skill/installation joins.

## Secrets and vars

Server-side money-path capture (Worker secret — never commit):

```bash
cd site
npx wrangler secret put POSTHOG_PROJECT_API_KEY --config wrangler.jsonc
```

`POSTHOG_HOST` defaults to `https://us.i.posthog.com` via `wrangler.jsonc` vars (override only if the project host changes).

Landing client capture (public project API key — safe for the browser, still never commit). Uses the existing `PUBLIC_*` vinext / Worker-var pattern (same family as `PUBLIC_SITE_URL`):

```bash
# Cloudflare dashboard → Worker → Settings → Variables, or:
npx wrangler secret put PUBLIC_POSTHOG_KEY --config wrangler.jsonc
# Prefer a plain Worker var once set: the phc_ project key is designed for client use.
```

Optional browser host override: `PUBLIC_POSTHOG_HOST`. Leave unset so the landing client uses the same-origin `/ingest` Worker proxy (PostHog ingest origins are remapped to `/ingest`). Do not point the browser at `https://us.i.posthog.com`.

The landing client loads `{ apiKey, host }` from `GET /api/analytics-config` (204 when unset), then captures `$pageview`, `$pageleave`, `$web_vitals`, CTA, and return events through `/ingest`. CSP `connect-src` is `'self'` only for analytics (the Worker proxies to PostHog).

Leave keys unset locally to disable capture. Redeploy after setting production values. Real keys are set on the Worker via wrangler after merge — this repo only wires env names + docs.

## Event names

| Event | Where | Distinct id | Notes |
|---|---|---|---|
| `$pageview` | Landing client | anonymous UUID in `localStorage` | path + UTM when present; UUIDv7 `$session_id` + `$host` |
| `$pageleave` | Landing client (`pagehide` / `visibilitychange`) | same anonymous UUID | same `$session_id`, `$current_url`, `$pathname`; sendBeacon / keepalive; once per page |
| `$web_vitals` | Landing client (`web-vitals`) | same anonymous UUID | LCP, CLS, INP in PostHog `$web_vitals_<NAME>_value` / `_event` shape |
| `founding_cta_clicked` | Landing client (CTA) | anonymous UUID | offer + UTM |
| `founding_checkout_created` | `POST /api/checkout` | `purchaseIdHash` | status, reused, UTM from JSON body |
| `founding_checkout_returned` | `/checkout/return` client | anonymous UUID | `purchaseIdHash` + polled status |
| `founding_payment_confirmed` | Dodo webhook on `succeeded` | `purchaseIdHash` | amount/currency when present — **no email** |

Browser events also set `$lib_custom_api_host` to `/ingest` so PostHog can detect the reverse proxy. Session ids are UUIDv7 in `sessionStorage` (per tab), rotated after 30 minutes idle or 24 hours (PostHog custom session id rules).

## Same-origin ingest proxy

The site Worker (production origin behind the Vercel host rewrite in `site-proxy/vercel.json`) intercepts `GET`/`POST` `/ingest/*` and forwards:

- `/ingest/static/*` and `/ingest/array/*` → `https://us-assets.i.posthog.com`
- everything else → `https://us.i.posthog.com`

Cookies and `Referer` are stripped; `Set-Cookie` from PostHog is dropped. Server-side founding events still POST directly to `POSTHOG_HOST` (not through `/ingest`).

`purchaseIdHash` is SHA-256 of `purchase:{uuid}` — never the raw purchase id or buyer email.

## Verify ingest

1. Set `POSTHOG_PROJECT_API_KEY` (and optionally `PUBLIC_POSTHOG_KEY`) on the Worker; redeploy.
2. Open `https://jobappagent.com/?utm_source=verify` — confirm `$pageview` in PostHog Live events. Network: capture POSTs go to `https://jobappagent.com/ingest/i/v0/e/` (not `us.i.posthog.com`). Properties include a UUIDv7 `$session_id` and `$host=jobappagent.com`.
3. Hide or close the tab — confirm `$pageleave` with the same `$session_id` / `$current_url` / `$pathname`.
4. Confirm a `$web_vitals` event with `$web_vitals_LCP_value` (CLS/INP appear when the library reports them).
5. Click **Reserve for $49** — confirm `founding_cta_clicked` then `founding_checkout_created`.
6. Complete a test-mode checkout and return — confirm `founding_checkout_returned`, then webhook `founding_payment_confirmed`.
7. Spot-check event properties: no `email`, no raw `purchaseId`, UTM only when present. The Health page warnings for session id, pageleave, web vitals, and reverse proxy clear after new events land (session id looks back 7 days).

## Out of scope

- Hosted-apply / skill funnel events
- Telemetry Worker identity fields on these site events
- Cookie-consent banners beyond anonymous first-party distinct_id storage

## Jobs board events

`/jobs` is still skipped by the landing client (`window.__JAA_JOBS_NO_ANALYTICS__` plus a pathname check) so founding `$pageview` does not start sending board filters or a raw `document.referrer`. A separate jobs client (`JobsAnalytics`) loads the same `/api/analytics-config` key and reuses `captureLandingEvent`. Browser capture posts only to hosts in CSP `connect-src` (`https://us.i.posthog.com`); a custom `PUBLIC_POSTHOG_HOST` that is not on that list is sent through the default ingest host.

| Event | Where | Distinct id | Notes |
|---|---|---|---|
| `$pageview` | `/jobs` board | anonymous UUID in `localStorage` | `surface=board`; `$current_url` is origin+pathname (no query/hash); allowlisted UTM only |
| `$pageview` | `/jobs/<slug>` | same | `surface=job_page`; slug is the public path only |
| `google_for_jobs_landing` | jobs surfaces, once per document | same | Google Search / `jobs.google.com` referrer host, or Google UTM with empty/`organic`/`referral` medium. Paid (`cpc`, `paidsearch`, `gclid`, …) is excluded. **Never** sends the referrer URL |
| `jobs_copy_clicked` | Copy prompt / Copy command | same | `copyKind` is `prompt` or `command`. Never clipboard contents |

`/jobs/alerts*` is not captured. GeoIP stays disabled; no `posthog-js`; no new cookies.

### Verify jobs ingest (after `deploy-site.yml`)

In PostHog project **556627** → Activity / Live events:

1. Open `https://jobappagent.com/jobs` — `$pageview` with `$pathname=/jobs`, `surface=board`, `$geoip_disable=true`, `$process_person_profile=false`. `$current_url` has no query string even if the address bar does.
2. Open `https://jobappagent.com/jobs/<slug>` — `$pageview` with that pathname and `surface=job_page`.
3. Open a job URL from Google (or `?utm_source=google&utm_medium=organic`) — the `$pageview` has `googleForJobs=true`, plus a `google_for_jobs_landing` event. Properties must not include `$referrer`, `gclid`, or a `q=` search string.
4. Click **Copy prompt** and **Copy command** — `jobs_copy_clicked` with `copyKind=prompt` then `copyKind=command`. No prompt text or CLI URL in properties.
