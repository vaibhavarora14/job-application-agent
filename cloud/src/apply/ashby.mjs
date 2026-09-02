import { recordHandoff } from './handoff.mjs';
import { upsertApplication } from './applications.mjs';
import { openDb } from '../db.mjs';

export async function fillAshby({ jobId, roundId = null, env = process.env }) {
  const job = openDb(env).prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return { skipped: true };
  const applicationId = upsertApplication({ job, roundId, status: 'ready', env });
  recordHandoff({
    applicationId,
    jobId,
    url: job.url,
    stage: 'application',
    blocker: 'other',
    instructions: 'Ashby fill is out of H0 until one Greenhouse agent-submit is confirmed. Open the apply URL yourself.',
    env,
  });
  return { handedOff: true, reason: 'channel-not-implemented' };
}
