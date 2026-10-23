"use strict";

// Disposable, end-to-end Firefox Developer Edition Native Messaging QA.
// The production content and background code are copied unchanged except
// for a test-only canonical localhost URL adapter. Actual native host is a
// no-execution Node fixture; no Jobflick daemon or Fish subprocess starts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Builder, By, until } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

async function main() {
  const binary = process.env.FDE_BINARY;
  if (!binary || !path.isAbsolute(binary)) throw Error("FDE_BINARY must be absolute");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobflick-fde-native-"));
  const ext = path.join(root, "addon");
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const hostDir = path.join(home, ".mozilla", "native-messaging-hosts");
  fs.mkdirSync(ext, { recursive: true });
  fs.mkdirSync(hostDir, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const originId = "jobflick-bridge-native-qa@sguzman.github.io";
  const production = path.resolve(__dirname, "../extension");
  const manifest = JSON.parse(fs.readFileSync(path.join(production, "manifest.json"), "utf8"));
  manifest.browser_specific_settings.gecko.id = originId;
  manifest.host_permissions = ["http://127.0.0.1/*"];
  manifest.content_scripts = [{ matches: ["http://127.0.0.1/*"],
    js: ["content.js"], run_at: "document_idle" }];
  manifest.action = { default_title: "Firefox Native QA" };
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  fs.copyFileSync(path.join(production, "content.js"), path.join(ext, "content.js"));
  // Only URL identity is adapted to synthetic localhost. All native protocol,
  // job tracking and other production background logic stays unchanged.
  const originalBackground = fs.readFileSync(path.join(production, "background.js"), "utf8");
  const needle = 'const SITES = new Set(["chatgpt.com", "chat.openai.com"]);';
  assert(originalBackground.includes(needle), "Missing known production origin guard");
  let background = originalBackground.replace(needle, 'const SITES = new Set(["127.0.0.1"]);');
  const rule = 'if (u.protocol !== "https:" || !SITES.has(u.hostname) ||\n        u.port || u.username || u.password) return null;';
  assert(background.includes(rule), "Origin guard changed; inspect adapter");
  background = background.replace(rule,
    'if (u.protocol !== "http:" || !SITES.has(u.hostname) ||\n        u.username || u.password) return null;');
  fs.writeFileSync(path.join(ext, "background.js"), background);

  const fixture = path.resolve(__dirname, "./fixtures/fake-native-host.cjs");
  const fakeHost = path.join(root, "fake-native-host");
  fs.copyFileSync(fixture, fakeHost);
  fs.chmodSync(fakeHost, 0o700);
  fs.writeFileSync(path.join(hostDir, "io.github.sguzman.jobflick.json"), JSON.stringify({
    name: "io.github.sguzman.jobflick",
    description: "Disposable no-execution QA Native Messaging fixture",
    path: fakeHost, type: "stdio", allowed_extensions: [originId]
  }), { mode: 0o600 });

  const yaml = [
    "schema: 4", "name: Firefox native QA", "shell: fish",
    "cwd: /tmp", "privilege: none", "timeout_seconds: 5", "command: pwd"
  ].join("\n");
  const html = "<!doctype html><html><head><meta charset='utf-8'></head><body>" +
    "<main><pre><code>" + yaml + "</code></pre></main></body></html>";
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let driver;
  // Browser and geckodriver inherit a HOME that only exists inside this test.
  // It cannot accidentally discover the runner's normal native host files.
  const savedHome = process.env.HOME;
  const savedState = process.env.JOBFLICK_QA_STATE;
  process.env.HOME = home;
  process.env.JOBFLICK_QA_STATE = state;
  try {
    driver = await new Builder().forBrowser("firefox")
      .setFirefoxOptions(new firefox.Options().setBinary(binary).addArguments("-headless"))
      .build();
    const id = await driver.installAddon(ext, true);
    assert.equal(id, originId);
    await driver.get("http://127.0.0.1:" + server.address().port + "/c/test-native-1234");
    await driver.wait(until.elementLocated(By.css("main pre code")), 10000);
    const button = await driver.wait(async () => {
      await driver.executeScript(
        "document.querySelector('pre').dispatchEvent(new Event('focusin',{bubbles:true}));"
      );
      const items = await driver.findElements(By.css(".jobflick-bridge-run"));
      return items[0] || false;
    }, 12000);
    assert.match(await button.getText(), /Run Jobflick/);
    await button.click();
    await driver.wait(async () => /Queued|succeeded/.test(await button.getText()), 12000);
    const logFile = path.join(state, "native-requests.jsonl");
    await driver.wait(() => {
      if (!fs.existsSync(logFile)) return false;
      return fs.readFileSync(logFile, "utf8").includes('"action":"submit_spec"');
    }, 10000);
    const requests = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
    assert(requests.some(r => r.action === "validate_spec"));
    const submits = requests.filter(r => r.action === "submit_spec");
    assert.equal(submits.length, 1, "Exactly one browser click must enqueue once");
    assert.match(submits[0].origin_tab_id, /^tab-[a-zA-Z0-9_-]{8,128}$/);
    assert.equal(requests.some(r => r.action === "show"), false, "Reports are never read automatically");
    assert.equal(requests.some(r => r.action === "cancel"), false);
    await driver.uninstallAddon(id);
    console.log("Headless FDE Native Messaging: real bridge validate, single submit, opaque origin succeeded using fake no-execution host");
  } finally {
    if (driver) await driver.quit();
    await new Promise(resolve => server.close(resolve));
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedState === undefined) delete process.env.JOBFLICK_QA_STATE;
    else process.env.JOBFLICK_QA_STATE = savedState;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error("FDE native QA failed:", error.message);
  process.exitCode = 1;
});
