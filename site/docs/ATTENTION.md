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
| `ATTENTION_LIVE_SESSION_BASE_URL` | no | Public HTTPS front for agent-box noVNC (historically port **6080**). Example: `https://novnc.example/vnc.html`. When set, live-session embeds/redirects here after magic-link verify. **Required for buyer live panel.** When unset, buyers see a soft “temporarily unavailable” message |
| `ATTENTION_NOVNC_PASSWORD` | no | VNC password held only on the Worker. Injected into the **URL fragment** for the embed iframe / redirect — **never emailed**. Omit to let noVNC prompt |
| `ATTENTION_IAP_HELPER_COMMAND` | no | **Founder/dev only.** Override the IAP tunnel one-liner documented below. Never rendered on buyer attention surfaces |
| `ATTENTION_WAKE_URL` | no | Optional HTTPS webhook for on-demand VM wake. When set, opening live session / `POST /api/internal/attention-wake` POSTs a signed wake payload here (Bearer `ATTENTION_NOTIFY_SECRET`). Wire to `gcloud compute instances start` outside the Worker |
| `ATTENTION_WAKE_INSTRUCTIONS` | no | **Founder/dev / internal wake API only.** Override wake instructions returned when `ATTENTION_WAKE_URL` is unset. Never shown in the buyer live panel |
| `ATTENTION_DRAFT_API_KEY` | no | Optional OpenAI-compatible key for judgment **Draft** on `/attention/:id`. When unset, Draft returns `draft_unconfigured` and typed answers still work |
| `ATTENTION_DRAFT_BASE_URL` | no | Optional chat-completions base URL (default OpenAI-compatible `/v1`) |
| `ATTENTION_DRAFT_MODEL` | no | Optional model id (default `gpt-4o-mini`) |

## CLI / runner host env (agent-box)

| Variable | Purpose |
|----------|---------|
| `ATTENTION_NOTIFY_URL` | e.g. `https://jobappagent.com/api/internal/attention-notify` |
| `ATTENTION_NOTIFY_SECRET` | Same bearer as the site Worker |
| `PUBLIC_SITE_URL` | Optional; poll client uses this (or derives origin from `ATTENTION_NOTIFY_URL`) |
| `JOB_APPLICATION_AGENT_STATE_DIR` | Local state root; session bindings live under `session-bindings/` (never cloud) |
| `DISPLAY` | Fill display — must be **`:99`** for headed Chrome |

### Live display hard rule

**Buyer live noVNC must show the fill session:** Xvfb `DISPLAY=:99` → x11vnc **`localhost:5900`** → websockify/noVNC (HTTP historically `:6080`).

- **Never** TigerVNC `:1` / port **`5901`** (cold desktop / jobs listing = product failure).
- Guard: `node job-application-agent/scripts/novnc-display-guard.mjs --unit /etc/systemd/system/novnc.service`
- Example unit: `job-application-agent/references/agent-box/novnc.service.example`
- Agent-box notes: `job-application-agent/references/agent-box/README.md`

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
  "requiredActions": ["review-legal", "provide-judgment", "complete-captcha"],
  "questions": [
    { "id": "why", "prompt": "Why this role at LiveKit?", "kind": "why-us", "required": true }
  ],
  "postingText": "optional — used to detect “don’t use AI assistance”",
  "aiAssistanceDiscouraged": false
}
```

Sends email subject `Action needed: {company} — {role}` with checklist + **Open live session** magic link (~45 min TTL). Never includes VNC passwords. `questions[]` and `aiAssistanceDiscouraged` are signed into the magic-link payload for the attention UI.

### `GET /api/attention/:id/live-session?token=…&embed=1`

Auth’d live-session entry (buyer path = **in-page embed**):

1. Verifies the same magic-link token as `/attention/:id`.
2. **Fire-and-forget wake** (see below) so on-demand agent-box can start — does **not** block the embed on wake recorded.
3. If `ATTENTION_LIVE_SESSION_BASE_URL` is set:
   - **`embed=1`** (attention panel) → same-origin HTML shell that iframes noVNC with `autoconnect=true` and optional `ATTENTION_NOVNC_PASSWORD` in the **hash fragment** (not query). Soft “Connecting…” clears once the iframe loads / after a short timeout. Soft “Live browser failed to load — retry” if the frame errors or stays blank. Worker CSP: attention page `frame-src` allows `'self'` + configured live origin + `https://*.trycloudflare.com`; embed shell allows `frame-ancestors 'self'` and the same noVNC `frame-src` / `wss:` `connect-src`.
   - Without `embed` → **302** to noVNC (new-tab / email deep-link fallback). Attention-page CSP must still allow the live origin so a redirected iframe can paint.
