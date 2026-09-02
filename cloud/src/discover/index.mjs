import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { nowIso, openDb } from '../db.mjs';
import { enqueue } from '../queue.mjs';
import { CLOUD_ROOT } from '../paths.mjs';
import { fetchAshbyBoard } from './ashby.mjs';
import { fetchGreenhouseBoard } from './greenhouse.mjs';
import { fetchLeverBoard } from './lever.mjs';

export async function loadBoards(env = process.env) {
  const file = env.CLOUD_BOARDS_PATH || join(CLOUD_ROOT, 'boards.json');
  const boards = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(boards)) throw new Error('boards.json must be an array.');
  return boards;
}

export async function discoverBoards({ fetchImpl = fetch, env = process.env, roundId = null } = {}) {
  const db = openDb(env);
  const insert = db.prepare(`INSERT INTO jobs (id, company, role, title, description, url, employer_job_id, application_channel, discovery_source, locations, salary_maximum, salary_currency, work_mode, questions_json, raw_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      description = excluded.description,
      questions_json = excluded.questions_json`);
  const boards = await loadBoards(env);
  let found = 0;
  let inserted = 0;
  const errors = [];
  for (const board of boards) {
    let jobs;
    try {
      jobs = await fetchBoard(board, fetchImpl);
    } catch (error) {
      errors.push({ slug: board.slug, error: error.message });
      continue;
    }
    found += jobs.length;
    for (const job of jobs) {
      const existed = db.prepare('SELECT id FROM jobs WHERE url = ?').get(job.url);
      insert.run(
        job.id, job.company, job.role, job.title, job.description, job.url, job.employerJobId,
        job.applicationChannel, job.discoverySource, JSON.stringify(job.locations),
        job.salaryMaximum, job.salaryCurrency, job.workMode,
        job.questions ? JSON.stringify(job.questions) : null,
        job.raw ? JSON.stringify(job.raw) : null,
        nowIso(),
      );
      if (!existed) {
        inserted += 1;
        enqueue('assess', { jobId: job.id, roundId }, env);
      }
    }
  }
  return { boards: boards.length, found, inserted, errors };
}

async function fetchBoard(board, fetchImpl) {
  if (board.channel === 'greenhouse') return fetchGreenhouseBoard(board.slug, board.company, fetchImpl);
  if (board.channel === 'lever') return fetchLeverBoard(board.slug, board.company, fetchImpl);
  if (board.channel === 'ashby') return fetchAshbyBoard(board.slug, board.company, fetchImpl);
  throw new Error(`Unsupported board channel: ${board.channel}`);
}
