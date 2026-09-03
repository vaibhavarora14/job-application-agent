import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { enableCommand, main, pullCommand, pushCommand } from "../src/cli.mjs";
import worker from "../src/worker.mjs";
import { createMemoryR2 } from "./r2-mock.mjs";

const TOKEN = "test-state-token-with-sufficient-length";
const URL = "https://state.example.com";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "job-app-cli-"));
  const stateDir = join(root, "state");
  const configPath = join(root, "cloud", "config.json");
  await mkdir(stateDir, { recursive: true });

  const bindings = { STATE_TOKEN: TOKEN, STATE: createMemoryR2() };
  const fetchImpl = (input, init = {}) =>
    worker.fetch(new Request(input, init), bindings);

  const profileStore = { value: null };
  const env = {
    JOB_APPLICATION_AGENT_STATE_DIR: stateDir,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: configPath,
  };

  const originalEnv = {
    JOB_APPLICATION_AGENT_STATE_DIR: process.env.JOB_APPLICATION_AGENT_STATE_DIR,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: process.env.JOB_APPLICATION_AGENT_CLOUD_CONFIG,
  };
  process.env.JOB_APPLICATION_AGENT_STATE_DIR = stateDir;
  process.env.JOB_APPLICATION_AGENT_CLOUD_CONFIG = configPath;

  return {
    root,
    stateDir,
    configPath,
    fetchImpl,
    profileStore,
    restore() {
      if (originalEnv.JOB_APPLICATION_AGENT_STATE_DIR === undefined) {
        delete process.env.JOB_APPLICATION_AGENT_STATE_DIR;
      } else {
        process.env.JOB_APPLICATION_AGENT_STATE_DIR =
          originalEnv.JOB_APPLICATION_AGENT_STATE_DIR;
      }
      if (originalEnv.JOB_APPLICATION_AGENT_CLOUD_CONFIG === undefined) {
        delete process.env.JOB_APPLICATION_AGENT_CLOUD_CONFIG;
      } else {
        process.env.JOB_APPLICATION_AGENT_CLOUD_CONFIG =
          originalEnv.JOB_APPLICATION_AGENT_CLOUD_CONFIG;
      }
    },
  };
}

test("enable writes 0600 config", async () => {
  const ctx = await setup();
  try {
    await enableCommand(["--url", URL, "--token", TOKEN]);
    const config = JSON.parse(await readFile(ctx.configPath, "utf8"));
    assert.equal(config.url, URL);
    assert.equal(config.token, TOKEN);
    assert.equal((await stat(ctx.configPath)).mode & 0o777, 0o600);
  } finally {
    ctx.restore();
  }
});

test("push then pull roundtrip a file", async () => {
  const ctx = await setup();
  try {
    const resumeBody = '{"importedAt":"2026-09-02"}';
    await writeFile(join(ctx.stateDir, "resume.json"), resumeBody);

    await main(["enable", "--url", URL, "--token", TOKEN], {
      fetchImpl: ctx.fetchImpl,
    });

    const pushResults = await main(["push"], { fetchImpl: ctx.fetchImpl });
    assert.ok(pushResults.some((r) => r.name === "resume.json"));

    await writeFile(join(ctx.stateDir, "resume.json"), '{"stale":true}');

    const pulled = await main(["pull"], { fetchImpl: ctx.fetchImpl });
    assert.ok(pulled.includes("resume.json"));
    assert.equal(
      await readFile(join(ctx.stateDir, "resume.json"), "utf8"),
      resumeBody,
    );
  } finally {
    ctx.restore();
  }
});
