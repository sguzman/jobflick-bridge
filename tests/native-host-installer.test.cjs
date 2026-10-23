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
