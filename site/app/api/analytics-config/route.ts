import { env } from "cloudflare:workers";
import { DEFAULT_POSTHOG_HOST, resolvePostHogHost } from "../../../lib/posthog.mjs";

/** Public PostHog config for the landing client. Empty → 204 (analytics off). */
export async function GET() {
  const apiKey = env.NEXT_PUBLIC_POSTHOG_KEY?.trim() ?? "";
  if (!apiKey) return new Response(null, { status: 204 });
  return Response.json({
    apiKey,
    host: resolvePostHogHost(env.NEXT_PUBLIC_POSTHOG_HOST ?? env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST),
  }, {
    headers: {
      "cache-control": "public, max-age=300",
    },
  });
}
