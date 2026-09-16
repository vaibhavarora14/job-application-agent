import { attentionEnv } from "../../../../../lib/attention-auth";
import { draftAttentionAnswer } from "../../../../../lib/attention-draft.mjs";
import { verifyAttentionMagicLink } from "../../../../../lib/attention-magic-link.mjs";
import { readJsonRequest } from "../../../../../lib/public-boundary.mjs";

type Params = { params: Promise<{ id: string }> };
type VerifyOk = {
  ok: true;
  payload: {
    attentionId: string;
    company: string;
    role: string;
    questions: { id: string; prompt: string; kind: string; required: boolean }[];
    aiAssistanceDiscouraged: boolean;
  };
};
type VerifyErr = { ok: false; error: string };

/**
 * POST /api/attention/:id/draft
 * Magic-link authenticated humanizer draft for one judgment question.
 * Returns draft_unconfigured when ATTENTION_DRAFT_API_KEY is unset.
 * Never pastes into ATS — candidate must Approve in the UI first.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const attentionId = decodeURIComponent(id ?? "").trim();
  if (!attentionId || attentionId.length > 180) {
    return Response.json({ error: "attention_id_invalid" }, { status: 400 });
  }

  const body = await readJsonRequest(request, 12_000);
  if (!body.ok) {
    return Response.json({ error: "invalid_body" }, { status: body.status ?? 400 });
  }

  const token = typeof body.data?.token === "string" ? body.data.token.trim() : "";
  if (!token) return Response.json({ error: "token_required" }, { status: 400 });

  const config = attentionEnv();
  const verified = await verifyAttentionMagicLink(token, config.magicLinkSecret, { attentionId }) as VerifyOk | VerifyErr;
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: 401 });
  }
  const payload = verified.payload;
  if (!payload) {
    return Response.json({ error: "token_invalid" }, { status: 401 });
  }

  if (payload.aiAssistanceDiscouraged) {
    return Response.json({
      error: "ai_assistance_discouraged",
      message: "This posting asks for your own voice. Draft assist is disabled — answer in the textarea.",
    }, { status: 403 });
  }

  const questionId = typeof body.data?.questionId === "string" ? body.data.questionId.trim() : "";
  const promptFromBody = typeof body.data?.prompt === "string" ? body.data.prompt.trim() : "";
  const question = (payload.questions ?? []).find((item) => item.id === questionId);
  const prompt = promptFromBody || question?.prompt || "";
  if (!prompt) return Response.json({ error: "prompt_required" }, { status: 400 });

  const drafted = await draftAttentionAnswer({
    prompt,
    company: payload.company,
    role: payload.role,
    candidateNotes: typeof body.data?.candidateNotes === "string" ? body.data.candidateNotes : "",
    aiAssistanceDiscouraged: false,
  }, {
    apiKey: config.draftApiKey,
    baseUrl: config.draftBaseUrl || undefined,
    model: config.draftModel || undefined,
  });

  if (!drafted.ok) {
    return Response.json(drafted, { status: drafted.status ?? 503, headers: { "cache-control": "no-store" } });
  }

  return Response.json({
    ok: true,
    questionId: questionId || null,
    draft: drafted.draft,
    model: drafted.model,
    note: drafted.note,
  }, { headers: { "cache-control": "no-store" } });
}
