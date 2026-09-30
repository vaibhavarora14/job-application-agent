# Quiet Trust hosted buyer workflow (locked)

Design source: the local `jaa-full-flow-gstack/index.html`, `PLAN.md`, and
`shots/{preflight,choose,queue,judgment,done,admin}.png` pack, locked by Vaibhav/CoS.
The hosted buyer extension uses Inter, Instrument Serif, background `#F7F4EF`,
ink `#1B3D2F`, and primary `#2F6B5A`. Marketing retains its existing Quiet Trust styles.

## Buyer contract

| Step | Behavior | Primary |
| --- | --- | --- |
| Preflight | Resume ready / Profile ready, before a queue starts | Start applying |
| Choose | Toggle role cards; selected count updates; zero disables the action | Apply to N jobs / Select at least 1 job |
| Queue | In progress / Waiting on you; View queue reveals the role list | View queue |
| Judgment | Actual packaged employer questions; every required answer must contain non-whitespace text | Continue applying |
| Done | Submission confirmed on the employer site | Back to search |

Only actual employer questions interrupt a buyer. Do not synthesize generic
questions from a `provide-judgment` action code. A technical-only pause renders
Queue. A mixed pause renders the employer questions and separately records an ops
alert. Technical blocker codes, browser panels, retry controls, session recovery,
and live-session instructions do not appear in the buyer page or buyer email.
Skip this role / Stop application live in the overflow disclosure.

`Continue applying` still sends the authenticated `resume` coordination signal.
It does **not** mean submitted. After a successful save the page shows Queue;
a failed save preserves the answer and gives a short save notice. The server also
rejects whitespace/missing required answers and unknown question IDs. Reopening
a link with a stored signal shows Queue or the saved skip/stop acknowledgment.
The runner must re-inspect before submitting and confirm visible ATS success.

## Review fixtures and backend boundaries

Open `/attention/design?design=preflight|choose|queue|judgment|done|admin`.
The design strip switches steps and mobile/laptop widths. Preflight → Choose →
Queue is interactive; answers gate Continue applying → Queue. Done → Choose
provides the Back to search preview. Queue expands the selected role list.

Aliases remain: `questions` → Judgment; `live-required`, `unavailable`, `retry`,
and `resume-requested` → Queue. Unknown/missing keys and **any non-design path ID**
still require a signed token. A query parameter never grants admin access.

All fixtures use synthetic Acme/Northstar/FieldKit/Gridline data. The persistent
strip labels all states as design fixtures with sample data. No fixture calls signal,
wake, apply, answers, drafts, live-session, email, or ops APIs. Admin is a dark,
explicitly **ADMIN ONLY · DESIGN-ONLY · NOT BUYER UI** contrast; Open session is a
local explanatory stub. It cannot display real ops data or open a real session.

Preflight, Choose, and Done currently ship **only as fixtures**. There is no hosted
readiness/search/queue-creation API or submission-confirmation feed yet. Do not
connect these screens to production by inventing ready/success values. Real
attention links display one known role; the queue count is 1, not a fabricated
account-wide total. Done must eventually consume verified employer confirmation;
a resume signal, elapsed time, or button click cannot select it in production.

## Ops/admin alert seam

`POST /api/internal/attention-notify` remains bearer-authenticated with
`ATTENTION_NOTIFY_SECRET`. On an accepted notification:

1. Normalize the employer questions and classify ops work.
2. For CAPTCHA, unsolvable/session/site issues, unmirrorable actions, or missing
   questions, invoke `recordAttentionAdminAlert` **before** checking buyer mail
   configuration. This also happens when employer questions coexist with ops work.
3. With zero questions, return `buyerNotified: false` and the alert result. No
   buyer email, magic-link signing, Resend key, or recipient email is needed.
4. With questions, sign the existing judgment magic link and send a **Needs your
   answer: Company — Role** email. It contains employer prompts and **Continue
   applying**, never a technical-action checklist.

**Explicit stub:** `site/lib/attention-admin-alert.mjs` writes a structured
`[attention-admin-alert]` operational warning containing only attention ID, blocker,
`status: "stubbed"`, and `buyerState: "in_progress"`. This is not a delivered page
or email and is not a durable ops inbox. Wire a private dispatcher/durable inbox
at this seam before relying on automatic paging. No messages were sent or external
notification service enabled by this change. There is no claim that ops was notified
when the result is stubbed. No candidate answers, email, credentials, session URL,
or private state is sent to telemetry/community Workers.

For technical-only events the notify response is:

