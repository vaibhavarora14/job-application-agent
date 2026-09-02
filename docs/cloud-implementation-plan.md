# Implementation Plan: Cloud apply MVP

**Specification:** [docs/cloud-mvp.md](./cloud-mvp.md)

**Overview.** Build a single-tenant hosted loop you can run for yourself: onboard once, discover Greenhouse / Lever / Ashby jobs over HTTP, score with the existing runbook, fill in a Playwright browser, and hand you the live tab to submit. Auth, multi-tenant isolation, and founding-access gating stay out. Do not fork scoring or ledger rules.

## Technical approach

Reuse the OSS CLI as the source of truth for candidate state. Add a new `cloud/` package that is **not** published in the npm skill.

| Concern | Personal MVP | Later (public cloud) |
|---|---|---|
| Profile, résumé, ledger, rounds, attention enums | Existing `job-application.mjs` via import + subprocess | Extract shared package both skill and worker import |
| Discovered jobs, watched slugs, assessments, browser sessions | New SQLite in `cloud/data/` (gitignored) | D1 / Postgres + R2 |
| Must-have assessment | LLM (or you) writes the `score --stdin` payload; never invent evidence | Same, with stored prompts and review |
| Apply | Playwright + local Chromium, never click Submit | Browser adapter `{launch, fill, handoff, heartbeat, close}` |
| Takeover | noVNC / CDP live view URL stored on `browser_sessions` | Cloudflare Browser Run or Steel/Browserbase |
| Operator UI | One local page, bound to localhost / Tailscale | Quiet Trust UI on the existing site |

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
    assess.mjs          # JD + résumé → score input
    apply/{browser,greenhouse,lever,ashby,handoff}.mjs
    server.mjs          # localhost API + operator page
  data/                 # gitignored
