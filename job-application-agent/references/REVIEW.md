# Batch review

Every live send needs the candidate's approval first. That covers an application submit, a replacement transmission (`ledger retry`), and an outreach handoff. The agent prepares the work, the candidate reviews it as a batch, and the CLI then accepts only sends that match what was approved.

This applies in both modes. In `review-each` each batch holds one application. In `routine-auto` a batch can hold up to 25 items. Unattended and scheduled runs can discover, assess, fill and stage batches, but nothing is sent until the candidate approves.

## What the CLI enforces, and what it cannot

The CLI does not click Submit. It gates the sanctioned steps around the click:

- `cloud intent-prepare` refuses to issue a transmission intent;
- `ledger add` and `cloud intent-confirm` refuse to record a submission;
- `ledger retry` refuses to record a replacement transmission;
- `outreach handoff` refuses to hand over copyable text.

It refuses each of these unless the send carries a `reviewBatchId` and `reviewToken` for an approved, unexpired, unused batch item that still matches. That means the same application ID, the same URL, the same answers, and the same canonical résumé. For email it means the same draft revision.

**It cannot stop a click made directly in the browser.** An agent that clicks Submit without approval breaks this skill's rules, and the send is never recorded, counted, or shared. Never click Submit, Send, or an equivalent without an approved item for that exact application.

The approval phrase and the review page show that a person reviewed the batch, and both leave an audit trail. Neither can prove that a person, rather than the agent, typed the phrase. Never type the phrase, open the review page, or operate it for the candidate.

## Flow

1. **Prepare.** Fill each application up to its final review screen and do not submit. Collect the exact answers you will send.
2. **Stage.** Send one JSON object to `review stage --stdin`:

```json
{
  "roundId": "optional round id",
  "items": [
    {
      "type": "application",
      "applicationId": "acme-staff-eng-2026-10",
      "company": "Acme",
      "role": "Staff Engineer",
      "url": "https://boards.greenhouse.io/acme/jobs/123",
      "ats": "greenhouse",
      "fitScore": 86,
      "answers": { "Why Acme?": "exact text that will be sent" },
      "flaggedAnswers": [
        { "answer": "Why Acme?", "reason": "The posting asks for a specific project and this answer stays general." }
      ]
    },
    {
      "type": "email",
      "opportunityId": "opportunity-1",
      "draftRevision": 2,
      "company": "Acme",
      "recipient": "Jo",
      "to": "jo@acme.example",
      "subject": "Staff Engineer application",
      "attachResume": true,
      "text": "exact draft text"
    }
  ]
}
```

   - `applicationId` must be the `id` you will pass to `ledger add`.
   - `answers` must be exactly the `answers` object you will record. Profile fields such as name and email do not need to be listed.
   - Use `flaggedAnswers` for anything the candidate should look at closely. Each flag names the answer and the real reason you flagged it, written to follow "Flagged because": the page shows it under the answer.
   - For an email, `to` is the exact address or profile the draft goes to, `subject` the exact subject line, and `attachResume` whether the canonical résumé is attached. They are approved together with `text`, so changing any of them needs a new batch.
   - For a replacement transmission, add `"purpose": "retry"`.
   - The CLI hashes the canonical résumé itself. A batch holds at most 25 items and must be approved within 24 hours.
3. **Present.** Show the candidate the returned `table` exactly as printed.
4. **Approve.** Use one of the two channels:
   - **Review page (default):** run `review open <batchId>` and give the candidate the URL. The page runs on `127.0.0.1` on this machine and shows every item, including its answers, each email's recipient, subject, attachments and exact text, and a link to the exact résumé PDF. The candidate unticks anything they don't want sent, types the batch code, and approves or rejects. Poll `review status <batchId>` until the status is `approved`, then read `reviewToken`.
   - **Chat phrase (fallback):** use this on hosts where the candidate has no browser on this machine, such as a VPS or a remote shell. Show the items from `review show <batchId>`, including the answers, and ask the candidate to type the approval phrase (for example `APPROVE KTR-42`). Pass their exact words to `review approve --stdin`:

```json
{ "batchId": "rb-20261022-1a2b3c4d", "phrase": "APPROVE KTR-42", "exclude": [3] }
```

   `exclude` lists the item numbers the candidate removed. The response carries `reviewToken`, and `review status <batchId>` returns it again while the approval is valid.
5. **Send.** For each approved item, carry `reviewBatchId` and `reviewToken`:
   - In cloud mode, pass them to `cloud intent-prepare` before you submit.
   - Submit in the browser, wait for visible confirmation, then pass them to `ledger add` (or `ledger retry` for a resend).
   - For an email item, pass them to `outreach handoff`, which returns the text for the candidate to send.
   - Each item covers one send.
   - Approval expires 24 hours after it is given.
   - If any answer, the URL, or the résumé changes after approval, the CLI refuses the send. Put that item in a new batch.
6. **Withdraw.** `review revoke <batchId>` stops anything not yet sent.

The ledger row records `reviewBatchId`, `reviewApprovedAt` and `reviewApprovalChannel` (`local-page` or `chat-phrase`). The token itself is never stored in the ledger, analytics, or community data.

## Commands

```text
node scripts/job-application.mjs review stage --stdin
node scripts/job-application.mjs review show <batch-id>
node scripts/job-application.mjs review open <batch-id>
node scripts/job-application.mjs review approve --stdin
node scripts/job-application.mjs review status <batch-id>
node scripts/job-application.mjs review list
node scripts/job-application.mjs review revoke <batch-id>
```

Owned fixtures and vendor sandboxes on the packaged allowlist (`fixtures/test-jobs.json`) are not employer submissions and do not need a batch. A caller-supplied `applyKind` does not exempt a live URL.
