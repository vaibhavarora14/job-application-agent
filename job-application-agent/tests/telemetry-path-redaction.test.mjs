import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { redactLocalIdentity, sanitizeTelemetryErrorMessage } from '../scripts/telemetry-schema.mjs';
import { localIdentityForRedaction, skillErrorProperties } from '../scripts/job-application.mjs';

test('sanitizeTelemetryErrorMessage redacts home paths on every OS style', () => {
  const cases = [
    "Cannot find module '/home/testuser/.agents/skills/job-application-agent/x.mjs'",
    'ENOENT /Users/Jane Doe/Library/Application Support/x',
    'EPERM C:\\Users\\bob\\AppData\\Local\\x',
    'at file:///C:/Users/bob/x.mjs:1:2',
    'open /mnt/c/Users/wsluser/x',
  ];
  for (const message of cases) {
    const out = sanitizeTelemetryErrorMessage(message);
    for (const leaked of ['testuser', 'Jane', 'Doe', 'bob', 'wsluser', '/home/', '/Users/', '\\Users\\']) assert.equal(out.includes(leaked), false, `${leaked} in ${out}`);
    assert.match(out, /~/);
  }
});

test('the current os.homedir() and os.userInfo().username are removed wherever they appear', () => {
  const homeDir = '/srv/people/qa-person';
  const out = sanitizeTelemetryErrorMessage(`failed at ${homeDir}/state/x.json for qa-person (QA-PERSON)`, { homeDir, userName: 'qa-person' });
  assert.equal(out, 'failed at ~/state/x.json for <user> (<user>)');
  assert.equal(redactLocalIdentity('C:\\Profiles\\winuser\\x', { homeDir: 'C:\\Profiles\\winuser', userName: 'winuser' }), '~\\x');
  assert.equal(redactLocalIdentity('C:/Profiles/winuser/x', { homeDir: 'C:\\Profiles\\winuser', userName: 'winuser' }), '~/x');
  // Short usernames are not used as a pattern (they would destroy ordinary words).
  assert.equal(redactLocalIdentity('a bad input', { userName: 'a' }), 'a bad input');
});

test('skill_error properties from a real error never contain this machine\'s home or username', () => {
  const { homeDir, userName } = localIdentityForRedaction();
  assert.equal(homeDir, os.homedir());
  const error = new Error(`Cannot find module '${os.homedir()}/.agents/skills/job-application-agent/scripts/runtime/x.cjs'`);
  const props = skillErrorProperties(error, ['resume', 'import']);
  assert.ok(props.sanitizedMessage);
  assert.equal(props.sanitizedMessage.includes(os.homedir()), false);
  if (userName && userName.length >= 3) assert.equal(props.sanitizedMessage.toLowerCase().includes(userName.toLowerCase()), false);
  assert.match(props.sanitizedMessage, /~\/\.agents\/skills/);
});
