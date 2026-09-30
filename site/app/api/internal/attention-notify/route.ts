import { readJsonRequest } from "../../../../lib/public-boundary.mjs";
import { authorizedAttentionInternal, attentionEnv } from "../../../../lib/attention-auth";
import { notifyAttentionOpened } from "../../../../lib/attention-notify.mjs";

/**
 * POST /api/internal/attention-notify
 * Called when an attention item opens (CLI hook or runner).
 * Bearer ATTENTION_NOTIFY_SECRET. Only employer questions require mailer/signing secrets.
 */
export async function POST(request: Request) {
  if (!await authorizedAttentionInternal(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await readJsonRequest(request, 8_192);
  if (!body.ok) {
    return Response.json({ error: "invalid_body" }, { status: body.status ?? 400 });
  }

  const config = attentionEnv();
  const result = await notifyAttentionOpened(body.data, {
    magicLinkSecret: config.magicLinkSecret,
    publicSiteUrl: config.publicSiteUrl,
    resendApiKey: config.resendApiKey,
    resendFrom: config.resendFrom,
    ttlSeconds: 2700,
    logger: console,
  });

  if (!result.ok) {
    return Response.json(
      { error: result.error },
      { status: result.status ?? 503, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
