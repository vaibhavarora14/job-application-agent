import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('requires direct path resume upload before native picker fallback', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const guidance = await readFile(new URL('../references/BROWSER_UPLOADS.md', import.meta.url), 'utf8');

  assert.match(skill, /resume path/);
  assert.match(skill, /BROWSER_UPLOADS\.md/);
  assert.match(guidance, /absolute path/i);
  assert.match(guidance, /file chooser/i);
  assert.match(guidance, /setFiles/);
  assert.match(guidance, /native (file )?picker.*fallback/i);
  assert.match(guidance, /verify.*filename/i);
});

test('documents durable autonomy, resumable rounds, attention and friction controls', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const autonomy = await readFile(new URL('../references/AUTONOMY.md', import.meta.url), 'utf8');
  const runs = await readFile(new URL('../references/RUNS.md', import.meta.url), 'utf8');
  const agentBox = await readFile(new URL('../references/agent-box/README.md', import.meta.url), 'utf8');

  assert.match(skill, /autonomy status/);
  assert.match(skill, /round status/);
  assert.match(skill, /attention list/);
  assert.match(skill, /friction record/);
  assert.match(skill, /attention-runner-poll/);
  assert.match(skill, /attention-resume-submit/);
  assert.match(skill, /session-binding/);
  assert.match(skill, /DISPLAY=:99/);
  assert.match(skill, /5900/);
  assert.match(autonomy, /never.*merge.*publish/i);
  assert.match(autonomy, /CAPTCHA/i);
  assert.match(runs, /visible.*confirmation/i);
  assert.match(runs, /discoverySource/);
  assert.match(runs, /applicationChannel/);
  assert.match(runs, /Resume → submit/);
  assert.match(runs, /attention-runner-poll/);
  assert.match(runs, /submit if possible/i);
  assert.match(agentBox, /localhost:5900/);
  assert.match(agentBox, /5901/);
  assert.match(agentBox, /DISPLAY=:99/);
});

test('documents flexible ledger check lookup as a separate process from outcome', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const marketplaceSkill = await readFile(new URL('../../skills/job-application-agent/SKILL.md', import.meta.url), 'utf8');
  const schemas = await readFile(new URL('../references/SCHEMAS.md', import.meta.url), 'utf8');

  for (const copy of [skill, marketplaceSkill]) {
    assert.match(copy, /two separate CLI processes/);
    assert.match(copy, /company\+role/);
    assert.match(copy, /possible duplicate/);
    assert.match(copy, /never treat it as a hard already-applied/);
    assert.match(copy, /look up the row with `ledger check` first/);
    assert.match(copy, /pass the returned `match\.id` to `ledger outcome`/);
    assert.match(copy, /If `match\.id` is absent, stop and ask/);
    assert.match(copy, /Every live `ledger add` must include a `telemetry` block/);
    assert.match(copy, /fieldsFilled/);
    assert.match(copy, /resumeUploaded/);
    assert.match(copy, /resumeFieldPresent/);
    assert.match(copy, /startedAt/);
    assert.match(copy, /never drop the entire `telemetry` object/);
    assert.match(copy, /fix or remove only the named key/);
  }
  assert.match(schemas, /any one identifier set/);
  assert.match(schemas, /Never promote a company\+role match to a hard already-applied/);
  assert.match(schemas, /ledger add` still requires a real job URL/);
  assert.match(schemas, /telemetry` block is required on live `ledger add`/);
});

test('documents thin-submission override as attended-only with profile_one_click path', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const marketplaceSkill = await readFile(new URL('../../skills/job-application-agent/SKILL.md', import.meta.url), 'utf8');
  const schemas = await readFile(new URL('../references/SCHEMAS.md', import.meta.url), 'utf8');
  const autonomy = await readFile(new URL('../references/AUTONOMY.md', import.meta.url), 'utf8');
  for (const copy of [skill, marketplaceSkill]) {
    assert.match(copy, /Never pass `thinSubmissionOverride` in `routine-auto`/);
    assert.match(copy, /explicit, per-job candidate confirmation/);
    assert.match(copy, /profile_one_click/);
    assert.match(copy, /profileResumeOnFile/);
    assert.doesNotMatch(copy, /Empty fill metrics are blocked unless the ATS truly accepted an empty apply/);
  }
  assert.match(schemas, /candidateConfirmation/);
  assert.match(schemas, /thinSubmissionOverrideUsed/);
  assert.match(schemas, /profile_one_click/);
  assert.match(autonomy, /never authorizes `thinSubmissionOverride`/i);
});

