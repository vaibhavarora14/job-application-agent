import { mapFields } from '../llm.mjs';
import { getProfile } from '../skill.mjs';
import { openDb } from '../db.mjs';
import { enqueue } from '../queue.mjs';
import { clickSubmit, fillMappedFields, pageText, restoreVerifiedFields, uploadResume, withPage } from './browser.mjs';
import { evaluateSubmitGate } from './gate.mjs';
import { recordHandoff } from './handoff.mjs';
import { markSubmitted, setApplicationStatus, upsertApplication } from './applications.mjs';
import { mapQuestions } from './prefill.mjs';
import { confirmationLooksSuccessful, detectHardStops } from './signals.mjs';
import { ledgerCheck } from '../skill.mjs';

export async function fillGreenhouse({ jobId, roundId = null, env = process.env, fetchImpl = fetch }) {
  const db = openDb(env);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return { skipped: true, reason: 'missing-job' };
  const stored = getProfile(env);
  if (!stored.configured || !stored.resumePath) {
    recordHandoff({
      applicationId: job.id,
      jobId,
      url: job.url,
      stage: 'resume',
      blocker: 'upload',
      instructions: 'Profile or résumé is missing. Finish onboarding.',
      env,
    });
    return { handedOff: true, reason: 'profile' };
  }

  const applicationId = upsertApplication({ job, roundId, status: 'filling', env });
  const assessment = db.prepare('SELECT * FROM assessments WHERE job_id = ?').get(jobId);
  const questions = safeJson(job.questions_json, []);
  const { mapped, leftover } = mapQuestions(questions, stored.profile, stored.extras, { channel: 'greenhouse', env });

  if (leftover.length) {
    const llmMapped = await mapFields({
      labels: leftover.map((item) => item.label),
      profile: stored.profile,
      resumeText: stored.extras.motivationBlurb,
      env,
      fetchImpl,
    });
    for (const item of leftover) {
      const hit = llmMapped.find((row) => row.label === item.label && row.value && row.confidence >= 0.7);
      if (hit) mapped.push({ ...item, value: hit.value, key: 'llm', source: 'llm' });
    }
  }

  const leftoverRequired = leftover.filter((item) => item.required && !mapped.some((row) => row.label === item.label));
  if (leftoverRequired.length) {
    setApplicationStatus(applicationId, 'ready', {}, env);
    recordHandoff({
      applicationId,
      jobId,
      url: job.url,
      stage: 'questions',
      blocker: 'judgment',
      instructions: `Unmapped required fields: ${leftoverRequired.map((item) => item.label).join(', ')}`,
      env,
    });
    return { handedOff: true, reason: 'unclear-fields' };
  }

  return withPage(env, async (page) => {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1000);
    const text = await pageText(page);
    const linkedIn = /apply with linkedin/i.test(text);
    const hardStop = detectHardStops(text, { hasLinkedInOverlay: linkedIn });
    if (hardStop) {
      setApplicationStatus(applicationId, 'ready', {}, env);
      recordHandoff({
        applicationId,
        jobId,
        url: job.url,
        stage: hardStop.stage,
        blocker: hardStop.blocker,
        instructions: `${hardStop.reason}. Finish this on the company page, then mark it done.`,
        env,
      });
      return { handedOff: true, reason: hardStop.blocker };
    }

    await fillMappedFields(page, mapped.length ? mapped : inferBasicFields(stored));
    const resumeAttached = await uploadResume(page, stored.resumePath);
    await restoreVerifiedFields(page, mapped.length ? mapped : inferBasicFields(stored));

    const ledger = await ledgerCheck({ id: applicationId, url: job.url, company: job.company, role: job.role }, env);
    const gate = evaluateSubmitGate({
      submissionMode: stored.profile.submissionMode,
      ledgerClean: !ledger.duplicate,
      decision: assessment?.decision || 'ask',
      autoEligible: Boolean(assessment?.auto_eligible),
      channel: 'greenhouse',
      requiredFilled: leftoverRequired.length === 0,
      resumeAttached,
      hardStop: null,
      env,
    });

    if (!gate.ok) {
      setApplicationStatus(applicationId, 'ready', {}, env);
      recordHandoff({
        applicationId,
        jobId,
        url: job.url,
        stage: stored.profile.submissionMode === 'review-each' ? 'review' : 'submission',
        blocker: stored.profile.submissionMode === 'review-each' ? 'judgment' : 'other',
        instructions: `Filled. Submit gate blocked: ${gate.failures.join(', ')}. Open the page and press Send if you want.`,
        env,
      });
      return { handedOff: true, reason: 'gate', failures: gate.failures };
    }

    enqueue('submit', { jobId, applicationId, roundId }, env);
    setApplicationStatus(applicationId, 'ready', {}, env);
    return { queuedSubmit: true, applicationId };
  });
}

export async function submitGreenhouse({ jobId, applicationId, env = process.env }) {
  const db = openDb(env);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  const stored = getProfile(env);
  const assessment = db.prepare('SELECT * FROM assessments WHERE job_id = ?').get(jobId);
  if (!job) return { skipped: true };

  return withPage(env, async (page) => {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(800);
    const before = await pageText(page);
    const hardStop = detectHardStops(before);
    if (hardStop) {
      recordHandoff({
        applicationId,
        jobId,
        url: job.url,
        stage: hardStop.stage,
        blocker: hardStop.blocker,
        instructions: `${hardStop.reason}. Did not click Submit.`,
        env,
      });
      return { handedOff: true };
    }
    const clicked = await clickSubmit(page);
    if (!clicked) {
      recordHandoff({
        applicationId,
        jobId,
        url: job.url,
        stage: 'submission',
        blocker: 'site-error',
        instructions: 'Could not find a Submit control. Finish on the company page.',
        env,
      });
      return { handedOff: true, reason: 'no-submit' };
    }
    await page.waitForTimeout(2500);
    const after = await pageText(page);
    const confirm = confirmationLooksSuccessful(after, page.url());
    if (!confirm.ok) {
      recordHandoff({
        applicationId,
        jobId,
        url: page.url(),
        stage: 'confirmation',
        blocker: 'site-error',
        instructions: 'Clicked Submit once. Confirmation was unclear — will not click again. Confirm or abandon from the inbox.',
        env,
      });
      return { handedOff: true, reason: 'unclear-confirmation', clicked: true };
    }
    return markSubmitted({
      applicationId,
      job,
      score: assessment?.score || 0,
      approval: stored.profile.submissionMode === 'routine-auto' ? 'STANDING AUTHORIZATION' : 'APPROVE SUBMIT',
      confirmationUrl: page.url(),
      confirmationExcerpt: confirm.excerpt,
      env,
    });
  });
}

function inferBasicFields(stored) {
  const { profile, extras } = stored;
  const parts = String(profile.name || '').split(/\s+/);
  return [
    { label: 'first name', key: 'firstName', value: parts[0], source: 'profile' },
    { label: 'last name', key: 'lastName', value: parts.slice(1).join(' ') || parts[0], source: 'profile' },
    { label: 'email', key: 'email', value: profile.email, source: 'profile' },
    { label: 'phone', key: 'phone', value: profile.phone, source: 'profile' },
    { label: 'linkedin', key: 'linkedin', value: profile.linkedin, source: 'profile' },
    { label: 'how did you hear', key: 'howHeard', value: extras.howHeard, source: 'profile' },
  ].filter((item) => item.value);
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
