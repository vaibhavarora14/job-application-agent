## Summary

<!-- What observable behavior changes, and why is this the smallest useful change? -->

## Risk and invariants

- [ ] This change does not affect security, privacy, persistence, concurrency, installation, release, or destructive filesystem behavior.
- [ ] If it does, I described the invariant, failure behavior, and rollback behavior below.
- [ ] Every use of “atomic,” “safe,” “exact,” “verified,” or “never” is backed by a direct test or explicitly bounded.

<!-- List the state that must remain true before, during, and after failures. Write “Not applicable” only when appropriate. -->

## Verification

- [ ] I added a regression test for each bug fix and confirmed it fails without the fix.
- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run privacy-audit`
- [ ] `npm run smoke:package`

<!-- Include relevant manual or platform-specific verification and its result. -->

## Scope

- [ ] The pull request contains one logical change.
- [ ] Non-test changes are roughly 300 lines or fewer, or I explained why splitting would reduce safety or reviewability.
