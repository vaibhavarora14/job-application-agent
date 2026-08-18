import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../.github/workflows/publish-npm.yml', import.meta.url);

test('npm publishing runs for main updates and skips versions already on the registry', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /npm view [^\n]+version/);
  assert.match(workflow, /publish_needed/);
  assert.match(workflow, /if: steps\.version-check\.outputs\.publish_needed == 'true'/);
  assert.match(workflow, /npm publish --access public/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});
