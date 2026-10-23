"use strict";
// Firefox Developer Edition test of actual popup export behavior, hosted on
// localhost with a non-executing runtime shim because Marionette cannot
// automate privileged moz-extension:// popup tabs.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const {Builder,By,until}=require("selenium-webdriver");
const firefox=require("selenium-webdriver/firefox");

const JOB="job_12345678";
const REPORT="Synthetic Jobflick report\nStatus: Succeeded\nNo personal content\n";

async function main(){
  if(process.env.GITHUB_ACTIONS!=="true"||process.env.CI!=="true")
    throw Error("Local export browser QA requires disposable GitHub Actions");
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary))throw Error("FDE_BINARY must be absolute");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-export-qa-"));
  const popupDir=path.join(__dirname,"../extension/popup");
  const originalHtml=fs.readFileSync(path.join(popupDir,"index.html"),"utf8");
  const js=fs.readFileSync(path.join(popupDir,"popup.js"),"utf8");
  const css=fs.readFileSync(path.join(popupDir,"popup.css"),"utf8");
  const stub=[
    '<script>',
    'window.__qaRequests=[];',
    'window.browser={runtime:{sendMessage:async request=>{',
    '  window.__qaRequests.push(request.type);',
    '  if(request.type==="jobflick:inbox")return {',
    '    ok:true,hasMore:false,nextOffset:1,jobs:[{',
    '      id:"job_12345678",name:"Synthetic completed QA",state:"succeeded",',
    '      submittedAt:1,orphaned:true,deliveryState:"manual_only",',
    '      conversation:"https://chatgpt.com/c/synthetic-1234"',
    '    }]};',
    '  if(request.type==="jobflick:report")return {',
    '    ok:true,report:"Synthetic Jobflick report\\nStatus: Succeeded\\nNo personal content\\n"};',
    '  throw Error("Unexpected browser action "+request.type);',
    '}}};',
    '</script>'
  ].join("\n");
  const html=originalHtml.replace('<script src="popup.js" defer></script>',
    stub+'\n<script src="popup.js" defer></script>');
  if(html===originalHtml)throw Error("Popup HTML script tag changed");
  let driver=null,server=null;
  try{
    server=http.createServer((request,response)=>{
      const file=request.url==="/popup.js"?js:request.url==="/popup.css"?css:html;
      response.writeHead(200,{"Content-Type":request.url==="/popup.js"?
        "application/javascript":request.url==="/popup.css"?
        "text/css":"text/html; charset=utf-8"});
      response.end(file);
    });
    await new Promise((resolve,reject)=>{
      server.once("error",reject);server.listen(0,"127.0.0.1",resolve);
    });
    const options=new firefox.Options().setBinary(binary).addArguments("-headless");
    options.setPreference("browser.download.folderList",2);
    options.setPreference("browser.download.dir",dir);
    options.setPreference("browser.download.useDownloadDir",true);
    options.setPreference("browser.helperApps.neverAsk.saveToDisk","text/plain");
    options.setPreference("browser.download.alwaysOpenPanel",false);
    driver=await new Builder().forBrowser("firefox")
      .setFirefoxOptions(options).build();
    await driver.get("http://127.0.0.1:"+server.address().port+"/");
    const findSave=()=>driver.findElement(
      By.xpath("//button[normalize-space(.)='Save report']"));
    await driver.wait(async()=>{
      return (await driver.findElements(
        By.xpath("//button[normalize-space(.)='Save report']"))).length>0;
    },10000);
    const target=path.join(dir,"jobflick-"+JOB+".txt");
    assert.equal(fs.existsSync(target),false,"Never download on popup load");
    await (await findSave()).click();
    await driver.wait(async()=>(
      await driver.findElements(
        By.xpath("//button[normalize-space(.)='Download prepared report']")
      )).length>0,7000);
    assert.equal(fs.existsSync(target),false,"First click only prepares a File");
    const actions=await driver.executeScript("return window.__qaRequests");
    assert.deepEqual(actions,["jobflick:inbox","jobflick:report"]);
    await (await driver.findElement(
      By.xpath("//button[normalize-space(.)='Download prepared report']")
    )).click();
    await driver.wait(()=>fs.existsSync(target),10000);
    assert.equal(fs.readFileSync(target,"utf8"),REPORT);
    const after=await driver.executeScript("return window.__qaRequests");
    assert.deepEqual(after,["jobflick:inbox","jobflick:report"]);
    console.log("Firefox manual report export: two gestures, exact text File downloaded, no submit or Send");
  }finally{
    if(driver)await driver.quit();
    if(server)await new Promise(resolve=>server.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(error=>{
  console.error("Disposable Firefox local export QA failed:",error.message);
  process.exitCode=1;
});