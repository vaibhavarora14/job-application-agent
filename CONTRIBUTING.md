# Contributing

Thanks for improving Job Application Agent. Changes should be focused, reproducible, and safe for people who keep private job-search data on their machines.

## Before opening a pull request

1. Start from the current `main` branch and keep one logical change per pull request.
2. Keep non-test changes near 300 lines or fewer. Split larger work unless a maintainer agrees that the change is mechanically reviewable.
3. Run:

   ```sh
   npm ci
   npm run check
   npm test
   npm run privacy-audit
   npm run smoke:package
   npm run check:native-artifacts
   ```

4. Add a regression test for every bug fix. The test must fail without the fix and assert observable behavior rather than mocked call order.
5. Complete the pull request template. Security or privacy vulnerabilities must use the private process in [`SECURITY.md`](SECURITY.md), not a public pull request.

## High-risk changes

Installer, persistence, local-state, release-workflow, package-metadata, and security-policy changes receive additional operating-system and Node.js compatibility checks. Their tests must cover:

- failure after each filesystem or scheduler side effect;
- rollback and the state reported after failure;
- ownership boundaries for recursive deletion or replacement;
- malformed, missing, symlinked, and non-regular filesystem entries where relevant;
- concurrent access and stale ownership where relevant.

Claims such as **atomic**, **safe**, **exact**, **verified**, or **never** need a direct test or a precise explanation of what remains outside the guarantee.

## External PR checklist (ledger / installer)

For ledger-lock, installer, or persistence changes (see [#14](https://github.com/vaibhavarora14/job-application-agent/pull/14) and [#15](https://github.com/vaibhavarora14/job-application-agent/pull/15)):

1. Synchronize with current `main` before requesting re-review.
2. Add the adversarial regressions already required on those PRs—do not invent weaker substitutes:
   - **Lock reclaim (#14):** a live lock cannot be reclaimed solely because of age; a replacement lock cannot be deleted after ownership changes; a failed metadata write closes and removes the newly created lock.
   - **Installer persistence (#15):** malformed/truncated status recovery; symlink and other non-regular package entries; runner/scheduler command consistency; rollback after every post-activation failure; configuration truthfulness; package-version consistency; uninstall preserving unrelated shared logs/state.
3. Expect the full Ubuntu/macOS/Windows × Node 20/24 matrix and the required `quality-gate` to pass.
4. Resolve every review conversation and request re-review. Owner bypass is not used for external contributions.

Security and privacy vulnerabilities still follow [`SECURITY.md`](SECURITY.md).

## Review and merge

All required checks and review conversations must be complete. New commits dismiss stale approvals. Do not ask a maintainer to bypass quality gates for an external contribution.
