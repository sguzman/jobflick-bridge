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
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
    throw Error("This Native Messaging host-registration QA is restricted to disposable GitHub Actions runners");
  }
  const runnerHome = process.env.HOME;
  if (!runnerHome || !path.isAbsolute(runnerHome)) throw Error("Missing ephemeral CI runner HOME");
  const runnerManifestDir=path.join(runnerHome,".mozilla","native-messaging-hosts");
  const runnerManifest=path.join(runnerManifestDir,"io.github.sguzman.jobflick.json");
  if (fs.existsSync(runnerManifest)) throw Error("QA refuses to replace an existing registered native host");
  const binary = process.env.FDE_BINARY;
  if (!binary || !path.isAbsolute(binary)) throw Error("FDE_BINARY must be absolute");
  const realHost = process.env.JOBFLICK_QA_REAL === "true";
  const realBinary = process.env.JOBFLICK_QA_BINARY;
  if (realHost && (!realBinary || !path.isAbsolute(realBinary) ||
                   !fs.existsSync(realBinary))) {
    throw Error("Real FDE integration requires an existing pinned Jobflick binary in CI");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobflick-fde-native-"));
  const ext = path.join(root, "addon");
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const hostDir = path.join(home, ".mozilla", "native-messaging-hosts");
  fs.mkdirSync(ext, { recursive: true });
  fs.mkdirSync(hostDir, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  for (const directory of ["config","data","runtime","work"]) {
    fs.mkdirSync(path.join(root,directory),{recursive:true,mode:0o700});
  }
  const originId = "jobflick-bridge-native-qa@sguzman.github.io";
  const production = path.resolve(__dirname, "../extension");
  const manifest = JSON.parse(fs.readFileSync(path.join(production, "manifest.json"), "utf8"));
  manifest.browser_specific_settings.gecko.id = originId;
  manifest.host_permissions = ["http://127.0.0.1/*"];
  manifest.content_scripts = [{ matches: ["http://127.0.0.1/*"],
    js: ["attachment-adapter.js","content.js","qa-route.js","qa-delivery.js"], run_at: "document_idle" }];
  manifest.action = { default_title: "Firefox Native QA" };
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  // Use the complete unmodified production content script.
  fs.copyFileSync(path.join(production,"attachment-adapter.js"),
    path.join(ext,"attachment-adapter.js"));
  fs.copyFileSync(path.join(production, "content.js"), path.join(ext, "content.js"));
  // Disposable QA-only diagnostic; no user content or report is exposed.
  fs.writeFileSync(path.join(ext,"qa-route.js"), [
    'document.addEventListener("jobflick-qa-read-route",()=>{',
    '  browser.runtime.sendMessage({type:"jobflick:qa-route"})',
    '    .then(reply=>{document.documentElement.dataset.jobflickQaRoute=',
    '      reply?.count===1 ? (reply.manualOnly?"manual_only":"active") : "missing";',
    '    }).catch(()=>{});',
    '});'
  ].join("\n"));
  // Test-only click adapter. The live extension never exposes this action.
  fs.writeFileSync(path.join(ext,"qa-delivery.js"),[
    '"use strict";',
    'document.addEventListener("click",async event=>{',
    '  if(event.target?.id!=="qa-export" || !event.isTrusted)return;',
    '  try {',
    '    const reply=await browser.runtime.sendMessage({type:"jobflick:qa-report"});',
    '    if(!reply?.ok)throw Error("Native report unavailable");',
    '    const file=globalThis.__jobflickAttachmentAdapter.prepare(reply.id,reply.report);',
    '    const receipt=globalThis.__jobflickAttachmentAdapter.handoff(',
    '      document.getElementById("qa-file-input"),file);',
    '    document.documentElement.dataset.qaHandoff=receipt.domHandoffOnly?"done":"invalid";',
    '  }catch(error){',
    '    document.documentElement.dataset.qaHandoff="error";',
    '  }',
    '});'
  ].join("\n"));
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
  const historyHostFilter='[{ hostEquals: "chatgpt.com" }, { hostEquals: "chat.openai.com" }]';
  assert(background.includes(historyHostFilter),"Production history filter changed");
  background=background.replace(historyHostFilter,'[{ hostEquals: "127.0.0.1" }]');
  const listenerAnchor='browser.runtime.onMessage.addListener((message, sender) => {';
  assert(background.includes(listenerAnchor),"Background listener moved");
  background=background.replace(listenerAnchor,listenerAnchor+`
  if(message?.type==="jobflick:qa-report"){
    if(!sender?.tab?.url?.startsWith("http://127.0.0.1:"))
      return Promise.resolve({ok:false});
    return saved().then(async records=>{
      const ready=Object.values(records).filter(item=>
        knownRecord(item) && FINISHED.has(item.state) && !item.orphaned);
      if(ready.length!==1)return {ok:false};
      const response=await native({action:"show",id:ready[0].id});
      return response.ok && typeof response.report==="string"
        ? {ok:true,id:ready[0].id,report:response.report} : {ok:false};
    });
  }
  if(message?.type==="jobflick:qa-route"){
    return saved().then(records=>{
      const items=Object.values(records).filter(record=>knownRecord(record));
      return {ok:true,count:items.length,
        manualOnly:items.length===1 &&
          items[0].orphaned===true &&
          items[0].deliveryState==="manual_only"};
    });
  }
`);
  fs.writeFileSync(path.join(ext, "background.js"), background);
  // Fail with a specific syntax error BEFORE starting Firefox; a malformed
  // disposable content script can otherwise look like native host failure.
  const checkNode = require("node:child_process").execFileSync;
  for (const script of ["qa-delivery.js","qa-route.js","background.js"]) {
    checkNode(process.execPath,["--check",path.join(ext,script)],
      {stdio:"pipe",timeout:10000});
  }

  const fixture = path.resolve(__dirname, "./fixtures/fake-native-host.cjs");
  const fakeHost = path.join(root, "fake-native-host");
  fs.copyFileSync(fixture, fakeHost);
  fs.chmodSync(fakeHost, 0o700);
  const realWrapper=path.join(root,"real-native-host");
  if (realHost) {
    // A fixed shell wrapper is needed because Firefox's manifest accepts
    // only an executable path, not command-line arguments.
    fs.writeFileSync(realWrapper,'#!/bin/sh\nexec "$JOBFLICK_QA_BINARY" native-host\n',{mode:0o700});
  }
  const nativeManifest=JSON.stringify({
    name: "io.github.sguzman.jobflick",
    description: realHost ? "Disposable real Jobflick CI acceptance" :
      "Disposable no-execution QA Native Messaging fixture",
    path: realHost ? realWrapper : fakeHost,
    type: "stdio", allowed_extensions: [originId]
  });
  fs.writeFileSync(path.join(hostDir, "io.github.sguzman.jobflick.json"), nativeManifest, { mode: 0o600 });
  // Firefox resolves user-level native manifests from its OS account home on
  // some Linux builds even when HOME is overridden for geckodriver. The GitHub
  // runner is disposable; install only our fixture manifest there as well.
  fs.mkdirSync(runnerManifestDir,{recursive:true});
  fs.writeFileSync(runnerManifest,nativeManifest,{mode:0o600});

  const yaml = [
    "schema: 4", "name: Firefox native QA", "shell: fish",
    "cwd: "+path.join(root,"work"), "privilege: none", "timeout_seconds: 10",
    "environment:", "  session: inherit", "  gpu: inherit",
    "command: printf bridge_real_fde_smoke"
  ].join("\n");
  const html = "<!doctype html><html><head><meta charset='utf-8'></head><body>" +
    "<main><pre><code>" + yaml + "</code></pre></main>" +
    "<input type='file' id='qa-file-input' accept='text/plain,.txt'>" +
    "<button type='button' id='qa-export'>Read native report locally</button>" +
    "<output id='qa-result'></output>" +
    "<script>document.querySelector('#qa-file-input').addEventListener('change',async e=>{" +
    "const file=e.target.files?.[0];if(!file)return;" +
    "const data=await file.text();" +
    "document.querySelector('#qa-result').textContent=JSON.stringify({" +
    "name:file.name,valid:data.includes('bridge_real_fde_smoke'),size:file.size});" +
    "});</script></body></html>";
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let driver;
  let daemon=null;
  let daemonLog="";
  let phase = "starting";
  // Browser and geckodriver inherit a HOME that only exists inside this test.
  // It cannot accidentally discover the runner's normal native host files.
  const savedHome = process.env.HOME;
  const savedState = process.env.JOBFLICK_QA_STATE;
  const savedXdg = {};
  for (const key of ["XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_RUNTIME_DIR"]) {
    savedXdg[key]=process.env[key];
    process.env[key]=path.join(root,key==="XDG_CONFIG_HOME"?"config":key==="XDG_DATA_HOME"?"data":"runtime");
  }
  process.env.HOME = home;
  process.env.JOBFLICK_QA_STATE = state;
  try {
    if (realHost) {
      phase="starting isolated real Jobflick daemon";
      daemon=require("node:child_process").spawn(realBinary,["daemon"],{
        env:process.env,stdio:["ignore","ignore","pipe"]
      });
      daemon.stderr.on("data",chunk=>{daemonLog=(daemonLog+chunk.toString()).slice(-3000);});
      const socket=path.join(process.env.XDG_RUNTIME_DIR,"jobflick","daemon.sock");
      for(let i=0;i<150&&!fs.existsSync(socket);i++){
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert(fs.existsSync(socket),"Real daemon startup failed: "+daemonLog);
    }
    phase = "starting browser";
    driver = await new Builder().forBrowser("firefox")
      .setFirefoxOptions(new firefox.Options().setBinary(binary).addArguments("-headless"))
      .build();
    phase = "installing addon";
    const id = await driver.installAddon(ext, true);
    assert.equal(id, originId);
    phase = "opening localhost conversation";
    await driver.get("http://127.0.0.1:" + server.address().port + "/c/test-native-1234");
    await driver.wait(until.elementLocated(By.css("main pre code")), 10000);
    phase = "native validation and Run button";
    const button = await driver.wait(async () => {
      await driver.executeScript(
        "document.querySelector('pre').dispatchEvent(new Event('focusin',{bubbles:true}));"
      );
      const items = await driver.findElements(By.css(".jobflick-bridge-run"));
      return items[0] || false;
    }, 12000);
    assert.match(await button.getText(), /Run Jobflick/);
    phase = "trusted Run submission";
    await button.click();
    // Real Rust daemon startup and browser Native Messaging are separate
    // processes. Give the actual backend a bounded 20s, but retain a faster
    // 12s gate for the no-execution fixture.
    await driver.wait(async () =>
      /Queued|running|succeeded|failed|timed_out|interrupted|cancelled/.test(
        await button.getText()
      ), realHost ? 20000 : 12000);
    phase = "verifying native submission";
    const logFile = path.join(state, "native-requests.jsonl");
    if (!realHost) {
      await driver.wait(() => {
        if (!fs.existsSync(logFile)) return false;
        return fs.readFileSync(logFile, "utf8").includes('"action":"submit_spec"');
      }, 10000);
      const requests=fs.readFileSync(logFile,"utf8").trim().split("\n").map(JSON.parse);
      assert(requests.some(r=>r.action==="validate_spec"));
      const submits=requests.filter(r=>r.action==="submit_spec");
      assert.equal(submits.length,1,"Exactly one browser click must enqueue once");
      assert.match(submits[0].origin_tab_id,/^tab-[a-zA-Z0-9_-]{8,128}$/);
      assert.equal(requests.some(r=>r.action==="show"),false);
      assert.equal(requests.some(r=>r.action==="cancel"),false);
    }
    // Firefox does not expose extension-privileged popup tabs through
    // ordinary WebDriver commands. Those controls have dedicated behavioral
    // tests; browser acceptance here is the real native status path.
    phase="native finished status propagation";
    await driver.wait(async()=>/succeeded/.test(await button.getText()),10000);
    let completedJobId=null;
    if (realHost) {
      const dir=path.join(process.env.XDG_DATA_HOME,"jobflick","jobs");
      const files=fs.readdirSync(dir).filter(file=>file.endsWith(".json"));
      assert.equal(files.length,1,"Browser should queue exactly one durable Jobflick job");
      const job=JSON.parse(fs.readFileSync(path.join(dir,files[0]),"utf8"));
      completedJobId=job.id;
      assert.equal(job.state,"succeeded");
      assert.match(job.origin_tab_id,/^tab-[a-zA-Z0-9_-]{8,128}$/);
      assert.equal(job.name,"Firefox native QA");
      assert.equal(job.command,"printf bridge_real_fde_smoke");
      assert(fs.readFileSync(job.log_path,"utf8").includes("bridge_real_fde_smoke"),
        "The hardcoded harmless Fish command must produce output");
    } else {
      const inspected=fs.readFileSync(logFile,"utf8").split("\n").filter(Boolean).map(JSON.parse);
      assert(inspected.some(x=>x.action==="inspect"),"Firefox did not query terminal status");
      assert.equal(inspected.filter(x=>x.action==="submit_spec").length,1);
      assert.equal(inspected.some(x=>x.action==="show"),false);
      assert.equal(inspected.some(x=>x.action==="cancel"),false);
    }
    assert.equal(await button.isEnabled(),false);
    if(realHost){
      phase="real Jobflick report into synthetic page File";
      // Only a WebDriver-delivered real click enables this QA-only transfer.
      await (await driver.findElement(By.id("qa-export"))).click();
      await driver.wait(async()=>(
        await driver.findElement(By.id("qa-result")).getText()
      ).length>0,10000);
      const raw=await driver.findElement(By.id("qa-result")).getText();
      const handoff=JSON.parse(raw);
      assert.equal(handoff.valid,true,"Page could not read real Jobflick report");
      assert.equal(handoff.name,"jobflick-"+completedJobId+".txt",
        "Firefox must hand the exact completed native job's File to the page");
      assert(handoff.size>0&&handoff.size<=524288);
      assert.equal(await driver.executeScript(
        "return document.documentElement.dataset.qaHandoff"),"done");
    }
    // Real Firefox History API navigation, not merely a mocked event.
    // Its URL must revoke this finished job's origin even after returning.
    phase="SPA navigation origin revocation";
    const readState=async()=>{
      await driver.executeScript(
        "document.dispatchEvent(new Event('jobflick-qa-read-route'));"
      );
      return driver.executeScript(
        "return document.documentElement.dataset.jobflickQaRoute || ''"
      );
    };
    await driver.wait(async()=>await readState()==="active",8000);
    await driver.executeScript(
      "history.pushState({},'', '/c/different-qa-conversation');"
    );
    await driver.wait(async()=>await readState()==="manual_only",10000);
    await driver.executeScript(
      "history.pushState({},'', '/c/test-native-1234');"
    );
    await driver.wait(async()=>await readState()==="manual_only",8000);

    await driver.uninstallAddon(id);
    console.log(realHost ?
      "FDE + REAL Jobflick: one hardcoded harmless Fish job, persisted browser origin, and terminal status passed" :
      "FDE + FAKE native host: one submit, terminal UI, no command execution or auto-report retrieval");
  } catch(error) {
    const logFile=path.join(state,"native-requests.jsonl");
    const actions=fs.existsSync(logFile) ?
      fs.readFileSync(logFile,"utf8").split("\n").filter(Boolean)
        .map(line=>{try{return JSON.parse(line).action;}catch{return "invalid-log";}}) : [];
    const page=driver ? await driver.executeScript(
      "return {url:location.pathname,codes:document.querySelectorAll('main pre code').length,buttons:document.querySelectorAll('.jobflick-bridge-run').length,buttonState:document.querySelector('.jobflick-bridge-run')?.textContent?.slice(0,120) || 'none'}"
    ).catch(()=>({unavailable:true})) : {unavailable:true};
    const recordDir=path.join(root,"data","jobflick","jobs");
    const records=realHost && fs.existsSync(recordDir) ?
      fs.readdirSync(recordDir).filter(x=>x.endsWith(".json")).slice(0,5)
        .map(file=>{try{
          const record=JSON.parse(fs.readFileSync(path.join(recordDir,file),"utf8"));
          return {id:record.id,state:record.state,hasOrigin:!!record.origin_tab_id};
        }catch{return {unreadable:true};}}) : [];
    console.error("Native QA phase:",phase,"requested_actions:",JSON.stringify(actions),
      "page:",JSON.stringify(page),"jobs:",JSON.stringify(records),
      "daemon_error_tail:",daemonLog.slice(-500));
    throw error;
  } finally {
    if (driver) await driver.quit();
    if (daemon) {
      daemon.kill("SIGTERM");
      await Promise.race([
        new Promise(resolve=>daemon.once("exit",resolve)),
        new Promise(resolve=>setTimeout(resolve,1500))
      ]);
      if (daemon.exitCode===null) daemon.kill("SIGKILL");
    }
    await new Promise(resolve => server.close(resolve));
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedState === undefined) delete process.env.JOBFLICK_QA_STATE;
    else process.env.JOBFLICK_QA_STATE = savedState;
    for (const [key,value] of Object.entries(savedXdg)) {
      if (value===undefined) delete process.env[key];
      else process.env[key]=value;
    }
    // Only our exact CI-only manifest was created; do not remove directories
    // or files belonging to other runner jobs.
    fs.rmSync(runnerManifest,{force:true});
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error("FDE native QA failed:", error.message);
  process.exitCode = 1;
});
