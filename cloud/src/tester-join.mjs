#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { joinUrl } from './tester-access.mjs';

// The shared link contains no token and does not create or reserve an account.
export async function writeJoinLink(outputFile, env = process.env) {
  if (!outputFile) throw new Error('Usage: node src/tester-join.mjs OUTPUT_FILE');
  await writeFile(outputFile, `${joinUrl(env)}\n`, { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeJoinLink(process.argv[2])
    .then(() => console.log('Shared join link written to the private output file.'))
    .catch(() => { console.error('Join link not written. Check hosting configuration and a new output-file path.'); process.exitCode = 1; });
}