```

## Dependencies

Must exist before Phase 1 coding:

- A machine you control (laptop is fine; a small VM is better)
- Node 20+, Chromium for Playwright
- Your `profile set` JSON and canonical PDF
- A `boards.json` seed of companies you would actually join (start with 20 slugs, not 200)
- An LLM key **only** for assessment, or willingness to assess the first batch by hand

Must **not** be in place: auth, Dodo activation, public DNS, Cloudflare Browser Run, LinkedIn session.

## Phases

### Phase 0 — Skeleton

Keep cloud code out of the published skill.

- [ ] Add `cloud/` with its own `package.json` (`private: true`)
- [ ] Leave root `package.json` `files` unchanged so `npx job-application-agent` does not ship this
- [ ] Gitignore `cloud/data/`, `cloud/.env`, uploaded PDFs
- [ ] `cloud/src/skill.mjs` can `profile check` against a configured state dir
- [ ] README: how to point `JOB_APPLICATION_STATE_DIR` at `cloud/data/skill-state`

**Done when:** `node cloud/src/cli.mjs status` prints skill profile status without writing candidate data into the repo.

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
- [ ] `cloud discover` is idempotent and safe to cron

**Done when:** 20 slugs produce a de-duplicated `jobs` table with direct apply URLs and descriptions. No scoring yet.

### Phase 3 — Assess and queue

This is the step the coding agent does today by reading the posting.

- [ ] For each new job, build a `score --stdin` payload:
  - `postingStatus: active` only after the apply URL still resolves
  - `eligibility` from authorization / location text; `unclear` if not explicit
  - `mustHaves[]` from the JD, each `met|partial|missing|unclear` with résumé-backed evidence or no evidence
- [ ] Default assessor: model + canonical résumé text + JD. Prompt forbids inventing evidence.
- [ ] Fallback: `cloud assess --job <id>` you fill by hand
- [ ] Call `scoreJob(job, profile)`; store the full result on `assessments`
- [ ] `exclude` / `skip` stay out of the fill queue
- [ ] `ask` becomes an attention item (`ambiguous-authorization`, `ambiguous-compensation`, or `unverifiable-claim`) — no browser yet
- [ ] `review` (and `autoEligible`) enter the fill queue. `autoEligible` means fill, not submit
- [ ] `ledger check` before queueing; hard duplicates never enter

**Done when:** a discover → assess pass leaves a fill queue of `review` jobs and a separate list of questions for you. Empty `mustHaves` never reaches fill.

### Phase 4 — Fill (Greenhouse first)

One channel until it is boring.

- [ ] Playwright launches Chromium with a dedicated `cloud/data/chrome-profile`
- [ ] Open the job `url`, not a Google/LinkedIn redirect
- [ ] Fill name, email, phone, location, links, work authorization, compensation from profile only
- [ ] Upload résumé with `setInputFiles` / file chooser using `resume path` ([BROWSER_UPLOADS.md](../job-application-agent/references/BROWSER_UPLOADS.md))
- [ ] After ATS parse, restore any verified field the parser changed
- [ ] Draft “why this company” from [APPLICATION_GUIDANCE.md](../job-application-agent/references/APPLICATION_GUIDANCE.md); do not submit it blindly if the profile is `review-each`
- [ ] Stop on login, MFA, CAPTCHA, legal, demographic, government-id, unclear compensation/authorization, unverifiable claim
- [ ] **Never click Submit**
- [ ] On stop or “ready to submit”, write skill `attention add` plus a `browser_sessions` row
- [ ] Skip Lever / Ashby / `other` until Greenhouse fill + handoff works end to end

**Done when:** one real Greenhouse application sits filled, résumé attached, waiting, with no submission recorded.

### Phase 5 — Handoff and confirm

You finish in the same tab.

- [ ] Expose the Playwright page over noVNC or a CDP live-view link
- [ ] Operator page (or CLI) prints `live_view_url` + instructions (“Review. If truthful, Submit. Wait for thank-you.”)
- [ ] Heartbeat the browser so the tab survives while you walk over
- [ ] If the session dies: reopen URL, refill, new attention item. No cookie export
- [ ] Detect confirmation conservatively (thank-you / application received). If unsure, stay `needs_attention`
- [ ] Only then `ledger add` with `approval: "APPROVE SUBMIT"` and a private confirmation artifact (URL + screenshot in `cloud/data/`)
- [ ] `attention resolve` after a confirmed submit or explicit abandon

**Done when:** you can submit from the live tab and the ledger gains a `submitted` row only after the success page.

### Phase 6 — Operator surface and mid-run answers

- [ ] Localhost page: profile completeness, fill queue, open attention with “Open live session”, submitted ledger
- [ ] Mid-run missing field: prompt on that page, store in `answers` keyed by `normalized question + channel`, resume fill
- [ ] Ping (ntfy / email) when attention is non-empty
- [ ] `cloud round start --count 10` uses skill `round start` and stops offering new fills at the target

**Done when:** you can run a round without SSH-ing into logs to find the next pause.

### Phase 7 — Lever + Ashby adapters

- [ ] Copy the Greenhouse fill contract: same stop rules, same no-submit, same confirmation rule
- [ ] Treat each channel’s extra widgets (Ashby steps, Lever custom questions, “Apply with LinkedIn”) as a stop if they are not mapped
- [ ] Record `friction` for reproducible general failures only (existing enum + no candidate data)

**Done when:** at least one confirmed Lever or Ashby submission exists, with a note of what had to be manual.

### Phase 8 — Dogfood a round of 10

- [ ] Seed ≥ 20 slugs, start a round of 10
- [ ] Per application, log: found via API? filled? bot/login block? you submitted? confirmation detected?
- [ ] Kill a session on purpose and confirm refill-without-cookies
- [ ] Decide the September browser: Cloudflare Browser Run vs Steel vs Browserbase vs stay on the VM

**Done when:** the [decision checklist](./cloud-mvp.md#decision-checklist) in the spec is ticked.

### Phase 9 — Public product (after dogfood)

Do not start this until Phase 8 is done.

- [ ] Extract score / ledger / attention / source-normalization into a shared package
- [ ] Browser adapter interface; swap VM Playwright without changing assess/queue
- [ ] Move control plane onto the existing site (D1 or Postgres, R2 for résumés)
- [ ] Auth + founding activation in front of that API
- [ ] Scheduled discovery + attention notifications
- [ ] Explicit cloud privacy controls before any third-party profile is accepted (already promised on the privacy page)
- [ ] Still no auto-submit until a channel is boringly reliable

## Risks

| Risk | Why it shows up | Mitigation |
|---|---|---|
| Assessor invents experience | `scoreJob` will happily score invented `met` evidence | Prompt + store evidence text; you review the first 20; `unclear` → `ask` |
| Greenhouse iframe / “Apply with LinkedIn” | Fill script clicks the wrong surface | Prefer the hosted board apply form; stop on LinkedIn overlay |
| ATS résumé parse clobbers fields | Local runbook already warns | Re-read fields after upload; restore from profile |
| Bot detection | Worse on hosted browsers than on a residential VM | Dogfood on your VM first; vendor choice is an output of Phase 8 |
| Confirmation false positive | Ledger would lie | Conservative detector; default to attention |
| Live view expires | Cloudflare idle 10 min; you are not at the desk | Heartbeat; VM/noVNC for MVP; longer-session vendor later |
| Schema drift from the skill | Copied score/ledger rules will rot | Import functions; subprocess writes; extract only in Phase 9 |
| PII on a public URL | Résumé + authorization in SQLite | Localhost / Tailscale only; no public DNS in Phases 0–8 |
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

1. `cloud/` skeleton + skill bridge + gitignore (Phase 0)
2. `onboard` / `status` (Phase 1)
3. `discover` + `boards.json` example (Phase 2)
4. `assess` + fill queue (Phase 3)
5. Greenhouse fill, no submit (Phase 4)
6. Handoff + `ledger add` on confirmation (Phase 5)
7. Localhost operator page (Phase 6)

Lever/Ashby and the public-cloud move are their own PRs after a real Greenhouse submission.
