import{env as e}from"cloudflare:workers";var t;async function n(){let n=e.DB;return t??=n.batch([n.prepare(`CREATE TABLE IF NOT EXISTS founding_registrations (
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
  )`),n.prepare(`CREATE TABLE IF NOT EXISTS founding_payments (
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
  )`),n.prepare(`CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id TEXT PRIMARY KEY NOT NULL,
    event_type TEXT NOT NULL,
    payment_id TEXT,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`),n.prepare(`CREATE INDEX IF NOT EXISTS idx_founding_payments_registration_id ON founding_payments(registration_id)`),n.prepare(`PRAGMA optimize`)]).then(()=>void 0),t}async function r(t){return await n(),e.DB.prepare(`SELECT id,email,paid_intent AS paidIntent FROM founding_registrations WHERE id=?`).bind(t).first()}async function i(t){return await n(),e.DB.prepare(`SELECT checkout_session_id AS checkoutSessionId,checkout_url AS checkoutUrl
    FROM founding_payments WHERE registration_id=? AND status='checkout_created'
    AND created_at >= datetime('now','-23 hours') ORDER BY created_at DESC LIMIT 1`).bind(t).first()}async function a(t){await n(),await e.DB.prepare(`INSERT INTO founding_payments (id,registration_id,checkout_session_id,checkout_url,product_id)
    VALUES (?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING`).bind(crypto.randomUUID(),t.registrationId,t.checkoutSessionId,t.checkoutUrl,t.productId).run()}async function o(t,r){await n();let i=r.status===`succeeded`?new Date().toISOString():null,a=e.DB;await a.batch([a.prepare(`INSERT INTO payment_webhook_events (id,event_type,payment_id) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING`).bind(t,r.eventType,r.paymentId),a.prepare(`INSERT INTO founding_payments (id,registration_id,checkout_session_id,checkout_url,dodo_payment_id,product_id,status,amount,currency,paid_at)
      VALUES (?,?,?, '',?,?,?, ?,?,?) ON CONFLICT(dodo_payment_id) DO UPDATE SET
      status=excluded.status,amount=excluded.amount,currency=excluded.currency,paid_at=COALESCE(excluded.paid_at,founding_payments.paid_at),updated_at=CURRENT_TIMESTAMP`).bind(crypto.randomUUID(),r.registrationId,`webhook:${r.paymentId}`,r.paymentId,r.productId,r.status,r.amount,r.currency,i)])}async function s(t){return await n(),e.DB.prepare(`SELECT status FROM founding_payments WHERE registration_id=? ORDER BY updated_at DESC LIMIT 1`).bind(t).first()}async function c(t){await n();let r=(await e.DB.prepare(`SELECT id FROM founding_registrations WHERE email = ?`).bind(t.email).first())?.id??crypto.randomUUID();return await e.DB.prepare(`INSERT INTO founding_registrations (id,email,target_role,target_location,source,consent_version)
    VALUES (?,?,?,?,?,'2026-08-18') ON CONFLICT(email) DO UPDATE SET
    target_role=excluded.target_role,target_location=excluded.target_location,source=excluded.source,updated_at=CURRENT_TIMESTAMP`).bind(r,t.email,t.targetRole,t.targetLocation,t.source).run(),r}async function l(t,r){return await n(),((await e.DB.prepare(`UPDATE founding_registrations SET paid_intent=?, paid_intent_recorded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(r,t).run()).meta?.changes??0)>0}export{a,r as i,i as n,l as o,s as r,c as s,o as t};