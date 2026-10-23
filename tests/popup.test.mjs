import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const popupSource=readFileSync(new URL("../extension/popup/popup.js",import.meta.url),"utf8");

class MockElement {
  constructor(tag) {
    this.tag=tag; this.children=[]; this.handlers={}; this.style={};
    this.parent=null; this.textContent=""; this.disabled=false;
  }
  addEventListener(type, callback) { this.handlers[type]=callback; }
  append(...nodes) {
    for(const node of nodes) {node.parent=this;this.children.push(node);}
  }
  replaceChildren(...nodes) {
    for(const child of this.children) child.parent=null;
    this.children=[];this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children=this.parent.children.filter(child=>child!==this);
    this.parent=null;
  }
  async click() {
    if(this.disabled) return;
    if(this.handlers.click) return this.handlers.click({isTrusted:true});
  }
}

function findText(root,text) {
  if (root.textContent === text) return root;
  for (const child of root.children) {
    const found=findText(child,text);
    if(found) return found;
  }
  return null;
}

async function boot(jobs=[],handler=null) {
  const named={};
  for(const name of ["jobs","notice","scan","refresh","diagnose","probe-upload"])
    named[name]=new MockElement("div");
  const body=new MockElement("body");
  const calls=[],files=[],downloads=[],objects=[];
  const document={
    getElementById:name=>named[name],
    createElement:tag=>{
      const node=new MockElement(tag);
      if(tag==="a")node.click=()=>{downloads.push({href:node.href,name:node.download});};
      return node;
    },
    body
  };
  const browser={
    runtime:{
      sendMessage:async message=>{
        calls.push(message);
        if(handler) return handler(message);
        if(message.type==="jobflick:inbox") return {ok:true,jobs};
        if(message.type==="jobflick:report") return {ok:true,report:"harmless report"};
        return {ok:true,message:"Acknowledged"};
      }
    },
    tabs:{create:async details=>({id:99,...details})}
  };
  class TestFile {
    constructor(parts,name,opts) {this.parts=parts;this.name=name;this.type=opts.type;files.push(this);}
  }
  const TestURL=class extends URL {};
  TestURL.createObjectURL=(file)=>{objects.push(file);return "blob:unit";};
  TestURL.revokeObjectURL=()=>{};
  // An anchor remains a local download request, never an upload.
  vm.runInNewContext(popupSource,{
    browser,document,URL:TestURL,File:TestFile,Set,console,
    setTimeout:()=>{},
  },{filename:"popup.js"});
  for(let i=0;i<12;i++)await Promise.resolve();
  return {named,body,calls,files,downloads,objects,find:text=>findText(named.jobs,text)};
}

const running={
  id:"job_12345678",state:"running",name:"Read-only QA",
  orphaned:false,conversation:"https://chatgpt.com/c/testing-1234",
  cancelRequested:false,submittedAt:1
};
const finished={...running,state:"succeeded",deliveryState:"report_pending_manual_delivery"};

test("stop requires two distinct popup gestures and never calls submit_spec",async()=>{
  const app=await boot([running]);
  const first=app.find("Request stop");
  assert(first,"Stop control absent");
  await first.click();
  assert.equal(app.calls.filter(c=>c.type==="jobflick:cancel").length,0);
  assert.equal(first.textContent,"Confirm stop");
  await first.click();
  assert.equal(app.calls.filter(c=>c.type==="jobflick:cancel").length,1);
  assert.equal(app.calls.filter(c=>c.type==="jobflick:submit").length,0);
  assert.match(app.named.notice.textContent,/Acknowledged/);
});

test("report download requires a separate click after asynchronous retrieval",async()=>{
  const app=await boot([finished]);
  const save=app.find("Save report");
  assert(save);
  await save.click();
  assert.equal(app.calls.filter(c=>c.type==="jobflick:report").length,1);
  assert.equal(app.downloads.length,0);
  assert.equal(save.textContent,"Download prepared report");
  await save.click();
  assert.equal(app.downloads.length,1);
  assert.equal(app.files.length,1);
  assert.equal(app.files[0].name,"jobflick-job_12345678.txt");
  assert.equal(app.files[0].parts[0],"harmless report");
  assert.equal(app.calls.filter(c=>c.type==="jobflick:submit").length,0);
});

test("forget is a two-click bridge-only action and never cancels native job",async()=>{
  const app=await boot([finished]);
  const forget=app.find("Forget bridge record");
  assert(forget);
  await forget.click();
  assert.equal(app.calls.filter(c=>c.type==="jobflick:forget").length,0);
  assert.equal(forget.textContent,"Confirm forget");
  await forget.click();
  assert.equal(app.calls.filter(c=>c.type==="jobflick:forget").length,1);
  assert.equal(app.calls.filter(c=>c.type==="jobflick:cancel").length,0);
});

test("job title from native host is rendered as text, never interpreted as markup",async()=>{
  const name="<img src=x onerror=alert(1)>";
  const app=await boot([{...running,name}]);
  const heading=app.find(name);
  assert.equal(heading.tag,"h2");
  assert.equal(app.named.jobs.children.length,1);
  assert.equal(app.calls.filter(c=>c.type==="jobflick:submit").length,0);
});