4. If unset → soft buyer HTML: **“Live browser is temporarily unavailable. Try again shortly.”** No IAP / gcloud / SSH paste blocks on this route.

Full WebSocket reverse-proxy through the Worker remains out of scope; public HTTPS noVNC embed is the buyer path.

### `POST /api/attention/:id/wake`

Magic-link body `{ "token": "…" }`. Same wake seam as the internal route; used fire-and-forget by the attention page before loading the live panel. Returns `{ status: "dispatched" | "recorded", message }` with **buyer-safe** soft status only — **no `instructions` field** on this buyer route.

### `POST /api/internal/attention-wake`

Bearer `ATTENTION_NOTIFY_SECRET`. Body:

```json
{ "attentionId": "attention-…", "reason": "live_session", "source": "ops" }
```

- If `ATTENTION_WAKE_URL` is set → POSTs `{ type: "attention_wake", attentionId, reason, source, requestedAt }` to that webhook (Bearer secret).
- If unset → `{ status: "recorded", instructions: "gcloud compute instances start …" }` for **Personal/ops** to start agent-box manually (founder tooling — not buyer UI).

No GCP credentials are required inside the Worker for this MVP.

### `POST /api/attention/:id/signal`

Magic-link body:

```json
{
  "token": "…",
  "action": "resume" | "skip" | "abort",
  "answers": [
    { "questionId": "why", "text": "…", "source": "typed" | "draft_approved" | "bank" }
  ]
}
```

Stores a coordination row in site D1 (`attention_signals`), including `answers[]` on `payload_json` for the runner. On resume, approved answers are also upserted into the site **answer bank** (`attention_answer_bank` — fingerprint, prompt, text, tags). **Not** the application ledger — state-worker attention stream remains SoT for opened/resolved. Never stores CAPTCHA/MFA/cookies.

### `POST /api/attention/:id/draft`

Magic-link body `{ "token", "questionId?", "prompt?", "candidateNotes?" }`. Returns a short first-person draft for edit/Approve, or `draft_unconfigured` when `ATTENTION_DRAFT_API_KEY` is unset. Disabled with `403 ai_assistance_discouraged` when the posting bans AI assistance. Drafts are private scratch until Approve — never silent-pasted into the ATS.

### `GET /api/attention/:id/answers?token=…&prompt=…`

Magic-link prior-answer suggestions from the site D1 answer bank (fuzzy prompt match). Never auto-fills without showing the text.

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
  "answers": [
    { "questionId": "why", "text": "…", "source": "typed" }
  ],
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
| `0` | `resume_requested` | Renew lease → load **session binding** → same-tab re-inspect → **submit if possible** → visible confirm → intent confirm |
| `10` | `skipped` | `attention resolve`, no submit, continue round |
| `11` | `aborted` | `cloud lease-release`, end round |
| `20` | timeout / `--once` still waiting | Renew lease or re-notify |
| `1` | config/HTTP error | Fix `ATTENTION_NOTIFY_SECRET` / site URL |

Helpers after exit `0`:

```bash
node job-application-agent/scripts/attention-resume-submit.mjs --checklist
node job-application-agent/scripts/attention-resume-submit.mjs \
  --attention-id attention-… --stdin <<'JSON'
{ "pageUrl": "https://…/application", "submitEnabled": true, "leaseHeld": true }
JSON
```

## Session binding (same-tab contract)

Paused runs must record enough to reattach — **local-only** (browser profile paths never enter cloud state):

