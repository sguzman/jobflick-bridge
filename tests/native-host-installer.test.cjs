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
