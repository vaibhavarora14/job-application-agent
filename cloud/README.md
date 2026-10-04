# Cloud apply (H0)

## Early tester invitations — not merged, not deployed

The invitation entry point is **`https://<tester-host>/invite#<single-use-token>`**.
There is **no deployed tester host in this change**. The unchanged `Dockerfile`
and `fly.toml` recipe starts the laptop operator, binds loopback, and provides no
public HTTPS ingress. `fly.tester.toml` is a separate tester recipe, not a deployment.
Do not send a localhost URL to a tester. Invites, sign-in, workspace access and
tester submission fail closed until a separately authorized hosting deployment
provides the prerequisites below. No real invite or employer submission was made
while implementing or testing this change.

The separate `npm run tester` entry point serves only invited accounts. It does
not expose the laptop operator API. An operator issues an invitation for a new
tester's email; accepting it creates that account and consumes the invitation in
one SQLite transaction. Opening the link alone does not consume it (link previews
are harmless); a second redemption fails. The tester then signs in at `/sign-in`
with that email and their chosen password. `/workspace` uses only their server-side
profile, PDF, ledger, queue and browser directory. It never imports a laptop profile
or invokes the skill subprocess/Keychain. Existing buyers and checkout receive no
access. `CLOUD_ACCESS_STATUS` and the $49 founding checkout are unchanged.

Prerequisites for a **future, separately authorized deployment**:

- A dedicated persistent host running `node src/tester-server.mjs`, Node 24,
  Playwright and Chromium. Do not expose `server.mjs` or use the existing operator
  Docker command as the tester entry point.
- HTTPS ingress at a dedicated non-loopback origin; restrict access to the backend
  so plaintext HTTP is not publicly accessible. Set `CLOUD_TESTER_ORIGIN` to that
  exact HTTPS origin (no trailing slash).
- A new absolute private persistent `CLOUD_TESTER_DATA_DIR`, separate from all
  operator/pilot/buyer data. Backups and volume access need to preserve that privacy.
- Set `CLOUD_TESTER_HOSTED=1` only after hosting is actually provisioned; this is an
  operator assertion, not a deployment or a reachability check. `HOST`/`PORT` must
  match the protected ingress. Missing configuration returns HTTP 503 and does not
  run a tester worker. Public registration remains unavailable.

### Separate Fly tester recipe (not deployed)

`cloud/fly.tester.toml` targets only the new app `jobappagent-cloud-tester`.
Do not attach it to Paisewise or `job-application-agent`. It builds the existing
`cloud/Dockerfile` with the repository root as build context and overrides its
command only for the `tester` process: `node src/tester-server.mjs`. The operator
Docker CMD and `cloud/fly.toml` remain unchanged. The tester process receives HTTPS
ingress with `force_https` and stays running for its embedded worker.

Provision one tester Machine in `iad` with a **new** `cloud_tester_data` volume
mounted at `/private/tester-data`; restrict that directory to mode 0700. Never
reuse `cloud_data` or any operator, pilot or buyer volume. Keep a single Machine
for this SQLite-backed invite so requests use the same account/session database.

The deployed tester server and its invite command must receive exactly these
hosting values (the first four are supplied by the tester TOML):

| Environment variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `PORT` | `8788` (matches `http_service.internal_port`) |
| `CLOUD_TESTER_DATA_DIR` | `/private/tester-data` |
| `CLOUD_TESTER_ORIGIN` | `https://jobappagent-cloud-tester.fly.dev` (no trailing slash) |
| `CLOUD_TESTER_HOSTED` | `1`, set **only on that deployed app** after hosting is provisioned |

Do not put the hosted assertion in a laptop `.env`, the Dockerfile, or operator
configuration. `hostingReady` still requires that assertion, an absolute data
directory and an exact HTTPS origin whose hostname contains a dot and is neither
localhost nor an IP. No access gate is changed by this recipe.

Future deploy command, from the repository root, **not run in this change**:

```sh
fly deploy --config cloud/fly.tester.toml --app jobappagent-cloud-tester --ha=false
```

This config is not a deployment. No invite works until that app is deployed with
the hosting values above and one invite is issued with `npm run invite`.
Localhost is still not a tester workspace. Only after those prerequisites, run
from `/repo/cloud` on that tester Machine:

```sh
npm run invite -- new-tester@example.com /private/tester-data/invite.txt
```

The command writes the invitation URL to a new mode-0600 file; it does not print
the credential. Deliver that file's link privately to its intended recipient.
It expires after 48 hours; possession permits account creation for the invited
email (there is no independent email verification). Passwords are scrypt-hashed;
sessions expire after 12 hours and use Secure, HttpOnly, SameSite cookies.
Sign-in and redemption have persistent attempt limits, including a conservative
IP limit; a shared reverse proxy can therefore require a 15-minute wait after ten
attempts. Logout invalidates the session. Tokens are stored as digests.

