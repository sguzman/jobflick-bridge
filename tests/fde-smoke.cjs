"use strict";

// GitHub Actions only: anonymous geckodriver profile, no Jobflick/native host,
// no authenticated ChatGPT. Passing is an add-on installation smoke gate only.
const assert = require("node:assert/strict");
const path = require("node:path");
const { Builder } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

async function main() {
  const binary = process.env.FDE_BINARY;
  if (!binary || !path.isAbsolute(binary)) {
    throw new Error("FDE_BINARY must be the exact installed Firefox Developer Edition binary");
  }
  const options = new firefox.Options().setBinary(binary).addArguments("-headless");
  let driver;
  try {
    driver = await new Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(options)
      .build();
    const id = await driver.installAddon(path.join(__dirname, "../extension"), true);
    assert.equal(id, "jobflick-bridge@sguzman.github.io");
    const ua = await driver.executeScript("return navigator.userAgent");
    assert.match(ua, /Firefox/);
    await driver.uninstallAddon(id);
    console.log("FDE headless: temporary Firefox extension installation/uninstallation passed");
  } finally {
    if (driver) await driver.quit();
  }
}

main().catch(error => {
  console.error("FDE smoke test failed:", error.message);
  process.exitCode = 1;
});
