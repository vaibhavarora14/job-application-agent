# Implementation Plan: Cloud apply MVP

**Specification:** [docs/cloud-mvp.md](./cloud-mvp.md)

**Overview.** Build horizon **H0** from [docs/cloud-mvp.md](./cloud-mvp.md): a hosted **async** loop. Onboard once, enqueue a round, workers discover / assess / fill / submit in the background. `cloud llm` prefers local Ollama when the tailnet is up, else a hosted API. Agent Submit when the gate passes. Live view is for hard stops and `review-each`. The HTTP API never holds a browser. Auth stays out of H0.

## Technical approach

Reuse the OSS CLI as the source of truth for candidate state. Add a new `cloud/` package that is **not** published in the npm skill.

| Concern | Personal MVP | Later (public cloud) |
|---|---|---|
| Profile, résumé, ledger, rounds, attention enums | Existing `job-application.mjs` via import + subprocess | Extract shared package both skill and worker import |
| Discovered jobs, watched slugs, assessments, browser sessions | New SQLite in `cloud/data/` (gitignored) | D1 / Postgres + R2 |
| Must-have assessment | Async `assess` job: Ollama (if reachable) → hosted API → heuristic, then `scoreJob` | Same |
| Prefill | Deterministic `questions[]` + synonym map; `cloud llm map-fields` / `draft` for leftovers and essays | Same |
| Apply | Async `fill` / `submit` jobs on a **new Fly Machine**; never inline in an HTTP handler | Browser adapter + work queue |
| Takeover | noVNC / CDP live view URL stored on `browser_sessions` | Cloudflare Browser Run or Steel/Browserbase |
| Operator UI | One local page, bound to `fly proxy` / WireGuard | Quiet Trust UI on the existing site |

**Do not extend `attention.ndjson` with a live-view URL.** The CLI schema is closed. Store `session_id` + `live_view_url` on `browser_sessions` and join by `applicationId`.

**`scoreJob` requires `mustHaves`.** A board API row is not enough. A fetch that skips assessment will always get `ask`. The assessor is a real phase, not a footnote.

Import from the skill, do not copy:

- `validateProfile`, `profileStatus`, `migrateProfile`
- `scoreJob`
- `validateLedgerEntry`
- `sourcesList`

Call the CLI for persistence until extraction: `profile set|check`, `resume import|path`, `ledger check|add`, `attention add|list|resolve`, `round start|status`.

```text
cloud/
  package.json          # private, not in root "files"
  boards.json           # watched {channel, slug, company}
  src/
    cli.mjs             # onboard, discover, round, attention
    db.mjs              # SQLite
    skill.mjs           # import + subprocess bridge
    discover/{greenhouse,lever,ashby,normalize}.mjs
    llm.mjs             # assess | map-fields | draft; Ollama then hosted API
    assess.mjs          # enqueue / drain assess jobs, then scoreJob
    queue.mjs           # work_queue: discover, assess, fill, submit, handoff
    apply/{browser,greenhouse,lever,ashby,handoff}.mjs
    worker.mjs          # long-running drain loop
    server.mjs          # enqueue only; no Playwright in the request path
  data/                 # gitignored
```

## Dependencies

Must exist before Phase 1 coding:

- A **new** Fly app in the same org as Paisewise (`job-application-agent` or similar). Do not reuse the Paisewise Machine, volume, or image.
- That Machine: ≥2 GB RAM, 2 shared CPUs, 10 GB volume, `auto_stop` off during a round
- Node 20+, Chromium for Playwright (in that image)
- Your `profile set` JSON and canonical PDF
- A `boards.json` seed of companies you would actually join (start with 20 slugs, not 200)
- Optional: Ollama on your laptop, reachable from Fly over Tailscale (`OLLAMA_HOST=http://<tailnet>:11434`). Optional hosted API key as fallback so async apply does not stall when the laptop is closed. Heuristic if neither is up.

Must **not** be in place: auth, Dodo activation, public DNS, Cloudflare Browser Run, LinkedIn session, anything running on the Paisewise app.

