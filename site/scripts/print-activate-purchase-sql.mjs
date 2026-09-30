#!/usr/bin/env node
/**
 * Print the production D1 UPDATE that mirrors activatePurchase().
 * Does not execute anything — ops review + wrangler d1 execute --remote.
 *
 * Usage: node scripts/print-activate-purchase-sql.mjs <purchase-uuid>
 */
import { activationWindow } from "../lib/purchase-lifecycle.mjs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const purchaseId = String(process.argv[2] ?? "").trim();

if (!uuidPattern.test(purchaseId)) {
  console.error("Usage: node scripts/print-activate-purchase-sql.mjs <purchase-uuid>");
  process.exit(1);
}

const window = activationWindow(new Date().toISOString());
const sql = [
  "UPDATE founding_purchases",
  `SET activated_at='${window.activatedAt}',`,
  `    access_expires_at='${window.accessExpiresAt}',`,
  "    updated_at=CURRENT_TIMESTAMP",
  `WHERE id='${purchaseId}'`,
  "  AND status='succeeded'",
  "  AND activated_at IS NULL",
  "  AND refund_status IS NULL;",
].join("\n");

console.log("# Mirrors site/lib/registration-store.ts activatePurchase()");
console.log(`# purchaseId=${purchaseId}`);
console.log(`# activated_at=${window.activatedAt}`);
console.log(`# access_expires_at=${window.accessExpiresAt} (90 days)`);
console.log("# Apply only after Support emailed access details to the buyer.");
console.log("#");
console.log("# npx wrangler d1 execute job-application-agent-public-stats \\");
console.log("#   --remote --config wrangler.jsonc \\");
console.log("#   --command \"<SQL below>\"");
console.log("");
console.log(sql);
