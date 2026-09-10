const DEFAULT_ALLOWLIST = ['greenhouse'];

export function routineChannels(env = process.env) {
  const raw = env.CLOUD_ROUTINE_CHANNELS || '';
  return new Set(raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function submitAllowlist(env = process.env) {
  const raw = env.CLOUD_SUBMIT_ALLOWLIST || DEFAULT_ALLOWLIST.join(',');
  return new Set(raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function evaluateSubmitGate({
  submissionMode,
  ledgerClean,
  decision,
  autoEligible,
  channel,
  requiredFilled,
  resumeAttached,
  hardStop = null,
  confirmationAlreadyUnclear = false,
  env = process.env,
}) {
  const failures = [];
  if (submissionMode !== 'routine-auto') failures.push('review-each');
  if (!ledgerClean) failures.push('ledger');
  if (decision !== 'review') failures.push('decision');
  const routine = routineChannels(env).has(channel);
  if (!autoEligible && !routine) failures.push('not-auto-eligible');
  if (!submitAllowlist(env).has(channel)) failures.push('channel');
  if (!requiredFilled) failures.push('required-fields');
  if (!resumeAttached) failures.push('resume');
  if (hardStop) failures.push(hardStop);
  if (confirmationAlreadyUnclear) failures.push('unclear-confirmation');
  return { ok: failures.length === 0, failures };
}
