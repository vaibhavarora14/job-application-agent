import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadApplyAllowlist } from "../scripts/ats/apply-url-gate.mjs";
import {
  WORKDAY_FILL_COVERAGE,
  assertNotLiveWorkdayTenant,
  loadWorkdayFixtures,
  htmlToVisibleText,
  planWorkdayFill,
  runWorkdayFixtureFill,
  toAttentionItem,
} from "../scripts/ats/fill-adapters.mjs";
import { detectConfirmation, resolveAtsAdapter } from "../scripts/ats/submit-adapters.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_DIR = join(ROOT, "job-application-agent/fixtures/workday");
const SITE_FIXTURE_DIR = join(ROOT, "site/public/fixtures/workday");
const CLI = join(ROOT, "job-application-agent/scripts/job-application.mjs");
const PROVE = join(ROOT, "job-application-agent/scripts/prove-apply.mjs");
const FILL_SOURCE = fileURLToPath(new URL("../scripts/ats/fill-adapters.mjs", import.meta.url));

const profile = {
  firstName: "Avery",
  lastName: "Quinn",
  email: "avery.quinn@example.com",
  phone: "+1-555-0100",
  location: "Austin, TX",
  streetAddress: "100 Congress Ave",
  country: "United States",
  postalCode: "78701",
  linkedin: "https://www.linkedin.com/in/avery-quinn-fixture",
  workAuthorization: "authorized",
  requiresSponsorship: false,
  experience: [{ title: "Staff Engineer", company: "Example Systems", start: "2020-01" }],
  education: [{ school: "State University", degree: "B.S. Computer Science" }],
};

function valueOf(plan, name) {
  return plan.fills.find((fill) => fill.name === name);
}

test("workday fill coverage is code-level only and does not claim submit", () => {
  assert.equal(WORKDAY_FILL_COVERAGE.fillTested, true);
  assert.equal(WORKDAY_FILL_COVERAGE.submitTested, false);
  assert.equal(WORKDAY_FILL_COVERAGE.stopsBeforeSubmit, true);
  assert.equal(WORKDAY_FILL_COVERAGE.recordsSubmission, false);
  assert.equal(WORKDAY_FILL_COVERAGE.publicCompareStatus, "listed-not-submitted-or-tested");
  assert.deepEqual(WORKDAY_FILL_COVERAGE.steps, [
    "my-information",
    "my-experience",
    "application-questions",
    "voluntary-disclosures",
    "review",
  ]);
});

test("workday fill tests do not request a live tenant", async () => {
  const source = await readFile(FILL_SOURCE, "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    throw new Error("network");
  };
  try {
    assert.throws(
      () => assertNotLiveWorkdayTenant("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Role_R1/apply"),
      /live Workday tenant/,
    );
    const fixtures = loadWorkdayFixtures();
    const review = fixtures.steps.find((step) => step.url.endsWith("/review.html"));
    const planned = planWorkdayFill({
      pageUrl: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Role_R1/apply",
      pageHtml: review.html,
      profile,
    });
    assert.equal(planned.action, "stop_before_submit");
    assert.equal(planned.submitted, false);
    assert.throws(
      () => runWorkdayFixtureFill(profile, {
        pages: [{ url: "https://vendor.myworkday.com/apply", html: review.html }],
      }),
      /live Workday tenant/,
    );
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = original;
  }
});

test("owned workday fixtures stay local and match the site copy", async () => {
  const names = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith(".html")).sort();
  assert.deepEqual(names, [
    "application-questions-judgment.html",
    "application-questions-legal.html",
    "application-questions.html",
    "captcha.html",
    "index.html",
    "my-experience.html",
    "my-information.html",
    "review.html",
    "sign-in.html",
    "voluntary-disclosures.html",
  ]);
  for (const name of names) {
    const html = await readFile(join(FIXTURE_DIR, name), "utf8");
    const hosted = await readFile(join(SITE_FIXTURE_DIR, name), "utf8");
    assert.equal(hosted, html, name);
    assert.equal(/myworkdayjobs\.com|myworkdaysite\.com|myworkday\.com/i.test(html), false, name);
    assert.match(html, /data-fixture="workday"/);
  }
});

