# Resumable application runs

## Shared cloud coordination

If `cloud status` reports a Cloudflare D1 backend (`cloudflare-d1-r2` or the private `cloudflare-d1-kv` blob fallback), acquire one 15-minute application-run lease before any transmission and renew it every five minutes. Other clients may still read shared state and record independent outcomes. A cloud outage pauses new submissions, while cached research and drafting may continue.

Before sending anything, stage the filled applications as a review batch and get the candidate's approval ([REVIEW.md](REVIEW.md)). Unattended and scheduled runs may discover, assess, fill and stage, then stop and wait for approval; they never send on their own. Immediately before sending an application, create an intent containing its application ID, canonical URL, round ID, active lease ID, `reviewBatchId` and `reviewToken`. After visible confirmation, pass the intent and lease IDs to `ledger add`; the Worker records the submission and round progress together. If a send may have happened but confirmation is unavailable, mark the intent `sent-unverified`. Lease expiry never makes an unverified intent safe to retry.

## Round lifecycle

Start each batch with an explicit ID:

```text
node scripts/job-application.mjs round start --stdin
node scripts/job-application.mjs round source --stdin
node scripts/job-application.mjs round status [round-id]
node scripts/job-application.mjs round confirm --stdin
node scripts/job-application.mjs round complete --stdin
```

Start input: `{ "requestedCount": 30 }`. Complete input: `{ "roundId": "round-..." }`.

## Discovery coverage

For new rounds (`discoveryPolicyVersion: 2`), order matters: first record every reviewed lead from a source with `round lead --stdin`, then report that source with `round source --stdin` **without** `reviewedCount`/`qualifiedCount`. The CLI derives the counts from the lead records; see [ACCOUNTING.md](ACCOUNTING.md) for lead fields, revisions, and delivery accounting. Passing counts is optional and they are treated as assertions: a count that does not match the recorded leads (for example, counts sent before the leads) is rejected, and the error reports the recorded totals. Only rounds started before per-lead accounting (legacy, unverified aggregate reports) require the counts.


Before submitting, search at least three relevant independent sources from `sources list`, including alternatives to the last round's dominant source. Listing the catalog or browsing multiple jobs on one board is not source coverage. Record a report after each actual search or observed access blocker:

```json
{
  "roundId": "round-...",
  "sourceId": "linkedin-jobs-feed",
  "status": "searched",
  "evidence": "Reviewed current target-matching listings; three met the unchanged fit criteria."
}
```

Legacy rounds also pass `"reviewedCount": 12, "qualifiedCount": 3`.

`status` is `searched` or `blocked`. Empty search results count as a search with zero counts, with evidence explaining the query/filter and absence of suitable postings. `reviewedCount` and `qualifiedCount` are bounded at 10,000; qualified cannot exceed reviewed. A blocked report must have zero counts and a `blocker` of `login`, `mfa`, `captcha`, `site-error`, or `access-unavailable`. Evidence is required, at most 2,000 characters, and stays private. Record concrete observations, never invented evidence or raw page content, credentials, recruiter identities, or answers. Reports describe agent-observed work; the CLI cannot independently verify browser activity.

Rounds started by this CLI version verify coverage locally (`round-evidence.ndjson` in the private state directory; never synced or sent anywhere). `round source` refuses `status: "searched"` for a board without `round lead` records for it in the round (record an empty search as one `no-relevant-opening` lead with the search URL), and refuses it when every lead was recorded after the round's latest submission. The community job feed uses `sourceId: "community-jobs-feed"`: `searched` needs a successful `sources jobs` pull since `round start`; `blocked` (blocker `access-unavailable` or `site-error`) is accepted only after a `sources jobs` call in the round failed (`communityFeedUnavailable: true`). `round complete` additionally requires one community feed pull (or that recorded failure) before the round's submissions and rejects sources whose only evidence was recorded after the last submission. `round status` shows this under `routineGates.coverage`. Rounds started by older versions keep the earlier rules.

`round start` also runs a résumé upload preflight (the canonical résumé is imported, readable, non-empty and a PDF). A failure is recorded as a `resume-upload-unavailable` blocker, returned by `round start`, listed under `routineGates.blockers` in `round status`, and repeated in `round complete` `warnings`. It does not block the round; report it to the candidate instead of narrowing to one-click boards. In those rounds an `entryOrigin=logged` ledger entry counts toward the target only when it was approved in its own one-application review batch (`routineGates.uncountedLoggedApplicationIds` lists the others).

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

Before completion, audit final email delivery failures through authorized email tools when available; otherwise report delivery not audited and continue. Verified email sends count with receipt unknown. Use `ledger delivery` to record matched failures, never `ledger outcome rejected`. Effective totals exclude failed attempts; completed rounds retain their completion record and expose a recovery shortfall. See [ACCOUNTING.md](ACCOUNTING.md) for safe linked replacement attempts.


Count unique applications with a visible employer/ATS confirmation or a verified sent recruiting email that were also added to the ledger with the same `roundId`, plus sent-verified outreach attached to that round when the company is not already a counted apply. Filled forms, blockers, drafts, unsent email, user-reported-only outreach, and ambiguous confirmations never count. Apply plus outreach at the same company is one confirmation. `round complete` rejects an under-target round.

