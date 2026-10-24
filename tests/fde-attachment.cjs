"use strict";
// QA-only file handoff acceptance. Disposable FDE add-on and localhost page.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const {Builder,By}=require("selenium-webdriver");
const firefox=require("selenium-webdriver/firefox");

async function main(){
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary))throw Error("FDE_BINARY must be absolute");
  if(process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true")
    throw Error("File handoff probe runs only on disposable GitHub Actions");
  const work=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-attachment-qa-"));
  let driver=null,server=null;
  try{
    const id="jobflick-attachment-qa@sguzman.github.io";
    const manifest={
      manifest_version:3,name:"Jobflick Local Attachment Probe",version:"0.0.1",
      browser_specific_settings:{gecko:{id,strict_min_version:"140.0"}},
      host_permissions:["http://127.0.0.1/*"],
      content_scripts:[{matches:["http://127.0.0.1/*"],js:["attachment-adapter.js","attachment-probe.js"],
        run_at:"document_idle"}]
    };
    fs.writeFileSync(path.join(work,"manifest.json"),JSON.stringify(manifest));
    fs.copyFileSync(path.join(__dirname,"../extension/attachment-adapter.js"),
      path.join(work,"attachment-adapter.js"));
    fs.writeFileSync(path.join(work,"attachment-probe.js"),[
      '"use strict";',
      'const api=globalThis.__jobflickAttachmentAdapter;',
      'const report=api.prepare("job_12345678","jobflick synthetic report: completed");',
      'const input=document.getElementById("upload");',
      'let assigned=false;',
      'try {',
      '  const receipt=api.handoff(input,report);',
      '  assigned=receipt.ok && receipt.domHandoffOnly && input.files?.length===1;',
      '}catch(error){',
      '  document.documentElement.dataset.probeError=String(error.message||error);',
      '}',

      'const composer=document.getElementById("composer");',
      'const busy=document.getElementById("busy");',
      'const guarded=document.getElementById("guarded");',
      'const ambiguous=document.getElementById("guarded-ambiguous");',
      'const attached=document.getElementById("guarded-attached");',
      'const routeInput=document.getElementById("guarded-route");',
      'const currentRoute=()=>location.origin+location.pathname;',
      'const currentEpoch=()=>Number(document.documentElement.dataset.qaEpoch||"0");',
      'document.documentElement.dataset.qaEpoch="0";',
      'const guardedArgs=(input,chosenComposer=composer)=>({',
      '  composer:chosenComposer,input,file:report,composerCandidates:[chosenComposer],',
      '  fileInputCandidates:[input],expectedRoute:currentRoute(),currentRoute,',
      '  expectedEpoch:0,currentEpoch,existingAttachmentsAbsent:()=>true',
      '});',
      'const verified=api.handoffToEmptyComposer(guardedArgs(guarded));',
      'document.documentElement.dataset.probeGuarded=String(verified.domHandoffOnly',
      '  && guarded.files?.length===1 && composer.textContent==="");',
      'let draftDenied=false;',
      'try{api.handoffToEmptyComposer(guardedArgs(document.getElementById("guarded-busy"),busy));}',
      'catch(error){draftDenied=/Existing draft/.test(error.message);}',
      'document.documentElement.dataset.probeBusy=String(draftDenied && busy.textContent==="User draft");',
      'let ambiguityDenied=false;',
      'try{api.handoffToEmptyComposer({...guardedArgs(ambiguous),',
      '  composerCandidates:[composer,busy]});}',
      'catch(error){ambiguityDenied=/ambiguous/.test(error.message);}',
      'document.documentElement.dataset.probeAmbiguous=String(ambiguityDenied',
      '  && ambiguous.files?.length===0);',
      'let attachmentsDenied=false;',
      'try{api.handoffToEmptyComposer({...guardedArgs(attached),',
      '  existingAttachmentsAbsent:()=>false});}',
      'catch(error){attachmentsDenied=/Existing attachments/.test(error.message);}',
      'document.documentElement.dataset.probeAttachments=String(attachmentsDenied',
      '  && attached.files?.length===0);',
      'let routeDenied=false;',
      'try{api.handoffToEmptyComposer({...guardedArgs(routeInput),',
      '  expectedRoute:currentRoute()+"#stale"});}',
      'catch(error){routeDenied=/conversation changed/.test(error.message);}',
      'document.documentElement.dataset.probeRoute=String(routeDenied',
      '  && routeInput.files?.length===0);',
      'let epochDenied=false;',
      'try{api.handoffToEmptyComposer(guardedArgs(routeInput));}',
      'catch(error){epochDenied=/conversation changed/.test(error.message);}',
      'document.documentElement.dataset.probeEpoch=String(epochDenied',
      '  && currentEpoch()===1 && currentRoute()===location.origin+location.pathname',
      '  && routeInput.files?.length===0);',
      'const replaceInput=document.getElementById("guarded-replacement");',
      'let preservedReplacement=false;',
      'try{api.handoffToEmptyComposer(guardedArgs(replaceInput));}',
      'catch(error){',
      '  preservedReplacement=/conversation changed/.test(error.message)',
      '   && replaceInput.files?.length===1',
      '   && replaceInput.files[0].name==="user-override.txt";',
      '}',
      'document.documentElement.dataset.probeReplacement=String(preservedReplacement);',
      'const occupied=document.getElementById("occupied");',
      'const selected=new DataTransfer();',
      'selected.items.add(new File(["user draft"],"user-draft.txt",{type:"text/plain"}));',
      'occupied.files=selected.files;',
      'let preserved=false;',
      'try {api.handoff(occupied,report);}',
      'catch(error){preserved=/must not be overwritten/.test(error.message);}',
      'document.documentElement.dataset.probePreserved=String(',
      '  preserved && occupied.files?.[0]?.name==="user-draft.txt");',
      'const rejecting=document.getElementById("reject");',
      'let listenerRejectionDetected=false;',
      'try {api.handoff(rejecting,report);}',
      'catch(error){listenerRejectionDetected=/changed during handoff/.test(error.message) && rejecting.files?.length===0;}',
      'document.documentElement.dataset.probeRejected=String(listenerRejectionDetected);',
      'const removed=document.getElementById("removed");',
      'let removedDetected=false;',
      'try {api.handoff(removed,report);}',
      'catch(error){removedDetected=/changed during handoff/.test(error.message) && !removed.isConnected;}',
      'document.documentElement.dataset.probeRemoved=String(removedDetected);',
      'let oversizeRejected=false;',
      'try {api.prepare("job_12345678","z".repeat(524289));}',
      'catch(error){oversizeRejected=/512 KiB/.test(error.message);}',
      'document.documentElement.dataset.probeOversize=String(oversizeRejected);',
      'document.documentElement.dataset.probeAssigned=String(assigned);'
    ].join("\n"));
    const html=[
      '<!doctype html><html lang="en"><meta charset="utf-8"><body>',
      '<input id="upload" type="file" accept=".txt,text/plain">',

      '<div id="composer" contenteditable="true" aria-label="Synthetic empty draft"></div>',
      '<div id="busy" contenteditable="true">User draft</div>',
      '<input id="guarded" type="file">',
      '<input id="guarded-busy" type="file">',
      '<input id="guarded-ambiguous" type="file">',
      '<input id="guarded-attached" type="file">',
      '<input id="guarded-route" type="file">',
      '<input id="guarded-replacement" type="file">',
      '<input id="occupied" type="file" accept=".txt,text/plain">',
      '<input id="reject" type="file" accept=".txt,text/plain">',
      '<input id="removed" type="file" accept=".txt,text/plain">',
      '<output id="result"></output>',
      '<script>',
      'document.querySelector("#guarded-route").addEventListener("change",()=>{',
      'const root=document.documentElement;',
      'root.dataset.qaEpoch=String(Number(root.dataset.qaEpoch||"0")+1);',
      '});',
      'document.querySelector("#guarded-replacement").addEventListener("change",e=>{',
      '  const transfer=new DataTransfer();',
      '  transfer.items.add(new File(["USER"],"user-override.txt",{type:"text/plain"}));',
      '  e.target.files=transfer.files;',
      '  const root=document.documentElement;',
      '  root.dataset.qaEpoch=String(Number(root.dataset.qaEpoch||"0")+1);',
      '});',
      'document.querySelector("#reject").addEventListener("change",e=>{e.target.value="";});',
      'document.querySelector("#removed").addEventListener("change",e=>{e.target.remove();});',
      'document.querySelector("#upload").addEventListener("change",async e=>{',
      '  const output=document.querySelector("#result");',
      '  try {',
      '    const file=e.target.files?.[0];',
      '    if(!file){output.textContent="missing-file";return;}',
      '    const contents=await file.text();',
      '    output.textContent=JSON.stringify({',
      '      name:file.name,type:file.type,bytes:file.size,text:contents,',
      '      trusted:e.isTrusted',
      '    });',
      '  }catch(error){output.textContent="error:"+error.name;}',
      '});',
      '</script></body></html>'
    ].join("\n");
    server=http.createServer((_req,res)=>{
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end(html);
    });
    await new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(0,"127.0.0.1",resolve);
    });
    driver=await new Builder().forBrowser("firefox")
      .setFirefoxOptions(new firefox.Options().setBinary(binary).addArguments("-headless"))
      .build();
    const addon=await driver.installAddon(work,true);
    assert.equal(addon,id);
    await driver.get("http://127.0.0.1:"+server.address().port+"/");
    await driver.wait(async()=>{
      const assigned=await driver.executeScript(
        "return document.documentElement.dataset.probeAssigned || ''");
      return !!assigned;
    },10000);
    const outcome=await driver.executeScript(
      "return {assigned:document.documentElement.dataset.probeAssigned,"+
      "error:document.documentElement.dataset.probeError||'',"+
      "result:document.querySelector('#result').textContent}");
    assert.equal(outcome.assigned,"true",
      "Firefox content-script FileList assignment failed: "+JSON.stringify(outcome));
    assert.equal(await driver.executeScript(
      "return document.documentElement.dataset.probePreserved"),"true",
      "Adapter must preserve a user-selected file");
    assert.equal(await driver.executeScript(
      "return document.documentElement.dataset.probeOversize"),"true",
      "Adapter must reject oversized report Files");
    assert.equal(await driver.executeScript(
      "return document.documentElement.dataset.probeRejected"),"true",
      "Adapter must refuse a page that synchronously clears the input");
    assert.equal(await driver.executeScript(
      "return document.documentElement.dataset.probeRemoved"),"true",
      "Adapter must refuse a page that detaches the input on change");

    for(const [key,meaning] of [
      ["probeGuarded","single empty composer accepted"],
      ["probeBusy","occupied draft preserved"],
      ["probeAmbiguous","multiple composers rejected"],
      ["probeAttachments","unverified preexisting attachments rejected"],
      ["probeRoute","stale route rejected before a File handoff"],
      ["probeEpoch","A-B-A navigation epoch change removes our staged File"],
      ["probeReplacement","page-replaced File remains untouched on navigation"]
    ]) {
      assert.equal(await driver.executeScript(
        "return document.documentElement.dataset."+key),"true",meaning);
    }
    await driver.wait(async()=>{
      const raw=await driver.findElement(By.id("result")).getText();
      return !!raw;
    },5000);
    const raw=await driver.findElement(By.id("result")).getText();
    assert(!raw.startsWith("error:"),"Page realm could not read assigned File: "+raw);
    const report=JSON.parse(raw);
    assert.equal(report.name,"jobflick-job_12345678.txt");
    assert.equal(report.type,"text/plain");
    assert.equal(report.text,"jobflick synthetic report: completed");
    assert.equal(report.bytes,Buffer.byteLength(report.text));
    assert.equal(report.trusted,false);
    await driver.uninstallAddon(addon);
    console.log("Synthetic Firefox attachment adapter: page read bounded File; existing selection preserved; page-side clear/detach detected; oversized report rejected; no network upload or Send");
  }finally{
    if(driver)await driver.quit();
    if(server)await new Promise(resolve=>server.close(resolve));
    fs.rmSync(work,{recursive:true,force:true});
  }
}
main().catch(error=>{
  console.error("Isolated Firefox attachment handoff failed:",error.message);
  process.exitCode=1;
});