test("phase 1 fill walks every Workday step and stops on Review without a submission", () => {
  const result = runWorkdayFixtureFill(profile, { resolvedBlockers: ["demographic"] });
  assert.equal(result.status, "stopped_before_submit");
  assert.equal(result.submitted, false);
  assert.equal(result.recordSubmission, false);
  assert.equal(result.ledgerEntry, null);
  assert.equal(result.telemetryEvent, null);
  assert.equal(result.resumeFieldPresent, true);
  assert.deepEqual(result.steps.map((step) => step.step), WORKDAY_FILL_COVERAGE.steps);
  assert.deepEqual(result.steps.map((step) => step.action), [
    "fill",
    "fill",
    "fill",
    "pause_resolved_skip_sensitive",
    "stop_before_submit",
  ]);

  const info = result.steps[0];
  assert.equal(valueOf(info, "firstName").value, "Avery");
  assert.equal(valueOf(info, "lastName").value, "Quinn");
  assert.equal(valueOf(info, "email").value, profile.email);
  assert.equal(valueOf(info, "phone").value, profile.phone);
  assert.equal(valueOf(info, "address").value, "100 Congress Ave");
  assert.equal(valueOf(info, "city").value, "Austin, TX");
  assert.equal(valueOf(info, "country").value, "US");
  assert.equal(valueOf(info, "postalCode").value, "78701");
  assert.equal(valueOf(info, "linkedin").value, profile.linkedin);

  const experience = result.steps[1];
  assert.equal(valueOf(experience, "jobTitle").value, "Staff Engineer");
  assert.equal(valueOf(experience, "company").value, "Example Systems");
  assert.equal(valueOf(experience, "startDate").value, "2020-01-01");
  assert.equal(valueOf(experience, "school").value, "State University");
  assert.equal(valueOf(experience, "degree").value, "B.S. Computer Science");
  assert.equal(valueOf(experience, "resume").action, "upload_canonical_resume");
  assert.equal("value" in valueOf(experience, "resume"), false);

  const questions = result.steps[2];
  assert.equal(valueOf(questions, "workAuthorization").value, "yes");
  assert.equal(valueOf(questions, "sponsorship").value, "no");
  assert.equal(questions.fills.some((fill) => fill.name === "source"), false);

  assert.deepEqual(result.steps[3].fills, []);
  assert.equal(result.steps[4].action, "stop_before_submit");
  assert.equal(result.clicks.some((click) => click.role === "submit" && click.click), false);
  assert.equal(result.clicks.filter((click) => click.role === "continue" && click.click).length, 3);
  assert.equal(JSON.stringify(result).includes("Woman"), false);
  assert.equal(JSON.stringify(result).includes("application_submitted"), false);
});

test("voluntary disclosures pause and store no demographic answer", () => {
  const fixtures = loadWorkdayFixtures();
  const result = runWorkdayFixtureFill(profile);
  assert.equal(result.status, "paused");
  assert.equal(result.submitted, false);
  assert.equal(result.ledgerEntry, null);
  assert.equal(result.stoppedAt, "voluntary-disclosures");
  assert.equal(result.steps.some((step) => step.step === "review"), false);
  assert.equal(result.attention.blocker, "demographic");
  assert.equal(result.attention.stage, "demographic");
  assert.deepEqual(result.attention.requiredActions, ["choose-demographic"]);
  assert.equal(result.attention.questions, undefined);
  assert.deepEqual(result.steps.at(-1).fills, []);
  assert.equal(result.clicks.some((click) => click.click), true);
  assert.equal(result.steps.at(-1).clicks.every((click) => click.click === false), true);

  const page = planWorkdayFill({ ...fixtures.steps[3], pageHtml: fixtures.steps[3].html, profile });
  assert.equal(page.pauseKind, "demographic");
  assert.equal(JSON.stringify(page).includes("Woman"), false);
});

