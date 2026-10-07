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

Host-aware routing in `site/proxy.ts` rewrites `stats.jobappagent.com/` to
`/community-view`. Founding CTA copy is shared via `FOUNDING_CTA_LABEL`
(`Reserve for $49`) in `site/lib/payment-core.mjs` and `FoundingCheckout`.
Post-deploy checks in `.github/workflows/deploy-site.yml` assert reservation
copy (`Founding reservation` / `Reserve for $49`) and reject stale activate /
open-hosted framing.
