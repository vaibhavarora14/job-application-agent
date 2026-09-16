"use client";

import { useEffect, useMemo, useState } from "react";

export type AttentionQuestion = {
  id: string;
  prompt: string;
  kind: string;
  required: boolean;
};

type DraftState = {
  status: "idle" | "loading" | "ready" | "error";
  text: string;
  message: string | null;
};

type PriorSuggestion = {
  fingerprint: string;
  prompt: string;
  text: string;
  score?: number;
};

type Props = {
  attentionId: string;
  token: string;
  questions: AttentionQuestion[];
  aiAssistanceDiscouraged: boolean;
  answers: Record<string, { text: string; source: "typed" | "draft_approved" | "bank" }>;
  onChange: (questionId: string, text: string, source: "typed" | "draft_approved" | "bank") => void;
};

export function AttentionAnswerFields({
  attentionId,
  token,
  questions,
  aiAssistanceDiscouraged,
  answers,
  onChange,
}: Props) {
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [priors, setPriors] = useState<Record<string, PriorSuggestion[]>>({});
  const [priorOpen, setPriorOpen] = useState<string | null>(null);

  const questionIds = useMemo(() => questions.map((q) => q.id).join("|"), [questions]);

  useEffect(() => {
    // Prefetch prior suggestions once per question set.
    let cancelled = false;
    async function load() {
      for (const question of questions) {
        try {
          const url = new URL(
            `/api/attention/${encodeURIComponent(attentionId)}/answers`,
            window.location.origin,
          );
          url.searchParams.set("token", token);
          url.searchParams.set("prompt", question.prompt);
          const response = await fetch(url.toString());
          if (!response.ok) continue;
          const body = await response.json() as { suggestions?: PriorSuggestion[] };
          if (cancelled) return;
          setPriors((prev) => ({
            ...prev,
            [question.id]: Array.isArray(body.suggestions) ? body.suggestions : [],
          }));
        } catch {
          /* ignore — typed path still works */
        }
      }
    }
    if (questions.length) void load();
    return () => {
      cancelled = true;
    };
  }, [attentionId, token, questionIds, questions]);

  async function requestDraft(question: AttentionQuestion) {
    if (aiAssistanceDiscouraged) return;
    setDrafts((prev) => ({
      ...prev,
      [question.id]: { status: "loading", text: "", message: null },
    }));
    try {
      const response = await fetch(`/api/attention/${encodeURIComponent(attentionId)}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          questionId: question.id,
          prompt: question.prompt,
        }),
      });
      const body = await response.json() as {
        draft?: string;
        heuristic?: string;
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        const heuristic = typeof body.heuristic === "string" ? body.heuristic : "";
        setDrafts((prev) => ({
          ...prev,
          [question.id]: {
            status: heuristic ? "ready" : "error",
            text: heuristic,
            message: body.message
              ?? (body.error === "draft_unconfigured"
                ? "Draft assist is not configured — type your answer, or use the heuristic starter below."
                : (body.error ?? "Draft failed.")),
          },
        }));
        return;
      }
      setDrafts((prev) => ({
        ...prev,
        [question.id]: {
          status: "ready",
          text: String(body.draft ?? ""),
          message: "Private scratch — edit, then Approve to use on resume.",
        },
      }));
    } catch {
      setDrafts((prev) => ({
        ...prev,
        [question.id]: { status: "error", text: "", message: "Network error while drafting." },
      }));
    }
  }

  function approveDraft(questionId: string) {
    const draft = drafts[questionId];
    if (!draft?.text.trim()) return;
    onChange(questionId, draft.text.trim(), "draft_approved");
    setDrafts((prev) => ({
      ...prev,
      [questionId]: { status: "idle", text: "", message: "Draft approved into the answer field." },
    }));
  }

  function discardDraft(questionId: string) {
    setDrafts((prev) => ({
      ...prev,
      [questionId]: { status: "idle", text: "", message: null },
    }));
  }

  if (!questions.length) return null;

  return (
    <div className="attention-answers">
      <p className="attention-answers-lead">
        {aiAssistanceDiscouraged
          ? "This posting asks for your own voice. Answer below — draft assist is off."
          : "Answer judgment questions here. Optional Draft is private until you Approve."}
      </p>
      {questions.map((question, index) => {
        const value = answers[question.id]?.text ?? "";
        const draft = drafts[question.id];
        const suggestions = priors[question.id] ?? [];
        return (
          <div key={question.id} className="attention-answer-card">
            <label className="attention-answer-label" htmlFor={`attention-q-${question.id}`}>
              <span className="attention-answer-index">{index + 1}.</span>{" "}
              {question.prompt}
              {question.required ? <span className="attention-answer-required"> *</span> : null}
            </label>
            <textarea
              id={`attention-q-${question.id}`}
              className="attention-answer-textarea"
              rows={5}
              value={value}
              placeholder="Write in your own voice…"
              onChange={(event) => onChange(question.id, event.target.value, "typed")}
            />
            <div className="attention-answer-tools">
              {aiAssistanceDiscouraged ? (
                <span className="attention-answer-hint">Answer in your own voice</span>
              ) : (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={draft?.status === "loading"}
                  onClick={() => requestDraft(question)}
                >
                  {draft?.status === "loading" ? "Drafting…" : "Draft"}
                </button>
              )}
              <button
                type="button"
                className="button button-secondary"
                disabled={!suggestions.length}
                onClick={() => setPriorOpen((id) => (id === question.id ? null : question.id))}
              >
                Use prior answer{suggestions.length ? ` (${suggestions.length})` : ""}
              </button>
            </div>
            {priorOpen === question.id && suggestions.length ? (
              <ul className="attention-prior-list">
                {suggestions.map((item) => (
                  <li key={item.fingerprint}>
                    <button
                      type="button"
                      className="attention-prior-item"
                      onClick={() => {
                        onChange(question.id, item.text, "bank");
                        setPriorOpen(null);
                      }}
                    >
                      <span className="attention-prior-prompt">{item.prompt || "Prior answer"}</span>
                      <span className="attention-prior-text">{item.text.slice(0, 180)}{item.text.length > 180 ? "…" : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {draft?.message ? <p className="attention-answer-hint" role="status">{draft.message}</p> : null}
            {draft?.status === "ready" && draft.text ? (
              <div className="attention-draft-box">
                <textarea
                  className="attention-answer-textarea"
                  rows={5}
                  value={draft.text}
                  onChange={(event) => setDrafts((prev) => ({
                    ...prev,
                    [question.id]: { ...draft, text: event.target.value },
                  }))}
                />
                <div className="attention-answer-tools">
                  <button type="button" className="button" onClick={() => approveDraft(question.id)}>
                    Approve
                  </button>
                  <button type="button" className="button button-secondary" onClick={() => discardDraft(question.id)}>
                    Discard
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
