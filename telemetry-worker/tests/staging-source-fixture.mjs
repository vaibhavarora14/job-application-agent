export function stagingSourceBaseUrl(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Staging source time must be a non-negative safe integer.');
  const runId = String(now).replace(/\d/g, (digit) => String.fromCharCode('k'.charCodeAt(0) + Number(digit)));
  return `https://staging-${runId}.example.com/openings/engineering?private=removed#jobs`;
}
