"use client";

import { useRef, useState } from "react";
import { canContinueApplying } from "../../../lib/attention-buyer-flow.mjs";
import type { AttentionQuestion } from "./AttentionAnswerFields";

export type AttentionView = {
  attentionId: string;
  company: string;
  role: string;
  questions: AttentionQuestion[];
  aiAssistanceDiscouraged: boolean;
  token: string;
};
export type AttentionAction = "resume" | "skip" | "abort";
export type AnswerEntry = { text: string; source: "typed" | "draft_approved" | "bank" };

/** Operational signals stay behind auth; design transitions are entirely local. */
export function useAttentionActions(view: AttentionView, designFixture: boolean) {
  const [answers, setAnswers] = useState<Record<string, AnswerEntry>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);

  function setAnswer(id: string, text: string, source: AnswerEntry["source"]) {
    setAnswers((previous) => ({ ...previous, [id]: { text, source } }));
    setError(null);
  }

  async function send(action: AttentionAction) {
    if (sending.current || (action === "resume" && !canContinueApplying(view.questions, answers))) return false;
    if (designFixture) return true;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/attention/${encodeURIComponent(view.attentionId)}/signal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: view.token,
          action,
          answers: action === "resume" ? Object.entries(answers)
            .filter(([, entry]) => entry.text.trim())
            .map(([questionId, entry]) => ({ questionId, text: entry.text.trim(), source: entry.source })) : [],
        }),
      });
      const body = await response.json() as { ok?: boolean; signal?: string };
      const expected = { resume: "resume_requested", skip: "skipped", abort: "aborted" }[action];
      if (!response.ok || !body.ok || body.signal !== expected) throw new Error("not_saved");
      return true;
    } catch {
      // Keep the answer and gate intact; never present a failed save as progress.
      setError("Your choice hasn’t been saved yet. Your answer is still here.");
      return false;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return { answers, busy, error, setAnswer, send };
}
