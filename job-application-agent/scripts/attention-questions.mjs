/**
 * Pause-time attention question packaging + AI-policy detection (skill/runner).
 * Mirrors site/lib/attention-questions.mjs for the published skill package.
 */

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

const KINDS = new Set(["judgment", "why-us", "proud-project", "narrative", "other"]);

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
    out.push({
      id,
      prompt,
      kind: KINDS.has(kindRaw) ? kindRaw : "judgment",
      required: item.required !== false,
    });
  }
  return out;
}

/**
 * Extract narrative prompts from posting / form copy when the agent did not pass questions[].
 * Best-effort packaging for judgment pauses.
 * @param {string} pageText
 * @param {{ limit?: number }} [options]
 */
export function extractNarrativeQuestionsFromText(pageText, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 6)) : 4;
  const text = String(pageText ?? "");
  if (!text.trim()) return [];
  const patterns = [
    /why (?:do )?you (?:want to )?work(?: at| for| with)?[^\n?]{0,80}\?/gi,
    /why (?:are you interested|this (?:role|company|team))[^\n?]{0,80}\?/gi,
    /(?:tell us about|describe) (?:a )?project you(?:'re| are)? proud of[^\n?]{0,40}\?/gi,
    /what (?:motivates|excites) you[^\n?]{0,60}\?/gi,
    /in your own words[^\n?]{0,80}\?/gi,
  ];
  const found = [];
  const seen = new Set();
  for (const re of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) && found.length < limit) {
      const prompt = match[0].replace(/\s+/g, " ").trim();
      const id = fingerprintPrompt(prompt);
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({
        id,
        prompt,
        kind: /proud|project/i.test(prompt) ? "proud-project" : /why/i.test(prompt) ? "why-us" : "judgment",
        required: true,
      });
    }
  }
  return found;
}
