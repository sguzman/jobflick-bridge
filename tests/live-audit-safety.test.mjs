import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./live-composer-audit.cjs", import.meta.url));
const run = env => spawnSync(process.execPath, [runner], {
  env: { ...process.env, ...env }, encoding: "utf8", timeout: 6000
});

test("live ChatGPT inspection requires explicit opt-in before loading WebDriver", () => {
  const result = run({ JOBFLICK_LIVE_READONLY_QA: "", CHATGPT_QA_URL:
    "https://chatgpt.com/c/testing-1234" });
  assert.equal(result.status, 1);
  assert.match(result.stderr,/read-only live QA refused/i);
  assert(!result.stdout.includes("testing-1234"));
});

test("live QA rejects all unsupported and foreign conversation URLs before profile access", () => {
  for(const url of [
    "https://example.com/c/testing-1234",
    "https://chatgpt.com/share/testing-1234",
    "https://chatgpt.com/settings",
    "https://chatgpt.com/c/testing-1234?other=1",
    "https://chatgpt.com/c/testing-1234#fragment",
    "http://chatgpt.com/c/testing-1234"
  ]) {
    const result=run({ JOBFLICK_LIVE_READONLY_QA:"YES", CHATGPT_QA_URL:url });
    assert.equal(result.status,1,url);
    assert.match(result.stderr,/refused or failed/);
    assert(!result.stdout.includes(url));
  }
});

test("live QA rejects unsafe XDG roots and a QA profile symlink", () => {
  const bad=run({ JOBFLICK_LIVE_READONLY_QA:"YES",
    CHATGPT_QA_URL:"https://chatgpt.com/c/testing-1234", XDG_DATA_HOME:"/" });
  assert.equal(bad.status,1);
  const root=mkdtempSync(join(tmpdir(),"jobflick-live-qa-safety-"));
  try {
    const qa=join(root,"jobflick-bridge-fde-qa");
    const privateProfile=join(root,"personal-profile");
    mkdirSync(qa);
    mkdirSync(privateProfile);
    symlinkSync(privateProfile,join(qa,"profile"));
    const response=run({ JOBFLICK_LIVE_READONLY_QA:"YES",
      CHATGPT_QA_URL:"https://chatgpt.com/c/testing-1234",
      XDG_DATA_HOME:root });
    assert.equal(response.status,1);
    assert.equal(response.stdout,"");
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
