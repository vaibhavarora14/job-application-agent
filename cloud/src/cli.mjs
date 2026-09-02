#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { listOpenAttention, resolveAttention } from './attention.mjs';
import { assessJob, draftAnswer, mapFields, resumeTextFromProfile } from './llm.mjs';
import { enqueue } from './queue.mjs';
import { startRound } from './round.mjs';
import { extrasFromBody, getProfile, saveProfile, storeResume } from './skill.mjs';
import { cloudStatus } from './status.mjs';

function usage() {
  return `Usage:
  node src/cli.mjs status
  node src/cli.mjs onboard --profile <file.json> --resume <file.pdf>
  node src/cli.mjs discover
  node src/cli.mjs round start [--count N]
  node src/cli.mjs attention
  node src/cli.mjs attention resolve <id>
  node src/cli.mjs llm assess|map-fields|draft --stdin`;
}

function arg(flag, argv) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

export async function runCli(argv, env = process.env) {
  const [cmd, sub] = argv;
  if (cmd === 'status' || !cmd) return cloudStatus(env);
  if (cmd === 'onboard') {
    const profilePath = arg('--profile', argv);
    const resumePath = arg('--resume', argv);
    if (!profilePath) throw new Error('onboard requires --profile');
    const raw = JSON.parse(await readFile(resolve(profilePath), 'utf8'));
    const extras = extrasFromBody(raw);
    const saved = saveProfile(raw, extras, null, env);
    if (resumePath) await storeResume(resolve(resumePath), env);
    return { ok: true, configured: saved.configured, missing: saved.missing, resume: Boolean(resumePath) };
  }
  if (cmd === 'discover') return enqueue('discover', { source: 'cli' }, env);
  if (cmd === 'round' && sub === 'start') return startRound(Number(arg('--count', argv) || 10), env);
  if (cmd === 'attention' && !sub) return listOpenAttention(env);
  if (cmd === 'attention' && sub === 'resolve') {
    return resolveAttention(argv[2], { resumeFill: argv.includes('--resume-fill'), env });
  }
  if (cmd === 'llm') {
    const input = await readStdinJson();
    const stored = getProfile(env);
    const resumeText = input.resumeText || resumeTextFromProfile(stored.profile || {}, stored.extras || {});
    if (sub === 'assess') return assessJob({ job: input.job || input, resumeText, profile: stored.profile || input.profile || {}, env });
    if (sub === 'map-fields') return mapFields({ labels: input.labels || [], profile: stored.profile || input.profile || {}, resumeText, env });
    if (sub === 'draft') return { text: await draftAnswer({ prompt: input.prompt, aboutMe: stored.extras?.motivationBlurb || input.aboutMe, job: input.job, env }) };
    throw new Error('llm assess|map-fields|draft');
  }
  throw new Error(usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), process.env)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
