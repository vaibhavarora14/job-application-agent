/**
 * Map approved attention answers → ATS narrative fields (Ashby-first).
 *
 * Pure helpers for the resume→submit loop. Browser automation stays outside —
 * the runner receives fill instructions and injects into matching textareas.
 */

import { fingerprintPrompt } from "../attention-questions.mjs";

export { fingerprintPrompt };

/**
 * @typedef {{
 *   id?: string,
 *   label?: string,
 *   name?: string,
 *   placeholder?: string,
 *   selector?: string,
 *   required?: boolean,
 *   value?: string,
 * }} NarrativeField
 */

/**
 * @typedef {{
 *   questionId: string,
 *   text: string,
 *   source?: string,
 *   prompt?: string,
 * }} ApprovedAnswer
 */

const ASHBY_NARRATIVE_SELECTORS = Object.freeze([
  'textarea[name*="question" i]',
  'textarea[id*="question" i]',
  'textarea[aria-label]',
  "textarea",
]);

/**
 * @param {string} value
 */
export function normalizeFieldLabel(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Token Jaccard similarity in [0, 1].
 * @param {string} left
 * @param {string} right
 */
export function labelSimilarity(left, right) {
  const a = new Set(normalizeFieldLabel(left).split(" ").filter((t) => t.length > 2));
  const b = new Set(normalizeFieldLabel(right).split(" ").filter((t) => t.length > 2));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

/**
 * Prefer exact questionId → field.id, then best prompt/label similarity.
 *
 * @param {ApprovedAnswer[]} answers
 * @param {NarrativeField[]} fields
 * @param {{ minScore?: number }} [options]
 */
export function mapAnswersToFields(answers, fields, options = {}) {
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.25;
  const remaining = [...(Array.isArray(fields) ? fields : [])];
  const mappings = [];
  const unmatchedAnswers = [];

  for (const answer of Array.isArray(answers) ? answers : []) {
    const text = String(answer?.text ?? "").trim();
    const questionId = String(answer?.questionId ?? "").trim();
    if (!text || !questionId) continue;

    let bestIndex = -1;
    let bestScore = 0;
    let matchedBy = "none";

    for (let i = 0; i < remaining.length; i += 1) {
      const field = remaining[i];
      const fieldId = String(field.id ?? "").trim();
      if (fieldId && fieldId === questionId) {
        bestIndex = i;
        bestScore = 1;
        matchedBy = "question_id";
        break;
      }
      const label = String(field.label ?? field.name ?? field.placeholder ?? "").trim();
      const prompt = String(answer.prompt ?? "").trim();
      const score = Math.max(
        labelSimilarity(prompt, label),
        labelSimilarity(questionId, label),
        labelSimilarity(prompt, fieldId),
      );
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
        matchedBy = "label_similarity";
      }
    }

    if (bestIndex < 0 || bestScore < minScore) {
      unmatchedAnswers.push(answer);
      continue;
    }

    const [field] = remaining.splice(bestIndex, 1);
    const label = String(field.label ?? field.name ?? field.placeholder ?? field.id ?? "").trim();
    mappings.push({
      questionId,
      fieldId: field.id ? String(field.id) : null,
      selector: field.selector ? String(field.selector) : null,
      label,
      text,
      source: String(answer.source ?? "typed"),
      score: bestScore,
      matchedBy,
    });
  }

  return {
    mappings,
    unmatchedAnswers,
    unmatchedFields: remaining,
  };
}

/**
 * Build Playwright/CDP-oriented inject plan for Ashby (and generic) textareas.
 *
 * @param {{
 *   answers?: ApprovedAnswer[],
 *   questions?: { id: string, prompt: string }[],
 *   fields?: NarrativeField[],
 *   pageUrl?: string,
 * }} input
 */
export function buildAnswerInjectPlan(input = {}) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers = (Array.isArray(input.answers) ? input.answers : []).map((answer) => {
    const question = questions.find((item) => item.id === answer.questionId);
    return {
      ...answer,
      prompt: answer.prompt ?? question?.prompt ?? "",
    };
  });

  const fields = Array.isArray(input.fields) && input.fields.length
    ? input.fields
    : answers.map((answer, index) => ({
      id: answer.questionId,
      label: answer.prompt || answer.questionId,
      selector: `textarea >> nth=${index}`,
      required: true,
    }));

  const mapped = mapAnswersToFields(answers, fields);
  return {
    adapterHint: /ashbyhq\.com/i.test(String(input.pageUrl ?? "")) ? "ashby" : "generic",
    textareaSelectors: [...ASHBY_NARRATIVE_SELECTORS],
    fills: mapped.mappings.map((item) => ({
      questionId: item.questionId,
      selector: item.selector,
      label: item.label,
      text: item.text,
      source: item.source,
      matchedBy: item.matchedBy,
      score: item.score,
      action: "fill_textarea",
    })),
    unmatchedAnswers: mapped.unmatchedAnswers,
    unmatchedFields: mapped.unmatchedFields,
    notes: [
      "Inject approved answers into matching textareas on the BOUND filled tab only.",
      "Never silent-paste model drafts — only typed / draft_approved / bank answers from the resume signal.",
      "After fill, re-inspect; if required narrative remains empty → attention again.",
      "Then continue existing resume→submit adapters.",
    ],
  };
}

/**
 * @param {{ answers?: ApprovedAnswer[], blockers?: string[] }} input
 */
export function shouldInjectAnswersBeforeSubmit(input = {}) {
  const answers = Array.isArray(input.answers)
    ? input.answers.filter((a) => String(a?.text ?? "").trim())
    : [];
  if (!answers.length) return { inject: false, reason: "no_answers" };
  return {
    inject: true,
    reason: "approved_answers_present",
    answerCount: answers.length,
  };
}