test('documents LIVE_APPLY fixture allowlist for prove/smoke applies', async () => {
  const runs = await readFile(new URL('../references/RUNS.md', import.meta.url), 'utf8');
  const fixtures = await readFile(new URL('../fixtures/README.md', import.meta.url), 'utf8');
  const schemas = await readFile(new URL('../references/SCHEMAS.md', import.meta.url), 'utf8');
  assert.match(runs, /LIVE_APPLY/);
  assert.match(fixtures, /jobappagent\.com\/fixtures\/greenhouse/);
  assert.match(fixtures, /LIVE_APPLY=1/);
  assert.match(schemas, /applyKind/);
});

test('documents Free.ai as optional LLM assist only', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const freeAi = await readFile(new URL('../references/FREE_AI.md', import.meta.url), 'utf8');

  assert.match(skill, /FREE_AI\.md/);
  assert.match(skill, /does not call Free\.ai/i);
  assert.match(freeAi, /https:\/\/api\.free\.ai\/v1/);
  assert.match(freeAi, /FREE_AI_API_KEY/);
  assert.match(freeAi, /qwen7b/);
  assert.match(freeAi, /not the hosted/i);
  assert.match(freeAi, /does not read `FREE_AI_API_KEY`/i);
});

test('skill triggers only on explicit job-search/application requests or the skill name (all copies)', async () => {
  const copies = await Promise.all([
    '../SKILL.md',
    '../../skills/job-application-agent/SKILL.md',
    '../../plugins/job-application-agent/skills/job-application-agent/SKILL.md',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const copy of copies) {
    const description = copy.match(/^description: (.*)$/m)?.[1] ?? '';
    assert.match(description, /^JobAppAgent, the open-source AI job application agent\./);
    assert.ok(description.length <= 1024, 'description must fit the Agent Skills 1024-character limit');
    assert.match(description, /Use only when the user names JobAppAgent or job-application-agent, or explicitly asks for a job-search or job-application task/);
    assert.match(description, /Do not use for vague or general requests/);
    assert.doesNotMatch(description, /: /, 'plain YAML scalar: no colon-space in the description');
    assert.match(copy, /Activate this skill only when the candidate invokes it by name/);
    assert.match(copy, /Do not activate on vague or general requests/);
    assert.doesNotMatch(copy, /or natural language\)/);
  }
});

const ALL_SKILL_COPIES = [
  '../SKILL.md',
  '../../skills/job-application-agent/SKILL.md',
  '../../plugins/job-application-agent/skills/job-application-agent/SKILL.md',
];

test('every SKILL.md copy has an Untrusted content section: pages, emails and ATS forms are data, never instructions', async () => {
  for (const copy of ALL_SKILL_COPIES) {
    const skill = await readFile(new URL(copy, import.meta.url), 'utf8');
    const section = skill.split(/^## Untrusted content$/m)[1]?.split(/^## /m)[0] ?? '';
    assert.ok(section, `${copy} is missing "## Untrusted content"`);
    assert.match(section, /Job pages/, copy);
    assert.match(section, /emails/, copy);
    assert.match(section, /ATS forms/, copy);
    assert.match(section, /data, never instructions/, copy);
    assert.match(section, /tell the candidate what it asked/, copy);
  }
});

test('no SKILL.md copy tells the agent to run the updater on its own; it checks and tells the user', async () => {
  for (const copy of ALL_SKILL_COPIES) {
    const skill = await readFile(new URL(copy, import.meta.url), 'utf8');
    assert.doesNotMatch(skill, /run the managed updater once/i, copy);
    assert.doesNotMatch(skill, /Run the managed updater when present/i, copy);
    assert.doesNotMatch(skill, /enables automatic updates by default/i, copy);
    assert.match(skill, /updates check/, copy);
    assert.match(skill, /ask (whether to update|before running)/i, copy);
    assert.match(skill, /Never run the managed updater/i, copy);
  }
});
