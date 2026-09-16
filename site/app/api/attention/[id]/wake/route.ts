import { attentionEnv } from "../../../../../lib/attention-auth";
import { verifyAttentionMagicLink } from "../../../../../lib/attention-magic-link.mjs";
import { readJsonRequest } from "../../../../../lib/public-boundary.mjs";
import { dispatchAttentionWake } from "../../../../../lib/attention-wake.mjs";

type Params = { params: Promise<{ id: string }> };
type VerifyOk = { ok: true; payload: { attentionId: string } };
type VerifyErr = { ok: false; error: string };

/**
 * POST /api/attention/:id/wake
 * Magic-link authenticated wake before opening the in-page live panel.
 * Same seam as POST /api/internal/attention-wake — no GCP creds in Worker.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const attentionId = decodeURIComponent(id ?? "").trim();
  if (!attentionId || attentionId.length > 180) {
    return Response.json({ error: "attention_id_invalid" }, { status: 400 });
  }

  const body = await readJsonRequest(request, 4_096);
  if (!body.ok) {
    return Response.json({ error: "invalid_body" }, { status: body.status ?? 400 });
  }

  const token = typeof body.data?.token === "string" ? body.data.token.trim() : "";
  if (!token) {
    return Response.json({ error: "token_required" }, { status: 400 });
  }

  const config = attentionEnv();
  const verified = await verifyAttentionMagicLink(token, config.magicLinkSecret, { attentionId }) as VerifyOk | VerifyErr;
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: 401 });
  }

  const result = await dispatchAttentionWake({
    attentionId,
    reason: "live_session",
    source: "attention_page",
    wakeUrl: config.wakeUrl,
    wakeInstructions: config.wakeInstructions,
    notifySecret: config.notifySecret,
    logger: console,
  });

  if (!result.ok) {
    return Response.json({
      error: result.error,
      attentionId,
      status: "failed",
      message: result.message,
      instructions: result.instructions ?? null,
    }, { status: result.status ?? 502, headers: { "cache-control": "no-store" } });
  }

  return Response.json({
    ok: true,
    attentionId: result.attentionId,
    status: result.status,
    message: result.message,
    instructions: result.instructions,
  }, { headers: { "cache-control": "no-store" } });
}
