import { pathToFileURL } from 'node:url';

import { assessQueuedJob, requeuePendingLlm } from './assess.mjs';
import { fillAshby } from './apply/ashby.mjs';
import { fillGreenhouse, submitGreenhouse } from './apply/greenhouse.mjs';
import { fillLever } from './apply/lever.mjs';
import { openDb } from './db.mjs';
import { discoverBoards } from './discover/index.mjs';
import { claimNext, finish } from './queue.mjs';

const TYPES = ['discover', 'assess', 'fill', 'submit', 'handoff'];

export async function drainOnce(env = process.env, { fetchImpl = fetch } = {}) {
  const job = claimNext(TYPES, env);
  if (!job) return null;
  try {
    const result = await handle(job, env, fetchImpl);
    finish(job.id, null, env);
    return { id: job.id, type: job.type, result };
  } catch (error) {
    finish(job.id, error.message, env);
    return { id: job.id, type: job.type, error: error.message };
  }
}

async function handle(job, env, fetchImpl) {
  if (job.type === 'discover') {
    return discoverBoards({ fetchImpl, env, roundId: job.payload.roundId });
  }
  if (job.type === 'assess') {
    return assessQueuedJob(job.payload.jobId, { roundId: job.payload.roundId, env, fetchImpl });
  }
  if (job.type === 'fill') {
    const row = openDb(env).prepare('SELECT application_channel FROM jobs WHERE id = ?').get(job.payload.jobId);
    const channel = row?.application_channel;
    if (channel === 'greenhouse') return fillGreenhouse({ ...job.payload, env, fetchImpl });
    if (channel === 'lever') return fillLever({ ...job.payload, env });
    if (channel === 'ashby') return fillAshby({ ...job.payload, env });
    throw new Error(`Unsupported fill channel: ${channel}`);
  }
  if (job.type === 'submit') {
    return submitGreenhouse({ ...job.payload, env });
  }
  if (job.type === 'handoff') {
    return { ok: true, note: 'Handoff is operator-driven. Use the inbox.' };
  }
  throw new Error(`Unknown job type: ${job.type}`);
}

export async function startWorker(env = process.env) {
  const interval = Number(env.CLOUD_WORKER_INTERVAL_MS || 1500);
  let pendingSweep = 0;
  const tick = async () => {
    try {
      pendingSweep += 1;
      if (pendingSweep % 20 === 0) requeuePendingLlm(env);
      await drainOnce(env);
    } catch (error) {
      console.error(`[worker] ${error.message}`);
    }
  };
  await tick();
  const timer = setInterval(tick, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker(process.env).then(() => {
    console.log('cloud worker listening for queue jobs');
  });
}
