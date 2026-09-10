# Resumable application runs

## Round lifecycle

Start each batch with an explicit ID:

```text
node scripts/job-application.mjs round start --stdin
node scripts/job-application.mjs round source --stdin
node scripts/job-application.mjs round status [round-id]
node scripts/job-application.mjs round complete --stdin
```

Start input: `{ "requestedCount": 30 }`. Complete input: `{ "roundId": "round-..." }`.

## Discovery coverage

Before submitting, search at least three relevant independent sources from `sources list`, including alternatives to the last round's dominant source. Listing the catalog or browsing multiple jobs on one board is not source coverage. Record a report after each actual search or observed access blocker:

```json
{
  "roundId": "round-...",
  "sourceId": "linkedin-jobs-feed",
  "status": "searched",
  "reviewedCount": 12,
  "qualifiedCount": 3,
  "evidence": "Reviewed current target-matching listings; three met the unchanged fit criteria."
}
```

`status` is `searched` or `blocked`. Empty search results count as a search with zero counts, with evidence explaining the query/filter and absence of suitable postings. `reviewedCount` and `qualifiedCount` are bounded at 10,000; qualified cannot exceed reviewed. A blocked report must have zero counts and a `blocker` of `login`, `mfa`, `captcha`, `site-error`, or `access-unavailable`. Evidence is required, at most 2,000 characters, and stays private. Record concrete observations, never invented evidence or raw page content, credentials, recruiter identities, or answers. Reports describe agent-observed work; the CLI cannot independently verify browser activity.

The minimum is three distinct sources attempted and at least one successfully searched. Blockers count toward attempts, not searches; try accessible alternatives whenever available. Repeated checks do not increase diversity. The two YC catalog entries count as one network. Inbound recruiting messages and user-provided links may supply good leads but do not count toward the three discovery sources. `round status` returns source reports, search/blocker counts, submission distribution, and missing attribution. A later blocker does not erase a prior search.

Every confirmed submission needs a `discoverySourceId` referring to a searched source. For older ledger entries without it, pass `applicationIds` in the matching `round source` report to append attribution without rewriting the ledger. Attribution must reference confirmed applications in that round and cannot conflict with their saved source. Coverage updates cannot modify a completed round. Always record real confirmed submissions even if discovery coverage is incomplete; the completion gate does not prevent accurate ledger accounting.

If any discovery source supplies more than 60% of confirmed submissions, `round complete` requires `concentrationReason` and a private `concentrationEvidence` explanation (at most 2,000 characters). Reasons are `stronger-fit`, `alternatives-exhausted`, `access-blocked`, or `candidate-directed`. For example:

```json
{
  "roundId": "round-...",
  "concentrationReason": "stronger-fit",
  "concentrationEvidence": "The other searched sources had no eligible Senior/Staff matches; selected LinkedIn leads met all existing requirements."
}
```

This is a discovery requirement, not an application quota. Never lower fit, eligibility, compensation, or evidence requirements to diversify submissions. ATS concentration alone does not imply discovery concentration: jobs from several boards may all use Ashby. Report coverage and blockers on unfinished handoffs too; `round complete` also continues to enforce the confirmed-submission target. Previously completed rounds remain historical; open rounds need coverage before completion.

Coverage reports emit bounded `source_checked` analytics automatically. Only allowlisted packaged source IDs (community sources become `community`), counts, status, and blocker codes are sent. Notes, application IDs, exact community IDs, and round IDs stay local. Completion emits aggregate coverage counts, maximum source share, and the reason code, never the explanation. Failed best-effort analytics does not erase local reports.

## Submission accounting

Count only unique applications with a visible employer/ATS confirmation or a verified sent recruiting email that were also added to the ledger with the same `roundId`. Filled forms, blockers, drafts, unsent email, and ambiguous confirmations never count. `round complete` rejects an under-target round.

Run both company-level and requisition-level duplicate checks before filling and again immediately before transmission. Hard ledger-ID, canonical-URL, employer-job-ID, and requisition duplicates always stop. Same-role aliases require a verified distinct requisition and `NEW REQUISITION CONFIRMED`. A genuinely different role at the same company may proceed automatically only when `companyReapply.decision` is `eligible-after-cooldown`: 15 full days have passed since the latest company application and no outcome has been recorded. `cooldown-active` and `follow-up-present` require explicit candidate approval.

Resolve the canonical résumé with `resume path`, upload its absolute path through the browser’s privileged chooser first, and verify the filename and parsed fields. Use a visible native picker only as a fallback.

Store independent attribution on every new ledger row:

- `discoverySource`: where the lead was found (`linkedin`, `x`, `yc`, `hacker-news`, `job-board`, `direct-company`, `email`, `user-supplied`, `web-search`, or `other`).
- `discoverySourceId`: stable packaged catalog ID such as `yc-work-at-a-startup` or `hacker-news-who-is-hiring`, when known.
- `applicationChannel`: where it was submitted (`ashby`, `greenhouse`, `lever`, `workday`, `company`, `email`, and the other documented ATS values).
- `source`: the legacy-compatible application channel.

## Attention queue

Append blocked work instead of interrupting the round:

```text
node scripts/job-application.mjs attention add --stdin
node scripts/job-application.mjs attention list
node scripts/job-application.mjs attention resolve --stdin
```

Store only application ID, canonical URL, round ID, stage, blocker enum, timestamp, and bounded required-action enums. Never store passwords, MFA codes, CAPTCHA answers, demographic answers, government IDs, or legal responses. Prioritize authentication/MFA/CAPTCHA, then legal/authorization/compensation, then judgment/video/site issues. Preserve the tab when supported; otherwise reopen the canonical URL and refill verified data.

## Friction queue

Record bounded general workflow failures without candidate data:

```text
node scripts/job-application.mjs friction record --stdin
node scripts/job-application.mjs friction list
```

Use a stable kebab-case error code, documented stage and ATS, and Boolean `reproducible` and `general` fields. Only entries where both are true qualify for a tested public-agent PR. Never include URLs, form text, answers, résumé metadata, identity, or raw errors.
