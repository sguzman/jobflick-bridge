"use strict";
// Real disposable Firefox Developer Edition, unchanged production popup code
// against a 325-job no-execution runtime fixture. Not a privileged popup.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const {Builder,By}=require("selenium-webdriver");
const firefox=require("selenium-webdriver/firefox");
const JOB="job_12345678";
const REPORT="Synthetic saved Jobflick report\nFinished safely\n";

async function main(){
  if(process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true")
    throw Error("Disposable GitHub Actions runner required");
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary))throw Error("Missing FDE_BINARY");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-inbox-qa-"));
  const popup=path.resolve(__dirname,"../extension/popup");
  const original=fs.readFileSync(path.join(popup,"index.html"),"utf8");
  const script=fs.readFileSync(path.join(popup,"popup.js"),"utf8");
  const css=fs.readFileSync(path.join(popup,"popup.css"),"utf8");
  const stub=[
    "<script>",
    "window.__qaRequests=[];window.__qaOpened=[];",
    "window.__qaJobs=[{id:'job_12345678',name:'Primary completed QA',state:'succeeded',",
    "submittedAt:325,orphaned:true,deliveryState:'manual_only',",
    "conversation:'https://chatgpt.com/c/synthetic-1234?ignore=1#fragment'},",
    "...Array.from({length:324},(_,i)=>({",
    "id:'job_'+String(i+1).padStart(8,'0'),name:'Archived QA '+String(i+1).padStart(4,'0'),",
    "state:'succeeded',submittedAt:324-i,orphaned:true,deliveryState:'manual_only',",
    "conversation:'https://chatgpt.com/c/archived-1234'}))];",
    "window.browser={runtime:{sendMessage:async req=>{",
    "window.__qaRequests.push({...req});",
    "if(req.type==='jobflick:inbox'){",
    "const query=String(req.query||'').trim().toLowerCase();",
    "const records=window.__qaJobs.filter(j=>!query||[j.id,j.name,j.state]",
    ".some(x=>x.toLowerCase().includes(query)));",
    "const offset=req.offset||0;const page=records.slice(offset,offset+(req.limit||40));",
    "return {ok:true,jobs:page,nextOffset:offset+page.length,",
    "hasMore:offset+page.length<records.length};}",
    "if(req.type==='jobflick:report'&&req.id==='job_12345678')",
    "return {ok:true,report:'Synthetic saved Jobflick report\\nFinished safely\\n'};",
    "if(req.type==='jobflick:forget'){window.__qaJobs=window.__qaJobs.filter(",
    "j=>j.id!==req.id);return {ok:true};}",
    "throw Error('Unexpected action '+req.type);",
    "}},tabs:{create:async details=>{window.__qaOpened.push(details);return {id:991,...details};}}};",
    "</script>"
  ].join("\n");
  const html=original.replace('<script src="popup.js" defer></script>',
    stub+'\n<script src="popup.js" defer></script>');
  assert.notEqual(html,original);
  let server,driver;
  try {
    server=http.createServer((req,res)=>{
      const isJs=req.url==="/popup.js",isCss=req.url==="/popup.css";
      res.writeHead(200,{"Content-Type":isJs?"application/javascript":
        isCss?"text/css":"text/html; charset=utf-8"});
      res.end(isJs?script:isCss?css:html);
    });
    await new Promise((ok,no)=>{
      server.once("error",no);server.listen(0,"127.0.0.1",ok);
    });
    const opts=new firefox.Options().setBinary(binary).addArguments("-headless");
    opts.setPreference("browser.download.folderList",2);
    opts.setPreference("browser.download.dir",dir);
    opts.setPreference("browser.download.useDownloadDir",true);
    opts.setPreference("browser.helperApps.neverAsk.saveToDisk","text/plain");
    driver=await new Builder().forBrowser("firefox").setFirefoxOptions(opts).build();
    await driver.get("http://127.0.0.1:"+server.address().port+"/");
    const rows=()=>driver.findElements(By.css("main#jobs section.job"));
    const count=n=>driver.wait(async()=>(await rows()).length===n,10000);
    const actions=()=>driver.executeScript("return window.__qaRequests");
    await count(40);
    assert.equal(await driver.executeScript(
      "return document.getElementById('load-older').hidden"),false);
    assert.deepEqual((await actions()).map(x=>x.type),["jobflick:inbox"]);
    for(let expected=80;expected<=325;expected+=40){
      await (await driver.findElement(By.id("load-older"))).click();
      await count(Math.min(expected,325));
    }
    assert.equal(await driver.executeScript(
      "return document.getElementById('load-older').hidden"),true);
    assert((await actions()).every(x=>x.type==="jobflick:inbox"));
    assert((await actions()).every(x=>x.limit===40));
    const filter=await driver.findElement(By.id("filter-query"));
    await filter.sendKeys("Archived QA 0324");
    await (await driver.findElement(By.css("#filter-form button"))).click();
    await count(1);
    assert.match(await (await rows())[0].getText(),/Archived QA 0324/);
    assert.equal((await actions()).filter(x=>x.type==="jobflick:report").length,0);
    await filter.clear();
    await (await driver.findElement(By.css("#filter-form button"))).click();
    await count(40);
    const first=(await rows())[0];
    assert.match(await first.getText(),/Primary completed QA/);
    await (await first.findElement(By.xpath(".//button[normalize-space(.)='Open chat']"))).click();
    assert.deepEqual(await driver.executeScript("return window.__qaOpened"),[
      {url:"https://chatgpt.com/c/synthetic-1234"}
    ]);
    assert.equal((await actions()).filter(x=>x.type==="jobflick:report").length,0);
    await (await first.findElement(By.xpath(
      ".//button[normalize-space(.)='Save report']"))).click();
    await driver.wait(async()=>(
      await first.findElements(By.xpath(
        ".//button[normalize-space(.)='Download prepared report']"))
    ).length===1,7000);
    assert.equal((await actions()).filter(x=>x.type==="jobflick:report").length,1);
    const downloaded=path.join(dir,"jobflick-"+JOB+".txt");
    assert.equal(fs.existsSync(downloaded),false);
    await (await first.findElement(By.xpath(
      ".//button[normalize-space(.)='Download prepared report']"))).click();
    await driver.wait(()=>fs.existsSync(downloaded)&&
      fs.readFileSync(downloaded,"utf8")===REPORT,10000);
    await (await first.findElement(By.xpath(
      ".//button[normalize-space(.)='Forget bridge record']"))).click();
    assert.equal((await actions()).filter(x=>x.type==="jobflick:forget").length,0);
    await (await first.findElement(By.xpath(
      ".//button[normalize-space(.)='Confirm forget']"))).click();
    await count(39);
    assert.equal((await actions()).filter(x=>x.type==="jobflick:forget").length,1);
    assert.equal(await driver.executeScript("return window.__qaJobs.length"),324);
    assert((await actions()).every(x=>![
      "jobflick:submit","jobflick:cancel","jobflick:send"
    ].includes(x.type)));
    console.log("FDE: 325 inbox entries paged/searched; manual chat, report and forget"+
      " verified, no submit/cancel/send");
  } finally {
    if(driver)await driver.quit();
    if(server)await new Promise(ok=>server.close(ok));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(e=>{
  console.error("Firefox inbox acceptance failed:",e.stack||e.message);
  process.exitCode=1;
});