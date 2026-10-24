import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const runner = fileURLToPath(new URL("./live-composer-audit.cjs", import.meta.url));
const { canonicalConversation, dedicatedProfile, readOnlyObservation, observeStable, structuralCandidatesUnique } =
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

test("hydration requires stable visible composer, never accepts empty first snapshot",async()=>{
  const url="https://chatgpt.com/c/testing-1234";
  const blank={composerCandidates:0,composerAmbiguous:true,draftOccupied:false,
    fileInputCandidates:0,fileInputAmbiguous:true,fileAlreadySelected:false};
  const ready={...blank,composerCandidates:1,composerAmbiguous:false};
  let n=0,time=0;
  const driver={getCurrentUrl:async()=>url,
    executeScript:async()=>++n<3?blank:ready};
  const result=await observeStable(driver,url,{
    delay:async()=>{time+=400;},clock:()=>time,timeoutMs:4000
  });
  assert.equal(result.stable,true);
  assert.equal(result.samples,5);
  assert.equal(result.observation.composerCandidates,1);
  assert.equal(result.observation.fileInputCandidates,0);
});

test("persistent empty or unstable composer observation remains inconclusive",async()=>{
  const url="https://chatgpt.com/c/testing-1234";
  for(const unstable of [false,true]){
    let n=0,time=0;
    const driver={getCurrentUrl:async()=>url,executeScript:async()=>{
      const count=unstable ? (++n%2) : 0;
      return {composerCandidates:count,composerAmbiguous:count!==1,draftOccupied:false,
        fileInputCandidates:0,fileInputAmbiguous:true,fileAlreadySelected:false};
    }};
    const result=await observeStable(driver,url,{
      delay:async()=>{time+=400;},clock:()=>time,timeoutMs:2000
    });
    assert.equal(result.stable,false);
    assert(result.samples>=5);
  }
});

test("route changes before or after DOM sampling fail closed",async()=>{
  const url="https://chatgpt.com/c/testing-1234";
  const reading={composerCandidates:1,composerAmbiguous:false,draftOccupied:false,
    fileInputCandidates:1,fileInputAmbiguous:false,fileAlreadySelected:false};
  for(const changedAt of [1,2]){
    let count=0;
    const driver={getCurrentUrl:async()=>++count===changedAt ?
      "https://chatgpt.com/c/different-1234":url,
      executeScript:async()=>reading};
    await assert.rejects(observeStable(driver,url),/route changed/i);
  }
});

test("untrusted read-only browser results are reduced to an allowlist",async()=>{
  const url="https://chatgpt.com/c/testing-1234";
  const driver={getCurrentUrl:async()=>url,executeScript:async()=>({
    composerCandidates:1,composerAmbiguous:false,draftOccupied:false,
    fileInputCandidates:1,fileInputAmbiguous:false,fileAlreadySelected:false,
    privateDraft:"SECRET NEVER RETURNED",fileName:"SECRET USER FILE"
  })};
  let time=0;
  const result=await observeStable(driver,url,{
    delay:async()=>{time++;},clock:()=>time,timeoutMs:100
  });
  assert.equal(result.stable,true);
  assert.equal(result.observation.privateDraft,undefined);
  assert(!JSON.stringify(result).includes("SECRET"));
});

test("invalid browser metadata is not printed or accepted",async()=>{
  const url="https://chatgpt.com/c/testing-1234";
  const driver={getCurrentUrl:async()=>url,executeScript:async()=>({
    composerCandidates:-1,composerAmbiguous:false,draftOccupied:false,
    fileInputCandidates:1,fileInputAmbiguous:false,fileAlreadySelected:false
  })};
  await assert.rejects(observeStable(driver,url),/Invalid read-only observation/);
});

test("inconclusive read-only discovery cannot claim structural success",()=>{
  const observation={composerCandidates:1,composerAmbiguous:false,
    fileInputCandidates:1,fileInputAmbiguous:false};
  assert.equal(structuralCandidatesUnique({stable:true,observation}),true);
  for(const sample of [
    {stable:false,observation},
    {stable:true,observation:{...observation,composerCandidates:0}},
    {stable:true,observation:{...observation,composerCandidates:2}},
    {stable:true,observation:{...observation,fileInputCandidates:0}},
    {stable:true,observation:{...observation,fileInputCandidates:2}},
    {stable:true,observation:{...observation,fileInputAmbiguous:true}}
  ]) assert.equal(structuralCandidatesUnique(sample),false);
});
