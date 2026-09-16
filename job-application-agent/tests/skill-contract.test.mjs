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

  assert.match(skill, /autonomy status/);
  assert.match(skill, /round status/);
  assert.match(skill, /attention list/);
  assert.match(skill, /friction record/);
  assert.match(skill, /attention-runner-poll/);
  assert.match(autonomy, /never.*merge.*publish/i);
  assert.match(autonomy, /CAPTCHA/i);
  assert.match(runs, /visible.*confirmation/i);
  assert.match(runs, /discoverySource/);
  assert.match(runs, /applicationChannel/);
  assert.match(runs, /Resume re-inspect checklist/);
  assert.match(runs, /attention-runner-poll/);
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
