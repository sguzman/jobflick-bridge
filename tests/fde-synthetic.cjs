"use strict";

// Disposable GitHub Actions Firefox Developer Edition DOM integration test.
// This intentionally creates a QA-only extension manifest with localhost
// permission and a mock background; production manifest/background are intact.
// No Jobflick daemon, native host, user profile, or authenticated ChatGPT.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const {Builder,By,until}=require("selenium-webdriver");
const firefox=require("selenium-webdriver/firefox");

async function main(){
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary))throw Error("FDE_BINARY must be absolute");
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-fde-synthetic-"));
  const extensionRoot=path.resolve(__dirname,"../extension");
  const manifest=JSON.parse(fs.readFileSync(path.join(extensionRoot,"manifest.json"),"utf8"));
  // Test-only host permission. Never modify production source to permit localhost.
  manifest.browser_specific_settings.gecko.id="jobflick-bridge-synthetic@sguzman.github.io";
  manifest.host_permissions=["http://127.0.0.1/*"];
  manifest.content_scripts=[{
    matches:["http://127.0.0.1/*"],
    js:["content.js"],run_at:"document_idle"
  }];
  manifest.background={scripts:["qa-background.js"]};
  manifest.action={default_title:"Synthetic browser QA"};
  fs.writeFileSync(path.join(temporary,"manifest.json"),JSON.stringify(manifest));
  fs.copyFileSync(path.join(extensionRoot,"content.js"),path.join(temporary,"content.js"));
  fs.writeFileSync(path.join(temporary,"qa-background.js"),[
    '"use strict";',
    'browser.runtime.onMessage.addListener(message=>{',
    ' if(message?.type==="jobflick:validate")return Promise.resolve({ok:true});',
    ' if(message?.type==="jobflick:submit")return Promise.resolve({ok:false,message:"Synthetic fixture never queues work"});',
    ' return Promise.resolve({ok:false,message:"Unknown synthetic action"});',
    '});'
  ].join("\n"));

  const yaml=[
    "schema: 4","name: QA non-executing fixture","shell: fish",
    "cwd: /tmp","privilege: none","timeout_seconds: 5","command: pwd"
  ].join("\n");
  const escapeHtml=s=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;");
  const html='<!doctype html><html><head><meta charset="utf-8"></head><body>'+
    '<main><pre><code>'+escapeHtml(yaml)+'</code></pre></main></body></html>';
  const server=http.createServer((_request,response)=>{
    response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
    response.end(html);
  });
  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",resolve);
  });
  let driver=null;
  try{
    const port=server.address().port;
    driver=await new Builder().forBrowser("firefox")
      .setFirefoxOptions(new firefox.Options().setBinary(binary).addArguments("-headless"))
      .build();
    const id=await driver.installAddon(temporary,true);
    assert.equal(id,"jobflick-bridge-synthetic@sguzman.github.io");
    await driver.get("http://127.0.0.1:"+port+"/");

    // Deliberately trigger only non-executing validation from the page.
    // The browser's actual content script still creates its own Run button.
    await driver.wait(until.elementLocated(By.css("main pre code")),10000);
    // The content script may be injected shortly after navigation; repeat
    // the non-executing focus event until the Firefox extension button exists.
    const button=await driver.wait(async()=>{
      await driver.executeScript(
        "document.querySelector('pre').dispatchEvent(new Event('focusin',{bubbles:true}));"
      );
      const matches=await driver.findElements(By.css(".jobflick-bridge-run"));
      return matches[0] || false;
    },10000);
    assert.match(await button.getText(),/Run Jobflick/);

    // Native Firefox/Marionette click generates trusted input, but the QA
    // background explicitly REJECTS submission. No Fish command executes.
    await button.click();
    await driver.wait(async()=>/Submission uncertain/.test(await button.getText()),10000);

    await driver.uninstallAddon(id);
    console.log("Synthetic FDE content script: validation UI and guarded click passed; no native jobs submitted");
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temporary,{recursive:true,force:true});
  }
}
main().catch(err=>{console.error("Synthetic FDE smoke failed:",err.message);process.exitCode=1;});
