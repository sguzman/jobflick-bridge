import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nextReady } from "../scripts/qa-next.mjs";

const read = path => JSON.parse(readFileSync(new URL("../"+path,import.meta.url),"utf8"));
const plan = read("acceptance-gates.json");
const progress = read("progress.json");
const all = progress.milestones.flatMap(m=>m.tasks);
const byId = new Map(all.map(x=>[x.id,x]));
const gates = new Map(plan.gates.map(g=>[g.id,g]));

test("every unfinished atomic roadmap task has exactly one specific future acceptance plan",()=>{
  assert.equal(plan.schema,1);
  assert.equal(gates.size,plan.gates.length);
  // Closed gates may remain in the historical plan. Every open task must
  // still be covered; promoting a task must not make the contract fail.
  assert(all.filter(t=>t.status!=="verified")
    .every(t=>gates.has(t.id)),"An unfinished roadmap task lacks acceptance criteria");
  for(const gate of gates.values()){
    assert(byId.has(gate.id));
    assert(gate.acceptance.length>=3);
    assert(gate.acceptance.every(s=>typeof s==="string"&&s.length>=30));
    assert(["live_fde","signed_ci","release"].includes(gate.evidence_class));
    assert(!gate.acceptance.some(x=>/fixture only counts as complete/i.test(x)));
  }
});

test("dependency graph is complete, acyclic and release depends on authentic acceptance",()=>{
  const visiting=new Set(),visited=new Set();
  function visit(id){
    if(visited.has(id))return;
    assert(!visiting.has(id),"Cycle at "+id);
    visiting.add(id);
    const gate=gates.get(id);
    assert(gate);
    for(const dep of gate.depends_on){
      assert(gates.has(dep),"Unknown acceptance dependency: "+dep);
      visit(dep);
    }
    visiting.delete(id);visited.add(id);
  }
  for(const gate of gates.values())visit(gate.id);
  assert.deepEqual(gates.get("M7-07").depends_on,["M7-06"]);
  assert.deepEqual(gates.get("M7-08").depends_on,["M7-07"]);
  assert.equal(gates.get("M7-06").evidence_class,"live_fde");
  assert.equal(gates.get("M5-08").evidence_class,"live_fde");
});

test("next-ready selection only shows unresolved prerequisites, never inventing acceptance",()=>{
  const ready=nextReady(plan,progress);
  const statuses=new Map(all.map(t=>[t.id,t.status]));
  const expected=plan.gates.filter(g=>statuses.get(g.id)!=="verified" &&
    g.depends_on.every(id=>statuses.get(id)==="verified"));
  assert.deepEqual(ready.map(g=>g.id),expected.map(g=>g.id));
  assert.equal(progress.overall.verified,all.filter(t=>t.status==="verified").length);
  assert.equal(progress.overall.total,all.length);
});

test("local status CLI prints only currently ready gates and evidence policy",()=>{
  const script=fileURLToPath(new URL("../scripts/qa-next.mjs",import.meta.url));
  const result=spawnSync(process.execPath,[script],{encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert(result.stdout.includes(progress.overall.verified+"/"+
    progress.overall.total+" verified ("+progress.overall.percent+"%)."));
  const ready=nextReady(plan,progress);
  assert(result.stdout.includes("Ready acceptance gates ("+ready.length+"):"));
  for (const gate of ready) assert(result.stdout.includes(gate.id));
  for (const gate of plan.gates.filter(g=>!ready.includes(g)))
    assert(!result.stdout.includes("  "+gate.id+" —"));
});
