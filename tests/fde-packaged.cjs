"use strict";
// CI-only load of the actual deterministic unsigned source archive as XPI.
// Firefox Developer Edition temporary installation is NOT Mozilla signing.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {Builder,By}=require("selenium-webdriver");
const firefox=require("selenium-webdriver/firefox");

async function main(){
  if(process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true")
    throw Error("Temporary package QA requires disposable GitHub Actions");
  const binary=process.env.FDE_BINARY;
  const xpi=process.env.FDE_UNSIGNED_ARCHIVE;
  if(!binary||!path.isAbsolute(binary)||!xpi||!path.isAbsolute(xpi)||
     !fs.statSync(xpi).isFile()||!xpi.endsWith(".xpi"))
    throw Error("Expected absolute Firefox binary and unsigned test XPI paths");
  const opts=new firefox.Options().setBinary(binary).addArguments("-headless");
  let driver;
  try {
    driver=await new Builder().forBrowser("firefox")
      .setFirefoxOptions(opts).build();
    const id=await driver.installAddon(xpi,true);
    assert.equal(id,"jobflick-bridge@sguzman.github.io",
      "Package must retain production Gecko ID for native host authorization");
    const hostile="<main><pre><code>schema: 4\ncommand: pwd</code></pre></main>";
    await driver.get("data:text/html,"+encodeURIComponent(hostile));
    assert.equal((await driver.findElements(By.css(".jobflick-bridge-run"))).length,0,
      "Deterministic QA archive must not inject on unauthorized hosts");
    await driver.uninstallAddon(id);
    console.log("Deterministic unsigned ZIP installed/removed as temporary "+
      "Firefox Developer Edition XPI; no personal profile, native job or signing");
  } finally {
    if(driver)await driver.quit();
  }
}
main().catch(e=>{
  console.error("Unsigned packaged XPI acceptance failed:",e.stack||e.message);
  process.exitCode=1;
});