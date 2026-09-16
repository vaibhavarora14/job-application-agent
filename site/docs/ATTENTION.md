# P1 Attention / Resume (hosted MVP)

Productizes the hosted-run attention pause: email notify → magic-link attention page → auth’d live session → resume/skip/abort signals → GCP runner poll.

## Env vars (site Worker)

| Variable | Required | Purpose |
|----------|----------|---------|
| `ATTENTION_NOTIFY_SECRET` | yes (to enable) | Bearer secret for `POST /api/internal/attention-notify` and runner poll `GET /api/internal/attention-signals/:id` |
| `ATTENTION_MAGIC_LINK_SECRET` | yes (to enable) | HMAC secret for signed `/attention/:id?token=…` links (≥16 chars; use `openssl rand -hex 32`) |
| `RESEND_API_KEY` | yes (to send mail) | Resend API key. **Fail-closed** when missing — notify returns 503 and logs |
| `RESEND_FROM_EMAIL` | no | Default `JobAppAgent <attention@jobappagent.com>` |
| `PUBLIC_SITE_URL` | yes | Origin used to build magic links (already used for checkout) |
| `ATTENTION_LIVE_SESSION_BASE_URL` | no | Public HTTPS front for agent-box noVNC (historically port **6080**). Example: `https://novnc.example/vnc.html`. When set, `/api/attention/:id/live-session` 302s here after magic-link verify |
| `ATTENTION_NOVNC_PASSWORD` | no | VNC password held only on the Worker. Injected into the **URL fragment** on redirect — **never emailed**. Omit to let noVNC prompt |
| `ATTENTION_IAP_HELPER_COMMAND` | no | Override the IAP tunnel one-liner shown when `ATTENTION_LIVE_SESSION_BASE_URL` is unset |

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

### `GET /api/attention/:id/live-session?token=…`

Auth’d live-session entry (Ticket 2):

1. Verifies the same magic-link token as `/attention/:id`.
2. If `ATTENTION_LIVE_SESSION_BASE_URL` is set → **302** to noVNC with `autoconnect=true` and optional `ATTENTION_NOVNC_PASSWORD` in the **hash fragment** (not query), so intermediaries do not log the password.
3. If unset → HTML page with a copy-paste **IAP tunnel** helper for agent-box port 6080 and local `http://127.0.0.1:6080/vnc.html`.

Full WebSocket reverse-proxy through the Worker is out of scope; this path is playable without Slack/VNC tribal knowledge.

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

**Open live session** → `/api/attention/:id/live-session?token=…` (never raw VNC password).

Then **I’ve finished — resume** / **Skip** / **Abort**.

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
4. Click **Open live session**:
   - With base URL + password secrets → lands in noVNC autoconnected.
   - Without → follow the IAP tunnel commands on the page, open `http://127.0.0.1:6080/vnc.html`.
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

- Full WebSocket noVNC reverse-proxy through the site Worker
- Playwright auto-resume loop on the VM
- Multi-tenant paid→slot
- CAPTCHA solving / VERIFYING badge flip
