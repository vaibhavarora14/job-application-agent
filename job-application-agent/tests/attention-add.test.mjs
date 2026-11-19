import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applicationIdFromUrl,
  ATTENTION_BLOCKERS,
  ATTENTION_STAGES,
  normalizeAttentionInput,
  REQUIRED_ACTIONS,
  skillErrorProperties,
} from '../scripts/job-application.mjs';

const scriptsDir = fileURLToPath(new URL('../scripts/', import.meta.url));

const validPause = {
  roundId: 'round-2026-01-15-00000000-0000-4000-8000-000000000000',
  applicationId: 'example-role',
  url: 'https://jobs.example.com/role',
  stage: 'submission',
  blocker: 'captcha',
  requiredActions: ['complete-captcha'],
};

function walkScripts(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkScripts(path, files);
    else if (entry.name.endsWith('.mjs')) files.push(path);
  }
  return files;
}

function requiredActionsInScripts() {
  const found = new Set();
  const kebab = '[a-z]+(?:-[a-z0-9]+)+';
  for (const file of walkScripts(scriptsDir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/requiredActions\s*[:=]\s*(?:Object\.freeze\()?\[([^\]]*)\]/g)) {
      for (const item of match[1].matchAll(new RegExp(`['"](${kebab})['"]`, 'g'))) found.add(item[1]);
    }
    for (const match of text.matchAll(new RegExp(`requiredActions\\s+(${kebab})`, 'g'))) found.add(match[1]);
  }
  return found;
}

test('review-form, a string requiredActions, and a missing applicationId with a valid url are accepted (#294)', () => {
  const reviewForm = normalizeAttentionInput({ ...validPause, requiredActions: ['review-form'] });
  assert.deepEqual(reviewForm.requiredActions, ['review-form']);

  const asString = normalizeAttentionInput({ ...validPause, requiredActions: 'sign-in' });
  assert.deepEqual(asString.requiredActions, ['sign-in']);

  const { applicationId: _unused, ...withoutId } = validPause;
  const derived = normalizeAttentionInput(withoutId);
  assert.equal(derived.applicationId, applicationIdFromUrl(validPause.url));
  assert.match(derived.applicationId, /^jobs-example-com-role$/);
  assert.ok(derived.applicationId.length <= 180);
});

test('an unknown attention action lists every allowed value (#294)', () => {
  assert.throws(
    () => normalizeAttentionInput({ ...validPause, requiredActions: ['open-the-form'] }),
    (error) => {
      assert.match(error.message, /^attention\.requiredActions\[0] "open-the-form" is not allowed\. Allowed: /);
      for (const action of REQUIRED_ACTIONS) assert.match(error.message, new RegExp(`\\b${action}\\b`));
      const props = skillErrorProperties(error, 'attention');
      assert.equal(props.errorCode, 'invalid_input');
      assert.equal(props.fieldLabel, 'attention.requiredActions');
      return true;
    },
  );
});

test('attention stage, blocker, and unknown property errors name the allowed values (#294)', () => {
  assert.throws(
    () => normalizeAttentionInput({ ...validPause, stage: 'filling' }),
    (error) => {
      assert.match(error.message, /^attention\.stage is invalid\. Allowed: /);
      for (const stage of ATTENTION_STAGES) assert.match(error.message, new RegExp(`\\b${stage}\\b`));
      return true;
    },
  );
  assert.throws(
    () => normalizeAttentionInput({ ...validPause, blocker: 'password' }),
    (error) => {
      assert.match(error.message, /^attention\.blocker is invalid\. Allowed: /);
      for (const blocker of ATTENTION_BLOCKERS) assert.match(error.message, new RegExp(`\\b${blocker}\\b`));
      return true;
    },
  );
  assert.throws(
    () => normalizeAttentionInput({ ...validPause, reason: 'please help' }),
    (error) => {
      assert.match(error.message, /^Unknown attention property: reason\. Allowed: /);
      assert.match(error.message, /\brequiredActions\b/);
      assert.match(error.message, /\bnotes\b/);
      return true;
    },
  );
});

test('attention notes are accepted and not stored on the opened payload (#294)', () => {
  const normalized = normalizeAttentionInput({ ...validPause, notes: 'local only pause context' });
  assert.equal('notes' in normalized, false);
  assert.equal(normalized.value.notes, 'local only pause context');
});

test('every requiredActions literal and hint in scripts/ is accepted by attention add (#294)', () => {
  const literals = requiredActionsInScripts();
  assert.ok(literals.has('review-form'), 'attention-resume-submit hint must be in the scan');
  assert.ok(literals.has('review-delivery'));
  assert.ok(literals.has('review-assessment'));
  for (const action of literals) {
    assert.doesNotThrow(
      () => normalizeAttentionInput({ ...validPause, requiredActions: [action] }),
      `scripts/ requiredActions value ${action} must pass attention add`,
    );
  }
});
