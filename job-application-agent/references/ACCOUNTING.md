# Delivery and discovery accounting

## Evidence and effective totals

Browser applications count after visible ATS success. They do not require email access. Email-only applications count after a verified send to an employer-published recruiting address; describe them as **sent, receipt unknown**, not as confirmed receipt. Use authorized email tools when available before completing a round and during outcome reviews. Without access, report "delivery not audited" and continue. The CLI does not connect to Gmail or infer mailbox activity.

Match a final delivery failure to the actual application attempt using its sent message, recipient, timing and returned failure evidence. Temporary delays, unrelated bounces, and hiring rejections are not delivery failures. A failed notification cannot overturn independent browser confirmation. Never guess an alternate address or automatically resend an uncertain transmission.

`ledger review`, `round status`, and `round complete` share one effective-count projection. They expose `recordedSubmissionCount`, `effectiveSubmissionCount`, `failedDeliveryCount`, and `receiptUnknownEmailCount`. Existing `submittedTotal`/`confirmedCount` fields now reflect effective submissions, not proven email receipt. Conversion denominators exclude failed applications while historical outcomes remain visible. Public usage events remain historical activity metrics.

A late failure preserves the original completion event. `shortfallCount` and `needsRecovery` flag the deficit; no run starts or round reopens automatically. Review the derived attention queue before a later authorized recovery.

## Record delivery evidence

```text
node scripts/job-application.mjs ledger delivery --stdin
node scripts/job-application.mjs ledger deliveries [application-id]
```

Example stdin (use your actual observation, never this synthetic evidence):

```json
{
  "id": "failure-message-123",
  "applicationId": "application-123",
  "attemptId": "initial:application-123",
  "type": "delivery-failed",
  "occurredAt": "2026-09-13T10:00:00Z",
  "evidenceType": "final-delivery-failure",
  "evidence": "Final recipient failure matched to the original sent recruiting message.",
  "messageRef": "private-provider-message-reference"
}
```

Original attempts are derived as `initial:<applicationId>` without rewriting application rows. Evidence types are `employer-acknowledgement`, `final-delivery-failure`, `browser-confirmation`, `sent-email`, `ambiguous`, and `delivery-delay`. Event types are `receipt-confirmed`, `delivery-failed`, and `correction`. For a correction, set `supersedes` to the mistaken event ID (or an array of conflicting IDs), and `status` to `receipt-confirmed`, `delivery-failed`, or `unknown`. Supply new evidence and a new ID. Unknown restores the original transmission status; it does not assert receipt.

Timestamps are required and normalized to UTC. IDs are optional deterministic content hashes; reuse the same input and observation timestamp when replaying an event. Reusing an ID with different content fails. Evidence is limited to 2,000 characters and message references to 500. Both stay private; omit raw email bodies, attachments, credentials, and unrelated personal data.

Contradictory or ambiguous evidence remains counted but enters derived attention and blocks recovery. Resolve it with an explicit correction, rather than `attention resolve`.

## Replacement attempts

Recovery is allowed only when all attempts for the canonical application have verified failures and no conflicting evidence. Recheck employer eligibility and existing candidate authorization, then verify a published replacement channel within 24 hours before transmission. Preserve duplicate checks for every other application.

In cloud mode, acquire the existing application lease and call `cloud intent-prepare --stdin` with the original `applicationId`, replacement `canonicalUrl`, `leaseId`, and `retry: true`. Use the returned intent ID as the new attempt ID. An uncertain transmission uses `cloud intent-sent` and must not be resent. A later confirmation can reconcile that same intent.

After a verified replacement send, call `ledger retry --stdin`:

```json
{
  "id": "replacement-123",
  "applicationId": "application-123",
  "attemptId": "returned-cloud-intent-id",
  "channel": "browser",
  "url": "https://employer.example/careers/123",
  "channelVerifiedAt": "2026-09-13T11:00:00Z",
  "occurredAt": "2026-09-13T11:10:00Z",
  "approval": "STANDING AUTHORIZATION",
  "evidenceType": "browser-confirmation",
  "evidence": "Visible ATS success for the replacement application.",
  "cloudIntentId": "returned-cloud-intent-id",
  "cloudLeaseId": "active-lease-id"
}
```

For email use `channel: "email"` and `evidenceType: "sent-email"`; the URL identifies the employer-published channel page. With local storage, omit cloud fields and choose a new stable attempt ID. Recovery appends delivery history, never a second application, a second community contribution, or a duplicate submission telemetry event. Revoked authorization, expired leases, and unresolved intents still stop new transmissions.

## Per-lead discovery

```text
node scripts/job-application.mjs round lead --stdin
node scripts/job-application.mjs round leads [round-id]
```

Record each reviewed job or careers page before reporting source totals:

```json
{
  "roundId": "round-123",
  "sourceId": "indeed",
  "url": "https://employer.example/jobs/123",
  "company": "Example Employer",
  "role": "Senior Engineer",
  "employerJobId": "REQ-123",
  "disposition": "qualified",
  "observedAt": "2026-09-13T09:00:00Z",
  "evidence": "Active posting meets the unchanged eligibility and evidence requirements.",
  "applicationId": "application-123"
}
```

Dispositions: `qualified`, `duplicate`, `no-relevant-opening`, `location-authorization-conflict`, `compensation-below-floor`, `seniority-mismatch`, `insufficient-must-have-coverage`, `closed-stale`, `blocked`. Role, employer job ID and application ID are optional during initial discovery; link the actual application ID before round completion. Use `supersedes` and a new event ID when revising an assessment or adding the application link.

A verified employer job ID merges requisition aliases. Without it, canonical URLs identify leads. A later verified ID can enrich the same URL. Repeated sightings do not increase counts; independent sources retain their sightings while unique totals deduplicate requisitions. Distinct requisitions remain separate. Conflicting revisions require an explicit superseding assessment and appear in attention. Existing-lead corrections remain possible after completion without reopening the round.

New rounds store `discoveryPolicyVersion: 2`. `round source` still records real searches and blockers; its optional `reviewedCount` and `qualifiedCount` are assertions against recorded leads. Empty searches may have zero leads with search evidence. New rounds cannot complete without qualified lead/application linkage and resolved assessment conflicts. Always record real submissions even if that audit is incomplete.

Existing rounds retain their historical policy and unsupported aggregates are marked `legacy-unverified`. Unfamiliar historical discovery records remain untouched. The three-source minimum and 60% concentration-explanation rule are unchanged.

## Cloud compatibility and privacy

The optional private backend must advertise `application-accounting-v1`. Deploy the updated Worker before installing the new client on cloud-configured hosts. Missing capability produces an upgrade error. A previously verified backend permits cached research and durable observed-evidence recording during a network outage, but never a new transmission intent.

Delivery/discovery evidence stays in owner-only local streams or the authenticated private backend, and is included in private export and backup/restore. It never enters analytics or community sharing. Reconciliation uses stable event IDs and detects conflicts instead of selecting whichever record arrived last. Initial local-history import uses the existing `cloud reconcile` workflow; do not append new cloud recovery attempts through generic record APIs.
