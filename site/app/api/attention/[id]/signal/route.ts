import { attentionEnv } from "../../../../../lib/attention-auth";
import { upsertAnswerBankEntries } from "../../../../../lib/attention-answer-bank";
import { verifyAttentionMagicLink } from "../../../../../lib/attention-magic-link.mjs";
import { readJsonRequest } from "../../../../../lib/public-boundary.mjs";
import { upsertAttentionSignal } from "../../../../../lib/attention-signal-store";
import {
  buildAttentionSignalRecord,
  validateAttentionSignalRequest,
} from "../../../../../lib/attention-signals.mjs";

type Params = { params: Promise<{ id: string }> };
type SignalOk = {
  ok: true;
  data: {
    token: string;
    signal: string;
    action: string;
    answers: { questionId: string; text: string; source: string }[];
  };
};
type SignalErr = { ok: false; error: string; status: number };

/**
 * POST /api/attention/:id/signal
 * Magic-link authenticated resume / skip / abort.
 * Optional answers[] persist to signal payload + answer bank (judgment text only).
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const attentionId = decodeURIComponent(id ?? "").trim();
  if (!attentionId || attentionId.length > 180) {
    return Response.json({ error: "attention_id_invalid" }, { status: 400 });
  }

  // Answers can be multi-KB; keep well under Worker limits but above resume-only.
  const body = await readJsonRequest(request, 48_000);
  if (!body.ok) {
    return Response.json({ error: "invalid_body" }, { status: body.status ?? 400 });
  }

  const validated = validateAttentionSignalRequest(body.data) as SignalOk | SignalErr;
  if (!validated.ok) {
    return Response.json({ error: validated.error }, { status: validated.status });
  }

  const config = attentionEnv();
  const verified = await verifyAttentionMagicLink(validated.data.token, config.magicLinkSecret, {
    attentionId,
  });
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: 401 });
  }

  const record = buildAttentionSignalRecord(attentionId, validated.data.signal, {
    answers: validated.data.answers,
  });
  const stored = await upsertAttentionSignal({
    attentionId: record.attentionId,
    signal: record.signal,
    actor: record.actor,
    payload: record.payload,
  });

  if (validated.data.signal === "resume_requested" && validated.data.answers.length) {
    const questionById = new Map(
      (verified.payload.questions ?? []).map((question) => [question.id, question]),
    );
    await upsertAnswerBankEntries(
      validated.data.answers.map((answer) => ({
        fingerprint: answer.questionId,
        prompt: questionById.get(answer.questionId)?.prompt ?? answer.questionId,
        text: answer.text,
        tags: [
          verified.payload.company,
          verified.payload.role,
          questionById.get(answer.questionId)?.kind,
        ].filter(Boolean) as string[],
        source: answer.source,
      })),
    );
  }

  return Response.json({
    ok: true,
    attentionId: stored.attentionId,
    signal: stored.signal,
    updatedAt: stored.updatedAt,
    answersStored: validated.data.answers.length,
    note: stored.signal === "resume_requested"
      ? "Resume requested. Approved answers will be injected on the bound tab before submit. filled ≠ applied until the runner confirms visible ATS success."
      : stored.signal === "skipped"
        ? "Skip recorded. Runner should resolve attention without submit and continue the round."
        : "Abort recorded. Runner should release the lease and end the round.",
  }, { headers: { "cache-control": "no-store" } });
}
