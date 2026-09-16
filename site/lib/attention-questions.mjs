/**
 * P1.5 attention judgment questions + answer payload helpers.
 *
 * Questions (prompts) may travel in magic-link / notify payloads.
 * Answers are coordination + answer-bank data — never CAPTCHA/MFA/cookies.
 */

export const ATTENTION_ANSWER_SOURCES = Object.freeze([
  "typed",
  "draft_approved",
  "bank",
]);

export const JUDGMENT_QUESTION_KINDS = Object.freeze([
  "judgment",
  "why-us",
  "proud-project",
  "narrative",
  "other",
]);

/** Patterns that mean the posting discourages AI-written answers. */
export const AI_ASSISTANCE_DISCOURAGED_PATTERNS = Object.freeze([
  /\bdo(?:n'?t| not)\s+use\s+ai\b/i,
  /\bno\s+ai\s+assistance\b/i,
  /\bwithout\s+ai\s+assistance\b/i,
  /\bai[- ]generated\s+(?:answers?|content|responses?)\s+(?:are|is)\s+(?:not\s+)?(?:allowed|permitted|welcome)/i,
  /\bplease\s+(?:write|answer)\s+in\s+your\s+own\s+(?:words|voice)\b/i,
  /\b(?:write|answer)\s+in\s+your\s+own\s+(?:words|voice)\b/i,
  /\bgenerative\s+ai\s+(?:is|are)\s+(?:not\s+)?(?:allowed|permitted)/i,
  /\bchatgpt\b.*\b(?:not|never|don'?t)\b/i,
  /\b(?:not|never|don'?t)\b.*\bchatgpt\b/i,
]);

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function detectAiAssistanceDiscouraged(text) {
  const haystack = String(text ?? "");
  if (!haystack.trim()) return false;
  return AI_ASSISTANCE_DISCOURAGED_PATTERNS.some((re) => re.test(haystack));
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, prompt: string, kind: string, required: boolean }[]}
 */
export function normalizeAttentionQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const prompt = String(item.prompt ?? item.text ?? item.label ?? "").trim().slice(0, 800);
    if (!prompt) continue;
    let id = String(item.id ?? "").trim().slice(0, 120);
    if (!id) id = fingerprintPrompt(prompt);
    if (seen.has(id)) continue;
    seen.add(id);
    const kindRaw = String(item.kind ?? "judgment").trim().toLowerCase().slice(0, 40);
    const kind = JUDGMENT_QUESTION_KINDS.includes(kindRaw) ? kindRaw : "judgment";
    const required = item.required !== false;
    out.push({ id, prompt, kind, required });
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ questionId: string, text: string, source: string }[]}
 */
export function normalizeAttentionAnswers(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const questionId = String(item.questionId ?? item.id ?? "").trim().slice(0, 120);
    const text = String(item.text ?? "").trim().slice(0, 5000);
    if (!questionId || !text) continue;
    if (seen.has(questionId)) continue;
    seen.add(questionId);
    const sourceRaw = String(item.source ?? "typed").trim().toLowerCase();
    const source = ATTENTION_ANSWER_SOURCES.includes(sourceRaw) ? sourceRaw : "typed";
    out.push({ questionId, text, source });
  }
  return out;
}

/**
 * Stable fingerprint for answer-bank keys (prompt-shaped).
 * @param {string} prompt
 */
export function fingerprintPrompt(prompt) {
  const normalized = String(prompt ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `q-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Simple token overlap for prior-answer suggestions. Never auto-fills without showing text.
 * @param {string} prompt
 * @param {{ fingerprint?: string, prompt?: string, text?: string, tags?: string[] }[]} bank
 * @param {{ limit?: number }} [options]
 */
export function suggestPriorAnswers(prompt, bank, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 5)) : 3;
  const needle = tokenize(prompt);
  if (!needle.size || !Array.isArray(bank)) return [];
  const scored = [];
  for (const entry of bank) {
    const hay = tokenize(`${entry.prompt ?? ""} ${(entry.tags ?? []).join(" ")}`);
    if (!hay.size) continue;
    let overlap = 0;
    for (const token of needle) if (hay.has(token)) overlap += 1;
    const score = overlap / Math.max(needle.size, hay.size);
    if (score < 0.15) continue;
    const text = String(entry.text ?? "").trim();
    if (!text) continue;
    scored.push({
      fingerprint: entry.fingerprint ?? fingerprintPrompt(entry.prompt ?? ""),
      prompt: String(entry.prompt ?? ""),
      text,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Absolute actions that still need the live browser (unmirrorable).
 * @param {string[]} requiredActions
 */
export function needsLiveBrowser(requiredActions = []) {
  const live = new Set([
    "complete-captcha",
    "complete-mfa",
    "sign-in",
    "review-legal",
    "choose-demographic",
    "provide-government-id",
    "record-video",
    "enable-upload",
    "retry-site",
  ]);
  return (Array.isArray(requiredActions) ? requiredActions : [])
    .map((item) => String(item).trim().toLowerCase())
    .some((action) => live.has(action));
}

/**
 * Judgment-class actions that can be answered in the attention card.
 * @param {string[]} requiredActions
 */
export function hasJudgmentActions(requiredActions = []) {
  const judgment = new Set([
    "provide-judgment",
    "provide-authorization",
    "provide-compensation",
    "verify-claim",
  ]);
  return (Array.isArray(requiredActions) ? requiredActions : [])
    .map((item) => String(item).trim().toLowerCase())
    .some((action) => judgment.has(action));
}

function tokenize(value) {
  return new Set(
    String(value ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}
