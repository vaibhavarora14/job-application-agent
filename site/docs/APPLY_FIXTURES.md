# Apply fixtures (site)

Static ATS-shaped apply forms for prove/smoke/E2E. Canonical copies also live in `job-application-agent/fixtures/`.

After the next site deploy, these are public at:

- https://jobappagent.com/fixtures/greenhouse/
- https://jobappagent.com/fixtures/lever/
- https://jobappagent.com/fixtures/ashby/

Confirmation pages: `…/confirmation.html` with **Thank you for applying (fixture)**.

Allowlist + `LIVE_APPLY` gate: `job-application-agent/fixtures/README.md` and `scripts/ats/apply-url-gate.mjs`.

**Deploy note:** files under `site/public/fixtures/` ship with the Worker asset bundle (`wrangler` `assets.directory` = `dist/client`). No extra Worker route is required for static HTML.