## Phases

### Phase 0 — Skeleton

Keep cloud code out of the published skill.

- [ ] Add `cloud/` with its own `package.json` (`private: true`)
- [ ] Leave root `package.json` `files` unchanged so `npx job-application-agent` does not ship this
- [ ] Gitignore `cloud/data/`, `cloud/.env`, uploaded PDFs
- [ ] `cloud/src/skill.mjs` can `profile check` against a configured state dir
- [ ] README: how to point `JOB_APPLICATION_STATE_DIR` at the Fly volume (and local `cloud/data/skill-state` for laptop runs)
- [ ] Dockerfile + `fly.toml` for the new app only: Chromium/Playwright deps, volume mount, no Paisewise hostname
- [ ] Document `fly proxy` as the operator path; do not allocate a public IPv4 for the UI
- [ ] `work_queue` table + `worker.mjs` drain loop (discover / assess / fill / submit / handoff)
- [ ] Server routes only enqueue; Playwright and `cloud llm` run in the worker

**Done when:** `node cloud/src/cli.mjs status` prints skill profile status without writing candidate data into the repo, and the Fly app is a separate process from Paisewise.

### Phase 1 — Onboarding

Collect the known set once. Mid-run questions come later.

- [ ] `cloud onboard --profile profile.json --resume resume.pdf`
- [ ] Validate with `validateProfile`; refuse inferring missing required fields
- [ ] Collect the extra ATS-common fields on the same command even if the CLI marks them optional: LinkedIn, GitHub, portfolio, availability, current/target compensation, compensation floor, skills, industries, exclusions
- [ ] Store the résumé through `resume import`; resolve later with `resume path`
- [ ] `cloud status` shows missing profile fields and whether a canonical résumé exists

**Done when:** one command takes you from empty state to a complete `profile check` plus `resume path`.

### Phase 2 — Discovery

HTTP only. No browser.

- [ ] `boards.json` entries: `{ "channel": "greenhouse"|"lever"|"ashby", "slug": "acme", "company": "Acme" }`
- [ ] Fetchers:
  - Greenhouse `GET /v1/boards/{slug}/jobs?content=true`
  - Lever `GET /v0/postings/{slug}?mode=json`
  - Ashby `GET /posting-api/job-board/{slug}`
- [ ] Normalize to `{company, role, title, description, url, employerJobId, applicationChannel, discoverySource, locations, salaryMaximum, salaryCurrency, workMode}`
- [ ] Upsert `jobs` on canonical URL / employer job id; skip closed
- [ ] For Greenhouse, persist the `questions` array for pre-flight later
- [ ] `cloud discover` enqueues a `discover` job (or runs in the worker on cron). Idempotent.

**Done when:** 20 slugs produce a de-duplicated `jobs` table with direct apply URLs and descriptions. No scoring yet.

### Phase 3 — Assess (async)

LLM CLI for accuracy; `scoreJob` stays pure. Never call this inside an HTTP handler.

- [ ] New jobs enqueue `assess`. Worker drains when a provider is up
- [ ] `cloud llm` tries Ollama (`OLLAMA_HOST` on the tailnet, short timeout) then hosted API then heuristic
- [ ] Unreachable providers: leave the row `pending_llm`; keep discovering and filling already-assessed jobs
- [ ] `cloud llm assess --stdin`: JD + résumé + profile → `mustHaves[]` with quoted evidence
- [ ] Fail closed: no quote → `unclear`; invalid JSON → heuristic; `cloud assess --job` by hand
- [ ] Call `scoreJob`; cache by job id + résumé hash
- [ ] `exclude` / `skip` stay out of fill; `ask` → attention; `review` → enqueue `fill`
- [ ] `ledger check` before enqueueing fill
- [ ] Review the first 20 assess outputs before trusting `autoEligible`

**Done when:** `cloud round start` returns immediately, a worker assesses in the background, and `pending_llm` drains when Ollama or the hosted API appears. Empty `mustHaves` never reaches fill.

