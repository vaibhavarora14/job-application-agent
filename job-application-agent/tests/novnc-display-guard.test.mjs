import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateNovncDisplayGuard,
  inspectNovncTargetText,
  NOVNC_GUARD_EXIT,
} from "../scripts/novnc-display-guard.mjs";

test("inspectNovncTargetText finds fill vs forbidden ports", () => {
  const good = inspectNovncTargetText("ExecStart=/usr/bin/websockify --web=/usr/share/novnc 6080 localhost:5900");
  assert.equal(good.websockifyTargets[0].port, 5900);

  const bad = inspectNovncTargetText("ExecStart=websockify 6080 localhost:5901");
  assert.equal(bad.websockifyTargets[0].port, 5901);
  assert.ok(bad.forbiddenPortMentions.length >= 1);
});

test("evaluateNovncDisplayGuard fails closed on 5901", () => {
  const fail = evaluateNovncDisplayGuard({
    text: "websockify 6080 127.0.0.1:5901",
  });
  assert.equal(fail.ok, false);
  assert.ok(fail.errors.some((e) => /5901|TigerVNC/i.test(e)));

  const ok = evaluateNovncDisplayGuard({
    text: "websockify 6080 localhost:5900\nEnvironment=DISPLAY=:99",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.targetPort, 5900);
});

test("evaluateNovncDisplayGuard accepts explicit target port", () => {
  assert.equal(evaluateNovncDisplayGuard({ targetPort: 5900 }).ok, true);
  assert.equal(evaluateNovncDisplayGuard({ targetPort: 5901 }).ok, false);
});

test("example novnc.service targets localhost:5900", async () => {
  const path = fileURLToPath(new URL("../references/agent-box/novnc.service.example", import.meta.url));
  const text = await readFile(path, "utf8");
  const result = evaluateNovncDisplayGuard({ text });
  assert.equal(result.ok, true);
  assert.equal(result.targetPort, 5900);
  assert.match(text, /localhost:5900/);
  assert.match(text, /ExecStart=.*localhost:5900/);
  assert.doesNotMatch(text.replace(/#.*$/gm, ""), /5901/);
  assert.equal(NOVNC_GUARD_EXIT.FAIL, 1);
});