test("account creation, sign-in, CAPTCHA, and legal questions use the existing attention pauses", () => {
  const fixtures = loadWorkdayFixtures();
  const account = planWorkdayFill({ ...fixtures.createAccount, pageHtml: fixtures.createAccount.html, profile });
  assert.equal(account.action, "pause");
  assert.equal(account.pauseKind, "account-creation");
  assert.equal(account.attention.blocker, "authentication");
  assert.deepEqual(account.attention.requiredActions, ["sign-in"]);
  assert.deepEqual(account.fills, []);
  assert.equal(account.clicks.every((click) => click.click === false), true);
  assert.equal(JSON.stringify(account.fills).includes("password"), false);

  const stillPaused = planWorkdayFill({
    ...fixtures.createAccount,
    pageHtml: fixtures.createAccount.html,
    profile,
    resolvedBlockers: ["authentication"],
  });
  assert.equal(stillPaused.action, "pause");

  const signIn = planWorkdayFill({ ...fixtures.signIn, pageHtml: fixtures.signIn.html, profile });
  assert.equal(signIn.pauseKind, "sign-in");
  assert.equal(signIn.attention.blocker, "authentication");
  assert.deepEqual(signIn.fills, []);
  assert.equal(signIn.clicks.every((click) => click.click === false), true);

  const captcha = planWorkdayFill({ ...fixtures.captcha, pageHtml: fixtures.captcha.html, profile });
  assert.equal(captcha.pauseKind, "captcha");
  assert.equal(captcha.attention.blocker, "captcha");
  assert.deepEqual(captcha.attention.requiredActions, ["complete-captcha"]);
  assert.deepEqual(captcha.fills, []);
  assert.equal(captcha.clicks.every((click) => click.click === false), true);

  const legal = planWorkdayFill({ ...fixtures.legal, pageHtml: fixtures.legal.html, profile });
  assert.equal(legal.action, "pause");
  assert.equal(legal.pauseKind, "legal");
  assert.equal(legal.attention.blocker, "legal-attestation");
  assert.equal(legal.attention.stage, "legal");
  assert.deepEqual(legal.attention.requiredActions, ["review-legal"]);
  assert.equal(valueOf(legal, "workAuthorization").value, "yes");
  assert.equal(legal.fills.some((fill) => fill.name === "terms"), false);
  assert.equal(legal.clicks.every((click) => click.click === false), true);

  const judgment = planWorkdayFill({ ...fixtures.judgment, pageHtml: fixtures.judgment.html, profile });
  assert.equal(judgment.attention.blocker, "judgment");
  assert.deepEqual(judgment.attention.requiredActions, ["provide-judgment"]);
  assert.match(judgment.attention.questions[0].prompt, /why do you want to work here/i);
  assert.equal(judgment.fills.some((fill) => fill.name === "why"), false);
  assert.equal(JSON.stringify(judgment.attention).includes("drafted"), false);
});

const AUTHORIZATION_FORM = `<main data-step="application-questions"><h1>Application Questions</h1>
  <fieldset>
    <legend>Are you legally authorized to work in the United States? *</legend>
    <div>
      <label><input type="radio" name="workAuthorization" value="yes" required /> Yes</label>
      <label><input type="radio" name="workAuthorization" value="no" /> No</label>
    </div>
  </fieldset>
  <button type="button" data-action="continue">Save and Continue</button>
</main>`;

function authorizationPlan(workAuthorization) {
  return planWorkdayFill({
    pageUrl: "https://jobappagent.com/fixtures/workday/application-questions.html",
    pageHtml: AUTHORIZATION_FORM,
    profile: { workAuthorization },
  });
}

