import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const foundingRegistrations = sqliteTable("founding_registrations", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  targetRole: text("target_role").notNull(),
  targetLocation: text("target_location").notNull().default(""),
  source: text("source").notNull().default(""),
  consentVersion: text("consent_version").notNull(),
  paidIntent: text("paid_intent"),
  paidIntentRecordedAt: text("paid_intent_recorded_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const foundingPayments = sqliteTable("founding_payments", {
  id: text("id").primaryKey(),
  registrationId: text("registration_id").notNull().references(() => foundingRegistrations.id),
  checkoutSessionId: text("checkout_session_id").notNull().unique(),
  checkoutUrl: text("checkout_url").notNull(),
  dodoPaymentId: text("dodo_payment_id").unique(),
  productId: text("product_id").notNull(),
  status: text("status").notNull().default("checkout_created"),
  amount: integer("amount"),
  currency: text("currency"),
  paidAt: text("paid_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_founding_payments_registration_id").on(table.registrationId),
]);

export const foundingPurchases = sqliteTable("founding_purchases", {
  id: text("id").primaryKey(),
  checkoutSessionId: text("checkout_session_id").unique(),
  checkoutUrl: text("checkout_url"),
  dodoPaymentId: text("dodo_payment_id").unique(),
  dodoCustomerId: text("dodo_customer_id"),
  customerEmail: text("customer_email"),
  productId: text("product_id").notNull(),
  status: text("status").notNull().default("created"),
  amount: integer("amount"),
  currency: text("currency"),
  paidAt: text("paid_at"),
  activationDeadlineAt: text("activation_deadline_at"),
  activatedAt: text("activated_at"),
  accessExpiresAt: text("access_expires_at"),
  refundId: text("refund_id").unique(),
  refundStatus: text("refund_status"),
  refundRequestedAt: text("refund_requested_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_founding_purchases_refund_due").on(table.status, table.activationDeadlineAt),
]);

export const paymentWebhookEvents = sqliteTable("payment_webhook_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  paymentId: text("payment_id"),
  processedAt: text("processed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const publicRateLimits = sqliteTable("public_rate_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("idx_public_rate_limits_updated_at").on(table.updatedAt),
]);

/** Coordination only — not the application ledger. Never store secrets here. */
export const attentionSignals = sqliteTable("attention_signals", {
  attentionId: text("attention_id").primaryKey(),
  signal: text("signal").notNull(),
  actor: text("actor").notNull().default("candidate"),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_attention_signals_updated_at").on(table.updatedAt),
]);

/**
 * Reusable judgment answers for attention UI (P1.5).
 * Never store CAPTCHA, MFA, cookies, or government IDs.
 */
export const attentionAnswerBank = sqliteTable("attention_answer_bank", {
  fingerprint: text("fingerprint").primaryKey(),
  prompt: text("prompt").notNull(),
  text: text("text").notNull(),
  tagsJson: text("tags_json").notNull().default("[]"),
  source: text("source").notNull().default("typed"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_attention_answer_bank_updated_at").on(table.updatedAt),
]);
