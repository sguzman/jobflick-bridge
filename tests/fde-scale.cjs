"use strict";
// Disposable Firefox Developer Edition scale and idle-activity acceptance.
// Production content script, localhost-only QA background; no native host,
// authentication, command execution, user profile or user data.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const {Builder,By,until}=require("selenium-webdriver");
const firefox=require("selenium-webdriver/firefox");
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function main(){
  if(process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true")
    throw Error("Real Firefox scale QA requires a disposable CI runner");
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary))throw Error("Missing Firefox Developer Edition binary");
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-fde-scale-"));
  const extension=path.resolve(__dirname,"../extension");
  const manifest=JSON.parse(fs.readFileSync(path.join(extension,"manifest.json"),"utf8"));
  manifest.browser_specific_settings.gecko.id="jobflick-scale-qa@sguzman.github.io";
  manifest.host_permissions=["http://127.0.0.1/*"];
  manifest.content_scripts=[{
    matches:["http://127.0.0.1/*"],
    js:["content.js","qa-stats.js"],run_at:"document_idle"
  }];
  manifest.background={scripts:["qa-background.js"]};
  manifest.action={default_title:"Inert Firefox scale QA"};
  fs.writeFileSync(path.join(tmp,"manifest.json"),JSON.stringify(manifest));
  fs.copyFileSync(path.join(extension,"content.js"),path.join(tmp,"content.js"));
  fs.writeFileSync(path.join(tmp,"qa-background.js"),[
    '"use strict";',
    'let validations=0;let submissions=0;',
    'browser.runtime.onMessage.addListener(message=>{',
    ' if(message?.type==="qa:stats")',
    '  return Promise.resolve({validations,submissions});',
    ' if(message?.type==="jobflick:validate"){',
    '  validations++;return Promise.resolve({ok:true});',
    ' }',
    ' if(message?.type==="jobflick:submit"){',
    '  submissions++;return Promise.resolve({ok:false,',
    '    message:"QA denies native submission"});',
    ' }',
    ' return Promise.resolve({ok:false,message:"Unsupported QA action"});',
    '});'
  ].join("\n"));
  fs.writeFileSync(path.join(tmp,"qa-stats.js"),[
    '"use strict";',
    'document.addEventListener("jobflick-qa-stats",()=>{',
    ' void browser.runtime.sendMessage({type:"qa:stats"})',
    '  .then(state=>{document.documentElement.dataset.qaStats=JSON.stringify(state);})',
    '  .catch(()=>{document.documentElement.dataset.qaStats="error";});',
    '});'
  ].join("\n"));

  const yaml=[
    "schema: 4","name: Harmless scale fixture","shell: fish",
    "cwd: /tmp","privilege: none","timeout_seconds: 5",
    "command: printf no_execution"
  ].join("\n");
  const html=(many)=>{
    const count=many?8000:10;
    const items=Array.from({length:count},(_,i)=>{
      const content=i<(many?40:0)?yaml:"archived discussion "+i;
      return "<pre><code>"+content+"</code></pre>";
    }).join("");
    return "<!doctype html><html lang='en'><meta charset='utf-8'>"+
      "<body><main>"+items+"</main></body></html>";
  };
  let driver,server;
  try {
    const dense=html(true),small=html(false);
    server=http.createServer((request,response)=>{
      response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      response.end(request.url?.startsWith("/c/dense")?dense:small);
    });
    await new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(0,"127.0.0.1",resolve);
    });
    const root="http://127.0.0.1:"+server.address().port;
    driver=await new Builder().forBrowser("firefox")
      .setFirefoxOptions(new firefox.Options().setBinary(binary).addArguments("-headless"))
      .build();
    const id=await driver.installAddon(tmp,true);
    assert.equal(id,"jobflick-scale-qa@sguzman.github.io");
    await driver.get(root+"/c/dense-history");
    await driver.wait(async()=>await driver.executeScript(
      "return document.querySelectorAll('main pre').length===8000"),12000);
    const stats=async()=>{
      await driver.executeScript(
        "document.documentElement.dataset.qaStats='';"+
        "document.dispatchEvent(new Event('jobflick-qa-stats'));");
      return driver.wait(async()=>{
        const reply=await driver.executeScript(
          "return document.documentElement.dataset.qaStats");
        return reply && reply!=="error"?JSON.parse(reply):false;
      },7000);
    };
    const idleStart=await stats();
    assert.deepEqual(idleStart,{validations:0,submissions:0},
      "Simply viewing an 8,000-block chat must not request native validation");

    // DOM churn does not trigger a transcript-wide MutationObserver.
    for(let i=0;i<200;i++){
      await driver.executeScript(
        "const old=document.querySelector('#qa-churn');if(old)old.remove();"+
        "const next=document.createElement('div');next.id='qa-churn';"+
        "next.textContent='Unrelated chat rerender '+arguments[0];"+
        "document.querySelector('main').append(next);",i);
    }
    const afterChurn=await stats();
    assert.deepEqual(afterChurn,idleStart,
      "200 unrelated React-style DOM updates must cause zero validation or native execution");

    const original=await driver.getWindowHandle();
    const secondary=[];
    for(let i=0;i<16;i++){
      await driver.switchTo().newWindow("tab");
      secondary.push(await driver.getWindowHandle());
      await driver.get(root+"/c/other-"+String(i).padStart(4,"0"));
      await driver.wait(until.elementLocated(By.css("main pre code")),8000);
      assert.equal((await driver.findElements(By.css(".jobflick-bridge-run"))).length,0,
        "Unrelated chats cannot acquire a Run control without user intent");
    }
    await driver.switchTo().window(original);
    const afterTabs=await stats();
    assert.deepEqual(afterTabs,idleStart,
      "Sixteen additional Firefox chats must be inert without user intent");
    // One minute of real Firefox idle time, with the dense history still
    // loaded and 16 additional tabs present. Watch periodic snapshots for
    // covert native validation/submit work rather than merely testing one
    // endpoint, and avoid brittle machine-dependent wattage thresholds.
    for(let checkpoint=1;checkpoint<=6;checkpoint++){
      await tick(10000);
      const sample=await stats();
      assert.deepEqual(sample,idleStart,
        "No native validation/submit in 60s idle interval "+checkpoint+"/6");
    }

    // Only explicit pointer/focus events may authorize validation.
    await driver.executeScript(
      "for(const pre of Array.from(document.querySelectorAll('main pre')).slice(0,40))"+
      "pre.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));");
    await driver.wait(async()=>(await stats()).validations===16,9000);
    const bounded=await stats();
    assert.equal(bounded.validations,16,
      "Forty pointer intents must obey the 16-candidate bounded queue");
    assert.equal(bounded.submissions,0);
    await tick(2000);
    assert.deepEqual(await stats(),bounded,
      "No repeated native validation after a settled explicit pointer burst");

    for(const handle of secondary){
      await driver.switchTo().window(handle);
      await driver.close();
    }
    await driver.switchTo().window(original);
    assert.equal((await stats()).submissions,0);
    await driver.uninstallAddon(id);
    console.log("FDE scale: 8,000 history blocks, 200 DOM rerenders, 16 other tabs, "+
      "60s idle (six 10s probes), bounded 16 validations after 40 pointer events, zero native submits");
  } finally {
    if(driver)await driver.quit();
    if(server)await new Promise(ok=>server.close(ok));
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
main().catch(error=>{
  console.error("Firefox scale/idle QA failed:",error.stack||error.message);
  process.exitCode=1;
});