Greenhouse is the sole tester discovery/fill/submit channel. The existing
Playwright adapter fills and submits on the same page for testers. It rechecks
authorization and the submit gate, records a durable one-shot attempt before
clicking, and writes `submitted` only after visible confirmation. An unclear result
stays `confirmation-unclear`; it cannot be retried automatically. A crash after the
attempt is recorded also requires operator investigation. No manual “mark sent”
API is available to testers. Routine submission is opt-in in their own profile.

### A new tester still cannot do

- Open a hosted workspace now: this PR is not deployed, and localhost is not a
  tester workspace. No usable invitation is being issued in this PR.
- Use Lever, Ashby, or a live browser. Their controls and routes are absent.
- Register publicly, redeem an invitation twice, or access another person's data.
- Import the founder's laptop profile, résumé, Keychain, or ledger.
- Submit before redeeming an invite, signing in, saving their own profile/PDF and
  opting into routine submission; bypass scoring, required fields or hard stops.
- Resolve CAPTCHA, MFA, legal/demographic questions or custom forms inside this
  workspace; retry an unclear submit or manually claim it was sent.
- Use password reset, email verification, account deletion/self-service recovery,
  or a hosted LLM. This small tester surface uses the existing heuristic reader.

Verification: `npm test` from `cloud/` exercises local test servers and isolated
temporary state. Employer responses in submit tests are test doubles; those tests
are not evidence that an employer received an application. Browser smoke testing
also uses only local fixture state. No deployment, payment or employer calls belong
in this workflow.

The rest of this document describes the pre-existing **laptop operator** and is
not an onboarding route for new testers.

Same apply loop as the skill, running as a local app on your laptop. Onboard once, start a round, leave. The worker discovers public ATS boards, scores with `scoreJob`, fills Greenhouse, and clicks Submit only when the routine-auto gate passes. `submitted` is written only after a visible thank-you page.

This package is `private: true` and is **not** in the root npm `files` list. `npx job-application-agent` does not ship it.

## Run it on your laptop

Node 22+. From the repo root:

```bash
git checkout cursor/cloud-mvp-plan-b6ff
cd cloud
npm install
npx playwright install chromium
cp .env.example .env          # optional: add ANTHROPIC_API_KEY or leave blank for heuristic / Ollama
npm run local
```

Or from the repo root after `cd cloud && npm install`: `npm run local`.

Open **http://127.0.0.1:8787**. If you already onboarded the Agent Skill on this machine, click **Use my laptop skill profile**. Otherwise fill setup once and upload the PDF. Tap **Find and apply to these**.

State stays in `cloud/data/` (gitignored). Chromium is local Playwright, not Fly.

CLI:

```bash
node src/cli.mjs onboard --from-skill
node src/cli.mjs status
node src/cli.mjs round start --count 10
node src/cli.mjs attention
```

Watch the browser: `PLAYWRIGHT_HEADLESS=0 npm run local`.

Ollama on this machine is used automatically when `ollama serve` is running (`OLLAMA_HOST=http://127.0.0.1:11434`). Otherwise a hosted API key, otherwise the heuristic.

## Fly (optional later)

A **new** Fly app, not the Paisewise Machine. Bind `127.0.0.1` and use `fly proxy` — no public IPv4.

```bash
fly apps create job-application-agent
fly volumes create cloud_data --size 10 --app job-application-agent
fly deploy --config cloud/fly.toml --app job-application-agent
fly proxy 8787:8787 -a job-application-agent
```

After reviewing the first 20 assess outputs, you may set `CLOUD_ROUTINE_CHANNELS=greenhouse` so a `review` decision can Submit on that channel without `autoEligible`.

## Submit gate

The agent clicks Submit only when all of these hold:

- `submissionMode` is `routine-auto`
- ledger check is clean
- score decision is `review` and (`autoEligible` or the channel is in `CLOUD_ROUTINE_CHANNELS`)
- required fields are verified facts
- résumé is attached
- no login / MFA / CAPTCHA / legal / demographic / government-id / LinkedIn overlay
- channel is on `CLOUD_SUBMIT_ALLOWLIST` (default: `greenhouse`)

Otherwise the inbox shows the company URL. H0 does not ship noVNC; refill-on-open is the contract. Never click Submit a second time if confirmation is unclear.

Lever and Ashby are discovered and scored, then handed off until one Greenhouse agent-submit is confirmed.
