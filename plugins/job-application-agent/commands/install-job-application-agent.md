---
name: install-job-application-agent
description: Install or update the Job Application Agent CLI and Agent Skill via npx
---

# Install Job Application Agent

Run the public installer (Node 20+):

```bash
npx job-application-agent@latest install --source=plugin
```

Then verify. When no job has been assessed yet, `status` prints the first-job guide (import a résumé, then assess one role in review-each):

```bash
npx job-application-agent@latest status --source=plugin
```

If résumé import fails, retry with an absolute PDF path, a shareable Google Docs URL, or `node scripts/job-application.mjs resume import --stdin` with `{"text":"<pasted résumé>"}`. Do not skip this and do not invent a résumé.

If the user prefers the skills CLI:

```bash
npx skills add vaibhavarora14/job-application-agent
```

Explain that the Marketplace plugin provides Cursor skill/command guidance; the npm installer places the full skill (scripts + references) under `~/.agents/skills/job-application-agent` and is notify-only by default: it tells the user when a new version exists, and automatic background updates are an explicit opt-in (`npx job-application-agent@latest updates enable --source=plugin`). Do not move candidate profile data during install/update.
