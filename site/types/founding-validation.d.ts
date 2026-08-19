declare module "*/founding-validation.mjs" {
  export function validateFoundingRegistration(input: unknown):
    | { ok: true; bot: boolean; data: { email: string; targetRole: string; targetLocation: string; source: string } }
    | { ok: false; errors: Record<string, string> };
  export function validatePaidIntent(input: unknown):
    | { ok: true; intent: "ready_to_pay" | "needs_trial" }
    | { ok: false; error: string };
}
