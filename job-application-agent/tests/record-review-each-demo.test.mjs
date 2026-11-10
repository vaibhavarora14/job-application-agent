import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DEMO_CAPTION,
  DEMO_PROFILE,
  exampleResumePdf,
  isLocalFixtureRequest,
} from '../../scripts/record-review-each-demo.mjs';

test('demo recorder allows only the local fixture origin', () => {
  const port = 4173;
  assert.equal(isLocalFixtureRequest('http://127.0.0.1:4173/fixtures/greenhouse/', port), true);
  assert.equal(isLocalFixtureRequest('http://127.0.0.1:4173/fixtures/greenhouse/index.html', port), true);
  assert.equal(isLocalFixtureRequest('about:blank', port), true);
  assert.equal(isLocalFixtureRequest('https://jobappagent.com/fixtures/greenhouse/', port), false);
  assert.equal(isLocalFixtureRequest('https://jobappagent.com/jobs', port), false);
  assert.equal(isLocalFixtureRequest('https://boards.greenhouse.io/example/jobs/1', port), false);
  assert.equal(isLocalFixtureRequest('http://127.0.0.1:4174/fixtures/greenhouse/', port), false);
  assert.equal(isLocalFixtureRequest('http://localhost:4173/fixtures/greenhouse/', port), false);
});

test('demo profile is the dummy example.test person and the caption is one line', () => {
  assert.deepEqual(DEMO_PROFILE, {
    first: 'Example',
    last: 'Person',
    email: 'person@example.test',
    phone: '555-0100',
    location: 'Example City',
    country: 'US',
    resumeName: 'example-resume.pdf',
  });
  assert.equal(DEMO_CAPTION, 'Stopped before Submit');
  assert.equal(DEMO_CAPTION.includes('\u2014') || DEMO_CAPTION.includes('\u2013'), false);
  assert.equal(DEMO_CAPTION.split('\n').length, 1);
});

test('demo resume file names only the dummy person', () => {
  const pdf = exampleResumePdf();
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const text = pdf.toString('latin1');
  assert.equal(text.includes('Example Person'), true);
  assert.equal(text.includes('@'), false);
  assert.equal(text.includes('555'), false);
});

test('README embeds the review-each demo and drops the placeholder', async () => {
  const readme = await readFile(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
  assert.equal(readme.includes('demo-video: embed goes here'), false);
  assert.match(readme, /!\[[^\]]+\]\(docs\/review-each-demo\.gif\)/);
  const gif = await stat(fileURLToPath(new URL('../../docs/review-each-demo.gif', import.meta.url)));
  assert.equal(gif.size > 1000 && gif.size < 3 * 1024 * 1024, true);
});
