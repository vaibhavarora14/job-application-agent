import { authorizedAttentionInternal } from "../../../../../lib/attention-auth";
import { getAttentionSignal } from "../../../../../lib/attention-signal-store";
import { formatRunnerSignalPoll } from "../../../../../lib/attention-signals.mjs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/internal/attention-signals/:id
 * Runner poll stub. Bearer ATTENTION_NOTIFY_SECRET.
 *
 * TODO(runner): replace with push webhook once GCP poll client is ready.
 * Poll every ~5s while lease held; act on resume_requested | skipped | aborted.
 */
export async function GET(request: Request, { params }: Params) {
  if (!await authorizedAttentionInternal(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const attentionId = decodeURIComponent(id ?? "").trim();
  if (!attentionId || attentionId.length > 180) {
    return Response.json({ error: "attention_id_invalid" }, { status: 400 });
  }

  const record = await getAttentionSignal(attentionId);
  return Response.json(formatRunnerSignalPoll(record), {
    headers: { "cache-control": "no-store" },
  });
}
