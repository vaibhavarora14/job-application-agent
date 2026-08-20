import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  accessDays: integer("access_days").notNull().default(90),
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

export const customerEmailDeliveries = sqliteTable("customer_email_deliveries", {
  id: text("id").primaryKey(),
  purchaseId: text("purchase_id").notNull().references(() => foundingPurchases.id),
  messageKind: text("message_kind").notNull(),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  providerMessageId: text("provider_message_id"),
  lastAttemptAt: text("last_attempt_at"),
  acceptedAt: text("accepted_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_customer_email_deliveries_purchase_kind").on(table.purchaseId, table.messageKind),
  index("idx_customer_email_deliveries_retry").on(table.status, table.lastAttemptAt),
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
