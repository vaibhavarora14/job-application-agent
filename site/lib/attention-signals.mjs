/**
 * Attention resume / skip / abort signal validation and runner poll contract.
 *
 * Site D1 stores coordination signals only — not the application ledger.
 * State-worker attention stream remains source of truth for opened/resolved items.
 *
 * After attention opens, the GCP hosted runner should:
 *   node scripts/attention-runner-poll.mjs --attention-id …
 * (or poll GET /api/internal/attention-signals/:id with Bearer ATTENTION_NOTIFY_SECRET).
 * On resume_requested: renew lease → load session binding (same tab / :99 / 5900) →
 * inject approved answers (P1.5) → re-inspect → submit if possible → visible confirm → intent/ledger.
 * Helper: node scripts/attention-resume-submit.mjs --attention-id … --checklist
 * Never treat UI "resume" as ledger success. Live noVNC must target VNC 5900, never 5901.
 */

import { normalizeAttentionAnswers } from "./attention-questions.mjs";

export const ATTENTION_SIGNAL_ACTIONS = Object.freeze({
  resume_requested: "resume_requested",
  skipped: "skipped",
  aborted: "aborted",
});

/**
 * @param {unknown} input
 */
export function validateAttentionSignalRequest(input) {
  const value = input && typeof input === "object" ? input : null;
  if (!value) return { ok: false, error: "invalid_body", status: 400 };

  const token = typeof value.token === "string" ? value.token.trim() : "";
  const actionRaw = typeof value.action === "string" ? value.action.trim().toLowerCase() : "";
  const actionMap = {
    resume: ATTENTION_SIGNAL_ACTIONS.resume_requested,
    resume_requested: ATTENTION_SIGNAL_ACTIONS.resume_requested,
    "i-finished": ATTENTION_SIGNAL_ACTIONS.resume_requested,
    skip: ATTENTION_SIGNAL_ACTIONS.skipped,
    skip_role: ATTENTION_SIGNAL_ACTIONS.skipped,
    abort: ATTENTION_SIGNAL_ACTIONS.aborted,
    abort_run: ATTENTION_SIGNAL_ACTIONS.aborted,
  };
  const signal = actionMap[actionRaw];
  if (!token) return { ok: false, error: "token_required", status: 400 };
  if (!signal) return { ok: false, error: "action_invalid", status: 400 };

  const answers = normalizeAttentionAnswers(value.answers);
  if (Object.prototype.hasOwnProperty.call(value, "answers") && !Array.isArray(value.answers)) {
    return { ok: false, error: "answers_invalid", status: 400 };
  }

  return { ok: true, data: { token, signal, action: actionRaw, answers } };
}

/**
 * @param {string} attentionId
 * @param {string} signal
 * @param {{ actor?: string, answers?: { questionId: string, text: string, source: string }[] }} [meta]
 */
export function buildAttentionSignalRecord(attentionId, signal, meta = {}) {
  const id = typeof attentionId === "string" ? attentionId.trim() : "";
  if (!id) throw new Error("attentionId required");
  if (!Object.values(ATTENTION_SIGNAL_ACTIONS).includes(signal)) throw new Error("signal invalid");
  const now = new Date().toISOString();
  const answers = normalizeAttentionAnswers(meta.answers);
  return {
    attentionId: id,
    signal,
    actor: meta.actor ?? "candidate",
    payload: answers.length ? { answers } : {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Runner poll response shape (stable interface for GCP client stub).
 * @param {object | null} record
 */
export function formatRunnerSignalPoll(record) {
  if (!record) {
    return {
      attentionId: null,
      signal: null,
      pending: false,
      resumeRequested: false,
      skipped: false,
      aborted: false,
      answers: [],
      payload: {},
    };
  }
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
  const answers = normalizeAttentionAnswers(payload.answers ?? record.answers);
  return {
    attentionId: record.attentionId,
    signal: record.signal,
    pending: true,
    resumeRequested: record.signal === ATTENTION_SIGNAL_ACTIONS.resume_requested,
    skipped: record.signal === ATTENTION_SIGNAL_ACTIONS.skipped,
    aborted: record.signal === ATTENTION_SIGNAL_ACTIONS.aborted,
    updatedAt: record.updatedAt,
    answers,
    payload,
  };
}
