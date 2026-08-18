import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../.github/workflows/publish-npm.yml', import.meta.url);

test('npm publishing requires a published release and skips versions already on the registry', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /release:\s*\n\s+types:\s*\[published\]/);
  assert.doesNotMatch(workflow, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /if:\s*github\.event\.release\.prerelease == false/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /git fetch --no-tags origin main:refs\/remotes\/origin\/main/);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" (?:refs\/remotes\/)?origin\/main/);
  assert.match(workflow, /RELEASE_TAG:\s*\$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.equal(workflow.match(/github\.event\.release\.tag_name/g)?.length, 1, 'release tag expressions belong only in env');
  assert.match(workflow, /"\$RELEASE_TAG"/);
  assert.match(workflow, /v\$\(node -p/);
  assert.match(workflow, /npm view [^\n]+version/);
  assert.match(workflow, /publish_needed/);
  assert.match(workflow, /if: steps\.version-check\.outputs\.publish_needed == 'true'/);
  assert.match(workflow, /npm publish --access public/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});
