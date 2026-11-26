import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildApplyAgentPrompt, buildApplyCliCommand } from '../lib/job-apply-copy.mjs';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const NPX_APPLY_OR_PLATFORMS = /npx job-application-agent(?:@[\w.-]+)? (?:apply|platforms)\b[^\n`]*/g;

test('apply CLI command keeps the full URL for clipboard', () => {
  const url = 'https://job-boards.greenhouse.io/exampleco/jobs/1001';
  assert.equal(buildApplyCliCommand(url), `npx job-application-agent@latest apply ${url}`);
});

// npm latest 3.8.10 rejects extra args on apply/platforms (usage, exit 1). Keep --source
// off those emitted commands until a CLI that strips the tag is on npm latest (#306).
test('emitted apply and platforms commands omit --source until npm latest accepts it (#306)', async () => {
  const url = 'https://jobs.ashbyhq.com/livekit/463e2769-bb85-4429-96a3-3a175eb228cd';
  const apply = buildApplyCliCommand(url);
  const prompt = buildApplyAgentPrompt({ role: 'Senior Product Engineer', company: 'LiveKit', url });
  assert.equal(apply.includes('--source='), false);
  assert.match(prompt, /npx job-application-agent@latest install --source=jobs/);
  assert.ok(prompt.includes(`npx job-application-agent@latest apply ${url}`));
  assert.equal(prompt.includes(`npx job-application-agent@latest apply ${url} --source=`), false);

  const texts = [
    await readFile(path.join(repoRoot, 'README.md'), 'utf8'),
    await readFile(path.join(siteRoot, 'public/llms.txt'), 'utf8'),
    await readFile(path.join(siteRoot, 'lib/job-apply-copy.mjs'), 'utf8'),
    await readFile(path.join(siteRoot, 'lib/structured-data.mjs'), 'utf8'),
    await readFile(path.join(siteRoot, 'lib/live-jobs.mjs'), 'utf8'),
    ...(await readSiteAppSources(path.join(siteRoot, 'app'))),
  ];
  for (const text of texts) {
    for (const match of text.matchAll(NPX_APPLY_OR_PLATFORMS)) {
      assert.equal(
        /--source=/.test(match[0]),
        false,
        `user-facing apply/platforms command still has --source (#306): ${match[0]}`,
      );
    }
  }
});

async function readSiteAppSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await readSiteAppSources(next));
    else if (/\.(?:tsx|ts|mjs|js|md|txt)$/.test(entry.name)) files.push(await readFile(next, 'utf8'));
  }
  return files;
}
