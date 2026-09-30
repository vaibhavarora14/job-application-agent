/** Public, synthetic review data only. No credentials or operational actions. */
export const ATTENTION_DESIGN_FIXTURE_ID = "design";
export const ATTENTION_DESIGN_STEPS = Object.freeze(["preflight", "choose", "queue", "judgment", "done", "admin"]);
const ALIASES = Object.freeze({
  questions: "judgment",
  "live-required": "queue",
  unavailable: "queue",
  retry: "queue",
  "resume-requested": "queue",
});
export const ATTENTION_DESIGN_FIXTURE_KEYS = Object.freeze([...ATTENTION_DESIGN_STEPS, ...Object.keys(ALIASES)]);
const FIXTURE_SET = new Set(ATTENTION_DESIGN_FIXTURE_KEYS);

export const DESIGN_JOBS = Object.freeze([
  { id: "acme", role: "Forward Deployed Engineer", company: "Acme Robotics", detail: "Customer deployments" },
  { id: "northstar", role: "Solutions Engineer", company: "Northstar Systems", detail: "Platform onboarding" },
  { id: "fieldkit", role: "Deployment Strategist", company: "FieldKit AI", detail: "Enterprise rollout" },
  { id: "gridline", role: "Implementation Lead", company: "Gridline Health", detail: "Client launch" },
]);

export function parseAttentionDesignKey(searchParams) {
  const raw = searchParams?.design;
  const design = Array.isArray(raw) ? raw[0] : raw;
  if (typeof design !== "string") return null;
  const key = design.trim().toLowerCase();
  return FIXTURE_SET.has(key) ? key : null;
}

/** A design key can never turn a real attention URL into an unauthenticated preview. */
export function resolveAttentionDesignFixture(searchParams, attentionId = ATTENTION_DESIGN_FIXTURE_ID) {
  if (attentionId !== ATTENTION_DESIGN_FIXTURE_ID) return null;
  const key = parseAttentionDesignKey(searchParams);
  return key ? buildAttentionDesignFixture(key) : null;
}

export function buildAttentionDesignFixture(key) {
  if (!FIXTURE_SET.has(key)) return null;
  return {
    key,
    step: ALIASES[key] ?? key,
    view: {
      attentionId: ATTENTION_DESIGN_FIXTURE_ID,
      company: "Acme Robotics",
      role: "Forward Deployed Engineer",
      token: "",
      aiAssistanceDiscouraged: false,
      questions: [{
        id: "why-us",
        prompt: "Why do you want to join Acme Robotics, and what would you bring to a customer-facing deployment role?",
        kind: "why-us",
        required: true,
      }],
    },
  };
}
