import assert from 'node:assert/strict';
import test from 'node:test';

import { isTelemetryPiiKey, redactHomePaths } from '../scripts/telemetry-redact.mjs';

test('redactHomePaths collapses POSIX, macOS, WSL, Windows, UNC and file:// home paths to ~', () => {
  const cases = [
    ['/home/testuser/.agents/skills/a.mjs', '~/.agents/skills/a.mjs'],
    ['at /Users/Jane.Doe/Library/x:1:2', 'at ~/Library/x:1:2'],
    ['/var/home/alice/x', '~/x'],
    ['/mnt/c/Users/wsl-user/x', '~/x'],
    ['C:\\Users\\bob\\AppData\\x', '~\\AppData\\x'],
    ['c:/Users/bob/x', '~/x'],
    ['D:\\Documents and Settings\\carol\\x', '~\\x'],
    ['\\\\host\\c$\\Users\\dave\\x', '~\\x'],
    ['file:///home/erin/x', '~/x'],
    ['file:///C:/Users/frank/x', '~/x'],
    ["'/home/gina'", "'~'"],
    ['/home/hank', '~'],
    ['C:\\Users\\Bob Smith\\AppData', '~\\AppData'],
    ['/Users/Jane Doe/Library', '~/Library'],
    ['failed at /home/ivan while loading', 'failed at ~ while loading'],
  ];
  for (const [input, expected] of cases) assert.equal(redactHomePaths(input), expected, input);
  assert.equal(redactHomePaths('no paths here /tmp/x /usr/lib'), 'no paths here /tmp/x /usr/lib');
});

test('isTelemetryPiiKey matches known identity keys case-insensitively and nothing in the schema', () => {
  for (const key of ['candidateName', 'candidateEmail', 'name', 'Email', 'phone', '$set']) assert.equal(isTelemetryPiiKey(key), true, key);
  for (const key of ['company', 'title', 'sanitizedMessage', 'fieldLabel', 'errorCode']) assert.equal(isTelemetryPiiKey(key), false, key);
});
