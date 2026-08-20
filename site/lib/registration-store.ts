import { env } from "cloudflare:workers";
import { activationDeadline, activationWindow } from "./purchase-lifecycle.mjs";
import { PURCHASE_WEBHOOK_UPDATE_SQL } from "./purchase-webhook-store.mjs";

let schemaReady: Promise<void> | undefined;

async function ensureSchema() {
  const db = env.DB;
  schemaReady ??= (async () => {
    await db.batch([db.prepare(`CREATE TABLE IF NOT EXISTS founding_registrations (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL UNIQUE,
    target_role TEXT NOT NULL,
    target_location TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    consent_version TEXT NOT NULL,
    paid_intent TEXT,
    paid_intent_recorded_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`), db.prepare(`CREATE TABLE IF NOT EXISTS founding_payments (
    id TEXT PRIMARY KEY NOT NULL,
    registration_id TEXT NOT NULL REFERENCES founding_registrations(id),
    checkout_session_id TEXT NOT NULL UNIQUE,
    checkout_url TEXT NOT NULL,
    dodo_payment_id TEXT UNIQUE,
    product_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'checkout_created',
    amount INTEGER,
    currency TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`), db.prepare(`CREATE TABLE IF NOT EXISTS payment_webhook_events (
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
    access_days INTEGER NOT NULL DEFAULT 90,
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
  )`), db.prepare(`CREATE TABLE IF NOT EXISTS customer_email_deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    purchase_id TEXT NOT NULL REFERENCES founding_purchases(id),
    message_kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    provider_message_id TEXT,
    last_attempt_at TEXT,
    accepted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(purchase_id,message_kind)
  )`), db.prepare("CREATE INDEX IF NOT EXISTS idx_founding_payments_registration_id ON founding_payments(registration_id)"), db.prepare("CREATE INDEX IF NOT EXISTS idx_founding_purchases_refund_due ON founding_purchases(status,activation_deadline_at)"), db.prepare("CREATE INDEX IF NOT EXISTS idx_customer_email_deliveries_retry ON customer_email_deliveries(status,last_attempt_at)"), db.prepare("PRAGMA optimize")]);
    const columns = await db.prepare("PRAGMA table_info(founding_purchases)").all<{ name: string }>();
    if (!(columns.results ?? []).some((column) => column.name === "access_days")) {
      await db.prepare("ALTER TABLE founding_purchases ADD COLUMN access_days INTEGER NOT NULL DEFAULT 90").run();
    }
  })();
  return schemaReady;
}

export async function getRegistrationForCheckout(id: string) {
  await ensureSchema();
  return env.DB.prepare("SELECT id,email,paid_intent AS paidIntent FROM founding_registrations WHERE id=?")
    .bind(id).first<{ id: string; email: string; paidIntent: string | null }>();
}

export async function findReusableCheckout(registrationId: string) {
  await ensureSchema();
  return env.DB.prepare(`SELECT checkout_session_id AS checkoutSessionId,checkout_url AS checkoutUrl
    FROM founding_payments WHERE registration_id=? AND status='checkout_created'
    AND created_at >= datetime('now','-23 hours') ORDER BY created_at DESC LIMIT 1`)
    .bind(registrationId).first<{ checkoutSessionId: string; checkoutUrl: string }>();
}

export async function saveCheckoutSession(input: { registrationId: string; checkoutSessionId: string; checkoutUrl: string; productId: string }) {
  await ensureSchema();
  await env.DB.prepare(`INSERT INTO founding_payments (id,registration_id,checkout_session_id,checkout_url,product_id)
    VALUES (?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING`)
    .bind(crypto.randomUUID(), input.registrationId, input.checkoutSessionId, input.checkoutUrl, input.productId).run();
}

export async function applyPaymentWebhook(eventId: string, payment: { eventType: string; registrationId: string; paymentId: string; productId: string; status: string; amount: number | null; currency: string | null }) {
  await ensureSchema();
  const paidAt = payment.status === "succeeded" ? new Date().toISOString() : null;
  const db = env.DB;
  await db.batch([
    db.prepare("INSERT INTO payment_webhook_events (id,event_type,payment_id) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING").bind(eventId, payment.eventType, payment.paymentId),
    db.prepare(`INSERT INTO founding_payments (id,registration_id,checkout_session_id,checkout_url,dodo_payment_id,product_id,status,amount,currency,paid_at)
      VALUES (?,?,?, '',?,?,?, ?,?,?) ON CONFLICT(dodo_payment_id) DO UPDATE SET
      status=excluded.status,amount=excluded.amount,currency=excluded.currency,paid_at=COALESCE(excluded.paid_at,founding_payments.paid_at),updated_at=CURRENT_TIMESTAMP`)
      .bind(crypto.randomUUID(), payment.registrationId, `webhook:${payment.paymentId}`, payment.paymentId, payment.productId, payment.status, payment.amount, payment.currency, paidAt),
  ]);
}

