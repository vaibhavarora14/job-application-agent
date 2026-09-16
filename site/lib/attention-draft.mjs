/**
 * Humanizer-style judgment drafts for attention UI.
 *
 * Drafts are private scratch until the candidate Approves.
 * Never invent employers, metrics, or stack claims.
 * When no LLM key is configured, return draft_unconfigured (typed path still works).
 */

const HUMANIZER_SYSTEM = `You draft short first-person job-application answers for a candidate to edit.

Rules:
- First person ("I"), short paragraphs, natural voice.
- No em-dash soup (avoid — and long dashed asides). Prefer periods or commas.
- Do not invent employers, job titles, metrics, customers, stack, or awards.
- Only use facts explicitly provided in the candidate context. If a fact is missing, leave a clear [bracketed placeholder] instead of guessing.
- Prefer roughly 80–140 words unless the question asks for shorter.
- No bullet lists unless the question asks for a list.
- Output only the draft answer text — no preamble.`;

/**
 * @param {object} config
 */
export function resolveDraftConfig(config = {}) {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const apiKey = String(config.apiKey ?? env.ATTENTION_DRAFT_API_KEY ?? "").trim();
  const baseUrl = String(
    config.baseUrl
      ?? env.ATTENTION_DRAFT_BASE_URL
      ?? env.FREE_AI_BASE_URL
      ?? "https://api.openai.com/v1",
  ).trim().replace(/\/+$/, "");
  const model = String(
    config.model
      ?? env.ATTENTION_DRAFT_MODEL
      ?? "gpt-4o-mini",
  ).trim() || "gpt-4o-mini";
  return {
    configured: Boolean(apiKey),
    apiKey,
    baseUrl,
    model,
  };
}

/**
 * Local heuristic draft when LLM is unconfigured — still editable, never silent-pasted.
 * @param {{ prompt: string, company?: string, role?: string, candidateNotes?: string }} input
 */
export function buildHeuristicDraft(input) {
  const prompt = String(input?.prompt ?? "").trim();
  const company = String(input?.company ?? "").trim() || "this team";
  const role = String(input?.role ?? "").trim() || "this role";
  const notes = String(input?.candidateNotes ?? "").trim();
  const noteLine = notes
    ? notes.slice(0, 400)
    : "[Add one concrete, resume-backed example here.]";

  if (/proud|project|built|shipped/i.test(prompt)) {
    return [
      `A project I'm proud of is ${noteLine}`,
      `I owned the problem end to end, stayed close to users, and measured success by whether the change actually shipped and held up.`,
      `I'd bring that same bias toward clear ownership and honest iteration to ${company}.`,
    ].join(" ");
  }

  if (/why|motivat|interest|join/i.test(prompt)) {
    return [
      `I'm interested in ${role} at ${company} because the work matches how I like to operate: close to the product, grounded in real constraints, and focused on outcomes.`,
      noteLine,
      `I write in my own voice and only claim work I can back with evidence.`,
    ].join(" ");
  }

  return [
    `For this question, my honest answer starts from verified experience: ${noteLine}`,
    `I'm applying to ${role} at ${company} and want the response to stay specific, first-person, and free of invented claims.`,
  ].join(" ");
}

/**
 * Soft cleanup so drafts stay Quiet Trust / humanizer-shaped.
 * @param {string} text
 */
export function humanizeDraftText(text) {
  return String(text ?? "")
    .replace(/\u2014/g, ". ")
    .replace(/\s*—\s*/g, ". ")
    .replace(/\s{2,}/g, " ")
    .replace(/\.\s*\./g, ".")
    .trim()
    .slice(0, 5000);
}

/**
 * @param {{
 *   prompt: string,
 *   company?: string,
 *   role?: string,
 *   candidateNotes?: string,
 *   aiAssistanceDiscouraged?: boolean,
 * }} input
 * @param {{
 *   apiKey?: string,
 *   baseUrl?: string,
 *   model?: string,
 *   fetchImpl?: typeof fetch,
 * }} [config]
 */
export async function draftAttentionAnswer(input, config = {}) {
  const prompt = String(input?.prompt ?? "").trim();
  if (!prompt) return { ok: false, error: "prompt_required", status: 400 };
  if (input?.aiAssistanceDiscouraged) {
    return { ok: false, error: "ai_assistance_discouraged", status: 403 };
  }

  const resolved = resolveDraftConfig(config);
  if (!resolved.configured) {
    return {
      ok: false,
      error: "draft_unconfigured",
      status: 503,
      message: "Draft assist is not configured. Type your answer, or set ATTENTION_DRAFT_API_KEY on the Worker.",
      heuristic: humanizeDraftText(buildHeuristicDraft(input)),
    };
  }

  const userContent = [
    `Company: ${String(input.company ?? "").trim() || "(unknown)"}`,
    `Role: ${String(input.role ?? "").trim() || "(unknown)"}`,
    `Question: ${prompt}`,
    `Candidate notes / verified facts only: ${String(input.candidateNotes ?? "").trim() || "(none provided — use placeholders, do not invent)"}`,
  ].join("\n");

  const fetchImpl = config.fetchImpl ?? fetch;
  let response;
  try {
    response = await fetchImpl(`${resolved.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolved.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: resolved.model,
        temperature: 0.4,
        max_tokens: 450,
        messages: [
          { role: "system", content: HUMANIZER_SYSTEM },
          { role: "user", content: userContent },
        ],
      }),
    });
  } catch {
    return { ok: false, error: "draft_upstream_failed", status: 503 };
  }

  if (!response.ok) {
    return { ok: false, error: "draft_upstream_failed", status: 503 };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "draft_upstream_failed", status: 503 };
  }

  const text = humanizeDraftText(body?.choices?.[0]?.message?.content ?? "");
  if (!text) return { ok: false, error: "draft_empty", status: 503 };

  return {
    ok: true,
    draft: text,
    model: resolved.model,
    note: "Private scratch until you Approve. Never silent-pasted into the ATS.",
  };
}