| Field | Required | Notes |
|-------|----------|-------|
| `attentionId` | yes | Ties binding to attention event |
| `jobUrl` | yes | Filled ATS form URL (`attention.url`) |
| `browserProfilePath` | yes | Chrome user-data-dir for the headed fill |
| `display` | yes | Must be `:99` |
| `vncPort` | yes | Must be `5900` |
| `tabHint` | no | Optional `{ title, urlContains }` |
| `applicationId` / `roundId` | no | Join keys |

Write via optional fields on `attention add` (`browserProfilePath`, `display`, `vncPort`, `tabHint`) or:

```bash
node job-application-agent/scripts/session-binding.mjs write --stdin
```

**Hard invariant:** keep headed Chrome on that exact filled form tab through the pause. Cold Chrome / jobs listing in the live panel is a bug.

## Resume re-inspect → submit checklist (agent)

After exit `0` / `resume_requested`:

1. `cloud lease-renew` (lease must stay held through the pause). If lease lost → new attention `session-expired`; fail closed.
2. Load session binding; refuse resume if missing or if live URL **drifts** from `jobUrl`.
3. Focus the **same** ATS tab the candidate used in the live session (`DISPLAY=:99` / profile path).
4. Load `answers[]` from the poll payload. Inject into matching textareas (`scripts/ats/answer-inject.mjs`, Ashby-first) before submit classification.
5. Re-check live DOM for remaining absolute blockers — do not trust prior fill state blindly.
6. **CAPTCHA vendor is Off by default** (`CAPTCHA_VENDOR=off`). Live panel remains the path for CAPTCHA. See CAPTCHA section below.
7. **If clear → agent submits** (submit bias). No extra in-app “please confirm submit” unless a new absolute gate appeared.
8. Wait for a **visible** success/confirmation surface (Ashby/generic selectors in `scripts/ats/submit-adapters.mjs`).
9. `cloud intent-confirm` / `ledger add` only after that visible confirm. **filled ≠ applied.**
10. If confirmation is missing after click → `cloud intent-sent` / sent-unverified; **never retry** until verified.
11. If still blocked → `attention add` again honestly (never invent success).
12. On skip (`10`): `attention resolve`, do not submit, continue the round.
13. On abort (`11`): `cloud lease-release`, end the round.

Ledger/intent rules are unchanged from `SKILL.md` / `RUNS.md` / `state-worker/AGENT.md`.

## P1.5 — Judgment answers + drafts

Quiet Trust attention card can collect narrative answers **in-app** so the live panel is reserved for unmirrorable blockers (CAPTCHA / MFA / legal widgets).

| Surface | Behavior |
|---------|----------|
| Pause packaging | `attention add` accepts `questions[]`, optional `postingText`, `aiAssistanceDiscouraged` |
| UI | Textareas per question; optional **Use prior answer**; optional **Draft** → edit → **Approve** / Discard |
| AI policy | When posting copy discourages AI assistance, Draft is hidden/disabled (“Answer in your own voice”) |
| Resume | Runner injects approved answers, then re-inspects / submits |
| Storage | Site D1 `attention_answer_bank` (reusable prompts/text). Signal `payload_json` carries answers for the poll. Attention queue still never stores CAPTCHA/MFA/cookies |

D1 binding name is **`job-application-agent-public-stats`** (see `site/wrangler.jsonc`). After deploy, apply migration `0006_attention_answer_bank.sql` if it has not already run:

```bash
cd site && npx wrangler d1 migrations apply job-application-agent-public-stats --remote
```

## CAPTCHA vendor (scaffolded, Off by default)

Optional buyer-opt-in CAPTCHA assist lives in `job-application-agent/scripts/captcha-vendor.mjs`.

| Env / pref | Default | Meaning |
|------------|---------|---------|
| `CAPTCHA_VENDOR` | `off` | `off` \| `capsolver` \| `2captcha` |
| `CAPTCHA_VENDOR_API_KEY` | unset | Runner-only secret |
| `CAPTCHA_BUYER_OPT_IN` / `CAPTCHA_ASSIST` | off | Must be `on` for assist |
| `CAPTCHA_SPEND_CAP_USD_MONTH` | `5` | Fail closed to live panel when exceeded |

