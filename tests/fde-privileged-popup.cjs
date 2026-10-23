"use strict";

// Disposable Firefox Developer Edition acceptance for the actual privileged
// moz-extension:// popup, not a localhost runtime shim. Native requests use
// a no-execution Jobflick fixture; no personal browser/profile is accessed.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const {Builder,By,until}=require("selenium-webdriver");
const firefox=require("selenium-webdriver/firefox");

const JOB="job_qa000001";
const REPORT="Synthetic Firefox Native Messaging result.\nNo command was run.\n";
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function main(){
  if(process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true")
    throw Error("Privileged popup QA must run on a disposable CI runner");
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary))throw Error("FDE_BINARY must be absolute");

  const root=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-privileged-popup-"));
  const ext=path.join(root,"addon"),home=path.join(root,"home");
  const state=path.join(root,"state"),downloads=path.join(root,"downloads");
  const hostDir=path.join(home,".mozilla","native-messaging-hosts");
  for(const dir of [ext,home,state,downloads,hostDir])fs.mkdirSync(dir,{recursive:true});
  const runnerHost=path.join(process.env.HOME||"","/.mozilla/native-messaging-hosts");
  const runnerManifest=path.join(runnerHost,"io.github.sguzman.jobflick.json");
  if(fs.existsSync(runnerManifest))
    throw Error("CI runner already registered a Jobflick host; refusing replacement");

  const addonId="jobflick-privileged-popup-qa@sguzman.github.io";
  const source=path.join(__dirname,"../extension");
  const manifest=JSON.parse(fs.readFileSync(path.join(source,"manifest.json"),"utf8"));
  manifest.browser_specific_settings.gecko.id=addonId;
  manifest.host_permissions=["http://127.0.0.1/*"];
  manifest.content_scripts=[{
    matches:["http://127.0.0.1/*"],js:["qa-seed.js"],run_at:"document_idle"
  }];
  fs.writeFileSync(path.join(ext,"manifest.json"),JSON.stringify(manifest));
  fs.copyFileSync(path.join(source,"background.js"),path.join(ext,"background.js"));
  fs.mkdirSync(path.join(ext,"popup"));
  for(const filename of ["index.html","popup.css","popup.js"]){
    fs.copyFileSync(path.join(source,"popup",filename),path.join(ext,"popup",filename));
  }
  // CI fixture data is seeded from a synthetic localhost page. The *popup*
  // and its background authorization/storage/native logic stay unmodified.
  fs.writeFileSync(path.join(ext,"qa-seed.js"),[
    '"use strict";',
    '(async()=>{',
    'const data=Object.create(null);',
    'for(let i=0;i<45;i++){',
    '  const id=i===0?"job_qa000001":"job_"+String(i).padStart(8,"0");',
    '  data[id]={id,recordVersion:1,state:"succeeded",name:i===0?"QA native report":"Older QA "+i,',
    '    submittedAt:100-i,tabId:999,origin:"tab-qa",',
    '    conversation:"https://chatgpt.com/c/qa-session-1234",',
    '    orphaned:true,deliveryState:"manual_only"};',
    '}',
    'await browser.storage.local.set({jobflick_bridge_jobs_v1:data});',
    'document.documentElement.dataset.qaPopupUrl=browser.runtime.getURL("popup/index.html");',
    'document.documentElement.dataset.qaSeeded="true";',
    '})().catch(()=>{document.documentElement.dataset.qaSeeded="error";});'
  ].join("\n"));

  const host=path.join(root,"fake-native-host");
  fs.copyFileSync(path.join(__dirname,"fixtures/fake-native-host.cjs"),host);
  fs.chmodSync(host,0o700);
  const nativeManifest=JSON.stringify({
    name:"io.github.sguzman.jobflick",description:"Disposable Firefox privileged-popup QA",
    type:"stdio",path:host,allowed_extensions:[addonId]
  });
  const manifestFile="io.github.sguzman.jobflick.json";
  fs.writeFileSync(path.join(hostDir,manifestFile),nativeManifest,{mode:0o600});
  fs.mkdirSync(runnerHost,{recursive:true});
  fs.writeFileSync(runnerManifest,nativeManifest,{mode:0o600});

  let driver=null,server=null;
  const oldHome=process.env.HOME,oldState=process.env.JOBFLICK_QA_STATE;
  process.env.HOME=home;
  process.env.JOBFLICK_QA_STATE=state;
  try{
    server=http.createServer((_req,response)=>{
      response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      response.end('<!doctype html><html lang="en"><body><main>Disposable popup QA</main></body></html>');
    });
    await new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(0,"127.0.0.1",resolve);
    });
    const opts=new firefox.Options().setBinary(binary).addArguments("-headless");
    opts.setPreference("browser.download.folderList",2);
    opts.setPreference("browser.download.dir",downloads);
    opts.setPreference("browser.download.useDownloadDir",true);
    opts.setPreference("browser.helperApps.neverAsk.saveToDisk","text/plain");
    opts.setPreference("browser.download.alwaysOpenPanel",false);
    driver=await new Builder().forBrowser("firefox").setFirefoxOptions(opts).build();
    const id=await driver.installAddon(ext,true);
    assert.equal(id,addonId);
    await driver.get("http://127.0.0.1:"+server.address().port+"/c/test-popup-1234");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaSeeded==='true'"),12000);
    const url=await driver.executeScript(
      "return document.documentElement.dataset.qaPopupUrl");
    assert.match(url,/^moz-extension:\/\/[^/]+\/popup\/index\.html$/);
    await driver.get(url);
    assert.equal(await driver.getTitle(),"Jobflick Bridge");
    await driver.wait(async()=>(
      await driver.findElements(By.css("main#jobs section.job"))
    ).length===40,12000);
    let rows=await driver.findElements(By.css("main#jobs section.job"));
    assert.equal(rows.length,40,"Initial privileged inbox page is capped at 40");
    await (await driver.findElement(By.id("load-older"))).click();
    await driver.wait(async()=>(
      await driver.findElements(By.css("main#jobs section.job"))
    ).length===45,10000);
    rows=await driver.findElements(By.css("main#jobs section.job"));
    assert.equal(rows.length,45,"All older jobs remain accessible");
    const search=await driver.findElement(By.id("filter-query"));
    await search.sendKeys("QA native report");
    await (await driver.findElement(By.css("#filter-form button"))).click();
    await driver.wait(async()=>(
      await driver.findElements(By.css("main#jobs section.job"))
    ).length===1,9000);
    assert.match(await driver.findElement(By.css("#jobs .job h2")).getText(),/QA native report/);

    const target=path.join(downloads,"jobflick-"+JOB+".txt");
    assert.equal(fs.existsSync(target),false);
    const button=()=>driver.findElement(
      By.xpath("//button[normalize-space(.)='Save report']"));
    await (await button()).click();
    await driver.wait(async()=>(
      await driver.findElements(By.xpath(
        "//button[normalize-space(.)='Download prepared report']"))
    ).length===1,10000);
    assert.equal(fs.existsSync(target),false,"First gesture only retrieves report");
    await (await driver.findElement(By.xpath(
      "//button[normalize-space(.)='Download prepared report']"))).click();
    await driver.wait(()=>fs.existsSync(target),12000);
    assert.equal(fs.readFileSync(target,"utf8"),REPORT);

    const log=path.join(state,"native-requests.jsonl");
    assert(fs.existsSync(log),"Report must come from Firefox Native Messaging");
    const requests=fs.readFileSync(log,"utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(requests.map(x=>x.action),["show"],
      "Popup must neither execute Fish nor submit, inspect or send");
    assert.equal(requests[0].id,JOB);

    const forget=()=>driver.findElement(By.xpath(
      "//button[normalize-space(.)='Forget bridge record']"));
    await (await forget()).click();
    assert.equal((await driver.findElements(By.css("#jobs .job"))).length,1);
    await (await driver.findElement(By.xpath(
      "//button[normalize-space(.)='Confirm forget']"))).click();
    await driver.wait(async()=>(
      await driver.findElements(By.css("#jobs .job"))
    ).length===0,10000);
    assert.equal(fs.readFileSync(log,"utf8").trim().split("\n").length,1,
      "Forget only removes browser metadata, no native action");

    await driver.uninstallAddon(id);
    console.log("Privileged Firefox popup: 45-row pagination, filtered search, native report two gestures, exact file download, bridge-only Forget; no submit/send");
  }finally{
    if(driver)await driver.quit();
    if(server)await new Promise(resolve=>server.close(resolve));
    if(oldHome===undefined)delete process.env.HOME;
    else process.env.HOME=oldHome;
    if(oldState===undefined)delete process.env.JOBFLICK_QA_STATE;
    else process.env.JOBFLICK_QA_STATE=oldState;
    if(fs.existsSync(runnerManifest))fs.rmSync(runnerManifest,{force:true});
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{
  console.error("Disposable Firefox privileged popup QA failed:",error.stack||error);
  process.exitCode=1;
});
