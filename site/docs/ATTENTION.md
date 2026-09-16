# P1 Attention / Resume (hosted MVP)

Productizes the hosted-run attention pause: email notify → magic-link attention page → resume/skip/abort signals for the GCP runner.

## Env vars (site Worker)

| Variable | Required | Purpose |
|----------|----------|---------|
| `ATTENTION_NOTIFY_SECRET` | yes (to enable) | Bearer secret for `POST /api/internal/attention-notify` and runner poll `GET /api/internal/attention-signals/:id` |
| `ATTENTION_MAGIC_LINK_SECRET` | yes (to enable) | HMAC secret for signed `/attention/:id?token=…` links (≥16 chars; use `openssl rand -hex 32`) |
| `RESEND_API_KEY` | yes (to send mail) | Resend API key. **Fail-closed** when missing — notify returns 503 and logs |
| `RESEND_FROM_EMAIL` | no | Default `JobAppAgent <attention@jobappagent.com>` |
| `PUBLIC_SITE_URL` | yes | Origin used to build magic links (already used for checkout) |
| `ATTENTION_LIVE_SESSION_BASE_URL` | no (Ticket 2 stub) | noVNC / live-view base URL. Page appends `?attention=<id>` when absent. Harden auth proxy in a follow-up |

## CLI hook (agent-box)

Optional — after `attention add`, the skill CLI POSTs to the site notify API when both are set:

| Variable | Purpose |
|----------|---------|
| `ATTENTION_NOTIFY_URL` | e.g. `https://jobappagent.com/api/internal/attention-notify` |
| `ATTENTION_NOTIFY_SECRET` | Same bearer as the site Worker |

Uses profile email + optional `company`/`role` on the attention input (or ledger lookup by `applicationId`). Notify failure is logged and does not roll back the attention event.

## APIs

### `POST /api/internal/attention-notify`

Bearer `ATTENTION_NOTIFY_SECRET`. Body:

```json
{
  "attentionId": "attention-…",
  "email": "candidate@example.com",
  "company": "LiveKit",
  "role": "Forward Deployed Engineer",
  "url": "https://…",
  "stage": "submission",
  "blocker": "legal-attestation",
  "requiredActions": ["review-legal", "provide-judgment", "complete-captcha"]
}
```

Sends email subject `Action needed: {company} — {role}` with checklist + **Open live session** magic link (~45 min TTL). Never includes VNC passwords.

### `POST /api/attention/:id/signal`

Magic-link body `{ "token": "…", "action": "resume" | "skip" | "abort" }`.
Stores a coordination row in site D1 (`attention_signals`). **Not** the application ledger — state-worker attention stream remains SoT for opened/resolved.

### `GET /api/internal/attention-signals/:id`

Bearer poll for the GCP runner.

```json
{
  "attentionId": "attention-…",
  "signal": "resume_requested",
  "pending": true,
  "resumeRequested": true,
  "skipped": false,
  "aborted": false,
  "updatedAt": "…"
}
```

## Runner contract (Ticket 3 stub)

```
TODO(runner): while lease held and attention open, poll
GET /api/internal/attention-signals/:id every ~5s with ATTENTION_NOTIFY_SECRET.

- resume_requested → renew lease → re-inspect ATS page → submit only with visible confirm
  or re-open attention honestly. filled ≠ applied until ledger intent confirm.
- skipped → resolve attention, no submit, continue round
- aborted → release lease, end round
```

## UI

`/attention/:id?token=…` — Quiet Trust attention card: blocker chip, required actions, lease badge, Open live session / I’ve finished — resume / Skip / Abort.

## Out of scope (follow-ups)

- Auth’d noVNC proxy (Ticket 2 hardening)
- Playwright resume loop on the VM
- Multi-tenant paid→slot
- CAPTCHA solving / VERIFYING badge flip
