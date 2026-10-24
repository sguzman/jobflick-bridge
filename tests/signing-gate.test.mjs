import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { signingPrerequisites } from "../.github/verify-signing-gate.mjs";

const progress = JSON.parse(readFileSync(new URL("../progress.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const clone = x => JSON.parse(JSON.stringify(x));
function syntheticAcceptedLedger() {
  const p = clone(progress);
  const tasks = p.milestones.flatMap(m => m.tasks);
  for (const t of tasks) {
    if (["M7-07", "M7-08"].includes(t.id)) continue;
    t.status = "verified";
    if (!Array.isArray(t.evidence) || !t.evidence.length)
      t.evidence = ["Synthetic gate test evidence; not a real project acceptance"];
  }
  for (const m of p.milestones) {
    m.verified = m.tasks.filter(t => t.status === "verified").length;
    m.implemented = m.tasks.filter(t => t.status === "implemented").length;
    m.percent = Math.floor(100 * m.verified / m.total);
  }
  p.overall.verified = tasks.filter(t => t.status === "verified").length;
  p.overall.implemented = tasks.filter(t => t.status === "implemented").length;
  p.overall.planned = tasks.filter(t => t.status === "planned").length;
  p.overall.percent = Math.floor(100 * p.overall.verified / p.overall.total);
  return p;
}
test("current incomplete roadmap cannot request a Mozilla signature", () => {
  const result = signingPrerequisites(progress, manifest, pkg);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unverified|inconsistent/i);
});
test("only signing and release tasks may remain open at signature request", () => {
  const result = signingPrerequisites(syntheticAcceptedLedger(), manifest, pkg);
  assert.equal(result.ok, true, result.reason);
});
test("an unverified live ChatGPT acceptance task always blocks signing", () => {
  const p = syntheticAcceptedLedger();
  p.milestones.flatMap(m => m.tasks).find(t => t.id === "M7-06").status = "implemented";
  p.overall.verified--;
  p.overall.implemented++;
  p.overall.percent = Math.floor(100 * p.overall.verified / p.overall.total);
  assert.equal(signingPrerequisites(p, manifest, pkg).ok, false);
});
test("inconsistent counts and duplicate task identifiers fail closed", () => {
  const p = syntheticAcceptedLedger();
  p.overall.verified++;
  assert.equal(signingPrerequisites(p, manifest, pkg).ok, false);
  const duplicate = syntheticAcceptedLedger();
  duplicate.milestones.flatMap(m => m.tasks).find(t => t.id === "M5-01").id = "M5-02";
  assert.equal(signingPrerequisites(duplicate, manifest, pkg).ok, false);
});
test("a purportedly verified task needs acceptance evidence", () => {
  const p = syntheticAcceptedLedger();
  p.milestones.flatMap(m => m.tasks).find(t => t.id === "M7-06").evidence = [];
  assert.equal(signingPrerequisites(p, manifest, pkg).ok, false);
});
test("manifest/package versions and stable native host Gecko ID are required", () => {
  const p = syntheticAcceptedLedger();
  assert.equal(signingPrerequisites(p, { ...manifest, version: "9.0.0" }, pkg).ok, false);
  const bad = clone(manifest);
  bad.browser_specific_settings.gecko.id = "another-bridge@invalid.example";
  assert.equal(signingPrerequisites(p, bad, pkg).ok, false);
});

test("AMO workflow requires signed XPI persistent Firefox acceptance before artifact retention", () => {
  const workflow = readFileSync(new URL("../.github/workflows/amo-sign.yml", import.meta.url),"utf8");
  const gate = workflow.indexOf("node .github/verify-signing-gate.mjs");
  const sign = workflow.indexOf("web-ext@10.8.0 sign");
  const acceptance = workflow.indexOf("node tests/fde-signed.cjs");
  const preserve = workflow.indexOf("name: Preserve signed XPI as a review artifact only");
  assert(gate >= 0 && sign > gate && acceptance > sign && preserve > acceptance);
  assert(workflow.includes("FDE_SIGNED_XPI"));
  assert(workflow.includes("latest-devedition"));
  assert(workflow.includes("workflow_dispatch:"));
  assert(!workflow.includes("secrets.GITHUB_TOKEN"));
  const script=readFileSync(new URL("./fde-signed.cjs",import.meta.url),"utf8");
  assert(script.includes('driver.installAddon(archive,false)'),
    "Signed package must use persistent install, not temporary add-on");
  assert(script.includes("await driver.quit();driver=null;"));
  assert(script.includes("await driver.uninstallAddon(id)"));
  assert(!script.includes("sendNativeMessage"));
});
