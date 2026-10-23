import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

const host=fileURLToPath(new URL("./fixtures/fake-native-host.cjs",import.meta.url));
const root=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-native-protocol-"));

async function exchange(request){
  const child=spawn(process.execPath,[host],{
    env:{...process.env,JOBFLICK_QA_STATE:root},stdio:["pipe","pipe","pipe"]
  });
  let output=Buffer.alloc(0);
  let errors="";
  child.stderr.on("data",chunk=>{errors+=chunk.toString();});
  try{
    const response=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("Host waited for stdin EOF or timed out")),5000);
      child.once("error",reject);
      child.once("exit",code=>{
        if(code!==0 && output.length<4){
          clearTimeout(timer);reject(new Error("Fake host exited "+code+": "+errors));
        }
      });
      child.stdout.on("data",chunk=>{
        output=Buffer.concat([output,chunk]);
        if(output.length<4)return;
        const size=output.readUInt32LE(0);
        if(output.length<size+4)return;
        clearTimeout(timer);
        assert.equal(output.length,size+4);
        resolve(JSON.parse(output.subarray(4).toString("utf8")));
      });
      const bytes=Buffer.from(JSON.stringify(request),"utf8");
      const header=Buffer.alloc(4);
      header.writeUInt32LE(bytes.byteLength);
      // Deliberately keep stdin OPEN while waiting for the reply. Firefox
      // does the same; Native Messaging must not block on EOF.
      child.stdin.write(Buffer.concat([header,bytes]));
    });
    return response;
  }finally{
    child.kill();
  }
}

test("fake host answers Firefox Native Messaging frames without stdin EOF",async()=>{
  try{
    const doc="schema: 4\nname: Firefox native QA\ncommand: pwd";
    const validate=await exchange({action:"validate_spec",spec_yaml:doc});
    assert.equal(validate.ok,true);
    const queued=await exchange({action:"submit_spec",spec_yaml:doc,origin_tab_id:"tab-qa-12345678"});
    assert.equal(queued.ok,true);
    assert.equal(queued.job.state,"queued");
    const finished=await exchange({action:"inspect",id:queued.job.id});
    assert.equal(finished.job.state,"succeeded");
    const report=await exchange({action:"show",id:queued.job.id});
    assert.match(report.report,/No command was run/);
    const actions=fs.readFileSync(path.join(root,"native-requests.jsonl"),"utf8")
      .trim().split("\n").map(JSON.parse);
    assert.deepEqual(actions.map(x=>x.action),["validate_spec","submit_spec","inspect","show"]);
    assert.equal(actions[1].origin_tab_id,"tab-qa-12345678");
    assert(!fs.readFileSync(path.join(root,"native-requests.jsonl"),"utf8").includes("command:"));
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
});
