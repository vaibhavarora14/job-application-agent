import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('requires direct path resume upload before native picker fallback', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const guidance = await readFile(new URL('../references/BROWSER_UPLOADS.md', import.meta.url), 'utf8');

  assert.match(skill, /resume path/);
  assert.match(skill, /BROWSER_UPLOADS\.md/);
  assert.match(guidance, /absolute path/i);
  assert.match(guidance, /file chooser/i);
  assert.match(guidance, /setFiles/);
  assert.match(guidance, /native (file )?picker.*fallback/i);
  assert.match(guidance, /verify.*filename/i);
});

test('documents durable autonomy, resumable rounds, attention and friction controls', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const autonomy = await readFile(new URL('../references/AUTONOMY.md', import.meta.url), 'utf8');
  const runs = await readFile(new URL('../references/RUNS.md', import.meta.url), 'utf8');
  const agentBox = await readFile(new URL('../references/agent-box/README.md', import.meta.url), 'utf8');

  assert.match(skill, /autonomy status/);
  assert.match(skill, /round status/);
  assert.match(skill, /attention list/);
  assert.match(skill, /friction record/);
  assert.match(skill, /attention-runner-poll/);
  assert.match(skill, /attention-resume-submit/);
  assert.match(skill, /session-binding/);
  assert.match(skill, /DISPLAY=:99/);
  assert.match(skill, /5900/);
  assert.match(autonomy, /never.*merge.*publish/i);
  assert.match(autonomy, /CAPTCHA/i);
  assert.match(runs, /visible.*confirmation/i);
  assert.match(runs, /discoverySource/);
  assert.match(runs, /applicationChannel/);
  assert.match(runs, /Resume → submit/);
  assert.match(runs, /attention-runner-poll/);
  assert.match(runs, /submit if possible/i);
  assert.match(agentBox, /localhost:5900/);
  assert.match(agentBox, /5901/);
  assert.match(agentBox, /DISPLAY=:99/);
});

test('documents flexible ledger check lookup as a separate process from outcome', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const marketplaceSkill = await readFile(new URL('../../skills/job-application-agent/SKILL.md', import.meta.url), 'utf8');
  const schemas = await readFile(new URL('../references/SCHEMAS.md', import.meta.url), 'utf8');

  for (const copy of [skill, marketplaceSkill]) {
    assert.match(copy, /two separate CLI processes/);
    assert.match(copy, /company\+role/);
    assert.match(copy, /possible duplicate/);
    assert.match(copy, /never treat it as a hard already-applied/);
    assert.match(copy, /look up the row with `ledger check` first/);
    assert.match(copy, /pass the returned `match\.id` to `ledger outcome`/);
  }
  assert.match(schemas, /any one identifier set/);
  assert.match(schemas, /Never promote a company\+role match to a hard already-applied/);
  assert.match(schemas, /ledger add` still requires a real job URL/);
});

test('documents Free.ai as optional LLM assist only', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const freeAi = await readFile(new URL('../references/FREE_AI.md', import.meta.url), 'utf8');

  assert.match(skill, /FREE_AI\.md/);
  assert.match(skill, /does not call Free\.ai/i);
  assert.match(freeAi, /https:\/\/api\.free\.ai\/v1/);
  assert.match(freeAi, /FREE_AI_API_KEY/);
  assert.match(freeAi, /qwen7b/);
  assert.match(freeAi, /not the hosted/i);
  assert.match(freeAi, /does not read `FREE_AI_API_KEY`/i);
});