When Off (or missing key / unsupported type / spend cap), behavior is identical to today: attention `complete-captcha` + live panel. Adapters are stubs until an explicit spike go — **no vendor calls in CI**, no production enable in this slice.

Buyer disclosure (Quiet Trust):

> Optional CAPTCHA assist uses a third-party solver on public challenge tokens. Some employers disallow automation. You can turn this off anytime; we fall back to the live browser.

## UI

`/attention/:id?token=…` — Quiet Trust attention card: blocker chip, required actions, lease badge, judgment answer fields when packaged.

**Open live browser** expands an **in-page live panel** (iframe → `/api/attention/:id/live-session?token=…&embed=1`). Shown as the primary CTA when CAPTCHA/MFA/unmirrorable actions remain; otherwise secondary beside in-card answers. Resume / Skip / Abort stay visible beside the panel.

Soft status line may show **Connecting…** briefly, then clears once the iframe loads (or after a short timeout). Buyers never see wake-recorded / ops / IAP / gcloud / SSH helper copy.

When `ATTENTION_LIVE_SESSION_BASE_URL` is unset, the panel shows **Live browser is temporarily unavailable. Try again shortly.**

## On-demand agent-box wake

agent-box may be **stopped** for cost. Opening the live panel triggers the wake seam in the background (fire-and-forget):

1. Attention page → `POST /api/attention/:id/wake` (no UI stall; no instructions rendered)
2. Live-session route also fire-and-forget dispatches wake
3. Ops can call `POST /api/internal/attention-wake` directly

Wire `ATTENTION_WAKE_URL` later to a small starter that runs:

```bash
gcloud compute instances start agent-box \
  --zone=asia-south1-a \
  --project=agent-runner-vaibhav-4500
```

Cold-start still needs Xvfb `:99` + x11vnc **`5900`** + noVNC on `:6080` (websockify → `localhost:5900`) after the instance is RUNNING. Never stop while a cloud lease is held or `/tmp/jaa-hosted-fill.running` exists. Run `novnc-display-guard.mjs` after cold start.

## Founder / dev: IAP tunnel helper (not buyer UI)

When there is no public noVNC front yet, founders can still reach agent-box port **6080** via IAP for local debugging. This is **ops tooling** — the buyer attention page and live-session route do **not** render these commands.

```bash
gcloud compute start-iap-tunnel AGENT_BOX_INSTANCE 6080 \
  --local-host-port=localhost:6080 \
  --zone=AGENT_BOX_ZONE \
  --project=AGENT_BOX_PROJECT
```

Then open `http://127.0.0.1:6080/vnc.html?autoconnect=true`. Override the documented one-liner with `ATTENTION_IAP_HELPER_COMMAND` if instance/zone/project differ. Prefer setting `ATTENTION_LIVE_SESSION_BASE_URL` for the real buyer path.

## Golden-path E2E runbook (founder on agent-box)

LiveKit-class: **pause on prefilled form → magic link live panel → human gates → resume → submit → ledger**.

### Preconditions

1. Worker secrets as in the “One-time Worker secrets” section below (`ATTENTION_LIVE_SESSION_BASE_URL` must front noVNC whose websockify targets **`localhost:5900`**).
2. agent-box: Xvfb `:99`, x11vnc on **5900**, noVNC on **6080** per `references/agent-box/`.
3. `node job-application-agent/scripts/novnc-display-guard.mjs --unit /etc/systemd/system/novnc.service` exits 0.
4. Headed Chrome uses a persistent fill profile on `DISPLAY=:99`.

### Steps

1. `cloud lease-acquire` (application-run). Hold/renew through the pause.
2. Navigate to a real ATS application URL on the fill display; fill verified résumé facts only.
3. Stop on absolute blockers (CAPTCHA / legal / judgment). **Do not submit.** Keep the **same filled tab** open.
4. Open attention **with session binding**:

