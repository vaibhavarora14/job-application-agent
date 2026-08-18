import { env } from "cloudflare:workers";

let schemaReady: Promise<void> | undefined;

async function ensureSchema() {
  const db = env.DB;
  schemaReady ??= db.batch([db.prepare(`CREATE TABLE IF NOT EXISTS founding_registrations (
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
  )`), db.prepare("CREATE INDEX IF NOT EXISTS idx_founding_payments_registration_id ON founding_payments(registration_id)"), db.prepare("PRAGMA optimize")]).then(() => undefined);
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
