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
