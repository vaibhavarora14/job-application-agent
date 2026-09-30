# Founding payment → manual seat activation (ops)

Money-path **option A**: verified Dodo `payment.succeeded` marks the purchase
**paid/succeeded** in D1 and alerts Support. **Paid ≠ activated.** Seat access
starts only after ops emails the buyer and runs activation manually.

Do **not** wire `activatePurchase` into the webhook. Do **not** promise public
automatic refunds from this runbook.

## What the webhook already does

On signed founding `payment.succeeded` (`POST /api/webhooks/dodo`):

1. Idempotently updates `founding_purchases` → `status='succeeded'`, stores
   `dodo_payment_id`, `customer_email`, `paid_at`, `activation_deadline_at`
   (60 days after pay — internal ops deadline only).
2. Records `payment_webhook_events` by webhook id (replays skip a second Support alert).
3. Alerts Support (Resend when `RESEND_API_KEY` is set; always emits a structured
   Worker log line `founding_payment_support_alert` with `purchaseId` + buyer email).
4. Captures PostHog `founding_payment_confirmed` (hashed purchase id only).
5. Does **not** call `activatePurchase`.

Buyer success UI (`/checkout/return`) already sets expectations: email usually
within ~24h; 90 days start on seat activation.

## Env (site Worker)

| Variable | Required | Purpose |
|----------|----------|---------|
| `RESEND_API_KEY` | for email alert | Same Resend key as attention mail |
| `RESEND_FROM_EMAIL` | no | From override (default ops From in alert path) |
| `FOUNDING_SUPPORT_ALERT_EMAIL` | no | Support inbox (default `founders@jobappagent.com`) |

Set secrets with Wrangler (never commit values):

```bash
cd site
npx wrangler secret put RESEND_API_KEY --config wrangler.jsonc
npx wrangler secret put FOUNDING_SUPPORT_ALERT_EMAIL --config wrangler.jsonc
```

If Resend is unset, Cloudflare logs still carry the actionable payload — query
D1 for the backlog (below).

## Fulfillment checklist

1. **Receive Support alert** (email or Worker log) with `purchaseId`, `buyerEmail`,
   and `paymentId` when present.
2. **Email the buyer** hosted access details to `buyerEmail` (within ~24h of pay).
3. **Activate the seat** only after that access email is sent (steps below).
4. Confirm `activated_at` / `access_expires_at` on the row (90-day window from activation).

## Manual `activatePurchase`

Runtime helper: `activatePurchase(purchaseId)` in `lib/registration-store.ts`.

Safety `WHERE` (all required):

- `status = 'succeeded'`
- `activated_at IS NULL`
- `refund_status IS NULL`

It sets `activated_at` and `access_expires_at` via `activationWindow` (90 days
from activation time) in `lib/purchase-lifecycle.mjs`.

### Preferred: generate SQL, then remote D1

From `site/`:

```bash
node scripts/print-activate-purchase-sql.mjs <purchase-uuid>
```

Review the printed `UPDATE`, then apply against production D1:

```bash
npx wrangler d1 execute job-application-agent-public-stats \
  --remote \
  --config wrangler.jsonc \
  --command "<paste UPDATE from the script>"
```

Expect `changes = 1`. If `changes = 0`, stop — the row is missing, not
`succeeded`, already activated, or has a refund marker.

### Safety checks before running

```sql
SELECT id, status, customer_email, dodo_payment_id, paid_at,
       activated_at, access_expires_at, refund_status
FROM founding_purchases
WHERE id = '<purchase-uuid>';
```

- Buyer email matches the access email you just sent.
- `status` is `succeeded`.
- `activated_at` and `refund_status` are null.

### Backlog (missed alert)

```sql
SELECT id, customer_email, dodo_payment_id, paid_at, activation_deadline_at
FROM founding_purchases
WHERE status = 'succeeded'
  AND activated_at IS NULL
  AND (refund_status IS NULL OR refund_status = 'failed')
ORDER BY paid_at;
```

## Explicitly out of scope here

- Auto seat provisioning / cloud dashboard unlock on pay
- Enabling or changing refund automation / refund cron behavior
- Changing Dodo product price or dashboard Name/Description
