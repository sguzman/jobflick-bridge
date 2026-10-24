import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const runner = fileURLToPath(new URL("./live-composer-audit.cjs", import.meta.url));
const { canonicalConversation, dedicatedProfile, readOnlyObservation } =
  createRequire(import.meta.url)(runner);
const run = env => spawnSync(process.execPath, [runner], {
  env: { ...process.env, ...env }, encoding: "utf8", timeout: 6000
});

test("live ChatGPT inspection requires explicit opt-in before loading WebDriver", () => {
  const result = run({ JOBFLICK_LIVE_READONLY_QA: "", CHATGPT_QA_URL:
    "https://chatgpt.com/c/testing-1234" });
  assert.equal(result.status, 1);
  assert.match(result.stderr,/read-only live QA refused/i);
  assert(!result.stdout.includes("testing-1234"));
});

test("live QA rejects all unsupported and foreign conversation URLs before profile access", () => {
  for(const url of [
    "https://example.com/c/testing-1234",
    "https://chatgpt.com/share/testing-1234",
    "https://chatgpt.com/settings",
    "https://chatgpt.com/c/testing-1234?other=1",
    "https://chatgpt.com/c/testing-1234#fragment",
    "http://chatgpt.com/c/testing-1234"
  ]) {
    const result=run({ JOBFLICK_LIVE_READONLY_QA:"YES", CHATGPT_QA_URL:url });
    assert.equal(result.status,1,url);
    assert.match(result.stderr,/refused or failed/);
    assert(!result.stdout.includes(url));
  }
});

test("live QA rejects unsafe XDG roots and a QA profile symlink", () => {
  const bad=run({ JOBFLICK_LIVE_READONLY_QA:"YES",
    CHATGPT_QA_URL:"https://chatgpt.com/c/testing-1234", XDG_DATA_HOME:"/" });
  assert.equal(bad.status,1);
  const root=mkdtempSync(join(tmpdir(),"jobflick-live-qa-safety-"));
  try {
    const qa=join(root,"jobflick-bridge-fde-qa");
    const privateProfile=join(root,"personal-profile");
    mkdirSync(qa);
    mkdirSync(privateProfile);
    symlinkSync(privateProfile,join(qa,"profile"));
    const response=run({ JOBFLICK_LIVE_READONLY_QA:"YES",
      CHATGPT_QA_URL:"https://chatgpt.com/c/testing-1234",
      XDG_DATA_HOME:root });
    assert.equal(response.status,1);
    assert.equal(response.stdout,"");
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test("canonical destination matching rejects host confusion, query and unrelated routes",()=>{
  for (const [url,expected] of [
    ["https://chatgpt.com/c/testing-1234","https://chatgpt.com/c/testing-1234"],
    ["https://chat.openai.com/uc/testing-1234","https://chat.openai.com/uc/testing-1234"],
    ["https://chatgpt.com/g/g-p-1234/c/testing-5678","https://chatgpt.com/g/g-p-1234/c/testing-5678"],
    ["https://evil.chatgpt.com/c/testing-1234",null],
    ["https://chatgpt.com.evil.invalid/c/testing-1234",null],
    ["https://chatgpt.com/c/testing-1234?q=secret",null],
    ["https://chatgpt.com/c/testing-1234#x",null],
    ["https://chatgpt.com/g/g-p-1234/project",null],
    ["https://chatgpt.com/share/testing-1234",null]
  ]) assert.equal(canonicalConversation(url),expected);
});

test("read-only observer returns only safe metadata, not draft or filename",()=>{
  const secret="PRIVATE TEST DRAFT NEVER TO PRINT";
  const doc={querySelectorAll(selector) {
    if(selector.includes("prompt-textarea"))return [
      {textContent:secret,value:undefined},
      {textContent:"",value:undefined}
    ];
    if(selector==='input[type="file"]')return [
      {files:[{name:"private-file-name.txt",size:10}]}
    ];
    throw Error("Unexpected DOM selector");
  }};
  const data=readOnlyObservation(doc);
  assert.deepEqual(data,{
    composerCandidates:2,composerAmbiguous:true,draftOccupied:true,
    fileInputCandidates:1,fileInputAmbiguous:false,fileAlreadySelected:true
  });
  assert(!JSON.stringify(data).includes(secret));
  assert(!JSON.stringify(data).includes("private-file-name.txt"));
});

test("read-only audit refuses a locked QA profile and symlinked data directory",()=>{
  const dir=mkdtempSync(join(tmpdir(),"jobflick-live-locks-"));
  try {
    const data=join(dir,"data"), root=join(data,"jobflick-bridge-fde-qa"),
      profile=join(root,"profile");
    mkdirSync(profile,{recursive:true,mode:0o700});
    chmodSync(root,0o700);
    chmodSync(profile,0o700);
    const previousHOME=process.env.HOME,previousXDG=process.env.XDG_DATA_HOME;
    try {
      process.env.HOME=dir;
      process.env.XDG_DATA_HOME=data;
      assert.equal(dedicatedProfile(),profile);
      writeFileSync(join(profile,".parentlock"),"locked");
      assert.throws(()=>dedicatedProfile(),/lock/);
      rmSync(join(profile,".parentlock"));
      const link=join(dir,"alias");
      symlinkSync(data,link);
      process.env.XDG_DATA_HOME=link;
      assert.throws(()=>dedicatedProfile(),/Symlinked|missing/);
    } finally {
      if(previousHOME===undefined)delete process.env.HOME;
      else process.env.HOME=previousHOME;
      if(previousXDG===undefined)delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME=previousXDG;
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
