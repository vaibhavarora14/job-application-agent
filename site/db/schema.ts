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

export const paymentWebhookEvents = sqliteTable("payment_webhook_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  paymentId: text("payment_id"),
  processedAt: text("processed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