export async function getLatestPaymentStatus(registrationId: string) {
  await ensureSchema();
  return env.DB.prepare("SELECT status FROM founding_payments WHERE registration_id=? ORDER BY updated_at DESC LIMIT 1")
    .bind(registrationId).first<{ status: string }>();
}

export async function saveRegistration(data: { email: string; targetRole: string; targetLocation: string; source: string }) {
  await ensureSchema();
  const existing = await env.DB.prepare("SELECT id FROM founding_registrations WHERE email = ?").bind(data.email).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO founding_registrations (id,email,target_role,target_location,source,consent_version)
    VALUES (?,?,?,?,?,'2026-08-18') ON CONFLICT(email) DO UPDATE SET
    target_role=excluded.target_role,target_location=excluded.target_location,source=excluded.source,updated_at=CURRENT_TIMESTAMP`)
    .bind(id, data.email, data.targetRole, data.targetLocation, data.source).run();
  return id;
}

export async function savePaidIntent(id: string, intent: string) {
  await ensureSchema();
  const result = await env.DB.prepare("UPDATE founding_registrations SET paid_intent=?, paid_intent_recorded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(intent, id).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function createPurchase(productId: string, accessDays = 90) {
  await ensureSchema();
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO founding_purchases (id,product_id,access_days) VALUES (?,?,?)").bind(id, productId, accessDays).run();
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
}) {
  await ensureSchema();
  const paidAt = payment.status === "succeeded" ? new Date().toISOString() : null;
  const deadline = paidAt ? activationDeadline(paidAt) : null;
  const db = env.DB;
  await db.batch([
    db.prepare("INSERT INTO payment_webhook_events (id,event_type,payment_id) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING")
      .bind(eventId, payment.eventType, payment.paymentId),
    db.prepare(PURCHASE_WEBHOOK_UPDATE_SQL)
      .bind(payment.paymentId, payment.customerId, payment.customerEmail, payment.status, payment.status, payment.status,
        payment.amount, payment.currency, paidAt, deadline, payment.refundId ?? null,
        payment.refundStatus ?? null, payment.refundStatus ?? null,
        payment.productId, payment.purchaseId, payment.purchaseId, payment.paymentId),
  ]);
}

export async function getWelcomeEmailPurchase(purchaseId: string) {
  await ensureSchema();
  return env.DB.prepare(`SELECT id,customer_email AS customerEmail,access_days AS accessDays,status
    FROM founding_purchases WHERE id=?`).bind(purchaseId).first<{
      id: string; customerEmail: string | null; accessDays: number; status: string;
    }>();
}

export async function claimWelcomeEmailDelivery(input: { purchaseId: string; messageKind: string }) {
  await ensureSchema();
  const db = env.DB;
  await db.prepare(`INSERT INTO customer_email_deliveries (id,purchase_id,message_kind)
    SELECT ?,id,? FROM founding_purchases WHERE id=? AND status='succeeded'
    ON CONFLICT(purchase_id,message_kind) DO NOTHING`)
    .bind(crypto.randomUUID(), input.messageKind, input.purchaseId).run();
  const result = await db.prepare(`UPDATE customer_email_deliveries SET status='sending',
    attempt_count=attempt_count+1,last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE purchase_id=? AND message_kind=? AND (
      status IN ('pending','failed') OR
      (status='sending' AND (last_attempt_at IS NULL OR last_attempt_at<=datetime('now','-5 minutes')))
    )`).bind(input.purchaseId, input.messageKind).run();
  if ((result.meta?.changes ?? 0) > 0) return "claimed";
  const delivery = await db.prepare(`SELECT status FROM customer_email_deliveries
    WHERE purchase_id=? AND message_kind=?`).bind(input.purchaseId, input.messageKind).first<{ status: string }>();
  return delivery?.status === "accepted" ? "accepted" : "busy";
}

export async function markWelcomeEmailAccepted(input: { purchaseId: string; messageKind: string; providerMessageId: string }) {
  await ensureSchema();
  const result = await env.DB.prepare(`UPDATE customer_email_deliveries SET status='accepted',provider_message_id=?,
    accepted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE purchase_id=? AND message_kind=? AND status='sending'`)
    .bind(input.providerMessageId, input.purchaseId, input.messageKind).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markWelcomeEmailFailed(input: { purchaseId: string; messageKind: string }) {
  await ensureSchema();
  await env.DB.prepare(`UPDATE customer_email_deliveries SET status='failed',updated_at=CURRENT_TIMESTAMP
    WHERE purchase_id=? AND message_kind=? AND status='sending'`)
    .bind(input.purchaseId, input.messageKind).run();
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
  const purchase = await env.DB.prepare("SELECT access_days AS accessDays FROM founding_purchases WHERE id=?")
    .bind(purchaseId).first<{ accessDays: number }>();
  if (!purchase) return null;
  const window = activationWindow(at.toISOString(), purchase.accessDays);
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
