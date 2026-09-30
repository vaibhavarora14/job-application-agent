import { needsLiveBrowser, normalizeAttentionQuestions } from "./attention-questions.mjs";

/** Locked buyer language; technical blockers never choose a buyer troubleshooting state. */
export const BUYER_FLOW_COPY = Object.freeze({
  preflight: {
    eyebrow: "Preflight", title: "Ready to apply", pill: "Resume ready · Profile ready",
    prompt: "Before the queue starts, your resume and profile are already set. Confirm once, then we begin applying.",
    primary: "Start applying",
  },
  choose: {
    eyebrow: "Choose", title: "Choose your targets", pill: "3 selected",
    prompt: "Pick the roles you want in this apply queue. We’ll keep the flow calm and only pause for judgment.",
    primary: "Apply to 3 jobs",
  },
  queue: {
    eyebrow: "Queue", title: "Your apply queue", pill: "In progress",
    prompt: "We’re applying to the jobs in your queue. You’ll only hear from us if a question needs your answer.",
    primary: "View queue",
  },
  judgment: {
    eyebrow: "", title: "", pill: "Needs your answer",
    prompt: "One question from the employer needs your input before we continue applying.",
    primary: "Continue applying",
  },
  done: {
    eyebrow: "", title: "", pill: "Applied",
    prompt: "This application is confirmed on the employer site.",
    primary: "Back to search",
  },
});

export function chooseActionLabel(count) {
  return count > 0 ? `Apply to ${count} ${count === 1 ? "job" : "jobs"}` : "Select at least 1 job";
}

export function buyerAttentionStep(view) {
  return normalizeAttentionQuestions(view?.questions).length ? "judgment" : "queue";
}

export function needsAdminAttention(view) {
  return buyerAttentionStep(view) === "queue"
    || needsLiveBrowser(view?.requiredActions)
    || Boolean(view?.blocker && !["judgment", "demographic", "ambiguous-authorization", "ambiguous-compensation", "unverifiable-claim"].includes(view.blocker));
}

/** Used at both the button and authenticated signal boundary. */
export function canContinueApplying(questions, answers) {
  return questions.length > 0
    && questions.some((q) => String(answers[q.id]?.text ?? "").trim())
    && questions.filter((q) => q.required).every((q) => String(answers[q.id]?.text ?? "").trim());
}