test("street address is not copied from a coarse location", () => {
  const fixtures = loadWorkdayFixtures();
  const info = fixtures.steps.find((step) => step.url.endsWith("/my-information.html"));
  const coarse = planWorkdayFill({
    ...info,
    pageHtml: info.html,
    profile: { ...profile, streetAddress: "", addressLine1: "", location: "Austin, TX" },
  });
  assert.equal(coarse.action, "needs_profile");
  assert.equal(coarse.fills.some((fill) => fill.name === "address"), false);
  assert.equal(valueOf(coarse, "city").value, "Austin, TX");
  assert.ok(coarse.unfilledRequired.some((field) => field.name === "address"));
  assert.equal(coarse.clicks.every((click) => click.click === false), true);

  const line = planWorkdayFill({
    ...info,
    pageHtml: info.html,
    profile: { ...profile, streetAddress: "", addressLine1: "100 Congress Ave" },
  });
  assert.equal(valueOf(line, "address").value, "100 Congress Ave");
  assert.equal(valueOf(line, "city").value, "Austin, TX");
});

test("negated or sponsorship-only authorization never selects yes", () => {
  for (const phrase of [
    "not legally authorized to work in the United States",
    "not currently authorized",
    "I am not authorized",
    "unauthorized",
    "not eligible to work",
  ]) {
    const plan = authorizationPlan(phrase);
    assert.equal(plan.action, "fill", phrase);
    assert.equal(valueOf(plan, "workAuthorization").value, "no", phrase);
    assert.notEqual(valueOf(plan, "workAuthorization").value, "yes", phrase);
  }

  for (const phrase of [
    "will require sponsorship",
    "requires sponsorship",
    "authorized to work but will require sponsorship",
    "maybe",
  ]) {
    const plan = authorizationPlan(phrase);
    assert.equal(plan.action, "pause", phrase);
    assert.equal(plan.attention.blocker, "ambiguous-authorization", phrase);
    assert.equal(plan.fills.some((fill) => fill.name === "workAuthorization" && fill.value === "yes"), false, phrase);
    assert.equal(plan.clicks.every((click) => click.click === false), true, phrase);
  }

  const allowed = authorizationPlan("authorized to work and will not require sponsorship");
  assert.equal(allowed.action, "fill");
  assert.equal(valueOf(allowed, "workAuthorization").value, "yes");
});

test("native date inputs get a full calendar date or stay unfilled", () => {
  const form = (type) => `<main data-step="my-experience"><h1>My Experience</h1>
    <label for="startDate">Start Date *</label>
    <input id="startDate" name="startDate" type="${type}" required />
    <button type="button" data-action="continue">Save and Continue</button>
  </main>`;
  const planFor = (type, start) => planWorkdayFill({
    pageUrl: "https://jobappagent.com/fixtures/workday/my-experience.html",
    pageHtml: form(type),
    profile: { experience: [{ start, title: "Staff Engineer", company: "Example Systems" }] },
  });

  const month = planFor("date", "2020-01");
  assert.equal(month.action, "fill");
  assert.equal(valueOf(month, "startDate").value, "2020-01-01");
  assert.equal(month.clicks.some((click) => click.role === "continue" && click.click), true);

  const full = planFor("date", "2020-01-15");
  assert.equal(valueOf(full, "startDate").value, "2020-01-15");

  const text = planFor("text", "2020-01");
  assert.equal(text.action, "fill");
  assert.equal(valueOf(text, "startDate").value, "2020-01");

  for (const start of ["2020-13", "2021-02-31", "January 2020", "2020-1"]) {
    const plan = planFor("date", start);
    assert.equal(plan.action, "needs_profile", start);
    assert.equal(plan.fills.some((fill) => fill.name === "startDate"), false, start);
    assert.ok(plan.unfilledRequired.some((field) => field.name === "startDate"), start);
    assert.equal(plan.clicks.every((click) => click.click === false), true, start);
    assert.equal(JSON.stringify(plan.fills).includes(start), false, start);
  }
});

