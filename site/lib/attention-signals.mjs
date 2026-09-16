/**
 * Attention resume / skip / abort signal validation and runner poll contract.
 *
 * Site D1 stores coordination signals only — not the application ledger.
 * State-worker attention stream remains source of truth for opened/resolved items.
 *
 * TODO(runner): GCP hosted runner should run
 * `node scripts/attention-runner-poll.mjs --attention-id …`
 * (or poll GET /api/internal/attention-signals/:id with Bearer ATTENTION_NOTIFY_SECRET)
 * after attention opens. On resume_requested: renew lease → re-inspect page →
 * submit only with visible confirm or re-open attention honestly.
 * Never treat UI "resume" as ledger success.
 */

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

  return { ok: true, data: { token, signal, action: actionRaw } };
}

/**
 * @param {string} attentionId
 * @param {string} signal
 * @param {{ actor?: string }} [meta]
 */
export function buildAttentionSignalRecord(attentionId, signal, meta = {}) {
  const id = typeof attentionId === "string" ? attentionId.trim() : "";
  if (!id) throw new Error("attentionId required");
  if (!Object.values(ATTENTION_SIGNAL_ACTIONS).includes(signal)) throw new Error("signal invalid");
  const now = new Date().toISOString();
  return {
    attentionId: id,
    signal,
    actor: meta.actor ?? "candidate",
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
      // TODO(runner): treat pending:false + null signal as "still waiting"
      resumeRequested: false,
      skipped: false,
      aborted: false,
    };
  }
  return {
    attentionId: record.attentionId,
    signal: record.signal,
    pending: true,
    resumeRequested: record.signal === ATTENTION_SIGNAL_ACTIONS.resume_requested,
    skipped: record.signal === ATTENTION_SIGNAL_ACTIONS.skipped,
    aborted: record.signal === ATTENTION_SIGNAL_ACTIONS.aborted,
    updatedAt: record.updatedAt,
  };
}