Run both company-level and requisition-level duplicate checks before filling and again immediately before transmission. Hard ledger-ID, canonical-URL, employer-job-ID, and requisition duplicates always stop. Same-role aliases require a verified distinct requisition and `NEW REQUISITION CONFIRMED`. A genuinely different role at the same company may proceed automatically only when `companyReapply.decision` is `eligible-after-cooldown`: 15 full days have passed since the latest company application and no outcome has been recorded. `cooldown-active` and `follow-up-present` require explicit candidate approval.

Resolve the canonical résumé with `resume path`, upload its absolute path through the browser’s privileged chooser first, and verify the filename and parsed fields. Use a visible native picker only as a fallback.

Store independent attribution on every new ledger row:

- `discoverySource`: where the lead was found (`linkedin`, `x`, `yc`, `hacker-news`, `job-board`, `direct-company`, `email`, `user-supplied`, `web-search`, or `other`).
- `discoverySourceId`: stable packaged catalog ID such as `yc-work-at-a-startup` or `hacker-news-who-is-hiring`, when known.
- `applicationChannel`: where it was submitted (`ashby`, `greenhouse`, `lever`, `workday`, `company`, `email`, `profile_one_click` for stored-profile one-click applies, and the other documented ATS values).
- `source`: the legacy-compatible application channel.

## Attention queue

Append blocked work instead of interrupting the round:

```text
node scripts/job-application.mjs attention add --stdin
node scripts/job-application.mjs attention list
node scripts/job-application.mjs attention resolve --stdin
```

Store only application ID, canonical URL, round ID, stage, blocker enum, timestamp, and bounded required-action enums. Never store passwords, MFA codes, CAPTCHA answers, demographic answers, government IDs, or legal responses. Prioritize authentication/MFA/CAPTCHA, then legal/authorization/compensation, then judgment/video/site issues. Preserve the tab when supported; otherwise reopen the canonical URL and refill verified data.

On hosted pause, also record a **local-only session binding** (`browserProfilePath`, `display: ":99"`, `vncPort: 5900`, optional `tabHint`) via optional `attention add` fields or `scripts/session-binding.mjs`. Bindings never sync to cloud. Live noVNC must target fill x11vnc **5900** (never TigerVNC **5901**) — see `references/agent-box/` and `scripts/novnc-display-guard.mjs`.

### Hosted notify + resume (P1)

When `ATTENTION_NOTIFY_URL` and `ATTENTION_NOTIFY_SECRET` are set on the runner host, `attention add` POSTs to the site Worker notify API so the candidate receives an email with a signed magic link to `/attention/:id`. Optional `company` / `role` on the add payload (or ledger lookup) fill the email subject; they are not persisted on the attention event.

**Open live session** goes through `GET /api/attention/:id/live-session?token=…` (magic-link verified). The Worker either embeds/302s to `ATTENTION_LIVE_SESSION_BASE_URL` with optional `ATTENTION_NOVNC_PASSWORD` in the URL fragment, or returns a soft buyer “temporarily unavailable” message when unset. IAP tunnel helpers are founder/dev-only (see `site/docs/ATTENTION.md`). VNC passwords are never emailed. **Hard rule:** that live front must show the paused fill on `DISPLAY=:99` / VNC **5900**, not TigerVNC **5901**.

Runner poll while lease held:

```text
node scripts/attention-runner-poll.mjs --attention-id attention-…
# GET {PUBLIC_SITE_URL}/api/internal/attention-signals/:id
# Authorization: Bearer $ATTENTION_NOTIFY_SECRET
```

Exit codes: `0` resume_requested · `10` skipped · `11` aborted · `20` timeout · `1` error.

#### Resume → submit (after exit 0)

**Submit if possible** once blockers are cleared and the application is an approved item in a review batch. The hosted Choose step does not issue batch tokens yet, so stage a batch of one and get approval if it is not already covered. filled ≠ applied until visible ATS confirmation.

```text
node scripts/attention-resume-submit.mjs --checklist
node scripts/attention-resume-submit.mjs --attention-id attention-… --stdin
```

After `resume_requested` (exit 0): renew the lease; load session binding; inject approved `answers[]` from the poll payload into matching textareas when present; re-inspect the **same** filled ATS tab; if clear and approved in a review batch, **submit**; wait for visible confirmation; confirm the ledger intent. CAPTCHA vendor assist is Off by default (`CAPTCHA_VENDOR=off`). If unsure or still blocked, re-open attention. On skip: resolve attention, no submit, continue the round. On abort: release the lease and end the round. Full contract: `site/docs/ATTENTION.md`.

Prove / smoke / E2E apply runners enforce the owned-fixture allowlist (`fixtures/test-jobs.json`) whenever `CI=true`, `PROVE_APPLY=1`, or `APPLY_URL_GATE=1`. Non-allowlisted employer URLs require `LIVE_APPLY=1` (explicit, logged). Prefer `https://jobappagent.com/fixtures/{greenhouse,lever,ashby}/` (or the local fixture server). Ledger entries for those URLs store `applyKind: "fixture"` so metrics do not treat them as real employer applies. Details: [`fixtures/README.md`](https://github.com/vaibhavarora14/job-application-agent/blob/main/job-application-agent/fixtures/README.md).

## Friction queue

Record bounded general workflow failures without candidate data:

```text
node scripts/job-application.mjs friction record --stdin
node scripts/job-application.mjs friction list
```

Use a stable kebab-case error code, documented stage and ATS, and Boolean `reproducible` and `general` fields. Only entries where both are true qualify for a tested public-agent PR. Never include URLs, form text, answers, résumé metadata, identity, or raw errors.
