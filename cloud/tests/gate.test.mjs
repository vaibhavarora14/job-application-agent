import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateSubmitGate } from '../src/apply/gate.mjs';
import { mapLabel, splitName } from '../src/apply/prefill.mjs';
import { confirmationLooksSuccessful, detectHardStops } from '../src/apply/signals.mjs';
import { isolatedEnv, sampleExtras, sampleProfile } from './helpers.mjs';

test('submit gate requires routine-auto, review, résumé, and a clean page', () => {
  const base = {
    submissionMode: 'routine-auto',
    ledgerClean: true,
    decision: 'review',
    autoEligible: true,
    channel: 'greenhouse',
    requiredFilled: true,
    resumeAttached: true,
    env: {},
  };
  assert.equal(evaluateSubmitGate(base).ok, true);
  assert.deepEqual(evaluateSubmitGate({ ...base, submissionMode: 'review-each' }).failures, ['review-each']);
  assert.ok(evaluateSubmitGate({ ...base, autoEligible: false }).failures.includes('not-auto-eligible'));
  assert.equal(evaluateSubmitGate({
    ...base,
    autoEligible: false,
    env: { CLOUD_ROUTINE_CHANNELS: 'greenhouse' },
  }).ok, true);
  assert.ok(evaluateSubmitGate({ ...base, hardStop: 'captcha' }).failures.includes('captcha'));
  assert.ok(evaluateSubmitGate({ ...base, channel: 'lever' }).failures.includes('channel'));
});

test('confirmation detector is conservative', () => {
  assert.equal(confirmationLooksSuccessful('Thanks for applying to Acme.').ok, true);
  assert.equal(confirmationLooksSuccessful('Please review your application before sending.').ok, false);
  assert.equal(confirmationLooksSuccessful('Application received', 'https://boards.greenhouse.io/acme/confirmation').ok, true);
});

test('hard stops include login, captcha, and Apply with LinkedIn', () => {
  assert.equal(detectHardStops('Please sign in to continue').blocker, 'authentication');
  assert.equal(detectHardStops('I am not a robot').blocker, 'captcha');
  assert.equal(detectHardStops('Welcome', { hasLinkedInOverlay: true }).blocker, 'authentication');
  assert.equal(detectHardStops('Name and email only'), null);
});

test('prefill maps common ATS labels to profile facts', async (t) => {
  const env = await isolatedEnv(t);
  const email = mapLabel('Corporate e-mail', sampleProfile, sampleExtras, { env });
  assert.equal(email.value, sampleProfile.email);
  assert.equal(splitName(sampleProfile.name).firstName, 'Test');
  const leftover = mapLabel('Favorite ice cream', sampleProfile, sampleExtras, { env });
  assert.equal(leftover.source, 'unclear');
});
