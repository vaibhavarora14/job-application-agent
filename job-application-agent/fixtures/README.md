# Owned apply fixtures + LIVE_APPLY gate

Self-hosted ATS-shaped apply forms for prove / smoke / E2E. **Default CI and prove runners must never submit to real employer jobs.**

## Fixture URLs

| ATS | Local (package static server) | Hosted (after site deploy) |
|-----|-------------------------------|----------------------------|
| Greenhouse | `http://127.0.0.1:4173/fixtures/greenhouse/` | `https://jobappagent.com/fixtures/greenhouse/` |
| Lever | `http://127.0.0.1:4173/fixtures/lever/` | `https://jobappagent.com/fixtures/lever/` |
| Ashby | `http://127.0.0.1:4173/fixtures/ashby/` | `https://jobappagent.com/fixtures/ashby/` |

Confirmation pages (submit target):

- `/fixtures/greenhouse/confirmation.html`
- `/fixtures/lever/confirmation.html`
- `/fixtures/ashby/confirmation.html`

Each confirmation page includes clear **Thank you for applying (fixture)** text so Playwright / `detectConfirmation` can treat it as success.

Allowlist source of truth: [`test-jobs.json`](./test-jobs.json) (`kind: "fixture"` | `"vendor-sandbox"`).

## Serve locally

```bash
node job-application-agent/scripts/serve-apply-fixtures.mjs
# → http://127.0.0.1:4173/fixtures/...
```

Hosted copies live under `site/public/fixtures/` and ship with the Cloudflare Worker asset bundle on deploy. Prefer these owned fixtures over vendor sandboxes for CI.

## LIVE_APPLY

`assertApplyUrlAllowed(url)` (see `scripts/ats/apply-url-gate.mjs`) refuses any URL that is not on the allowlist unless:

```bash
LIVE_APPLY=1
```

When `LIVE_APPLY=1`, the gate logs an explicit warning and allows a one-off real employer URL (ops / Mac-home proof only — never default CI).

Gate enforcement for resume→submit / prove scripts:

| Env | Effect |
|-----|--------|
| `APPLY_URL_GATE=1` or `CI=true` or `PROVE_APPLY=1` | Enforce allowlist (unless `LIVE_APPLY=1`) |
| `APPLY_URL_GATE=0` | Disable gate (Hosted interactive buyer path) |
| `LIVE_APPLY=1` | Allow non-allowlisted URLs; always logged |

## Ledger marking

Fixture / vendor-sandbox applies store `applyKind: "fixture"` or `"vendor-sandbox"` (equivalent to “source=fixture” for metrics). Those entries:

- are skipped for community job contribution
- do not emit `application_submitted` usage telemetry
- are excluded from effective submission / round confirmation counts

`source` / `applicationChannel` remain the ATS channel (`greenhouse`, `lever`, `ashby`).

## Vendor sandboxes (kind=`vendor-sandbox`)

Optional non-employer demos on the allowlist (not default CI):

- `https://jobs.ashbyhq.com/ashby-embed-demo-org…`
- Ashby posts whose title contains `[ASHBY] - For Testing Use Only` (pass `pageTitle` into the gate)
- `https://jobs.lever.co/leverdemo…`

Real employer URLs (e.g. Confluent) are **not** allowlisted.