```json
{
  "ok": true,
  "attentionId": "attention-example",
  "buyerNotified": false,
  "adminAlert": {
    "type": "attention_admin_alert",
    "attentionId": "attention-example",
    "blocker": "captcha",
    "status": "stubbed",
    "buyerState": "in_progress"
  }
}
```

The job stays in progress for the buyer while ops resolves the issue. The stub
never sends a resume signal, resolves an attention event, grants a consent, or
claims application success. Legal attestations and other consent gates remain
subject to the runner's existing authorization rules.

## Authenticated coordination APIs

| Endpoint | Authentication / purpose |
| --- | --- |
| `POST /api/internal/attention-notify` | Internal bearer; ops routing and/or judgment email |
| `POST /api/attention/:id/signal` | Magic link; resume with employer answers, skip, abort |
| `POST /api/attention/:id/draft` | Magic link; optional private draft, disabled when AI assistance is discouraged |
| `GET /api/attention/:id/answers` | Magic link; prior answers, never silently inserted |
| `GET /api/internal/attention-signals/:id` | Internal bearer; runner coordination poll |
| `POST /api/internal/attention-wake` | Internal bearer; optional VM wake webhook or recorded ops instructions |

Signal body remains `{ token, action: "resume" | "skip" | "abort", answers }`.
Answers carry `{ questionId, text, source: "typed" | "draft_approved" | "bank" }`.
Site D1 stores coordination signals and approved answer-bank entries, **not** the
application ledger. State-worker remains the attention/ledger source of truth.
Draft and prior-answer controls sit in the optional Answer options disclosure.
Drafts require explicit approval; postings discouraging AI retain typed answers.

The legacy magic-link `/api/attention/:id/live-session` and `/wake` endpoints
remain available for compatibility with existing integrations. New buyer pages
and emails never link to or call them. This PR does not redesign or enable the
underlying noVNC or CAPTCHA vendor infrastructure. Real ops still use internal
wake tooling and their existing authorized agent-box session; the public admin
fixture supplies neither credentials nor access.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ATTENTION_NOTIFY_SECRET` | Internal notify/signals/wake bearer |
| `ATTENTION_MAGIC_LINK_SECRET` | Judgment HMAC signing, at least 16 characters |
| `PUBLIC_SITE_URL` | Origin for judgment links |
| `RESEND_API_KEY` | Judgment mail delivery; fail closed when absent |
| `RESEND_FROM_EMAIL` | Optional sender, defaults to `JobAppAgent <attention@jobappagent.com>` |
| `ATTENTION_DRAFT_API_KEY`, `ATTENTION_DRAFT_BASE_URL`, `ATTENTION_DRAFT_MODEL` | Optional private draft provider |
| `ATTENTION_WAKE_URL`, `ATTENTION_WAKE_INSTRUCTIONS` | Optional internal wake webhook / manual ops instructions |
| `ATTENTION_LIVE_SESSION_BASE_URL`, `ATTENTION_NOVNC_PASSWORD` | Existing noVNC compatibility configuration; never passed to buyer components |
| `ATTENTION_IAP_HELPER_COMMAND` | Founder/dev IAP helper only |

No new secret or database migration is needed for this slice. Existing D1
`attention_signals` and `attention_answer_bank` storage is reused. Single-tenant
answer-bank scoping is unchanged.

## Runner and ops contract

Use the installed `job-application-agent` CLI for private state operations. Acquire
and renew the shared application-run lease, download the canonical résumé via
`resume path`, and upload its absolute path. Keep session bindings local-only:
attention ID, job URL, persistent profile, `DISPLAY=:99`, VNC `5900`, optional tab
hint. Do not switch to TigerVNC `:1` / `5901` or lose the filled form tab.

The existing `scripts/attention-runner-poll.mjs` exits 0 for `resume_requested`,
10 for skip, 11 for abort, 20 for still waiting/timeout. On resume: renew lease,
reattach the same tab, inject approved answers, re-inspect all absolute gates,
create the submission intent immediately before transmitting, then confirm it
only after visible ATS success. Sent-but-unverified is not permission to retry.
No buyer UI signal authorizes bypassing a remaining technical or consent gate.
See `state-worker/AGENT.md` and the runner/session-binding documentation.

## Validation

Run the attention unit and component-render tests from `site/`:

```sh
node --test tests/attention-*.test.mjs tests/attention-*.spec.mjs
npm run typecheck
```

Tests cover the six fixtures and aliases, auth-gate boundaries, CTA text, whitespace
answer gating, buyer/ops notification routing (all mail/network mocked), actual
rendered buyer markup, and the absence of troubleshooting/admin chrome. Preview
all six screens at mobile and laptop widths and exercise card toggles, zero
selection, whitespace input, the overflow, and the queue transition before shipping.
