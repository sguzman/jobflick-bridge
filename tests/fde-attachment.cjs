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
      content_scripts:[{matches:["http://127.0.0.1/*"],js:["attachment-probe.js"],
        run_at:"document_idle"}]
    };
    fs.writeFileSync(path.join(work,"manifest.json"),JSON.stringify(manifest));
    fs.writeFileSync(path.join(work,"attachment-probe.js"),[
      '"use strict";',
      '// A synthetic, non-executable text report with no personal data.',
      'const text="jobflick synthetic report: completed";',
      'const input=document.getElementById("upload");',
      'const report=new File([text],"jobflick-test-report.txt",{type:"text/plain"});',
      'const transfer=new DataTransfer();',
      'transfer.items.add(report);',
      'let assigned=false;',
      'try {',
      '  input.files=transfer.files;',
      '  assigned=input.files?.length===1;',
      '  if(assigned)input.dispatchEvent(new Event("change",{bubbles:true}));',
      '} catch(error) {',
      '  document.documentElement.dataset.probeError=String(error.name||error);',
      '}',
      'document.documentElement.dataset.probeAssigned=String(assigned);'
    ].join("\n"));
    const html=[
      '<!doctype html><html lang="en"><meta charset="utf-8"><body>',
      '<input id="upload" type="file" accept=".txt,text/plain">',
      '<output id="result"></output>',
      '<script>',
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
    await driver.wait(async()=>{
      const raw=await driver.findElement(By.id("result")).getText();
      return !!raw;
    },5000);
    const raw=await driver.findElement(By.id("result")).getText();
    assert(!raw.startsWith("error:"),"Page realm could not read assigned File: "+raw);
    const report=JSON.parse(raw);
    assert.equal(report.name,"jobflick-test-report.txt");
    assert.equal(report.type,"text/plain");
    assert.equal(report.text,"jobflick synthetic report: completed");
    assert.equal(report.bytes,Buffer.byteLength(report.text));
    assert.equal(report.trusted,false);
    await driver.uninstallAddon(addon);
    console.log("Synthetic Firefox attachment handoff: page could read 1 text/plain File from extension realm; no network upload or Send");
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