import { env } from "cloudflare:workers";
import { getPaymentConfig } from "../../../../lib/dodo";
import { refundOverduePurchases } from "../../../../lib/refund-overdue";

async function digest(value: string) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function authorized(request: Request) {
  const expected = env.REFUND_CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const [left, right] = await Promise.all([digest(expected), digest(supplied)]);
  const a = new Uint8Array(left); const b = new Uint8Array(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function POST(request: Request) {
  if (!await authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const configured = getPaymentConfig();
  if (!configured.ok) return Response.json({ error: "payments_unavailable" }, { status: 503 });
  try {
    return Response.json(await refundOverduePurchases(configured.config), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "refund_job_failed" }, { status: 503 });
  }
}
