const DAY_MS = 24 * 60 * 60 * 1000;

export function activationWindow(activatedAt, accessDays = 90) {
  const start = new Date(activatedAt);
  if (!Number.isFinite(start.getTime())) throw new Error("Activation time is invalid.");
  if (!Number.isInteger(accessDays) || accessDays < 1 || accessDays > 365) throw new Error("Access duration is invalid.");
  return {
    activatedAt: start.toISOString(),
    accessExpiresAt: new Date(start.getTime() + accessDays * DAY_MS).toISOString(),
  };
}

export function activationDeadline(paidAt) {
  const paid = new Date(paidAt);
  if (!Number.isFinite(paid.getTime())) throw new Error("Payment time is invalid.");
  return new Date(paid.getTime() + 60 * DAY_MS).toISOString();
}

export function isRefundDue(purchase, now = new Date()) {
  if (purchase?.status !== "succeeded" || purchase?.activatedAt || !purchase?.paidAt) return false;
  const paid = new Date(purchase.paidAt);
  return Number.isFinite(paid.getTime()) && paid.getTime() + 60 * DAY_MS <= now.getTime();
}
