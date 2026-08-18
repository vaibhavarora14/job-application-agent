import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

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
