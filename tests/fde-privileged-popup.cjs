"use strict";

// Disposable Firefox Developer Edition acceptance for the actual privileged
// moz-extension:// popup, not a localhost runtime shim. Native requests use
// a no-execution Jobflick fixture; no personal browser/profile is accessed.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const {Builder,By}=require("selenium-webdriver");
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
  const runnerHost=path.join(process.env.HOME||"",".mozilla","native-messaging-hosts");
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
  // CI-only shortcut opens the actual Firefox toolbar-action popup.
  // Unlike a moz-extension:// tab, the action popup has the exact sender
  // identity that the untouched production background authorizes.
  fs.writeFileSync(path.join(ext,"manifest.json"),JSON.stringify(manifest));
  // Firefox 149+ supports action.openPopup without user activation.
  // This opens the *actual toolbar popup*, whose extension sender has no
  // tab and therefore satisfies the unchanged production isPopup guard.
  // Only a disposable CI add-on exposes this QA trigger.
  const originalBackground=fs.readFileSync(path.join(source,"background.js"),"utf8");
  const qaOpen=[
    'browser.runtime.onMessage.addListener((message,sender)=>{',
    ' if(message?.type==="qa:open-popup" &&',
    '    sender?.tab?.url?.startsWith("http://127.0.0.1:"))',
    '   void browser.action.openPopup().catch(error=>{',
    '     void browser.storage.local.set({jobflick_qa_popup_result:{',
    '       ok:false,message:"Popup open failed: "+String(error)}});',
    '   });',
    '});'
  ].join("\n");
  fs.writeFileSync(path.join(ext,"background.js"),qaOpen+"\n"+originalBackground);
  fs.mkdirSync(path.join(ext,"popup"));
  for(const filename of ["index.html","popup.css","popup.js"]){
    fs.copyFileSync(path.join(source,"popup",filename),path.join(ext,"popup",filename));
  }
  const popupHtml=path.join(ext,"popup","index.html");
  const originalPopupHtml=fs.readFileSync(popupHtml,"utf8");
  assert(originalPopupHtml.includes('<script src="popup.js" defer></script>'));
  fs.writeFileSync(popupHtml,originalPopupHtml.replace(
    '<script src="popup.js" defer></script>',
    '<script src="popup.js" defer></script><script src="qa-popup.js" defer></script>'));
  // The page runs the original unmodified production popup implementation.
  // This CI-only peer script asserts its DOM, triggers each distinct control,
  // then publishes only diagnostic pass/fail evidence into extension storage.
  const qaPopup=[
    '"use strict";',
    '(async()=>{',
    ' const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));',
    ' const wait=async fn=>{for(let i=0;i<100;i++){const value=fn();if(value)return value;await delay(100);}',
    '   throw Error("Popup condition timed out; notice="+document.getElementById("notice")?.textContent);};',
    ' const rows=()=>document.querySelectorAll("main#jobs section.job").length;',
    ' const byText=text=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()===text);',
    ' try{',
    '   await wait(()=>rows()===40);',
    '   const uncertain=[...document.querySelectorAll("section.job")].find(s=>',
    '     s.querySelector("h2")?.textContent==="Older QA 1");',
    '   if(!uncertain||!uncertain.textContent.includes("Delivery outcome unconfirmed")',
    '     ||!uncertain.textContent.includes("No automatic retry"))',
    '     throw Error("Uncertain delivery state must be visible and fail closed");',
    '   const load=byText("Load older jobs");',
    '   if(!load||load.hidden)throw Error("Older jobs control unavailable");',
    '   load.click();',
    '   await wait(()=>rows()===45);',
    '   document.getElementById("filter-query").value="QA native report";',
    '   document.getElementById("filter-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));',
    '   await wait(()=>rows()===1&&document.querySelector("#jobs h2")?.textContent==="QA native report");',
    '   const save=byText("Save report");',
    '   if(!save)throw Error("Manual report action missing");',
    '   save.click();',
    '   await wait(()=>save.textContent.trim()==="Download prepared report");',
    '   save.click();',
    '   await wait(()=>save.textContent.trim()==="Save report");',
    '   const forget=byText("Forget bridge record");',
    '   if(!forget)throw Error("Forget action missing");',
    '   forget.click();',
    '   if(rows()!==1||forget.textContent.trim()!=="Confirm forget")',
    '     throw Error("Forget must require confirmation");',
    '   forget.click();',
    '   await wait(()=>rows()===0);',
    '   await browser.storage.local.set({jobflick_qa_popup_result:{ok:true,loaded:45,filtered:1,',
    '      prepared:true,forgotten:true}});',
    ' }catch(error){await browser.storage.local.set({jobflick_qa_popup_result:{',
    '     ok:false,message:String(error?.message||error)}});}',
    '})();'
  ].join("\n");
  fs.writeFileSync(path.join(ext,"popup","qa-popup.js"),qaPopup);
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
    '    orphaned:true,deliveryState:i===1?"delivery_uncertain":"manual_only"};',
    '}',
    'await browser.storage.local.set({jobflick_bridge_jobs_v1:data});',
    'document.querySelector("#qa-open").addEventListener("click",event=>{',
    ' if(event.isTrusted)void browser.runtime.sendMessage({type:"qa:open-popup"});',
    '});',
    'document.documentElement.dataset.qaPopupUrl=browser.runtime.getURL("popup/index.html");',
    'document.documentElement.dataset.qaSeeded="true";',
    'const poll=setInterval(async()=>{',
    ' const state=await browser.storage.local.get("jobflick_qa_popup_result");',
    ' if(state.jobflick_qa_popup_result){',
    '   document.documentElement.dataset.qaResult=JSON.stringify(state.jobflick_qa_popup_result);',
    '   clearInterval(poll);',
    ' }',
    '},250);',
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
      response.end('<!doctype html><html lang="en"><body><main>Disposable popup QA</main><button type="button" id="qa-open">Open privileged popup</button></body></html>');
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
    // Genuine WebDriver click sends a validated QA-only request for the
    // actual toolbar action popup. This cannot be implemented by navigating
    // an extension tab: the production popup guard forbids sender.tab.
    await (await driver.findElement(By.id("qa-open"))).click();
    await driver.wait(async()=>(
      await driver.executeScript("return Boolean(document.documentElement.dataset.qaResult)")
    ),20000);
    const result=JSON.parse(await driver.executeScript(
      "return document.documentElement.dataset.qaResult"));
    assert.equal(result.ok,true,result.message||"Privileged popup QA failed");
    assert.equal(result.loaded,45);
    assert.equal(result.filtered,1);
    assert.equal(result.forgotten,true);

    const target=path.join(downloads,"jobflick-"+JOB+".txt");
    await driver.wait(()=>fs.existsSync(target) &&
      fs.readFileSync(target,"utf8")===REPORT,12000);
    assert.equal(fs.readFileSync(target,"utf8"),REPORT);
    const log=path.join(state,"native-requests.jsonl");
    assert(fs.existsSync(log),"Report must come from Firefox Native Messaging");
    const requests=fs.readFileSync(log,"utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(requests.map(x=>x.action),["show"],
      "Popup must neither execute Fish nor submit, inspect or send");
    assert.equal(requests[0].id,JOB);

    await driver.uninstallAddon(id);
    console.log("Real Firefox toolbar popup: 45-row paging, filtered search, native show report, exact File export, bridge-only Forget; no submit/send. Test clicks inside popup are CI-side programmatic, not WebDriver-trusted gestures.");
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
