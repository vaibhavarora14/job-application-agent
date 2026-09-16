# P1 Attention / Resume (hosted MVP)

Productizes the hosted-run attention pause: email notify → magic-link attention page → **in-browser live panel** → resume/skip/abort signals → GCP runner poll.

## Env vars (site Worker)

| Variable | Required | Purpose |
|----------|----------|---------|
| `ATTENTION_NOTIFY_SECRET` | yes (to enable) | Bearer secret for internal attention APIs (`attention-notify`, `attention-signals`, `attention-wake`) and runner poll |
| `ATTENTION_MAGIC_LINK_SECRET` | yes (to enable) | HMAC secret for signed `/attention/:id?token=…` links (≥16 chars; use `openssl rand -hex 32`) |
| `RESEND_API_KEY` | yes (to send mail) | Resend API key. **Fail-closed** when missing — notify returns 503 and logs |
| `RESEND_FROM_EMAIL` | no | Default `JobAppAgent <attention@jobappagent.com>` |
| `PUBLIC_SITE_URL` | yes | Origin used to build magic links (already used for checkout) |
| `ATTENTION_LIVE_SESSION_BASE_URL` | no | Public HTTPS front for agent-box noVNC (historically port **6080**). Example: `https://novnc.example/vnc.html`. When set, live-session embeds/redirects here after magic-link verify |
| `ATTENTION_NOVNC_PASSWORD` | no | VNC password held only on the Worker. Injected into the **URL fragment** for the embed iframe / redirect — **never emailed**. Omit to let noVNC prompt |
| `ATTENTION_IAP_HELPER_COMMAND` | no | Override the IAP tunnel one-liner shown when `ATTENTION_LIVE_SESSION_BASE_URL` is unset |
| `ATTENTION_WAKE_URL` | no | Optional HTTPS webhook for on-demand VM wake. When set, opening live session / `POST /api/internal/attention-wake` POSTs a signed wake payload here (Bearer `ATTENTION_NOTIFY_SECRET`). Wire to `gcloud compute instances start` outside the Worker |
| `ATTENTION_WAKE_INSTRUCTIONS` | no | Override the founder wake instructions returned when `ATTENTION_WAKE_URL` is unset |

## CLI / runner host env (agent-box)

| Variable | Purpose |
|----------|---------|
| `ATTENTION_NOTIFY_URL` | e.g. `https://jobappagent.com/api/internal/attention-notify` |
| `ATTENTION_NOTIFY_SECRET` | Same bearer as the site Worker |
| `PUBLIC_SITE_URL` | Optional; poll client uses this (or derives origin from `ATTENTION_NOTIFY_URL`) |

After `attention add`, the skill CLI POSTs to the site notify API when notify URL + secret are set. Uses profile email + optional `company`/`role` (or ledger lookup). Notify failure is logged and does not roll back the attention event.

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

### `GET /api/attention/:id/live-session?token=…&embed=1`

Auth’d live-session entry (buyer path = **in-page embed**):

1. Verifies the same magic-link token as `/attention/:id`.
2. Best-effort **wake** (see below) so on-demand agent-box can start before noVNC connects.
3. If `ATTENTION_LIVE_SESSION_BASE_URL` is set:
   - **`embed=1`** (attention panel) → same-origin HTML shell that iframes noVNC with `autoconnect=true` and optional `ATTENTION_NOVNC_PASSWORD` in the **hash fragment** (not query). Worker CSP allows `frame-ancestors 'self'` and `frame-src` for the noVNC origin.
   - Without `embed` → **302** to noVNC (new-tab / email deep-link fallback).
4. If unset → HTML page with a copy-paste **IAP tunnel** helper for agent-box port 6080 and local `http://127.0.0.1:6080/vnc.html` (founder-only fallback).

Full WebSocket reverse-proxy through the Worker remains out of scope; public HTTPS noVNC embed is the buyer path.

### `POST /api/attention/:id/wake`

Magic-link body `{ "token": "…" }`. Same wake seam as the internal route; used by the attention page before loading the live panel. Returns `{ status: "dispatched" | "recorded", message, instructions? }`.

### `POST /api/internal/attention-wake`

Bearer `ATTENTION_NOTIFY_SECRET`. Body:

```json
{ "attentionId": "attention-…", "reason": "live_session", "source": "ops" }
```

- If `ATTENTION_WAKE_URL` is set → POSTs `{ type: "attention_wake", attentionId, reason, source, requestedAt }` to that webhook (Bearer secret).
- If unset → `{ status: "recorded", instructions: "gcloud compute instances start …" }` for Personal/ops to start agent-box manually.

No GCP credentials are required inside the Worker for this MVP.

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

`signal: null` / `pending: false` means still waiting — keep polling while the lease is held.

## Runner poll client

```bash
node job-application-agent/scripts/attention-runner-poll.mjs \
  --attention-id attention-… \
  --interval 5 \
  --timeout 3600
```

