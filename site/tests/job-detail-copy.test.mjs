import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApplyCliCommand } from '../lib/job-apply-copy.mjs';

test('apply CLI command keeps the full URL for clipboard', () => {
  const url = 'https://job-boards.greenhouse.io/exampleco/jobs/1001';
  assert.equal(buildApplyCliCommand(url), `npx job-application-agent@latest apply ${url}`);
});
