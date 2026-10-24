# JobAppAgent Vercel Proxy

This directory configures the Vercel project (`jobappagent-proxy`) that connects
custom domains to the Cloudflare Worker:
`https://job-application-agent-site.varora1406.workers.dev`

## Architecture

- **Domain Registrar / DNS**: Vercel (`jobappagent.com`)
- **DNS Records**:
    - Apex `A` record points to Vercel edge (`76.76.21.21`).
    - `stats.jobappagent.com` must `CNAME` to `cname.vercel-dns.com` (same proxy as
      the apex). Do **not** point it at `custom-domains.chatgpt.site` — that OpenAI
      Sites edge can lag main and reintroduce stale founding CTA copy
      (e.g. “Reserve 90-day access · $49”).
    - ImprovMX and Amazon SES MX/TXT records remain untouched in Vercel DNS.
- **Vercel Project**: Proxies all routes `/*` to the Cloudflare Worker for both
  `jobappagent.com` and `stats.jobappagent.com`.
- **Origin Worker**: Deployed via GitHub Actions (`.github/workflows/deploy-site.yml`)
  to Cloudflare Workers on every push to `main`.

## Edge cache (Workers Cache API)

The Worker (`site/lib/edge-cache.mjs`) stores anonymous HTML in `caches.default`.
That cache **does HIT** when the Worker is hit directly
(`*.workers.dev`). The apex must not be shared-cached by Vercel in front of the
Worker: a cached `x-cache: MISS` response would be replayed forever and origin
would never see a second request. The Worker therefore sends
`Cache-Control: private, no-store` and `Vercel-CDN-Cache-Control: no-store` on
edge-cached routes so Vercel always re-originates; freshness lives only in
`caches.default`.

### Out-of-repo option (not applied by this repo)

To drop the Vercel hop entirely (optional, free Cloudflare DNS + Worker route):
point `jobappagent.com` at Cloudflare and attach a route to
`job-application-agent-site`. Do **not** change live DNS/routes from CI; that is
an operator change outside this repository.

Host-aware routing in `site/proxy.ts` rewrites `stats.jobappagent.com/` to
`/community-view`. Founding CTA copy is shared via `FOUNDING_CTA_LABEL`
(`Reserve for $49`) in `site/lib/payment-core.mjs` and `FoundingCheckout`.
Post-deploy checks in `.github/workflows/deploy-site.yml` assert reservation
copy (`Founding reservation` / `Reserve for $49`) and reject stale activate /
open-hosted framing.
