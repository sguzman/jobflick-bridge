import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const manifest = JSON.parse(read("extension/manifest.json"));
const background = read("extension/background.js");
const content = read("extension/content.js");
const installer = read("scripts/install-native-host.fish");

test("Firefox-specific MV3 manifest, never Chrome service worker", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.browser_specific_settings.gecko.id, "jobflick-bridge@sguzman.github.io");
  assert.deepEqual(manifest.background, { scripts: ["background.js"] });
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "https://chat.openai.com/*"]);
  assert(manifest.permissions.includes("nativeMessaging"));
  assert(!manifest.permissions.includes("tabs"), "Host permissions cover ChatGPT tab URL without general tabs permission");
});

test("native host is Firefox-specific, explicit and uses correct allowlist", () => {
  assert(installer.includes("allowed_extensions"));
  assert(installer.includes("jobflick-bridge@sguzman.github.io"));
  assert(installer.includes(".mozilla/native-messaging-hosts"));
  assert(installer.includes("jobflick native-host") === false);
  assert(installer.includes("native-host\\n"));
  assert(!installer.includes("allowed_origins"));
  assert(installer.includes("case --install"));
  assert(installer.includes("case --uninstall"));
});

test("no idle transcript scanning, polling or automatic code execution", () => {
  assert(!/MutationObserver|\.observe\(/.test(content));
  assert(!/setInterval\s*\(/.test(content + background));
  assert(content.includes('document.addEventListener("pointerover"'));
  assert(content.includes('document.addEventListener("focusin"'));
  assert(content.includes("event.isTrusted"));
  assert(content.includes('button.addEventListener("click"'));
  assert(background.includes('action: "validate_spec"'));
  assert.equal((background.match(/action: "submit_spec"/g) || []).length, 1);
});

test("origin tokens are separate from YAML and browser tab IDs", () => {
  assert(background.includes("crypto.randomUUID()"));
  assert(background.includes("origin_tab_id: origin"));
  assert(background.includes("canonical(tab.url) === expectedUrl"));
  assert(background.includes('browser.storage.session.get(key)'));
  assert(!content.includes("origin_tab_id"));
});

test("submission failures are uncertain, no retry, and orphaned jobs are preserved", () => {
  assert(background.includes("submission may have succeeded"));
  assert(background.includes("record.orphaned = true"));
  assert(background.includes("browser.storage.local.set"));
  assert(background.includes("browser.alarms.create"));
  assert(!/jobs\[jobId\]\s*=/m.test(background));
});

test("file attachments and automated Send are not falsely claimed to be implemented", () => {
  assert(!content.includes('button[data-testid="send-button"]'));
  const popup = read("extension/popup/popup.js");
  assert(popup.includes("URL.createObjectURL"));
  assert(popup.includes("new File("));
  assert(popup.includes("Download prepared report"));
  assert(popup.includes("report"));
  assert(!popup.includes("innerHTML"));
  assert(!popup.includes("eval("));
  assert(background.includes("NO automated ChatGPT composer injection"));
  assert(read("docs/QA.md").includes("Not run"));
});

test("extension popup is packaged locally and requires no new browser domains", () => {
  assert.equal(manifest.action.default_popup, "popup/index.html");
  const html = read("extension/popup/index.html");
  assert(html.includes('src="popup.js"'));
  assert(!html.includes("http://") && !html.includes("https://"));
  assert(!manifest.permissions.includes("downloads"));
  assert(!manifest.permissions.includes("clipboardRead"));
  assert(!manifest.permissions.includes("<all_urls>"));
  const popup = read("extension/popup/popup.js");
  assert(popup.includes('parts[2] === "c"'));
  assert(popup.includes('destination.username'));
});

test("read-only attachment probe is not an upload or automatic send", () => {
  const content = read("extension/content.js");
  const bg = read("extension/background.js");
  assert(content.includes("jobflick:probe-upload"));
  assert(bg.includes("jobflick:probe-upload"));
  assert(!content.includes("DataTransfer("));
  assert(!content.includes("dispatchEvent(new Event"));
  assert(!content.includes("new File("));
  assert(!content.includes("send-button"));
});

test("costly pinned Jobflick integration only runs on native-facing script changes",()=>{
  const workflow=read(".github/workflows/real-integration.yml");
  assert(workflow.includes('"scripts/install-native-host.fish"'));
  assert(workflow.includes('"scripts/package-unsigned.fish"'));
  assert(!workflow.includes('"scripts/**"'));
  assert(workflow.includes('"extension/background.js"'));
  assert(workflow.includes('"extension/content.js"'));
  assert(workflow.includes('"tests/fde-native.cjs"'));
});
