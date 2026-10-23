import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync,
  rmSync, symlinkSync, lstatSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
test("QA launcher targets only Firefox Developer Edition and owns separate profile", () => {
  const qa = read("scripts/qa-firefox-developer.fish");
  assert(qa.includes("command -sq firefox-developer-edition"));
  assert(qa.includes('exec firefox-developer-edition --no-remote --profile "$profile"'));
  assert(qa.includes("jobflick-bridge-fde-qa"));
  assert(qa.includes('test -L "$profile"'));
  assert(!qa.includes("firefox-bin"));
  assert(!qa.includes("killall"));
  assert(!qa.includes("pkill"));
  assert(!qa.includes("about:config"));
  assert(!qa.includes("user.js"));
  assert(!qa.includes("install-native-host.fish"));
  assert(!qa.includes("allowed_extensions"));
});

test("documentation preserves QA/native-host distinction", () => {
  const qa = read("docs/QA.md");
  assert(qa.includes("per OS user"));
  assert(qa.includes("Load Temporary Add-on"));
});

const requireCaptureAbsent = file => {
  try { readFileSync(file); return false; } catch(error) { if(error.code==="ENOENT") return true; throw error; }
};
const launcher = fileURLToPath(new URL("../scripts/qa-firefox-developer.fish", import.meta.url));
const fishAvailable = spawnSync("/bin/sh", ["-c", "command -v fish >/dev/null 2>&1"]).status === 0;
function isolatedLauncherFixture(action) {
  const dir=mkdtempSync(join(tmpdir(),"jobflick-fde-profile-"));
  const home=join(dir,"personal-home");
  const data=join(dir,"separate qa data with spaces");
  const bin=join(dir,"bin");
  const capture=join(dir,"firefox-arguments.txt");
  mkdirSync(home);
  mkdirSync(data);
  mkdirSync(bin);
  const personal=join(home,".mozilla","firefox");
  const native=join(home,".mozilla","native-messaging-hosts");
  mkdirSync(personal,{recursive:true});
  mkdirSync(native,{recursive:true});
  const personalFile=join(personal,"profiles.ini");
  const nativeFile=join(native,"io.github.sguzman.jobflick.json");
  writeFileSync(personalFile,"PERSONAL FIREFOX PROFILE MUST REMAIN UNCHANGED\n");
  writeFileSync(nativeFile,"PERSONAL NATIVE MESSAGING HOST MUST REMAIN UNCHANGED\n");
  writeFileSync(join(bin,"firefox-developer-edition"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$JOBFLICK_QA_CAPTURE"\n',{mode:0o700});
  const env={...process.env,HOME:home,XDG_DATA_HOME:data,
    PATH:bin+":"+process.env.PATH,JOBFLICK_QA_CAPTURE:capture};
  const run=(extra={})=>spawnSync("fish",[launcher],{
    env:{...env,...extra},encoding:"utf8",timeout:10000
  });
  try { action({dir,home,data,bin,capture,personalFile,nativeFile,run}); }
  finally {rmSync(dir,{recursive:true,force:true});}
}

test("isolated FDE launcher invokes only dedicated profile and never edits personal Firefox",{skip:!fishAvailable},()=>{
  isolatedLauncherFixture(({home,data,capture,personalFile,nativeFile,run})=>{
    const launch=run();
    assert.equal(launch.status,0,launch.stderr);
    const profile=join(data,"jobflick-bridge-fde-qa","profile");
    assert.deepEqual(readFileSync(capture,"utf8").trim().split("\n"),[
      "--no-remote","--profile",profile,"about:debugging#/runtime/this-firefox"
    ]);
    assert.equal(statSync(profile).mode&0o777,0o700);
    assert.equal(statSync(join(data,"jobflick-bridge-fde-qa")).mode&0o777,0o700);
    assert.match(launch.stdout,/No native host will be installed/);
    assert.equal(readFileSync(personalFile,"utf8"),
      "PERSONAL FIREFOX PROFILE MUST REMAIN UNCHANGED\n");
    assert.equal(readFileSync(nativeFile,"utf8"),
      "PERSONAL NATIVE MESSAGING HOST MUST REMAIN UNCHANGED\n");
    assert.equal(home.includes("personal-home"),true);
  });
});

test("isolated FDE launcher refuses symlinked QA root and profile without following either",{skip:!fishAvailable},()=>{
  for(const kind of ["root","profile"]){
    isolatedLauncherFixture(({home,data,capture,personalFile,nativeFile,run})=>{
      const root=join(data,"jobflick-bridge-fde-qa");
      const personal=join(home,".mozilla","firefox");
      if(kind==="root") symlinkSync(personal,root);
      else {
        mkdirSync(root);
        symlinkSync(personal,join(root,"profile"));
      }
      const result=run();
      assert.equal(result.status,2,result.stderr);
      assert.match(result.stderr,/symbolic link/);
      assert.equal(lstatSync(kind==="root"?root:join(root,"profile")).isSymbolicLink(),true);
      assert.equal(readFileSync(personalFile,"utf8"),
        "PERSONAL FIREFOX PROFILE MUST REMAIN UNCHANGED\n");
      assert.equal(readFileSync(nativeFile,"utf8"),
        "PERSONAL NATIVE MESSAGING HOST MUST REMAIN UNCHANGED\n");
      assert.equal(requireCaptureAbsent(capture),true);
    });
  }
});

test("isolated FDE launcher rejects unsafe XDG_DATA_HOME overrides before filesystem writes",{skip:!fishAvailable},()=>{
  isolatedLauncherFixture(({data,capture,run})=>{
    for(const value of ["", ".", "../relative", "/"]){
      const result=run({XDG_DATA_HOME:value});
      assert.equal(result.status,2,"Expected safe refusal for "+JSON.stringify(value)+": "+result.stderr);
      assert.match(result.stderr,/non-root absolute path/);
    }
    assert.equal(lstatSync(data).isDirectory(),true);
    assert.equal(requireCaptureAbsent(capture),true);
  });
});
