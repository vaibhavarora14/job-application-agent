# JobAppAgent Vercel Proxy

This directory configures the Vercel project (`jobappagent-proxy`) that connects the custom apex domain `https://jobappagent.com` to the Cloudflare Worker:
`https://job-application-agent-site.varora1406.workers.dev`

## Architecture

- **Domain Registrar / DNS**: Vercel (`jobappagent.com`)
- **DNS Records**:
  - Apex `A` record points to Vercel edge (`76.76.21.21`).
  - ImprovMX and Amazon SES MX/TXT records remain untouched in Vercel DNS.
- **Vercel Project**: Proxies all routes `/*` to the Cloudflare Worker.
- **Origin Worker**: Deployed via GitHub Actions (`.github/workflows/deploy-site.yml`) to Cloudflare Workers on every push to `main`.
