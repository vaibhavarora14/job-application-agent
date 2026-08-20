import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { PURCHASE_WEBHOOK_UPDATE_SQL } from "../lib/purchase-webhook-store.mjs";

test("replaying a succeeded payment preserves its original payment and activation timestamps", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE founding_purchases (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL, dodo_payment_id TEXT, dodo_customer_id TEXT,
    customer_email TEXT, status TEXT, amount INTEGER, currency TEXT, paid_at TEXT,
    activation_deadline_at TEXT, refund_id TEXT, refund_status TEXT, updated_at TEXT
  )`);
  database.prepare(`INSERT INTO founding_purchases
    (id,product_id,status,paid_at,activation_deadline_at) VALUES (?,?,?,?,?)`)
    .run("purchase-1", "product-1", "succeeded", "2026-08-19T12:00:00.000Z", "2026-10-18T12:00:00.000Z");

  database.prepare(PURCHASE_WEBHOOK_UPDATE_SQL).run(
    "payment-1", "customer-1", "customer@example.com",
    "succeeded", "succeeded", "succeeded", 4900, "USD",
    "2026-08-20T12:00:00.000Z", "2026-10-19T12:00:00.000Z", null,
    null, null, "product-1", "purchase-1", "purchase-1", "payment-1",
  );

  const purchase = database.prepare("SELECT paid_at AS paidAt, activation_deadline_at AS deadline FROM founding_purchases WHERE id=?")
    .get("purchase-1");
  assert.equal(purchase.paidAt, "2026-08-19T12:00:00.000Z");
  assert.equal(purchase.deadline, "2026-10-18T12:00:00.000Z");
});
