import { env } from "cloudflare:workers";
import { activationDeadline, activationWindow } from "./purchase-lifecycle.mjs";

let schemaReady: Promise<void> | undefined;

async function ensureSchema() {
  const db = env.DB;
  schemaReady ??= db.batch([db.prepare(`CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id TEXT PRIMARY KEY NOT NULL,
    event_type TEXT NOT NULL,
    payment_id TEXT,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`), db.prepare(`CREATE TABLE IF NOT EXISTS founding_purchases (
    id TEXT PRIMARY KEY NOT NULL,
    checkout_session_id TEXT UNIQUE,
    checkout_url TEXT,
    dodo_payment_id TEXT UNIQUE,
    dodo_customer_id TEXT,
    customer_email TEXT,
    product_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    amount INTEGER,
    currency TEXT,
    paid_at TEXT,
    activation_deadline_at TEXT,
    activated_at TEXT,
    access_expires_at TEXT,
    refund_id TEXT UNIQUE,
    refund_status TEXT,
    refund_requested_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`), db.prepare("CREATE INDEX IF NOT EXISTS idx_founding_purchases_refund_due ON founding_purchases(status,activation_deadline_at)"), db.prepare("PRAGMA optimize")]).then(() => undefined);
  return schemaReady;
}

export async function createPurchase(productId: string) {
  await ensureSchema();
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO founding_purchases (id,product_id) VALUES (?,?)").bind(id, productId).run();
  return id;
}

export async function findReusablePurchase(id: string) {
  await ensureSchema();
  return env.DB.prepare(`SELECT id,checkout_session_id AS checkoutSessionId,checkout_url AS checkoutUrl
    FROM founding_purchases WHERE id=? AND status='checkout_created' AND checkout_url IS NOT NULL
    AND created_at>=datetime('now','-23 hours') LIMIT 1`)
    .bind(id).first<{ id: string; checkoutSessionId: string; checkoutUrl: string }>();
}

export async function savePurchaseCheckout(input: { purchaseId: string; checkoutSessionId: string; checkoutUrl: string }) {
  await ensureSchema();
  const result = await env.DB.prepare(`UPDATE founding_purchases SET checkout_session_id=?,checkout_url=?,status='checkout_created',updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status IN ('created','checkout_created')`)
    .bind(input.checkoutSessionId, input.checkoutUrl, input.purchaseId).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function applyPurchaseWebhook(eventId: string, payment: {
  eventType: string; purchaseId: string | null; paymentId: string; productId: string; customerId: string | null;
  customerEmail: string | null; status: string | null; amount: number | null; currency: string | null;
  refundId?: string | null; refundStatus?: string | null;
}): Promise<{ isNewEvent: boolean }> {
  await ensureSchema();
  const paidAt = payment.status === "succeeded" ? new Date().toISOString() : null;
  const deadline = paidAt ? activationDeadline(paidAt) : null;
  const db = env.DB;
  // Record the webhook id first so replays can skip Support alerts while still
  // re-applying the purchase UPDATE (idempotent field fill / status).
  const inserted = await db.prepare(
    "INSERT INTO payment_webhook_events (id,event_type,payment_id) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
  ).bind(eventId, payment.eventType, payment.paymentId).run();
  const isNewEvent = (inserted.meta?.changes ?? 0) > 0;
  await db.prepare(`UPDATE founding_purchases SET dodo_payment_id=?,dodo_customer_id=COALESCE(?,dodo_customer_id),
      customer_email=COALESCE(?,customer_email),status=CASE
        WHEN status='refunded' OR ? IS NULL OR (status LIKE 'dispute_%' AND ? NOT LIKE 'dispute_%') THEN status ELSE ? END,
      amount=COALESCE(?,amount),currency=COALESCE(?,currency),paid_at=COALESCE(?,paid_at),
      activation_deadline_at=COALESCE(?,activation_deadline_at),refund_id=COALESCE(?,refund_id),
      refund_status=CASE WHEN refund_status='succeeded' OR ? IS NULL THEN refund_status ELSE ? END,updated_at=CURRENT_TIMESTAMP
      WHERE product_id=? AND ((? IS NOT NULL AND id=?) OR dodo_payment_id=?)`)
    .bind(payment.paymentId, payment.customerId, payment.customerEmail, payment.status, payment.status, payment.status,
      payment.amount, payment.currency, paidAt, deadline, payment.refundId ?? null,
      payment.refundStatus ?? null, payment.refundStatus ?? null,
      payment.productId, payment.purchaseId, payment.purchaseId, payment.paymentId).run();
  return { isNewEvent };
}

export async function getPurchaseStatus(purchaseId: string) {
  await ensureSchema();
  return env.DB.prepare(`SELECT status,paid_at AS paidAt,activation_deadline_at AS activationDeadlineAt,
    activated_at AS activatedAt,access_expires_at AS accessExpiresAt,refund_status AS refundStatus
    FROM founding_purchases WHERE id=?`).bind(purchaseId).first<{
      status: string; paidAt: string | null; activationDeadlineAt: string | null;
      activatedAt: string | null; accessExpiresAt: string | null; refundStatus: string | null;
    }>();
}

export async function activatePurchase(purchaseId: string, at = new Date()) {
  await ensureSchema();
  const window = activationWindow(at.toISOString());
  const result = await env.DB.prepare(`UPDATE founding_purchases SET activated_at=?,access_expires_at=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='succeeded' AND activated_at IS NULL AND refund_status IS NULL`)
    .bind(window.activatedAt, window.accessExpiresAt, purchaseId).run();
  return (result.meta?.changes ?? 0) > 0 ? window : null;
}

export async function listRefundDue(limit = 100) {
  await ensureSchema();
  const result = await env.DB.prepare(`SELECT id,dodo_payment_id AS paymentId FROM founding_purchases
    WHERE status='succeeded' AND activated_at IS NULL AND dodo_payment_id IS NOT NULL
      AND activation_deadline_at<=CURRENT_TIMESTAMP AND (refund_status IS NULL OR refund_status='failed')
    ORDER BY activation_deadline_at LIMIT ?`).bind(limit).all<{ id: string; paymentId: string }>();
  return result.results ?? [];
}

export async function recordRefundRequest(purchaseId: string, refund: { refundId: string | null; status: string }) {
  await ensureSchema();
  await env.DB.prepare(`UPDATE founding_purchases SET refund_id=COALESCE(?,refund_id),refund_status=?,refund_requested_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='succeeded' AND activated_at IS NULL`)
    .bind(refund.refundId, refund.status, purchaseId).run();
}
