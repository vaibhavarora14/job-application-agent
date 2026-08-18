const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function validateFoundingRegistration(input) {
  const email = text(input?.email, 254).toLowerCase();
  const targetRole = text(input?.targetRole, 120);
  const targetLocation = text(input?.targetLocation, 100);
  const source = text(input?.source, 100);
  const errors = {};
  if (!emailPattern.test(email)) errors.email = "Enter a valid email address.";
  if (!targetRole) errors.targetRole = "Tell us the role you want the agent to search for.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, bot: Boolean(text(input?.company, 80)), data: { email, targetRole, targetLocation, source } };
}

export function validatePaidIntent(value) {
  if (value === "ready_to_pay" || value === "needs_trial") return { ok: true, intent: value };
  return { ok: false, error: "Choose one of the available options." };
}
