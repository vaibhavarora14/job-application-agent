import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { emptyCurrentLocationAnswers, fillCurrentLocationAnswers, isCurrentLocationQuestion, profileCurrentLocation } from '../scripts/location-answers.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

test('current-location questions are recognised; preference questions are not', () => {
  for (const label of [
    'What is your current location?', 'Current location', 'Current City', 'Where are you currently located?', 'Where do you live?',
    'Where are you based?', 'City of residence', 'Country of current residence', 'Home address', 'Location', 'Location (city, country)', 'City*',
  ]) assert.equal(isCurrentLocationQuestion(label), true, label);
  for (const label of [
    'Preferred location', 'Are you willing to relocate?', 'Which office location do you prefer?', 'Desired work location', 'Why this team?',
    'Are you open to relocation to our current location in Berlin?', '', null,
  ]) assert.equal(isCurrentLocationQuestion(label), false, String(label));
});

test('profileCurrentLocation falls back through the profile location fields in order', () => {
  assert.deepEqual(profileCurrentLocation({ currentLocation: 'Pune, India', location: 'Bengaluru, India' }), { value: 'Pune, India', source: 'currentLocation', exact: true });
  assert.deepEqual(profileCurrentLocation({ location: ' Bengaluru, India ' }), { value: 'Bengaluru, India', source: 'location', exact: true });
  assert.deepEqual(profileCurrentLocation({ location: '  ', city: 'Austin', state: 'TX', country: 'USA' }), { value: 'Austin, TX, USA', source: 'city/state/country', exact: false });
  assert.deepEqual(profileCurrentLocation({ address: { city: 'Lisbon', country: 'Portugal' } }), { value: 'Lisbon, Portugal', source: 'address', exact: false });
  assert.deepEqual(profileCurrentLocation({ address: 'Toronto, ON, Canada' }), { value: 'Toronto, ON, Canada', source: 'address', exact: false });
  assert.deepEqual(profileCurrentLocation({ targetLocations: ['Remote', 'Worldwide', 'India'] }), { value: 'India', source: 'targetLocations', exact: false });
  assert.deepEqual(profileCurrentLocation({ preferredLocations: ['London'], targetLocations: ['India'] }), { value: 'London', source: 'preferredLocations', exact: false });
  assert.equal(profileCurrentLocation({ targetLocations: ['Remote', 'Anywhere'] }), null);
  assert.equal(profileCurrentLocation({}), null);
  assert.equal(profileCurrentLocation(null), null);
});

const item = (answers, extra = {}) => ({ type: 'application', applicationId: 'app-1', company: 'Acme', role: 'Engineer', url: 'https://www.linkedin.com/jobs/view/1', ats: 'linkedin', fitScore: 80, answers, ...extra });

test('empty current-location answers are filled from the profile; other answers are never touched', () => {
  const items = [item({ 'What is your current location?': '', 'Why us?': 'Because.', 'Preferred location': '' }), item({ Location: 'Delhi' }, { applicationId: 'app-2' })];
  assert.deepEqual(emptyCurrentLocationAnswers(items[0]), ['What is your current location?']);
  const { items: out, filled, missing } = fillCurrentLocationAnswers(items, { location: 'Bengaluru, India' });
  assert.equal(out[0].answers['What is your current location?'], 'Bengaluru, India');
  assert.equal(out[0].answers['Why us?'], 'Because.');
  assert.equal(out[0].answers['Preferred location'], '');
  assert.equal(out[0].flaggedAnswers, undefined, 'an exact profile location is not flagged');
  assert.equal(out[1], items[1], 'a filled answer is left exactly as given');
  assert.deepEqual(filled, [{ index: 0, applicationId: 'app-1', answer: 'What is your current location?', source: 'location' }]);
  assert.deepEqual(missing, []);
  assert.equal(items[0].answers['What is your current location?'], '', 'input items are not mutated');
});

test('a fallback location is flagged for the candidate to check on the review page', () => {
  const flaggedAnswers = [{ answer: 'Why us?', reason: 'General.' }];
  const { items: out } = fillCurrentLocationAnswers([item({ 'Current city': ' ', 'Why us?': 'Because.' }, { flaggedAnswers })], { targetLocations: ['Remote', 'India'] });
  assert.equal(out[0].answers['Current city'], 'India');
  assert.equal(out[0].flaggedAnswers.length, 2);
  assert.equal(out[0].flaggedAnswers[1].answer, 'Current city');
  assert.match(out[0].flaggedAnswers[1].reason, /targetLocations/);
  assert.equal(flaggedAnswers.length, 1, 'the caller array is not mutated');
});

