"use strict";

// Runs ONLY on a disposable Linux CI runner against a separately built,
// pinned copy of the real Jobflick executable. This is an integration test,
// not a command gateway. Never reads the user's HOME, Jobflick queue or
// Firefox profile; the only Fish command is a hardcoded printf.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawn}=require("node:child_process");

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-bridge-real-"));
const binary=process.env.JOBFLICK_QA_BINARY;
if(process.env.GITHUB_ACTIONS!=="true" || process.env.CI!=="true" ||
   !binary || !path.isAbsolute(binary) || !fs.existsSync(binary)) {
  throw Error("Real-host test requires a disposable GitHub Actions runner and pinned Jobflick binary");
}
const dirs={
  HOME:path.join(root,"home"),
  XDG_CONFIG_HOME:path.join(root,"config"),
  XDG_DATA_HOME:path.join(root,"data"),
  XDG_RUNTIME_DIR:path.join(root,"runtime")
};
for(const dir of Object.values(dirs))fs.mkdirSync(dir,{recursive:true,mode:0o700});
const workdir=path.join(root,"work");
fs.mkdirSync(workdir,{mode:0o700});
const env={...process.env,...dirs};
delete env.DBUS_SESSION_BUS_ADDRESS;

function framed(request) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,["native-host"],{env,stdio:["pipe","pipe","pipe"]});
    let data=Buffer.alloc(0);
    let errors="";
    let done=false;
    const timeout=setTimeout(()=>fail(Error("Jobflick native-host response timed out")),18000);
    function cleanup(){clearTimeout(timeout);}
    function fail(error) {
      if(done)return;
      done=true;cleanup();child.kill("SIGKILL");reject(error);
    }
    child.on("error",fail);
    child.stderr.on("data",chunk=>{errors=(errors+chunk.toString()).slice(-2000);});
    child.stdout.on("data",chunk=>{
      if(done)return;
      data=Buffer.concat([data,chunk]);
      if(data.length<4)return;
      const size=data.readUInt32LE(0);
      if(!size || size>1024*1024)return fail(Error("Invalid or excessive host response size"));
      if(data.length<size+4)return;
      try{
        assert.equal(data.length,size+4,"One native frame only");
        const reply=JSON.parse(data.subarray(4).toString("utf8"));
        done=true;cleanup();resolve(reply);
      }catch(error){fail(error);}
    });
    // The process exit notification may arrive before pending stdout data
    // events. 'close' waits for stdio streams to drain, avoiding a false
    // missing-frame failure on a successful native-host invocation.
    child.on("close",code=>{
      if(!done)fail(Error("Native host closed "+code+" before frame: "+errors));
    });
    const msg=Buffer.from(JSON.stringify(request),"utf8");
    const header=Buffer.alloc(4);header.writeUInt32LE(msg.length);
    // Deliberately leave stdin open: Firefox expects framed replies without EOF.
    child.stdin.write(Buffer.concat([header,msg]));
  });
}

async function main(){
  const daemon=spawn(binary,["daemon"],{env,stdio:["ignore","ignore","pipe"]});
  let daemonLog="";
  daemon.stderr.on("data",chunk=>{daemonLog=(daemonLog+chunk.toString()).slice(-4000);});
  try{
    const socket=path.join(dirs.XDG_RUNTIME_DIR,"jobflick","daemon.sock");
    for(let n=0;n<150 && !fs.existsSync(socket);n++)await delay(100);
    assert(fs.existsSync(socket),"Real Jobflick daemon socket did not appear: "+daemonLog);
    const invalid=await framed({action:"validate_spec",spec_yaml:"invalid: not a document"});
    assert.equal(invalid.ok,false,"Malformed document must be refused");
    const yaml=[
      "schema: 4","name: Bridge real QA","shell: fish",
      "cwd: "+workdir,"privilege: none","timeout_seconds: 10",
      "environment:","  session: inherit","  gpu: inherit",
      "command: printf jobflick_bridge_real_smoke"
    ].join("\n")+"\n";
    const valid=await framed({action:"validate_spec",spec_yaml:yaml});
    assert.equal(valid.ok,true,valid.message);
    const token="tab-real-bridge-qa-12345678";
    const submit=await framed({action:"submit_spec",spec_yaml:yaml,origin_tab_id:token});
    assert.equal(submit.ok,true,submit.message);
    const id=submit.job?.id;
    assert.match(id,/^[a-zA-Z0-9_-]{8,128}$/);
    assert.equal(submit.job.origin_tab_id,token);
    assert.equal(submit.job.name,"Bridge real QA");
    let done;
    for(let n=0;n<100;n++){
      const result=await framed({action:"inspect",id});
      assert.equal(result.ok,true,result.message);
      done=result.job;
      if(["succeeded","failed","cancelled","timed_out","interrupted"].includes(done?.state))break;
      await delay(100);
    }
    assert.equal(done.state,"succeeded","Fish fixture did not succeed: "+JSON.stringify(done));
    assert.equal(done.origin_tab_id,token);
    const report=await framed({action:"show",id});
    assert.equal(report.ok,true,report.message);
    assert.match(report.report,/jobflick_bridge_real_smoke/);
    assert.match(report.report,/Status: Succeeded/);
    const jobs=fs.readdirSync(path.join(dirs.XDG_DATA_HOME,"jobflick","jobs"))
      .filter(file=>file.endsWith(".json"));
    assert.deepEqual(jobs,[id+".json"],"One click should create one durable Jobflick job");
    console.log("REAL Jobflick native host and daemon: schema 4 validation, exactly one Fish printf, persisted origin, terminal inspect and report passed");
  }finally{
    daemon.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve=>daemon.once("exit",resolve)),
      delay(2000).then(()=>daemon.kill("SIGKILL"))
    ]);
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(err=>{
  console.error("Isolated real-Jobflick acceptance failed:",err.message);
  process.exitCode=1;
});