| Exit | Meaning | Next action |
|------|---------|-------------|
| `0` | `resume_requested` | Renew lease → **re-inspect** ATS page → submit only on visible confirm → intent confirm |
| `10` | `skipped` | `attention resolve`, no submit, continue round |
| `11` | `aborted` | `cloud lease-release`, end round |
| `20` | timeout / `--once` still waiting | Renew lease or re-notify |
| `1` | config/HTTP error | Fix `ATTENTION_NOTIFY_SECRET` / site URL |

## Resume re-inspect checklist (agent)

After exit `0` / `resume_requested`:

1. `cloud lease-renew` (lease must stay held through the pause).
2. Re-open or focus the **same** ATS tab/page the candidate used in the live session.
3. Re-check required fields, uploads, and disclosures on the live page — do not trust prior fill state blindly.
4. Submit **only** when the ATS shows a visible success/confirmation surface.
5. `cloud intent-confirm` / `ledger add` only after that visible confirm. **filled ≠ applied.**
6. If confirmation is missing or the page still blocks → `attention add` again honestly (never invent success).
7. On skip (`10`): `attention resolve`, do not submit, continue the round.
8. On abort (`11`): `cloud lease-release`, end the round.

Ledger/intent rules are unchanged from `SKILL.md` / `RUNS.md` / `state-worker/AGENT.md`.

## UI

`/attention/:id?token=…` — Quiet Trust attention card: blocker chip, required actions, lease badge.

**Open live browser** expands an **in-page live panel** (iframe → `/api/attention/:id/live-session?token=…&embed=1`). Resume / Skip / Abort stay visible beside the panel. Optional full-bleed expand and “Open in new tab” for desktop.

Status line shows **Starting live browser…** while wake runs. IAP helper HTML is shown inside the panel when `ATTENTION_LIVE_SESSION_BASE_URL` is unset (founder-only).

## On-demand agent-box wake

agent-box may be **stopped** for cost. Opening the live panel triggers the wake seam before loading noVNC:

1. Attention page → `POST /api/attention/:id/wake`
2. Live-session route also best-effort dispatches wake
3. Ops can call `POST /api/internal/attention-wake` directly

Wire `ATTENTION_WAKE_URL` later to a small starter that runs:

```bash
gcloud compute instances start agent-box \
  --zone=asia-south1-a \
  --project=agent-runner-vaibhav-4500
```

Cold-start still needs Xvfb + x11vnc/noVNC on `:6080` after the instance is RUNNING. Never stop while a cloud lease is held or `/tmp/jaa-hosted-fill.running` exists.

## Playable demo (founder on agent-box)

### One-time Worker secrets

```bash
cd site
npx wrangler secret put ATTENTION_NOTIFY_SECRET
npx wrangler secret put ATTENTION_MAGIC_LINK_SECRET   # openssl rand -hex 32
npx wrangler secret put RESEND_API_KEY
# Optional public noVNC front (otherwise IAP helper page is used):
npx wrangler secret put ATTENTION_LIVE_SESSION_BASE_URL
npx wrangler secret put ATTENTION_NOVNC_PASSWORD
# Optional wake webhook (otherwise instructions are returned):
# npx wrangler secret put ATTENTION_WAKE_URL
```

Ensure `PUBLIC_SITE_URL=https://jobappagent.com` is set (wrangler vars already default this).

### Agent-box env

```bash
export ATTENTION_NOTIFY_URL=https://jobappagent.com/api/internal/attention-notify
export ATTENTION_NOTIFY_SECRET=…   # same as Worker
export PUBLIC_SITE_URL=https://jobappagent.com
```

### Demo loop

1. Hold an application-run lease (`cloud lease-acquire`).
2. Open attention (CLI or curl notify):

```bash
node job-application-agent/scripts/job-application.mjs attention add --stdin <<'JSON'
{
  "roundId": "round-demo",
  "applicationId": "app-demo",
  "url": "https://jobs.example.com/role",
  "stage": "submission",
  "blocker": "captcha",
  "requiredActions": ["complete-captcha"],
  "company": "DemoCo",
  "role": "Demo Role"
}
JSON
```

3. Open the magic link from email (or `magicLinkUrl` from the notify JSON response).
4. Click **Open live browser**:
   - With base URL + password secrets → in-page panel embeds noVNC autoconnected.
   - Without → IAP tunnel helper appears in the panel; open local `http://127.0.0.1:6080/vnc.html`.
5. Finish the blocker in the live browser.
6. Click **I’ve finished — resume**.
7. On the runner:

```bash
node job-application-agent/scripts/attention-runner-poll.mjs \
  --attention-id attention-…   # id from step 2
# expect exit 0 and printed resume checklist
```

8. Follow the resume re-inspect checklist above.

## Out of scope (follow-ups)

- Full WebSocket noVNC reverse-proxy through the site Worker (next slice after embed works)
- Browserbase / Steel
- Playwright auto-resume loop on the VM
- Multi-tenant paid→slot / billing
- CAPTCHA solving / VERIFYING badge flip
- Changing founding/checkout copy
