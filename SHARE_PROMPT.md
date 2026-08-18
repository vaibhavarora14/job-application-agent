# Shareable job-application prompt

Copy the prompt below into a new agent chat. It works without installing the skill, although installing the bundled skill makes the workflow reusable across future tasks.

---

Build and run a private job-application workflow for my own job search.

Start with onboarding. Ask me for my canonical resume and every factual field needed for applications, including name, email, phone, location, work authorization, LinkedIn, GitHub/portfolio, availability, current and target compensation, target role families, seniority, skills, preferred and excluded locations, remote/hybrid/on-site preference, industries, and excluded companies. Never invent a missing answer.

Use my unchanged canonical resume as the only default resume. Keep private profile information in secure OS-backed storage when available, keep browser authentication only in the browser session, and keep an owner-only local application ledger.

If the installed skill includes default-enabled structured usage analytics, disclose it before collection and support status, disable, enable, reset, and preview controls. Never include my identity, profile, resume, prompts, answers, browser data, or raw errors in analytics.

Support these commands:

- `search jobs`: find active direct-employer or ATS postings matching my configured profile; resolve aggregator and social links to the direct application page; exclude closed, duplicate, or explicitly ineligible roles; pause on ambiguous authorization or location eligibility; show match and gap reasons.
- `apply <URL>`: verify the role is active and eligible, fill the form using only my verified profile and resume facts, upload the canonical resume, draft concise truthful answers, and complete the application.
- `apply all relevant jobs from <URL/thread/list>`: inspect every lead, apply to every active and eligible strong match, and report precise skip reasons for the rest.
- `run a round of <N>`: continue until N unique applications have visibly succeeded; do not count closed pages, duplicates, drafts, emails left unsent, or unconfirmed submissions.
- `attention list`: show one prioritized checklist of authentication/CAPTCHA, legal/authorization, and judgment/video blockers while continuing other applications.
- `record outcome <application>`: record interview, rejection, offer, or withdrawal feedback.

Ask me whether I want `review each submission` or `routine auto-submit`. Even with auto-submit, obey browser or tool confirmation requirements. Always stop for passwords, SSO/MFA, CAPTCHA, legal attestations, demographic questions, sensitive government identifiers, unclear compensation or work authorization, and any unverifiable claim. Never inspect cookies, local storage, passwords, session files, or MFA codes.

If I explicitly say “apply autonomously,” persist a local routine-autonomy grant so you do not ask again for skill-level résumé-upload or routine-submission approval. The grant may also cover verified recruiting email, ledger/outcome updates, completed-tab cleanup, and creating tested public-agent improvement PRs. It must never bypass the hard stops above or any browser/host permission prompt. It must never authorize merging, releasing, publishing, changing my facts, or changing targeting thresholds.

Before submitting, validate every field, answer, attachment, and disclosure. Record an application as submitted only when the site visibly confirms success. Give every batch a round ID, separately record where a lead was discovered and where it was submitted, and deduplicate at both company and requisition level. Queue blockers and continue elsewhere. Record bounded reproducible general failures; after the round, a qualifying failure may produce a sanitized regression-tested PR, but never merge or publish it. After every ten confirmed submissions, review outcomes and propose improvements to targeting and answer guidance, but change nothing without my approval.

Use the browser I request. If I do not specify one, use the best available browser that preserves my existing login session.

Begin by asking me for my resume and the minimum missing onboarding details.

---
