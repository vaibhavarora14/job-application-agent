# Security — Job Application Agent plugin

## Scope

This package is Marketplace metadata + Cursor skill/command wrappers around the public npm CLI/skill. Report vulnerabilities via [GitHub private vulnerability reporting](https://github.com/vaibhavarora14/job-application-agent/security/advisories/new).

## Credentials & secrets

- Do not commit tokens, profile dumps, résumés, or browser session data.
- Prefer OS secret stores for candidate profile fields.
- The project does not attempt to bypass authentication, MFA, CAPTCHA, legal attestations, or ATS access controls.

## Install surface

- Installer: `npx job-application-agent@latest install` (Node ≥ 20).
- Updates are staged and validated before replacement; private candidate state lives outside the replaceable skill directory.

## Reporting

Include affected file or workflow, reproduction steps, and impact. Strip personal data before submitting. Expect acknowledgement within seven days.
