"use strict";
// Full process-restart recovery in two actual disposable FDE instances.
// Synthetic pending browser record and no-execution native host only.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const {Builder,By}=require("selenium-webdriver");
const firefox=require("selenium-webdriver/firefox");
const tick=ms=>new Promise(ok=>setTimeout(ok,ms));
async function main(){
  if(process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true")
    throw Error("Process restart QA requires disposable GitHub Actions");
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary))throw Error("Missing FDE_BINARY");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-restart-fde-"));
  const profile=path.join(root,"profile");
  const ext=path.join(root,"extension");
  const state=path.join(root,"state");
  fs.mkdirSync(profile);fs.mkdirSync(ext);fs.mkdirSync(state);
  const addonId="jobflick-process-restart-qa@sguzman.github.io";
  const production=path.resolve(__dirname,"../extension");
  const manifest=JSON.parse(fs.readFileSync(path.join(production,"manifest.json"),"utf8"));
  manifest.browser_specific_settings.gecko.id=addonId;
  manifest.host_permissions=["http://127.0.0.1/*"];
  manifest.content_scripts=[{matches:["http://127.0.0.1/*"],js:["qa-restart.js"],
    run_at:"document_idle"}];
  fs.writeFileSync(path.join(ext,"manifest.json"),JSON.stringify(manifest));
  const original=fs.readFileSync(path.join(production,"background.js"),"utf8");
  const listenerAnchor='browser.runtime.onMessage.addListener((message, sender) => {';
  assert(original.includes(listenerAnchor),"Production onMessage dispatcher changed");
  const qaHook=[
    'if(message?.type==="qa:resume"){',
    ' if(!sender?.tab?.url?.startsWith("http://127.0.0.1:"))',
    '  return Promise.resolve({ok:false,message:"Unauthorized QA sender"});',
    ' return checkJobs().then(async()=>{',
    '  const record=(await saved()).job_qa000001;',
    '  return {ok:!!record,state:record?.state,',
    '    orphaned:record?.orphaned,deliveryState:record?.deliveryState};',
    ' });',
    '}'
  ].join("\n");
  // Adapt only this disposable QA action into the existing dispatcher.
  // All other production background logic is byte-identical.
  fs.writeFileSync(path.join(ext,"background.js"),
    original.replace(listenerAnchor,listenerAnchor+"\n"+qaHook));
  fs.writeFileSync(path.join(ext,"qa-restart.js"),[
    '"use strict";',
    'document.querySelector("#seed").addEventListener("click",async event=>{',
    ' if(!event.isTrusted)return;',
    ' const id="job_qa000001";',
    ' await browser.storage.local.set({jobflick_bridge_jobs_v1:{[id]:{',
    '  id,recordVersion:1,state:"running",name:"Restart QA",',
    '  tabId:999,origin:"tab-original-qa",',
    '  conversation:"https://chatgpt.com/c/restart-qa-1234",',
    '  orphaned:true,deliveryState:"manual_only",submittedAt:1}}});',
    ' document.documentElement.dataset.qaSeeded="true";',
    '});',
    'document.querySelector("#read").addEventListener("click",async event=>{',
    ' if(!event.isTrusted)return;',
    ' const data=await browser.storage.local.get("jobflick_bridge_jobs_v1");',
    ' const record=data.jobflick_bridge_jobs_v1?.job_qa000001;',
    ' document.documentElement.dataset.qaRead=record?',
    '  JSON.stringify({id:record.id,state:record.state,',
    '    orphaned:record.orphaned,deliveryState:record.deliveryState}):"missing";',
    '});',
    'document.querySelector("#resume").addEventListener("click",async event=>{',
    ' if(!event.isTrusted)return;',
    ' const response=await browser.runtime.sendMessage({type:"qa:resume"});',
    ' document.documentElement.dataset.qaResumed=JSON.stringify(response);',
    '});'
  ].join("\n"));
  const inspect=require("node:child_process").execFileSync;
  for(const file of ["background.js","qa-restart.js"])
    inspect(process.execPath,["--check",path.join(ext,file)],{timeout:10000});

  const runnerHome=process.env.HOME;
  if(!runnerHome||!path.isAbsolute(runnerHome))throw Error("No ephemeral CI HOME");
  const manifestDir=path.join(runnerHome,".mozilla","native-messaging-hosts");
  const hostManifest=path.join(manifestDir,"io.github.sguzman.jobflick.json");
  if(fs.existsSync(hostManifest))throw Error("Refusing to alter existing native host registration");
  const fake=path.join(root,"fake-native-host");
  fs.copyFileSync(path.join(__dirname,"fixtures/fake-native-host.cjs"),fake);
  fs.chmodSync(fake,0o700);
  const oldState=process.env.JOBFLICK_QA_STATE;
  process.env.JOBFLICK_QA_STATE=state;
  let server=null,driver=null;
  const createDriver=()=>new Builder().forBrowser("firefox")
    .setFirefoxOptions(new firefox.Options().setBinary(binary)
      .addArguments("-headless","-profile",profile)).build();
  try {
    server=http.createServer((_req,res)=>{
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end('<!doctype html><html><body><main>Restart QA</main>'+
        '<button id="seed">Seed pending record</button>'+
        '<button id="read">Read saved record</button>'+
        '<button id="resume">Recover native state</button></body></html>');
    });
    await new Promise((ok,no)=>{server.once("error",no);server.listen(0,"127.0.0.1",ok);});
    const url="http://127.0.0.1:"+server.address().port+"/c/restart-test-1234";

    driver=await createDriver();
    assert.equal(await driver.installAddon(ext,true),addonId);
    await driver.get(url);
    await (await driver.findElement(By.id("seed"))).click();
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaSeeded==='true'"),8000);
    await driver.quit();driver=null;

    // Native transport becomes available only after the browser process
    // is completely gone. Reuse ONLY the private test profile.
    fs.mkdirSync(manifestDir,{recursive:true});
    fs.writeFileSync(hostManifest,JSON.stringify({
      name:"io.github.sguzman.jobflick",type:"stdio",
      description:"No-execution process restart QA",
      path:fake,allowed_extensions:[addonId]
    }),{mode:0o600});

    driver=await createDriver();
    assert.equal(await driver.installAddon(ext,true),addonId);
    await driver.get(url);
    await (await driver.findElement(By.id("read"))).click();
    await driver.wait(async()=>await driver.executeScript(
      "return !!document.documentElement.dataset.qaRead"),8000);
    const preserved=await driver.executeScript(
      "return document.documentElement.dataset.qaRead");
    assert.notEqual(preserved,"missing","Durable job must survive a full browser-process restart");
    const stored=JSON.parse(preserved);
    assert.equal(stored.id,"job_qa000001");
    assert.equal(stored.orphaned,true,"Old tab authorization must stay revoked");
    assert.equal(stored.deliveryState,"manual_only");

    await (await driver.findElement(By.id("resume"))).click();
    await driver.wait(async()=>await driver.executeScript(
      "return !!document.documentElement.dataset.qaResumed"),12000);
    const resumed=JSON.parse(await driver.executeScript(
      "return document.documentElement.dataset.qaResumed"));
    assert.equal(resumed.ok,true,JSON.stringify(resumed));
    assert.equal(resumed.state,"succeeded");
    assert.equal(resumed.orphaned,true);
    assert.equal(resumed.deliveryState,"manual_only");

    const log=path.join(state,"native-requests.jsonl");
    assert(fs.existsSync(log));
    const requests=fs.readFileSync(log,"utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert(requests.some(req=>req.action==="inspect"&&req.id==="job_qa000001"));
    assert(requests.every(req=>req.action!=="submit_spec"&&req.action!=="show"&&
      req.action!=="cancel"),"Restart must not execute or deliver anything");
    await driver.uninstallAddon(addonId);
    console.log("FDE full browser restart: durable orphaned pending job recovered via "+
      "native inspect, no resubmission or report disclosure");
  } finally {
    if(driver)await driver.quit();
    if(server)await new Promise(ok=>server.close(ok));
    if(oldState===undefined)delete process.env.JOBFLICK_QA_STATE;
    else process.env.JOBFLICK_QA_STATE=oldState;
    if(fs.existsSync(hostManifest))fs.rmSync(hostManifest,{force:true});
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{
  console.error("Firefox full process restart acceptance failed:",error.stack||error.message);
  process.exitCode=1;
});