test('items are reported missing when the profile has no location at all', () => {
  const { items: out, filled, missing } = fillCurrentLocationAnswers([item({ 'What is your current location?': '' }), item({ Sponsorship: 'No' }, { applicationId: 'app-2' })], { targetLocations: ['Remote'] });
  assert.deepEqual(filled, []);
  assert.deepEqual(missing, [{ index: 0, applicationId: 'app-1', answers: ['What is your current location?'] }]);
  assert.equal(out[0].answers['What is your current location?'], '');
});

async function cliEnv(t) {
  const directory = await mkdtemp(join(tmpdir(), 'location-answers-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  return {
    directory,
    env: {
      ...process.env,
      JOB_APPLICATION_AGENT_STATE_DIR: directory,
      JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
      JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
      JOB_APPLICATION_AGENT_TELEMETRY_URL: 'http://127.0.0.1:9',
      JOB_APPLICATION_AGENT_NO_BROWSER: '1',
      // A fresh, empty profile store: this run has no stored profile and so no location.
      JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    },
  };
}
function cli(env, args, input) {
  const run = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
  return { status: run.status, stderr: run.stderr, json: run.status === 0 ? JSON.parse(run.stdout) : null };
}

test('review stage holds an item with no location answer and opens an attention item instead of failing the batch', async (t) => {
  const { directory, env } = await cliEnv(t);
  const { roundId } = cli(env, ['round', 'start', '--stdin'], { requestedCount: 2 }).json;
  const missing = item({ 'What is your current location?': '', 'Why us?': 'Because.' });
  const fine = item({ 'Why us?': 'Because.' }, { applicationId: 'app-2', url: 'https://www.linkedin.com/jobs/view/2' });
  const staged = cli(env, ['review', 'stage', '--stdin'], { items: [missing, fine] });
  assert.equal(staged.status, 0, staged.stderr);
  assert.match(staged.json.batchId, /^rb-/);
  assert.deepEqual(staged.json.items.map((entry) => entry.applicationId), ['app-2']);
  assert.equal(staged.json.heldForAttention.length, 1);
  const [held] = staged.json.heldForAttention;
  assert.equal(held.applicationId, 'app-1');
  assert.equal(held.reason, 'profile-has-no-location');
  assert.deepEqual(held.answers, ['What is your current location?']);
  assert.match(staged.json.next, /current location/);

  const attention = cli(env, ['attention', 'list']).json;
  const opened = attention.items.find((entry) => entry.id === held.attentionId);
  assert.ok(opened, 'the attention item is open');
  assert.equal(opened.roundId, roundId);
  assert.equal(opened.blocker, 'unverifiable-claim');
  assert.deepEqual(opened.requiredActions, ['verify-claim']);
  assert.equal(opened.stage, 'questions');
  assert.deepEqual(opened.questions.map((question) => question.prompt), ['What is your current location?']);
  assert.ok(!JSON.stringify(opened).includes('Because.'), 'candidate answers are never stored on the attention queue');

  // Staging the same application again reuses the open attention item instead of adding another.
  const again = cli(env, ['review', 'stage', '--stdin'], { items: [missing] });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.staged, false);
  assert.equal(again.json.batchId, null);
  assert.equal(again.json.heldForAttention[0].attentionId, held.attentionId);
  assert.equal(again.json.heldForAttention[0].reusedAttention, true);
  const rows = (await readFile(join(directory, 'attention.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(rows.length, 1);
});

test('review stage without a round explains the missing location instead of a bare validation error', async (t) => {
  const { env } = await cliEnv(t);
  const staged = cli(env, ['review', 'stage', '--stdin'], { items: [item({ 'What is your current location?': '' })] });
  assert.notEqual(staged.status, 0);
  assert.match(staged.stderr, /has an empty answer to "What is your current location\?" and the profile has no location/);
  assert.doesNotMatch(staged.stderr, /must be a non-empty string/);
});
