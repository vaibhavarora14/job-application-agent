import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertApplyUrlAllowed,
  checkApplyUrlAllowed,
  findAllowlistedApply,
  isFixtureOrSandboxApply,
  loadApplyAllowlist,
  resolveApplyKind,
  shouldEnforceApplyUrlGate,
} from "../scripts/ats/apply-url-gate.mjs";
import { validateLedgerEntry } from "../scripts/job-application.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "job-application-agent/scripts/job-application.mjs");
const PROVE = join(ROOT, "job-application-agent/scripts/prove-apply.mjs");

test("allowlist loads fixture and vendor-sandbox entries", () => {
  const list = loadApplyAllowlist();
  assert.ok(list.some((e) => e.id === "fixture-greenhouse" && e.kind === "fixture"));
  assert.ok(list.some((e) => e.id === "vendor-leverdemo" && e.kind === "vendor-sandbox"));
  assert.ok(!list.some((e) => /confluent/i.test(e.url)));
});

test("assertApplyUrlAllowed accepts owned fixture URLs", () => {
  for (const url of [
    "https://jobappagent.com/fixtures/greenhouse/",
    "https://jobappagent.com/fixtures/lever/confirmation.html",
    "http://127.0.0.1:4173/fixtures/ashby/",
    "http://localhost:4173/fixtures/ashby/confirmation.html",
  ]) {
    const result = assertApplyUrlAllowed(url, { liveApply: false });
    assert.equal(result.allowed, true);
    assert.equal(result.applyKind, "fixture");
    assert.equal(result.entry?.kind, "fixture");
  }
});

test("assertApplyUrlAllowed accepts vendor sandboxes", () => {
  const ashby = assertApplyUrlAllowed("https://jobs.ashbyhq.com/ashby-embed-demo-org/role-1", { liveApply: false });
  assert.equal(ashby.applyKind, "vendor-sandbox");
  const lever = assertApplyUrlAllowed("https://jobs.lever.co/leverdemo/abc/apply", { liveApply: false });
  assert.equal(lever.applyKind, "vendor-sandbox");
});

test("Ashby for-testing title marker is required", () => {
  assert.equal(
    findAllowlistedApply("https://jobs.ashbyhq.com/acme/job-1"),
    null,
  );
  const marked = findAllowlistedApply("https://jobs.ashbyhq.com/acme/job-1", {
    pageTitle: "[ASHBY] - For Testing Use Only — Demo Role",
  });
  assert.equal(marked?.id, "vendor-ashby-for-testing");
});

test("assertApplyUrlAllowed rejects real employer URL without LIVE_APPLY", () => {
  assert.throws(
    () => assertApplyUrlAllowed("https://jobs.ashbyhq.com/confluent/staff-engineer", { liveApply: false }),
    /allowlist|LIVE_APPLY/i,
  );
  const soft = checkApplyUrlAllowed("https://boards.greenhouse.io/acme/jobs/1", { liveApply: false });
  assert.equal(soft.ok, false);
});

test("LIVE_APPLY=1 accepts real employer URL and logs", () => {
  const logs = [];
  const result = assertApplyUrlAllowed("https://jobs.ashbyhq.com/confluent/staff-engineer", {
    liveApply: true,
    log: (message) => logs.push(message),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.applyKind, "live");
  assert.equal(result.liveApply, true);
  assert.ok(logs.some((line) => /LIVE_APPLY/i.test(line)));
});

test("shouldEnforceApplyUrlGate defaults", () => {
  assert.equal(shouldEnforceApplyUrlGate({ CI: "true" }), true);
  assert.equal(shouldEnforceApplyUrlGate({ PROVE_APPLY: "1" }), true);
  assert.equal(shouldEnforceApplyUrlGate({ APPLY_URL_GATE: "0", CI: "true" }), false);
  assert.equal(shouldEnforceApplyUrlGate({}), false);
});

test("resolveApplyKind and validateLedgerEntry mark fixture applies", () => {
  assert.equal(resolveApplyKind("https://jobappagent.com/fixtures/greenhouse/"), "fixture");
  assert.equal(resolveApplyKind("https://jobs.ashbyhq.com/confluent/x"), "live");

  const entry = validateLedgerEntry({
    id: "fixture-gh-1",
    company: "Fixture Co",
    role: "Senior Software Engineer",
    url: "https://jobappagent.com/fixtures/greenhouse/",
    source: "greenhouse",
    applicationChannel: "greenhouse",
    score: 90,
    status: "submitted",
    submittedAt: "2026-09-30T00:00:00.000Z",
    approval: "STANDING AUTHORIZATION",
  });
  assert.equal(entry.applyKind, "fixture");
  assert.equal(isFixtureOrSandboxApply(entry), true);
});

test("ledger add stores applyKind=fixture and excludes from review totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jaa-fixture-ledger-"));
  await mkdir(join(dir, "secure"), { recursive: true });
  const env = {
    ...process.env,
    JOB_APPLICATION_AGENT_HOME: dir,
    JOB_APPLICATION_AGENT_STATE_DIR: dir,
  };
  const input = {
    id: "fixture-ledger-1",
    company: "Fixture Co",
    role: "Senior Software Engineer",
    url: "https://jobappagent.com/fixtures/greenhouse/",
    source: "greenhouse",
    applicationChannel: "greenhouse",
    score: 88,
    status: "submitted",
    submittedAt: "2026-09-30T12:00:00.000Z",
    approval: "STANDING AUTHORIZATION",
  };
  const run = spawnSync(process.execPath, [CLI, "ledger", "add", "--stdin"], {
    env,
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.recorded, "fixture-ledger-1");
  assert.equal(payload.review.submittedTotal, 0);

  const lines = (await import("node:fs/promises")).readFile;
  const raw = await lines(join(dir, "applications.ndjson"), "utf8");
  const stored = JSON.parse(raw.trim().split("\n").at(-1));
  assert.equal(stored.applyKind, "fixture");
});

test("prove-apply lists fixtures and refuses Confluent without LIVE_APPLY", () => {
  const ok = spawnSync(process.execPath, [PROVE], { encoding: "utf8", env: { ...process.env, LIVE_APPLY: "0" } });
  assert.equal(ok.status, 0, ok.stderr);
  const body = JSON.parse(ok.stdout);
  assert.ok(body.results.every((r) => r.applyKind === "fixture"));

  const blocked = spawnSync(
    process.execPath,
    [PROVE, "--url", "https://jobs.ashbyhq.com/confluent/x"],
    { encoding: "utf8", env: { ...process.env, LIVE_APPLY: "0" } },
  );
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /allowlist|LIVE_APPLY/i);

  const allowed = spawnSync(
    process.execPath,
    [PROVE, "--url", "https://jobs.ashbyhq.com/confluent/x"],
    { encoding: "utf8", env: { ...process.env, LIVE_APPLY: "1" } },
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /LIVE_APPLY/);
});

test("fixture HTML pages include thank-you confirmation copy", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const ats of ["greenhouse", "lever", "ashby"]) {
    const html = await readFile(join(ROOT, `job-application-agent/fixtures/${ats}/confirmation.html`), "utf8");
    assert.match(html, /Thank you for applying \(fixture\)/i);
    const form = await readFile(join(ROOT, `job-application-agent/fixtures/${ats}/index.html`), "utf8");
    assert.match(form, /type="submit"|Submit application/i);
    assert.match(form, /name="email"|id="email"/i);
  }
});