test("unclear work authorization pauses instead of guessing", () => {
  const fixtures = loadWorkdayFixtures();
  const questions = fixtures.steps.find((step) => step.url.endsWith("/application-questions.html"));
  const plan = planWorkdayFill({
    ...questions,
    pageHtml: questions.html,
    profile: { ...profile, workAuthorization: "unclear" },
  });
  assert.equal(plan.action, "pause");
  assert.equal(plan.attention.blocker, "ambiguous-authorization");
  assert.deepEqual(plan.attention.requiredActions, ["provide-authorization"]);
  assert.equal(plan.fills.some((fill) => fill.name === "workAuthorization"), false);
});

test("visible text strips script and style tags and decodes entities once", () => {
  assert.equal(htmlToVisibleText("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(htmlToVisibleText("&AMP;"), "&");
  assert.equal(htmlToVisibleText("&amp;amp;"), "&amp;");
  assert.equal(htmlToVisibleText("&amp;lt;"), "&lt;");
  assert.equal(htmlToVisibleText("&amp;nbsp;"), "&nbsp;");
  assert.equal(htmlToVisibleText("A&nbsp;B"), "A B");
  assert.equal(htmlToVisibleText("Say &quot;hi&quot;"), "Say \"hi\"");
  assert.equal(htmlToVisibleText("it&#39;s &apos;ok&apos;"), "it's 'ok'");
  assert.equal(htmlToVisibleText("1 < 2"), "1 < 2");
  assert.equal(htmlToVisibleText("<span title=\"a>b\">OK</span>"), "OK");
  assert.equal(htmlToVisibleText("<script>sign in</script>My Information"), "My Information");
  assert.equal(htmlToVisibleText("<ScRiPt>sign in</sCrIpT>My Information"), "My Information");
  assert.equal(htmlToVisibleText("<script type=\"text/javascript\" data-x=\"a>b\">secret</script>OK"), "OK");
  assert.equal(htmlToVisibleText("Before<script>sign in"), "Before");
  assert.equal(htmlToVisibleText("<style>sign in</style>After"), "After");
  assert.equal(htmlToVisibleText("<STYLE>sign in</STYLE>After"), "After");
  assert.equal(htmlToVisibleText("Before<style>sign in"), "Before");
  assert.equal(
    htmlToVisibleText("&amp;lt;script&amp;gt;sign in&amp;lt;/script&amp;gt;"),
    "&lt;script&gt;sign in&lt;/script&gt;",
  );

  const plan = planWorkdayFill({
    pageUrl: "https://jobappagent.com/fixtures/workday/my-information.html",
    pageHtml: `<main data-step="my-information"><h1>My Information</h1>
      <script>Please sign in and complete the CAPTCHA</script>
      <style>sign in</style>
      <label for="firstName">First Name *</label>
      <input id="firstName" name="firstName" required />
      <button type="button" data-action="continue">Save and Continue</button>
    </main>`,
    profile,
  });
  assert.equal(plan.step, "my-information");
  assert.equal(plan.action, "fill");
  assert.equal(plan.attention, null);
  assert.equal(valueOf(plan, "firstName").value, "Avery");
});

test("a heading is enough to classify a Workday step", () => {
  const plan = planWorkdayFill({
    pageUrl: "https://jobappagent.com/fixtures/workday/my-information.html",
    pageHtml: `<main><h1>My Information</h1><form>
      <label for="firstName">First Name *</label>
      <input id="firstName" name="firstName" required />
      <label for="employeeId">Employee ID *</label>
      <input id="employeeId" name="employeeId" required />
      <button type="button" data-action="continue">Save and Continue</button>
    </form></main>`,
    profile,
  });
  assert.equal(plan.step, "my-information");
  assert.equal(plan.action, "needs_profile");
  assert.equal(valueOf(plan, "firstName").value, "Avery");
  assert.equal(plan.clicks.every((click) => click.click === false), true);
  assert.equal(plan.submitted, false);
});

test("workday confirmation text is not a submission and other ATS adapters are unchanged", () => {
  assert.equal(resolveAtsAdapter("https://acme.wd5.myworkdayjobs.com/en-US/job/Role_R1/apply").id, "workday");
  assert.equal(resolveAtsAdapter("https://jobappagent.com/fixtures/workday/review.html").id, "workday");
  assert.equal(resolveAtsAdapter("https://boards.greenhouse.io/acme/jobs/1").id, "generic");
  assert.equal(resolveAtsAdapter("https://jobs.ashbyhq.com/acme/role").id, "ashby");
  assert.equal(resolveAtsAdapter("https://jobs.lever.co/leverdemo/abc/apply").id, "generic");
  const workday = detectConfirmation({
    pageUrl: "https://jobappagent.com/fixtures/workday/review.html",
    pageText: "Thank you for applying",
  });
  assert.equal(workday.confirmed, false);
  assert.equal(workday.submitted, false);
  assert.equal(detectConfirmation({
    pageUrl: "https://jobs.ashbyhq.com/x/application-submitted",
  }).confirmed, true);
});

test("prove-apply still submits only greenhouse, lever, and ashby fixtures", () => {
  const allowlist = loadApplyAllowlist();
  const workday = allowlist.find((entry) => entry.id === "fixture-workday");
  assert.equal(workday.allowSubmit, false);
  assert.equal(workday.ats, "workday");
  const proved = execFileSync(process.execPath, [PROVE], {
    encoding: "utf8",
    env: { ...process.env, LIVE_APPLY: "0" },
  });
  const body = JSON.parse(proved);
  assert.deepEqual(body.results.map((result) => result.url), [
    "https://jobappagent.com/fixtures/greenhouse/",
    "https://jobappagent.com/fixtures/lever/",
    "https://jobappagent.com/fixtures/ashby/",
  ]);
});

test("workday pauses are accepted by attention add and record nothing submitted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "workday-fill-attention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "telemetry.json"), JSON.stringify({
    version: 1,
    enabled: false,
    disclosed: true,
    graceConsumed: true,
    installationEventPending: false,
  }));
  const env = {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_HOME: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, "cloud-config.json"),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: "http://127.0.0.1:9",
    JOB_APPLICATION_AGENT_TELEMETRY_URL: "http://127.0.0.1:9",
  };
  const started = JSON.parse(execFileSync(process.execPath, [CLI, "round", "start", "--stdin"], {
    env,
    encoding: "utf8",
    input: JSON.stringify({ requestedCount: 1 }),
  }));
  const fixtures = loadWorkdayFixtures();
  const pages = [fixtures.createAccount, fixtures.signIn, fixtures.captcha, fixtures.legal, fixtures.steps[3]];
  for (const [index, page] of pages.entries()) {
    const plan = planWorkdayFill({ ...page, pageHtml: page.html, profile });
    const item = toAttentionItem(plan, {
      roundId: started.roundId,
      applicationId: `workday-pause-${index}`,
    });
    assert.equal("answers" in item, false);
    assert.equal(JSON.stringify(item).includes("Woman"), false);
    const added = JSON.parse(execFileSync(process.execPath, [CLI, "attention", "add", "--stdin"], {
      env,
      encoding: "utf8",
      input: JSON.stringify(item),
    }));
    assert.equal(added.blocker, plan.attention.blocker);
    assert.deepEqual(added.requiredActions, plan.attention.requiredActions);
  }
  const listed = JSON.parse(execFileSync(process.execPath, [CLI, "attention", "list"], { env, encoding: "utf8" }));
  assert.equal(listed.count, pages.length);
  await assert.rejects(readFile(join(directory, "applications.ndjson"), "utf8"));
});
