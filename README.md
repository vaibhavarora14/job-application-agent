# Job Application Agent for Codex

A reusable, candidate-agnostic Codex skill for discovering, validating, completing, and tracking a person's own job applications.

## Install

Copy the `job-application-agent` directory into your Codex skills directory:

```sh
cp -R job-application-agent ~/.codex/skills/
```

Restart Codex, then start with:

```text
Use $job-application-agent to onboard my resume and job-search preferences.
```

If you do not want to install a skill, paste the contents of `SHARE_PROMPT.md` into a new task.

## Privacy and safety

- The package contains no candidate data or resume.
- Profiles are stored in macOS Keychain.
- The canonical resume and application ledger use owner-only local permissions.
- Passwords, MFA, CAPTCHA, demographic data, legal attestations, and government identifiers are never stored or automated.
- Forms are submitted only when authorized and visibly confirmed.

## Requirements

- Codex with browser-control capability
- Node.js 20 or newer
- macOS Keychain for persistent profile storage

## Validate

```sh
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py job-application-agent
node --test job-application-agent/tests/job-application.test.mjs
```

## License

MIT
