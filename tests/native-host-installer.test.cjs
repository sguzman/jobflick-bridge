"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("Firefox native host installer writes and safely removes only its own manifest", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jobflick-bridge-host-"));
  try {
    const home = path.join(fixture, "home");
    const xdgData = path.join(fixture, "data");
    const bin = path.join(fixture, "bin");
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    // This fake Jobflick executable is NEVER run. Installation only needs an
    // absolute binary path to write into the generated Fish wrapper.
    const fake = path.join(bin, "jobflick");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 19\n", { mode: 0o700 });
    const manifest = path.join(home, ".mozilla/native-messaging-hosts", "io.github.sguzman.jobflick.json");
    const wrapper = path.join(xdgData, "jobflick-bridge", "native-host");
    const env = { ...process.env, HOME: home, XDG_DATA_HOME: xdgData, PATH: bin + path.delimiter + process.env.PATH };
    const installer = path.join(__dirname, "../scripts/install-native-host.fish");
    const run = action => spawnSync("fish", [installer, action], { encoding: "utf8", env });
    const first = run("--install");
    assert.equal(first.status, 0, first.stderr);
    const written = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.equal(written.name, "io.github.sguzman.jobflick");
    assert.equal(written.type, "stdio");
    assert.deepEqual(written.allowed_extensions, ["jobflick-bridge@sguzman.github.io"]);
    assert.equal(written.allowed_origins, undefined);
    assert.equal(written.path, wrapper);
    assert.match(fs.readFileSync(wrapper, "utf8"), /native-host/);
    assert.equal(fs.statSync(manifest).mode & 0o777, 0o600);

    const second = run("--install");
    assert.notEqual(second.status, 0, "Installer must refuse replacing a registered manifest");
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest, "utf8")), written);
    const removed = run("--uninstall");
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(manifest), false);
    assert.equal(fs.existsSync(wrapper), true, "Uninstall keeps the wrapper and Jobflick data intact");
    const before=fs.statSync(wrapper).ino;
    const reinstalled=run("--install");
    assert.equal(reinstalled.status,0,"Reinstall should reuse identical existing wrapper: "+reinstalled.stderr);
    assert.equal(fs.statSync(wrapper).ino,before,"Identical wrapper must not be rewritten");
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest,"utf8")),written);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("installer rejects symlinked host manifest, including a dangling link", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jobflick-bridge-symlink-"));
  try {
    const home = path.join(fixture, "home");
    const data = path.join(fixture, "data");
    const bin = path.join(fixture, "bin");
    const hostDir = path.join(home, ".mozilla/native-messaging-hosts");
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(bin, "jobflick"), "#!/bin/sh\nexit 19\n", { mode: 0o700 });
    const manifest = path.join(hostDir, "io.github.sguzman.jobflick.json");
    fs.symlinkSync(path.join(fixture, "nonexistent-target"), manifest);
    const env = { ...process.env, HOME: home, XDG_DATA_HOME: data, PATH: bin + path.delimiter + process.env.PATH };
    const installer = path.join(__dirname, "../scripts/install-native-host.fish");
    const result = spawnSync("fish", [installer, "--install"], { encoding: "utf8", env });
    assert.notEqual(result.status, 0);
    assert.equal(fs.lstatSync(manifest).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(data, "jobflick-bridge", "native-host")), false);
    const removed = spawnSync("fish", [installer, "--uninstall"], { encoding: "utf8", env });
    assert.notEqual(removed.status, 0);
    assert.equal(fs.lstatSync(manifest).isSymbolicLink(), true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("installer never overwrites a foreign or symlinked native-host wrapper",()=>{
  for(const link of [false,true]){
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-bridge-wrapper-"));
    try{
      const home=path.join(fixture,"home"),data=path.join(fixture,"data");
      const bin=path.join(fixture,"bin");
      const wrapperDir=path.join(data,"jobflick-bridge");
      fs.mkdirSync(home);
      fs.mkdirSync(bin);
      fs.mkdirSync(wrapperDir,{recursive:true});
      fs.writeFileSync(path.join(bin,"jobflick"),"#!/bin/sh\nexit 0\n",{mode:0o700});
      const wrapper=path.join(wrapperDir,"native-host");
      const target=path.join(fixture,"foreign-executable");
      fs.writeFileSync(target,"#!/bin/sh\necho foreign\n",{mode:0o700});
      if(link)fs.symlinkSync(target,wrapper);
      else fs.writeFileSync(wrapper,"#!/bin/sh\necho foreign\n",{mode:0o700});
      const original=fs.readFileSync(target,"utf8");
      const env={...process.env,HOME:home,XDG_DATA_HOME:data,
        PATH:bin+path.delimiter+process.env.PATH};
      const installer=path.join(__dirname,"../scripts/install-native-host.fish");
      const result=spawnSync("fish",[installer,"--install"],{env,encoding:"utf8"});
      assert.notEqual(result.status,0,"Refuse to overwrite foreign native wrapper");
      assert.match(result.stderr,/Refusing to overwrite/);
      assert.equal(fs.readFileSync(wrapper,"utf8"),"#!/bin/sh\necho foreign\n");
      assert.equal(fs.readFileSync(target,"utf8"),original);
      assert.equal(fs.lstatSync(wrapper).isSymbolicLink(),link);
      const manifest=path.join(home,".mozilla/native-messaging-hosts",
        "io.github.sguzman.jobflick.json");
      assert.equal(fs.existsSync(manifest),false,"No registration on wrapper collision");
    } finally {
      fs.rmSync(fixture,{recursive:true,force:true});
    }
  }
});

test("installed Fish wrapper passes binary Native Messaging frames to child executable", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jobflick-bridge-frame-"));
  try {
    const home = path.join(fixture, "home");
    const data = path.join(fixture, "data");
    const bin = path.join(fixture, "bin");
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    const fake = path.join(bin, "jobflick");
    fs.writeFileSync(fake, [
      "#!/usr/bin/env node",
      "'use strict';",
      "if (process.argv[2] !== 'native-host') process.exit(15);",
      "const chunks=[];",
      "process.stdin.on('data',chunk=>chunks.push(chunk));",
      "process.stdin.on('end',()=>{",
      "  const buf=Buffer.concat(chunks);",
      "  if (buf.length<4) process.exit(16);",
      "  const n=buf.readUInt32LE(0);",
      "  if(n!==buf.length-4) process.exit(17);",
      "  const msg=JSON.parse(buf.subarray(4).toString('utf8'));",
      "  if(msg.action!=='validate_spec') process.exit(18);",
      "  const reply=Buffer.from(JSON.stringify({ok:false,message:'schema invalid, no execution'}));",
      "  const h=Buffer.alloc(4);h.writeUInt32LE(reply.length,0);",
      "  process.stdout.write(Buffer.concat([h,reply]));",
      "});"
    ].join("\n") + "\n", { mode: 0o700 });
    const env = { ...process.env, HOME: home, XDG_DATA_HOME: data,
      PATH: bin + path.delimiter + process.env.PATH };
    const installer = path.join(__dirname, "../scripts/install-native-host.fish");
    const installed = spawnSync("fish", [installer, "--install"], { encoding:"utf8", env });
    assert.equal(installed.status, 0, installed.stderr);
    const wrapper = path.join(data,"jobflick-bridge","native-host");
    const payload = Buffer.from(JSON.stringify({
      action: "validate_spec", spec_yaml: "invalid: intentionally non-executable"
    }),"utf8");
    const head=Buffer.alloc(4);
    head.writeUInt32LE(payload.length,0);
    const child=spawnSync(wrapper, { input: Buffer.concat([head,payload]), env });
    assert.equal(child.status,0,child.stderr.toString());
    assert(child.stdout.length>=4);
    const reportedLength=child.stdout.readUInt32LE(0);
    assert.equal(reportedLength,child.stdout.length-4,"Host wrapper did not corrupt framing");
    const reply=JSON.parse(child.stdout.subarray(4).toString("utf8"));
    assert.deepEqual(reply,{ok:false,message:"schema invalid, no execution"});
    assert.equal(child.stderr.length,0);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("uninstaller refuses a forged manifest even if it mentions the add-on ID", () => {
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),"jobflick-bridge-foreign-"));
  try {
    const home=path.join(fixture,"home");
    const manifestDir=path.join(home,".mozilla/native-messaging-hosts");
    fs.mkdirSync(manifestDir,{recursive:true});
    const manifest=path.join(manifestDir,"io.github.sguzman.jobflick.json");
    const foreign={
      name:"io.github.sguzman.jobflick",type:"stdio",
      description:"Mentions jobflick-bridge@sguzman.github.io but owned elsewhere",
      path:"/unexpected/native/host",
      allowed_extensions:["jobflick-bridge@sguzman.github.io"]
    };
    fs.writeFileSync(manifest,JSON.stringify(foreign));
    const env={...process.env,HOME:home,XDG_DATA_HOME:path.join(fixture,"data")};
    const installer=path.join(__dirname,"../scripts/install-native-host.fish");
    const result=spawnSync("fish",[installer,"--uninstall"],{encoding:"utf8",env});
    assert.notEqual(result.status,0);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest,"utf8")),foreign);
  }finally{
    fs.rmSync(fixture,{recursive:true,force:true});
  }
});
