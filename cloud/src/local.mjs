#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { loadLocalEnv } from './env.mjs';
import { ensureDataDirs } from './paths.mjs';
import { startServer } from './server.mjs';
import { getProfile } from './skill.mjs';

export async function startLocal(env = process.env, options = {}) {
  const loaded = loadLocalEnv(env, options);
  ensureDataDirs(loaded);
  const server = startServer(loaded, { embedWorker: loaded.CLOUD_EMBED_WORKER !== '0' });
  const { host, port } = await server.ready;
  const status = getProfile(loaded);
  const url = `http://${host}:${port}`;
  return { url, host, port, configured: status.configured, resume: Boolean(status.resumePath), close: server.close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocal(process.env)
    .then((started) => {
      const setup = started.configured && started.resume
        ? 'Profile and résumé are ready. Start a round from the page.'
        : 'Open the page and import your laptop skill profile, or fill setup once.';
      process.stdout.write(`Job Application Agent (local)\n${started.url}\n${setup}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
