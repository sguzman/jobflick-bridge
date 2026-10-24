"use strict";
// Disposable real Firefox Developer Edition execution of the *inert* pure
// delivery policy. No native host, ChatGPT account, report, input or Send.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Builder } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

async function main() {
  if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true")
    throw Error("Delivery policy Firefox QA must run on disposable CI");
  const binary = process.env.FDE_BINARY;
  if (!binary || !path.isAbsolute(binary)) throw Error("Missing FDE_BINARY");
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-policy-fde-"));
  let driver = null, server = null;
  try {
    const addonId="jobflick-delivery-policy-qa@sguzman.github.io";
    fs.writeFileSync(path.join(root,"manifest.json"),JSON.stringify({
      manifest_version:3,name:"Jobflick Inert Delivery Policy QA",
      version:"0.0.1",browser_specific_settings:{gecko:{id:addonId,strict_min_version:"140.0"}},
      host_permissions:["http://127.0.0.1/*"],
      content_scripts:[{matches:["http://127.0.0.1/*"],
        js:["delivery-policy.js","qa.js"],run_at:"document_idle"}]
    }));
    fs.copyFileSync(path.join(__dirname,"../extension/delivery-policy.js"),
      path.join(root,"delivery-policy.js"));
    fs.writeFileSync(path.join(root,"qa.js"),[
      '"use strict";',
      'try {',
      ' const policy=globalThis.__jobflickDeliveryPolicy;',
      ' const record={id:"job_12345678",state:"succeeded",',
      '   origin:"tab-qa-session",tabId:11,submittedAt:123,',
      '   conversation:"https://chatgpt.com/c/synthetic-1234",',
      '   deliveryState:"report_pending_manual_delivery"};',
      ' const consent={jobId:record.id,tabId:11,origin:record.origin,',
      '   conversation:record.conversation,currentConversation:record.conversation,',
      '   expectedEpoch:0,currentEpoch:0,originalTabVerified:true,',
      '   siteIdentityVerified:true,composerIdentity:"synthetic-A",',
      '   composerCount:1,fileInputCount:1,composerEmpty:true,',
      '   existingAttachmentsAbsent:true,fileSelectionEmpty:true,',
      '   noOtherAttachments:true,attachmentCount:1};',
      ' const receipt={jobId:record.id,accepted:true,',
      '   filename:"jobflick-"+record.id+".txt",',
      '   conversation:record.conversation,composerIdentity:"synthetic-A",',
      '   originalConversationVerified:true,siteAttachmentAcknowledged:true,',
      '   siteSendAcknowledged:true};',
      ' const illegal=policy.propose(record,"begin_send",{...consent,',
      '   receipt,optIn:"send-this-job"});',
      ' const prepared=policy.propose(record,"begin_attachment",{...consent,',
      '   optIn:"attach-this-job"});',
      ' const attached=policy.propose(prepared.next,"attachment_acknowledged",',
      '   {...consent,receipt});',
      ' const send=policy.propose(attached.next,"begin_send",{...consent,',
      '   receipt,optIn:"send-this-job"});',
      ' const repeat=policy.propose(send.next,"begin_send",{...consent,',
      '   receipt,optIn:"send-this-job"});',
      ' const unknown=policy.propose(send.next,"reconcile_uncertain");',
      ' document.documentElement.dataset.qaPolicy=JSON.stringify({',
      '   prohibitedBeforeAttachment:illegal.ok===false,',
      '   prepareState:prepared.next?.deliveryState,',
      '   attachmentState:attached.next?.deliveryState,',
      '   reservedSendState:send.next?.deliveryState,',
      '   duplicateBlocked:repeat.ok===false,',
      '   uncertainState:unknown.next?.deliveryState,',
      '   sideEffectless:send.effect==="none",',
      '   contentUnchanged:document.body.textContent.trim()==="Inert policy QA"});',
      '} catch(error) { document.documentElement.dataset.qaPolicy=',
      ' JSON.stringify({error:String(error.message)}); }'
    ].join("\n"));
    server=http.createServer((_req,res)=>{
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end('<!doctype html><html><body>Inert policy QA</body></html>');
    });
    await new Promise((yes,no)=>{
      server.once("error",no);server.listen(0,"127.0.0.1",yes);
    });
    driver=await new Builder().forBrowser("firefox").setFirefoxOptions(
      new firefox.Options().setBinary(binary).addArguments("-headless")).build();
    assert.equal(await driver.installAddon(root,true),addonId);
    await driver.get("http://127.0.0.1:"+server.address().port+"/");
    await driver.wait(async()=>Boolean(await driver.executeScript(
      "return document.documentElement.dataset.qaPolicy")),10000);
    const result=JSON.parse(await driver.executeScript(
      "return document.documentElement.dataset.qaPolicy"));
    assert.deepEqual(result,{
      prohibitedBeforeAttachment:true,prepareState:"attachment_preparing",
      attachmentState:"attachment_confirmed",reservedSendState:"send_requested",
      duplicateBlocked:true,uncertainState:"delivery_uncertain",
      sideEffectless:true,contentUnchanged:true
    });
    await driver.uninstallAddon(addonId);
    console.log("FDE inert delivery policy: exact staged transitions, no duplicates, no page or native side effects");
  } finally {
    if (driver) await driver.quit();
    if (server) await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
}

main().catch(error=>{
  console.error("Disposable Firefox delivery policy failure:",error.message);
  process.exitCode=1;
});
