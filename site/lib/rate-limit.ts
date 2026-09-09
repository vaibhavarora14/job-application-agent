import { env } from "cloudflare:workers";
import { consumeRateLimit, hashRateLimitKey } from "./public-boundary.mjs";

let schemaReady: Promise<void> | undefined;

async function ensureRateLimitSchema() {
  schemaReady ??= env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS public_rate_limits (
      key TEXT PRIMARY KEY NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_public_rate_limits_updated_at ON public_rate_limits(updated_at)"),
  ]).then(() => undefined);
  return schemaReady;
}

export async function enforcePublicRateLimit(request: Request, scope: string, limit: number, windowSeconds = 900) {
  const url = new URL(request.url);
  const salt = env.RATE_LIMIT_SALT || (url.hostname === "localhost" ? "local-development-only" : "");
  if (!salt) return Response.json({ error: "This service is temporarily unavailable." }, { status: 503 });

  const address = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  try {
    await ensureRateLimitSchema();
    const key = await hashRateLimitKey(address, scope, salt);
    const result = await consumeRateLimit(env.DB, key, { limit, windowSeconds });
    if (result.allowed) return null;
    return Response.json({ error: "Too many requests. Please try again shortly." }, {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(result.retryAfter),
        "x-ratelimit-limit": String(result.limit),
        "x-ratelimit-remaining": String(result.remaining),
      },
    });
  } catch {
    return Response.json({ error: "This service is temporarily unavailable." }, { status: 503 });
  }
}
