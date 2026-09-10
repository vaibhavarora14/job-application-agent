import { homePiles } from './attention.mjs';
import { providerStatus } from './llm.mjs';
import { queuedCounts } from './queue.mjs';
import { listRounds } from './round.mjs';
import { getProfile } from './skill.mjs';

export async function cloudStatus(env = process.env, fetchImpl = fetch) {
  const profile = getProfile(env);
  return {
    profile: {
      configured: profile.configured,
      missing: profile.missing,
      resumePath: Boolean(profile.resumePath),
      submissionMode: profile.profile?.submissionMode || null,
      extras: profile.extras || {},
    },
    llm: await providerStatus(env, fetchImpl),
    piles: homePiles(env),
    queue: queuedCounts(env),
    rounds: listRounds(env),
  };
}