```bash
node job-application-agent/scripts/job-application.mjs attention add --stdin <<'JSON'
{
  "roundId": "round-e2e",
  "applicationId": "app-e2e",
  "url": "https://jobs.ashbyhq.com/…/application",
  "stage": "submission",
  "blocker": "legal-attestation",
  "requiredActions": ["review-legal", "provide-judgment", "complete-captcha"],
  "company": "LiveKit",
  "role": "Forward Deployed Engineer",
  "browserProfilePath": "/home/runner/.jaa-chrome-fill",
  "display": ":99",
  "vncPort": 5900,
  "tabHint": { "urlContains": "/application" }
}
JSON
```

5. Open the magic link → Quiet Trust `/attention/:id` → **Open live browser**.
6. **Accept only if** the panel shows the **already-filled** ATS form (fields visible). If you see TigerVNC desktop, blank XFCE, or a fresh jobs listing → **fail the run** (fix/VNC misbind); fix `novnc.service` → 5900.
7. Candidate completes only listed absolute actions in that live tab.
8. Click **I’ve finished — resume**.
9. Runner poll:

```bash
node job-application-agent/scripts/attention-runner-poll.mjs --attention-id attention-…
# expect exit 0
```

10. Resume → submit:

```bash
# Agent / automation: re-inspect same tab, then:
node job-application-agent/scripts/attention-resume-submit.mjs --attention-id attention-… --stdin <<'JSON'
{
  "pageUrl": "https://jobs.ashbyhq.com/…/application",
  "submitEnabled": true,
  "leaseHeld": true
}
JSON
# exit 13 → click submit using Ashby/generic selectors
# re-probe until exit 0 (visible confirmation) → intent-confirm / ledger add
```

11. Confirm: ledger row exists; attention resolved; **filled ≠ applied** held until step 10 confirmation.
12. Skip / Abort: exit 10 → resolve, no submit; exit 11 → release lease, end round.

### One-time Worker secrets

```bash
cd site
npx wrangler secret put ATTENTION_NOTIFY_SECRET
npx wrangler secret put ATTENTION_MAGIC_LINK_SECRET   # openssl rand -hex 32
npx wrangler secret put RESEND_API_KEY
# Required for buyer live panel:
npx wrangler secret put ATTENTION_LIVE_SESSION_BASE_URL
npx wrangler secret put ATTENTION_NOVNC_PASSWORD
# Optional wake webhook (otherwise internal wake returns founder instructions only):
# npx wrangler secret put ATTENTION_WAKE_URL
```

Ensure `PUBLIC_SITE_URL=https://jobappagent.com` is set (wrangler vars already default this).

### Agent-box env

```bash
export ATTENTION_NOTIFY_URL=https://jobappagent.com/api/internal/attention-notify
export ATTENTION_NOTIFY_SECRET=…   # same as Worker
export PUBLIC_SITE_URL=https://jobappagent.com
export DISPLAY=:99
```

### Notify-only smoke (no fill session)

For mail/UI wiring without a headed fill, the shorter “Playable demo” loop below still works — but it does **not** satisfy golden-path acceptance (same-tab + submit).

## Playable demo (notify + poll smoke)

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
   - Without → soft “temporarily unavailable” in the panel (use founder IAP docs above for local ops).
5. Finish the blocker in the live browser.
6. Click **I’ve finished — resume**.
7. On the runner:

```bash
node job-application-agent/scripts/attention-runner-poll.mjs \
  --attention-id attention-…   # id from step 2
# expect exit 0 and printed resume checklist
```

8. Follow the resume → submit checklist above (session binding required for golden path).

## Out of scope (follow-ups)

- Full WebSocket noVNC reverse-proxy through the site Worker (next slice after embed works)
- Named Cloudflare tunnel DNS / VM wake automation (`live.jobappagent.com`)
- Browserbase / Steel
- Enabling CAPTCHA vendor in production (scaffold only — `CAPTCHA_VENDOR=off`)
- Attestation auto-grants UI
- Multi-tenant paid→slot / billing
- VERIFYING badge flip / founding checkout copy changes
- Multi-tenant answer-bank scoping beyond founding single-tenant fingerprints
