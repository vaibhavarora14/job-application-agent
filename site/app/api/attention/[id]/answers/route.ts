import { attentionEnv } from "../../../../../lib/attention-auth";
import { listAnswerBank } from "../../../../../lib/attention-answer-bank";
import { suggestPriorAnswers } from "../../../../../lib/attention-questions.mjs";
import { verifyAttentionMagicLink } from "../../../../../lib/attention-magic-link.mjs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/attention/:id/answers?token=…&prompt=…
 * Magic-link authenticated prior-answer suggestions from the site D1 bank.
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const attentionId = decodeURIComponent(id ?? "").trim();
  if (!attentionId || attentionId.length > 180) {
    return Response.json({ error: "attention_id_invalid" }, { status: 400 });
  }

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") ?? "").trim();
  if (!token) return Response.json({ error: "token_required" }, { status: 400 });

  const config = attentionEnv();
  const verified = await verifyAttentionMagicLink(token, config.magicLinkSecret, { attentionId });
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: 401 });
  }

  const prompt = String(url.searchParams.get("prompt") ?? "").trim();
  const bank = await listAnswerBank(40);
  const suggestions = prompt
    ? suggestPriorAnswers(prompt, bank, { limit: 3 })
    : bank.slice(0, 5).map((entry) => ({
      fingerprint: entry.fingerprint,
      prompt: entry.prompt,
      text: entry.text,
      score: 0,
    }));

  return Response.json({
    ok: true,
    suggestions,
  }, { headers: { "cache-control": "no-store" } });
}
