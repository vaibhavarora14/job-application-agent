# Shareable job-application prompt

Copy the prompt below into a new Codex task. It works without installing the skill, although installing the bundled skill makes the workflow reusable across future tasks.

---

Build and run a private job-application workflow for my own job search.

Start with onboarding. Ask me for my canonical resume and every factual field needed for applications, including name, email, phone, location, work authorization, LinkedIn, GitHub/portfolio, availability, current and target compensation, target role families, seniority, skills, preferred and excluded locations, remote/hybrid/on-site preference, industries, and excluded companies. Never invent a missing answer.

Use my unchanged canonical resume as the only default resume. Keep private profile information in secure OS-backed storage when available, keep browser authentication only in the browser session, and keep an owner-only local application ledger.

Support these commands:

- `search jobs`: find active direct-employer or ATS postings matching my configured profile; resolve aggregator and social links to the direct application page; exclude closed, duplicate, or explicitly ineligible roles; pause on ambiguous authorization or location eligibility; show match and gap reasons.
- `apply <URL>`: verify the role is active and eligible, fill the form using only my verified profile and resume facts, upload the canonical resume, draft concise truthful answers, and complete the application.
- `apply all relevant jobs from <URL/thread/list>`: inspect every lead, apply to every active and eligible strong match, and report precise skip reasons for the rest.
- `run a round of <N>`: continue until N unique applications have visibly succeeded; do not count closed pages, duplicates, drafts, emails left unsent, or unconfirmed submissions.
- `record outcome <application>`: record interview, rejection, offer, or withdrawal feedback.

Ask me whether I want `review each submission` or `routine auto-submit`. Even with auto-submit, obey browser or tool confirmation requirements. Always stop for passwords, SSO/MFA, CAPTCHA, legal attestations, demographic questions, sensitive government identifiers, unclear compensation or work authorization, and any unverifiable claim. Never inspect cookies, local storage, passwords, session files, or MFA codes.

Before submitting, validate every field, answer, attachment, and disclosure. Record an application as submitted only when the site visibly confirms success. Deduplicate by direct job URL or employer job ID. After every ten confirmed submissions, review outcomes and propose improvements to targeting and answer guidance, but change nothing without my approval.

Use the browser I request. If I do not specify one, use the best available browser that preserves my existing login session.

Begin by asking me for my resume and the minimum missing onboarding details.

---
