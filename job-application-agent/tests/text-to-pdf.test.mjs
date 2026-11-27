import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeWinAnsi, textToPdf, wrapResumeLines } from '../scripts/text-to-pdf.mjs';

test('encodeWinAnsi maps punctuation and replaces unsupported characters', () => {
  const encoded = encodeWinAnsi('Hello\u2014world \u2022 \u4F60');
  assert.equal(encoded.text, 'Hello--world * ?');
  assert.equal(encoded.replacedCharacters, 1);
});

test('wrapResumeLines keeps newlines and wraps long lines', () => {
  const lines = wrapResumeLines('one\ntwo\n' + 'word '.repeat(40));
  assert.equal(lines[0], 'one');
  assert.equal(lines[1], 'two');
  assert.ok(lines.length > 3);
  assert.ok(lines.every((line) => line.length <= 90));
});

test('textToPdf writes a %PDF buffer that contains the résumé text', () => {
  const sample = 'Software engineer with ten years of backend TypeScript experience building APIs.';
  const pdf = textToPdf(sample);
  assert.equal(pdf.bytes.subarray(0, 8).toString('ascii'), '%PDF-1.4');
  assert.match(pdf.bytes.toString('latin1'), /%%EOF/);
  assert.match(pdf.bytes.toString('latin1'), /Software engineer with ten years/);
  assert.match(pdf.bytes.toString('latin1'), /\/Encoding \/WinAnsiEncoding/);
  assert.equal(pdf.pageCount, 1);
  assert.equal(pdf.replacedCharacters, 0);
});

test('textToPdf keeps accented Latin characters under WinAnsiEncoding', () => {
  const pdf = textToPdf('Résumé of a senior engineer in Montréal.');
  assert.match(pdf.bytes.toString('latin1'), /\/Encoding \/WinAnsiEncoding/);
  assert.match(pdf.bytes.toString('latin1'), /R\\351sum\\351 of a senior engineer in Montr\\351al/);
  assert.equal(pdf.replacedCharacters, 0);
});

test('textToPdf paginates a long résumé', () => {
  const pdf = textToPdf(Array.from({ length: 80 }, (_, i) => `Line ${i} of a long résumé.`).join('\n'));
  assert.ok(pdf.pageCount >= 2);
  assert.equal(pdf.bytes.subarray(0, 4).toString('ascii'), '%PDF');
});
