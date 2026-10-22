// Test-only helper: stage and approve a review batch for a send the test is about to make,
// the same way a candidate would through `review stage` and the approval phrase. Production
// code has no bypass; tests that exercise the gate itself call the CLI directly.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from '../../scripts/entrypoint.mjs';
import { approvalPhrase, approveBatch, resumeDigest, stageBatch } from '../../scripts/review-batch.mjs';

const SELF = fileURLToPath(import.meta.url);

export function applicationItem(entry, purpose = 'submit') {
  return {
    type: 'application', purpose, applicationId: entry.id ?? entry.applicationId, company: entry.company ?? 'Example', role: entry.role ?? 'Role',
    url: entry.url ?? entry.canonicalUrl, fitScore: Number.isInteger(entry.score) ? entry.score : 80, answers: entry.answers ?? {},
  };
}

export async function approveItems(stateDir, items) {
  const batch = await stageBatch(stateDir, { items }, { resume: await resumeDigest(join(stateDir, 'resume.pdf')) });
  const { token } = await approveBatch(stateDir, batch.batchId, { channel: 'chat-phrase', phrase: approvalPhrase(batch) });
  return { reviewBatchId: batch.batchId, reviewToken: token };
}

/** Synchronous variant for helpers built on execFileSync. */
export function approveItemsSync(stateDir, items) {
  return JSON.parse(execFileSync(process.execPath, [SELF], { input: JSON.stringify({ stateDir, items }), encoding: 'utf8' }));
}

const LIVE_HOST_FIXTURES = /^(https?:\/\/)(jobappagent\.com|www\.jobappagent\.com|localhost|127\.0\.0\.1)\//;

/** Adds reviewBatchId/reviewToken to a `ledger add` input that does not carry them yet. */
export function withTestReview(env, args, input) {
  const stateDir = env?.JOB_APPLICATION_AGENT_STATE_DIR;
  if (!stateDir || !input || typeof input !== 'object' || 'reviewBatchId' in input) return input;
  if (args?.[0] === 'outreach' && args?.[1] === 'handoff') {
    return { ...input, ...approveItemsSync(stateDir, [{ type: 'email', opportunityId: input.id, draftRevision: input.draftRevision, company: 'Example', text: 'Test draft.' }]) };
  }
  if (args?.[0] !== 'ledger' || args?.[1] !== 'add') return input;
  if (typeof input.url !== 'string' || !input.id || LIVE_HOST_FIXTURES.test(input.url)) return input;
  try { new URL(input.url); } catch { return input; }
  try { return { ...input, ...approveItemsSync(stateDir, [applicationItem(input)]) }; } catch { return input; }
}

if (isEntrypoint(import.meta.url)) {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const { stateDir, items } = JSON.parse(text);
  process.stdout.write(JSON.stringify(await approveItems(stateDir, items)));
}
