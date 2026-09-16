import { readJsonRequest } from "../../../../lib/public-boundary.mjs";
import { authorizedAttentionInternal, attentionEnv } from "../../../../lib/attention-auth";
import {
  dispatchAttentionWake,
  validateAttentionWakeRequest,
} from "../../../../lib/attention-wake.mjs";

type WakeOk = {
  ok: true;
  data: { attentionId: string; reason: string; source: string };
};
type WakeErr = { ok: false; error: string; status: number };

/**
 * POST /api/internal/attention-wake
 * Bearer ATTENTION_NOTIFY_SECRET.
 *
 * Records a wake request and optionally POSTs ATTENTION_WAKE_URL so Personal/ops
 * can wire `gcloud compute instances start` without GCP creds in the Worker.
 */
export async function POST(request: Request) {
  if (!await authorizedAttentionInternal(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await readJsonRequest(request, 4_096);
  if (!body.ok) {
    return Response.json({ error: "invalid_body" }, { status: body.status ?? 400 });
  }

  const validated = validateAttentionWakeRequest(body.data) as WakeOk | WakeErr;
  if (!validated.ok) {
    return Response.json({ error: validated.error }, { status: validated.status });
  }

  const config = attentionEnv();
  const result = await dispatchAttentionWake({
    attentionId: validated.data.attentionId,
    reason: validated.data.reason,
    source: validated.data.source,
    wakeUrl: config.wakeUrl,
    wakeInstructions: config.wakeInstructions,
    notifySecret: config.notifySecret,
    logger: console,
  });

  if (!result.ok) {
    return Response.json({
      error: result.error,
      attentionId: result.attentionId ?? validated.data.attentionId,
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
    payload: result.payload,
  }, { headers: { "cache-control": "no-store" } });
}
