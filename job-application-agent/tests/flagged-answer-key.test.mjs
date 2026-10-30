// #220: a flag that names no answer key says how to fix it in one retry.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { flaggedAnswerKeyError, stageBatch } from '../scripts/review-batch.mjs';

const answers = { 'Why do you want to work here?': 'Because.', 'Sponsorship required?': 'No' };

test('flaggedAnswerKeyError suggests the closest key or lists the keys', () => {
  assert.match(flaggedAnswerKeyError('x.answer', 'why do you want to work here', answers), /must name a key in answers, copied exactly\. Did you mean "Why do you want to work here\?"\? Use that exact key\./);
  assert.match(flaggedAnswerKeyError('x.answer', 'Cover letter', answers), /Answer keys: "Why do you want to work here\?", "Sponsorship required\?"\.$/);
  assert.match(flaggedAnswerKeyError('x.answer', 'Why?', {}), /answers is empty, so there is nothing to flag/);
  assert.match(flaggedAnswerKeyError('x.answer', 3, answers), /It must be a string/);
});

test('review stage still matches exactly and reports the closest key (#220)', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'flag-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const item = (flagged) => ({ type: 'application', applicationId: 'a-1', company: 'Acme', role: 'Engineer', url: 'https://jobs.lever.co/acme/1', ats: 'lever', fitScore: 80, answers, flaggedAnswers: [{ answer: flagged, reason: 'The answer is generic.' }] });
  await assert.rejects(stageBatch(directory, { items: [item('Why do you want to work here')] }), /items\[0\]\.flaggedAnswers\[0\]\.answer must name a key in answers, copied exactly\. Did you mean "Why do you want to work here\?"/);
  const staged = await stageBatch(directory, { items: [item('Why do you want to work here?')] });
  assert.equal(staged.items[0].flaggedAnswers[0].answer, 'Why do you want to work here?');
});

test('a long answer key is suggested in full so it can be copied exactly', async () => {
  const { flaggedAnswerKeyError } = await import('../scripts/review-batch.mjs');
  const key = `Describe ${'a very long screening question '.repeat(5)}in detail?`;
  assert.ok(key.length > 80 && key.length <= 200);
  assert.ok(flaggedAnswerKeyError('flag', key.toLowerCase().replace(/\?$/, ''), { [key]: 'Yes' }).includes(JSON.stringify(key)));
});
