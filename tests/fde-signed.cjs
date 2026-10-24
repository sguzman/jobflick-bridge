"use strict";
// Only used AFTER explicit Mozilla signing gate. Disposable Firefox Developer
// Edition checks a signed XPI with permanent (not temporary) installation.
// Never touches a regular browser profile or native-host registration.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");

async function main() {
  if(process.env.CI!=="true" || process.env.GITHUB_ACTIONS!=="true")
    throw Error("Signed XPI QA requires disposable CI environment");
  const binary=process.env.FDE_BINARY, archive=process.env.FDE_SIGNED_XPI;
  if(!binary || !path.isAbsolute(binary) ||
      !archive || !path.isAbsolute(archive) || !archive.endsWith(".xpi") ||
      !fs.statSync(binary).isFile() || !fs.statSync(archive).isFile())
    throw Error("Signed Firefox QA requires absolute existing Firefox/XPI files");
  const {Builder,By}=require("selenium-webdriver");
  const firefox=require("selenium-webdriver/firefox");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-signed-fde-"));
  const profile=path.join(root,"profile");
  fs.mkdirSync(profile,{mode:0o700});
  let driver=null;
  const makeDriver=()=>new Builder().forBrowser("firefox").setFirefoxOptions(
    new firefox.Options().setBinary(binary)
      .addArguments("-headless","-profile",profile)).build();
  try {
    driver=await makeDriver();
    const id=await driver.installAddon(archive,false);
    assert.equal(id,"jobflick-bridge@sguzman.github.io",
      "Signed extension ID must match allowed_extensions of Firefox native host");
    const hostile="<main><pre><code>schema: 4\\ncommand: pwd</code></pre></main>";
    await driver.get("data:text/html,"+encodeURIComponent(hostile));
    assert.equal((await driver.findElements(By.css(".jobflick-bridge-run"))).length,0,
      "Signed extension must not inject Jobflick controls on foreign sites");
    await driver.quit();driver=null;
    driver=await makeDriver();
    await driver.get("data:text/html,"+encodeURIComponent(hostile));
    assert.equal((await driver.findElements(By.css(".jobflick-bridge-run"))).length,0);
    // Removing it after a full process restart establishes that installation
    // was persistent rather than only the WebDriver temporary-add-on path.
    await driver.uninstallAddon(id);
    console.log("Signed XPI installed persistently and removed after Firefox Developer Edition process restart; no personal profile or execution");
  } finally {
    if(driver)await driver.quit();
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{
  console.error("Disposable signed XPI acceptance failed:",error.message);
  process.exitCode=1;
});
