# Cloud apply (H0)

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
