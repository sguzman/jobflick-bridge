import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function nextReady(plan,progress) {
  const tasks=progress.milestones.flatMap(m=>m.tasks);
  const verified=new Set(tasks.filter(t=>t.status==="verified").map(t=>t.id));
  const open=new Set(tasks.filter(t=>t.status!=="verified").map(t=>t.id));
  return plan.gates.filter(g=>open.has(g.id) &&
    g.depends_on.every(id=>verified.has(id)));
}

if(process.argv[1] && import.meta.url===new URL("file://"+process.argv[1]).href) {
  const base=new URL("../",import.meta.url);
  const plan=JSON.parse(readFileSync(new URL("acceptance-gates.json",base),"utf8"));
  const progress=JSON.parse(readFileSync(new URL("progress.json",base),"utf8"));
  const ready=nextReady(plan,progress);
  console.log("Jobflick Bridge: "+progress.overall.verified+"/"+progress.overall.total+
    " verified ("+progress.overall.percent+"%).");
  console.log("Ready acceptance gates ("+ready.length+"):");
  for(const gate of ready) console.log("  "+gate.id+" — "+gate.title+" ["+gate.evidence_class+"]");
  console.log("Every gate requires evidence before progress.json may count it.");
}
