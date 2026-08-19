import { env } from "cloudflare:workers";
import { isStorageHealthy } from "../../../lib/health.mjs";

export async function GET() {
  if (await isStorageHealthy(env.DB)) {
    return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
  }
  return Response.json(
    { status: "unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