### Phase 4 — Fill and submit (async, Greenhouse first)

Worker jobs only. One Chromium lease at a time on the personal Machine.

- [ ] `fill` / `submit` are queue types; the API never launches Playwright
- [ ] Playwright launches Chromium with a dedicated `cloud/data/chrome-profile`
- [ ] Open the job `url`, not a Google/LinkedIn redirect
- [ ] Prefill known fields from Greenhouse `questions` ids → profile keys; synonym map next
- [ ] Leftover required labels: `cloud llm map-fields`; still `unclear` → attention
- [ ] Upload résumé with `setInputFiles` / file chooser using `resume path` ([BROWSER_UPLOADS.md](../job-application-agent/references/BROWSER_UPLOADS.md))
- [ ] After ATS parse, restore any verified field the parser changed
- [ ] Narratives: `cloud llm draft` grounded in `motivationBlurb` + résumé; `review-each` still shows the draft before send
- [ ] Stop on login, MFA, CAPTCHA, legal, demographic, government-id, unclear compensation/authorization, unverifiable claim, “Apply with LinkedIn”
- [ ] Implement the submit gate from [cloud-mvp.md](./cloud-mvp.md#when-the-agent-submits)
- [ ] On a passing gate: screenshot, click Submit, wait for confirmation, `ledger add` with `STANDING AUTHORIZATION`
- [ ] On a failing gate or `review-each`: `attention add` plus a `browser_sessions` row — do not click
- [ ] If confirmation is unclear after a click: attention only, never click again
- [ ] Skip Lever / Ashby / `other` until one Greenhouse agent-submit is confirmed

**Done when:** one real Greenhouse application is agent-submitted and the ledger row exists only after the thank-you page.

### Phase 5 — Handoff (hard stops and review-each)

You finish only what the agent must not.

- [ ] Expose the Playwright page over noVNC or a CDP live-view link
- [ ] Operator page prints `live_view_url` + blocker-specific instructions
- [ ] Heartbeat while leased; if the session dies, reopen, refill, new attention item. No cookie export
- [ ] After the operator unblocks, the agent may resume and Submit if the gate now passes
- [ ] In `review-each`, the operator clicks Submit; the agent still waits for confirmation
- [ ] Detect confirmation conservatively. If unsure, stay `needs_attention`
- [ ] `ledger add` uses `STANDING AUTHORIZATION` for agent Submit, `APPROVE SUBMIT` for review-each, plus a private confirmation artifact
- [ ] `attention resolve` after a confirmed submit or explicit abandon

**Done when:** a CAPTCHA or legal stop can be finished in live view, after which the agent Submits (routine-auto) or you do (`review-each`), and the ledger moves only after confirmation.

### Phase 6 — Operator surface and mid-run answers

- [ ] Localhost page: profile completeness, fill queue, open attention with “Open live session”, submitted ledger
- [ ] Mid-run missing field: prompt on that page, store in `answers` keyed by `normalized question + channel`, resume fill
- [ ] Ping (ntfy / email) when attention is non-empty
- [ ] `cloud round start --count 10` uses skill `round start` and stops offering new fills at the target

**Done when:** you can run a round without SSH-ing into logs to find the next pause.

### Phase 7 — Lever + Ashby adapters

- [ ] Copy the Greenhouse fill contract: same stop rules, same submit gate, same confirmation rule
- [ ] Treat each channel’s extra widgets (Ashby steps, Lever custom questions, “Apply with LinkedIn”) as a stop if they are not mapped
- [ ] Record `friction` for reproducible general failures only (existing enum + no candidate data)

**Done when:** at least one confirmed Lever or Ashby submission exists, with a note of what had to be manual.

### Phase 8 — Dogfood a round of 10

- [ ] Seed ≥ 20 slugs, start a round of 10
- [ ] Per application, log: found via API? filled? bot/login block? agent submitted or handed off? confirmation detected?
- [ ] Kill a session on purpose and confirm refill-without-cookies
- [ ] Decide the September browser: Cloudflare Browser Run vs Steel vs Browserbase vs stay on the VM

**Done when:** the [decision checklist](./cloud-mvp.md#decision-checklist) in the spec is ticked.

### Phase 9 — Public product (after dogfood)

Do not start this until Phase 8 is done.

- [ ] Extract score / ledger / attention / source-normalization into a shared package
- [ ] Browser adapter interface; swap VM Playwright without changing assess/queue
- [ ] Session lease: `needs_attention` does not require a live tab; “Open live session” acquires, refills, hands off, releases
- [ ] One browser context per user; never share a Chrome profile across tenants
- [ ] Move control plane onto the existing site (Postgres + object storage once more than one operator; D1 remains for founding checkout)
- [ ] Auth + founding activation in front of that API
- [ ] Browser pool sized to concurrent fills + concurrent handoffs, not pending-row count (see [100 × 100](./cloud-mvp.md#scale-100-users--100-pending-submits))
- [ ] Per-channel rate limits and staggered fills so one egress IP does not look like a botnet
- [ ] Inbox UX: filter + “next ready,” not 100 open tabs
- [ ] Scheduled discovery + attention notifications
- [ ] Explicit cloud privacy controls before any third-party profile is accepted (already promised on the privacy page)
- [ ] Agent Submit only through the documented gate; new channels start watched until one clean confirm

## Risks

| Risk | Why it shows up | Mitigation |
|---|---|---|
| Assessor invents experience | `scoreJob` will happily score invented `met` evidence | `cloud llm assess` must quote résumé text; no quote → `unclear`; first 20 reviewed; heuristic fallback only |
| Greenhouse iframe / “Apply with LinkedIn” | Fill script clicks the wrong surface | Prefer the hosted board apply form; stop on LinkedIn overlay |
| ATS résumé parse clobbers fields | Local runbook already warns | Re-read fields after upload; restore from profile |
| Bot detection | Worse on hosted browsers than on a residential VM | Dogfood on your VM first; vendor choice is an output of Phase 8 |
| Confirmation false positive | Ledger would lie | Conservative detector; default to attention |
| Live view expires | Cloudflare idle 10 min; you are not at the desk | Heartbeat while *leased*; refill-on-open is the default at scale |
| Holding a tab per pending submit | 100 users × 100 ready ≈ 10,000 Chromiums | Queue is data; pool ≈ concurrent fills + people in live view |
| Shared Chrome profile across users | Cookies and résumés leak | One context per user; destroy or freeze after release |
| Schema drift from the skill | Copied score/ledger rules will rot | Import functions; subprocess writes; extract only in Phase 9 |
| PII on a public URL | Résumé + authorization in SQLite | `fly proxy` / WireGuard only; no public DNS in Phases 0–8 |
| Sharing the Paisewise Machine | Chromium OOMs payroll; deploys kill tabs; untrusted ATS pages sit next to money data | Second Fly app + volume; never attach to `paisewise.com` |
| Scope creep into LinkedIn / Workday | Session + ToS + detection | Boards that need a login are skipped, not “tried a little” |

## Out of scope until Phase 9+

- User accounts, OAuth, Dodo activation
- Auto-submit
- LinkedIn Easy Apply, X, YC Work at a Startup
- Demographic answers, government IDs, stored passwords, CAPTCHA solvers
- Per-company résumé rewrites
- A second scoring system

## First commit sequence

When implementation starts, land in this order so each PR stays reviewable:

1. `cloud/` skeleton + skill bridge + work queue + gitignore (Phase 0)
2. `onboard` / `status` (Phase 1)
3. async `discover` + `boards.json` example (Phase 2)
4. async `cloud llm assess` (Ollama then hosted) (Phase 3)
5. Greenhouse fill + agent Submit (Phase 4)
6. Handoff for hard stops + `ledger add` on confirmation (Phase 5)
7. Localhost operator page (Phase 6)

Lever/Ashby and the public-cloud move are their own PRs after a real Greenhouse submission.
