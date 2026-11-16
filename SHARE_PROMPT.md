# Shareable job-application prompt

```bash
npx job-application-agent@latest install
```

Copy the prompt below into a new agent chat. Use `scripts/job-application.mjs` for private state. Do not keep a second ledger. `score` and `ledger add` are refused until that install has been run on the same machine as the browser.

---

Install the managed runtime on the same machine as the browser, then use `scripts/job-application.mjs` for the profile, résumé, score, ledger, rounds, and outcomes. Do not keep a second ledger.

```bash
npx job-application-agent@latest install
```

`score` and `ledger add` are refused until that command finishes. Do not assess or apply from this prompt alone. Follow the installed `SKILL.md` for every later step.

Build and run a private job-application workflow for my own job search.

Start with onboarding. Ask me for my canonical resume and every factual field needed for applications, including name, email, phone, location, work authorization, LinkedIn, GitHub/portfolio, availability, current and target compensation, target role families, seniority, skills, preferred and excluded locations, remote/hybrid/on-site preference, industries, and excluded companies. Never invent a missing answer.

Use my unchanged canonical resume as the only default resume. Keep private profile information in secure OS-backed storage when available, and keep browser authentication only in the browser session. Read and write applications only through `node scripts/job-application.mjs`. Do not keep a second ledger.

If the installed skill includes default-enabled structured usage analytics, disclose them before collection and explain `telemetry disable` to stop all analytics. Analytics must not include candidate name, email, phone, résumé content, prompts, answers, browser data, or raw errors. Relay the CLI disclosure to me before running another command. Honor any opt-out immediately.

These requests are not commands. Run them through the installed skill:

- Search: `node scripts/job-application.mjs sources jobs` and `sources list`, then `score --stdin`. Resolve aggregator and social links to the direct application page. Exclude closed, duplicate, or explicitly ineligible roles. Pause on ambiguous authorization or location eligibility. Show match and gap reasons from the score.
- One posting URL: follow the installed skill Apply section. Do not submit from this prompt. Record with `ledger add` only after the site visibly confirms success.
- A batch of leads, or a round of N: `round start --stdin` with `{ "requestedCount": N }`, then one `round lead --stdin` and one `round source --stdin`, then the Apply section. Attempt at least three distinct relevant discovery sources. At least one source must be successfully searched. Record each application's discovery source. If one source supplies over 60% of submissions, explain why using fit and coverage evidence. Never lower the fit bar to balance sources. Do not count closed pages, duplicates, drafts, emails left unsent, or unconfirmed submissions.
- The attention queue: `attention list`.
- An outcome: `ledger outcome` (or `ledger outcome <application-id-or-url> --status response|rejected|interview|offer|closed`).

Ask me whether I want `review each` (fill each application and stop before Submit so I can look at the filled page and confirm in chat, or submit it myself) or `routine auto` (submit routine applications within my rules without asking each time). Either way, obey browser or tool confirmation requirements. Always stop for passwords, SSO/MFA, CAPTCHA, legal attestations, demographic questions, sensitive government identifiers, unclear compensation or work authorization, and any unverifiable claim. Never inspect cookies, local storage, passwords, session files, or MFA codes.

If I explicitly say “apply autonomously,” persist a local routine-autonomy grant so you do not ask again for skill-level résumé-upload or routine-submission approval. The grant may also cover verified recruiting email, ledger/outcome updates, completed-tab cleanup, and creating tested public-agent improvement PRs. It must never bypass the hard stops above or any browser/host permission prompt. It must never authorize merging, releasing, publishing, changing my facts, or changing targeting thresholds.

Before submitting, validate every field, answer, attachment, and disclosure. Record an application as submitted only when the site visibly confirms success. Use the `roundId` returned by `round start`, separately record where a lead was discovered and where it was submitted, and deduplicate at both company and requisition level. Queue blockers and continue elsewhere. Record bounded reproducible general failures; after the round, a qualifying failure may produce a sanitized regression-tested PR, but never merge or publish it. After every ten confirmed submissions, review outcomes and propose improvements to targeting and answer guidance, but change nothing without my approval.

Use the browser I request. If I do not specify one, use the best available browser that preserves my existing login session.

Begin by asking me for my resume and the minimum missing onboarding details.

---
