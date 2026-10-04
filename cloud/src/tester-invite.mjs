#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { issueInvite } from './tester-access.mjs';

// Operator-only CLI. No HTTP invite minting or public registration endpoint.
export async function writeInvite(email, outputFile, env = process.env) {
  if (!email || !outputFile) throw new Error('Usage: node src/tester-invite.mjs EMAIL OUTPUT_FILE');
  const invite = issueInvite(email, env);
  await writeFile(outputFile, `${invite.url}\n`, { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeInvite(process.argv[2], process.argv[3])
    .then(() => console.log('Invite written to the private output file. Expires in 48 hours.'))
    .catch(() => { console.error('Invite not written. Check hosting configuration, email and a new output-file path.'); process.exitCode = 1; });
}
