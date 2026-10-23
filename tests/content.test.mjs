import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const yaml = "schema: 4\nname: Browser-only QA\nshell: fish\ncwd: /tmp\nprivilege: none\ntimeout_seconds: 5\ncommand: pwd\n";

function simulate(initialYaml = yaml, validateOK = true, probeOptions = {}) {
  const documentListeners = {};
  const runtimeMessages = [];
  const timerJobs = new Map();
  let timerId = 0;
  let runtimeListener;
  class Element {
    constructor(tag = "div") {
      this.tag = tag;
      this.style = {};
      this.isConnected = true;
      this.handlers = {};
      this.textContent = "";
    }
    matches(selector) { return selector === this.tag; }
    closest(selector) {
      if (selector === "pre" && this.tag === "pre") return this;
      if (selector === "main") return this.tag === "pre" ? { isConnected: true } : null;
      return null;
    }
    querySelector(selector) {
      if (this.tag === "pre" && selector === "code") return { textContent: this.yaml };
      return null;
    }
    insertAdjacentElement(_where, child) {
      this.button = child;
      child.isConnected = true;
    }
    addEventListener(type, callback) { this.handlers[type] = callback; }
    remove() { this.isConnected = false; }
    getBoundingClientRect() {
      return this.visible === false ? { top: 9000, bottom: 9200 } : { top: 5, bottom: 40 };
    }
  }
  const pre = new Element("pre");
  pre.yaml = initialYaml;
  const pres = [pre];
  const count = Math.max(1, Math.min(8000, probeOptions.blockCount || 1));
  for (let i = 1; i < count; i++) {
    const block = new Element("pre");
    block.yaml = initialYaml;
    pres.push(block);
  }
  const visibleCount = probeOptions.visibleCount ?? count;
  pres.forEach((block, i) => { block.visible = i < visibleCount; });
  const document = {
    querySelector(selector) {
      if (selector.includes("#prompt-textarea") &&
          probeOptions.composerPresent) {
        return { textContent: probeOptions.composerText || "" };
      }
      if (selector === 'input[type="file"]' && probeOptions.fileInputPresent) {
        return { type: "file" };
      }
      return null;
    },
    addEventListener(type, callback) { documentListeners[type] = callback; },
    createElement(tag) { return new Element(tag); },
    querySelectorAll(selector) { return selector === "main pre" ? pres : []; }
  };
  const browser = {
    runtime: {
      sendMessage: async message => {
        runtimeMessages.push(message);
        if (message.type === "jobflick:validate") return { ok: validateOK };
        if (message.type === "jobflick:submit") {
          if (probeOptions.earlyStatus) {
            await runtimeListener({
              type: "jobflick:status", jobId: "job_12345678",
              state: "succeeded", name: "QA", color: "#aabbcc"
            });
          }
          return { ok: true, job: { id: "job_12345678", name: "QA", color: "#aabbcc" } };
        }
        throw new Error("Unexpected message type");
      },
      onMessage: { addListener(fn) { runtimeListener = fn; } }
    }
  };
  vm.runInNewContext(content, {
    document, browser, Element, TextEncoder, innerHeight: 768, globalThis: {},
    setTimeout: fn => { const id = ++timerId; timerJobs.set(id, fn); return id; },
    clearTimeout: id => timerJobs.delete(id),
    WeakMap, Set, Promise
  }, { filename: "content.js" });

  const pump = async () => {
    for (let pass = 0; pass < 10; pass++) {
      if (timerJobs.size) {
        const timers = [...timerJobs.values()];
        timerJobs.clear();
        for (const timer of timers) timer();
      }
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  const pointer = (target = pre) => documentListeners.pointerover({ target });
  const focus = (target = pre) => documentListeners.focusin({ target });
  return { pre, pres, pump, pointer, focus, messages: runtimeMessages, runtimeListener };
}

test("idle page does not scan or validate until intentional pointer/focus", async () => {
  const app = simulate();
  await app.pump();
  assert.equal(app.messages.length, 0);
  app.pointer();
  await app.pump();
  assert.equal(app.messages.filter(x => x.type === "jobflick:validate").length, 1);
  assert.equal(app.pre.button.textContent, "▶ Run Jobflick");
});

test("forged DOM click does not authorize local shell execution", async () => {
  const app = simulate();
  app.focus();
  await app.pump();
  await app.pre.button.handlers.click({ isTrusted: false });
  assert.equal(app.messages.filter(x => x.type === "jobflick:submit").length, 0);
  await app.pre.button.handlers.click({ isTrusted: true });
  assert.equal(app.messages.filter(x => x.type === "jobflick:submit").length, 1);
  await app.pre.button.handlers.click({ isTrusted: true });
  assert.equal(app.messages.filter(x => x.type === "jobflick:submit").length, 1);
  assert.equal(app.pre.button.disabled, true);
});

test("code changes after validation fail closed before submission", async () => {
  const app = simulate();
  app.pointer();
  await app.pump();
  app.pre.yaml += "\n# different";
  await app.pre.button.handlers.click({ isTrusted: true });
  assert.equal(app.messages.filter(x => x.type === "jobflick:submit").length, 0);
});

test("invalid YAML never shows Run button", async () => {
  const app = simulate("hello from ChatGPT");
  app.pointer();
  await app.pump();
  assert.equal(app.pre.button, undefined);
  assert.equal(app.messages.length, 0);
});

test("server-side validation denial never shows Run button", async () => {
  const app = simulate(yaml, false);
  app.pointer();
  await app.pump();
  assert.equal(app.pre.button, undefined);
  assert.equal(app.messages.filter(x => x.type === "jobflick:validate").length, 1);
});

test("toolbar scan requires explicit popup action and only considers visible blocks", async () => {
  const app = simulate();
  assert.equal(app.messages.length, 0);
  const result = await app.runtimeListener({ type: "jobflick:scan" });
  assert.equal(result.ok, true);
  await app.pump();
  assert.equal(app.messages.filter(x => x.type === "jobflick:validate").length, 1);
});

test("read-only attachment capability probe returns only booleans", async () => {
  const app = simulate(yaml, true, {
    composerPresent: true, composerText: "private draft must never escape",
    fileInputPresent: true
  });
  const result = await app.runtimeListener({ type: "jobflick:probe-upload" });
  assert.deepEqual(Object.keys(result).sort(), [
    "composerOccupied", "composerPresent", "fileInputPresent", "ok"
  ].sort());
  assert.equal(result.composerPresent, true);
  assert.equal(result.composerOccupied, true);
  assert.equal(result.fileInputPresent, true);
  assert.equal(app.messages.length, 0);
});

test("no known file input yields an inconclusive read-only result", async () => {
  const app = simulate(yaml, true, { composerPresent: true });
  const result = await app.runtimeListener({ type: "jobflick:probe-upload" });
  assert.equal(result.ok, true);
  assert.equal(result.fileInputPresent, false);
  assert.equal(result.composerOccupied, false);
  assert.equal(app.messages.length, 0);
});

test("8,000-block history stays inert until explicit visible scan", async () => {
  const app = simulate(yaml, true, { blockCount: 8000, visibleCount: 2 });
  await app.pump();
  assert.equal(app.messages.length, 0);
  const result = await app.runtimeListener({ type: "jobflick:scan" });
  assert.equal(result.ok, true);
  await app.pump();
  assert.equal(app.messages.filter(x => x.type === "jobflick:validate").length, 2);
  assert.equal(app.messages.filter(x => x.type === "jobflick:submit").length, 0);
});

test("pointer bursts across 40 blocks are bounded to 16 queued candidates", async () => {
  const app = simulate(yaml, true, { blockCount: 40 });
  for (const pre of app.pres) app.pointer(pre);
  await app.pump();
  assert.equal(app.messages.filter(x => x.type === "jobflick:validate").length, 16);
  assert.equal(app.messages.filter(x => x.type === "jobflick:submit").length, 0);
});

test("16 independent conversation content scripts never submit without clicks", async () => {
  const apps = Array.from({ length: 16 }, () => simulate());
  for (const app of apps) app.pointer();
  await Promise.all(apps.map(app => app.pump()));
  assert.equal(apps.reduce((sum, app) =>
    sum + app.messages.filter(x => x.type === "jobflick:validate").length, 0), 16);
  assert(apps.every(app => app.messages.every(x => x.type !== "jobflick:submit")));
});

test("terminal status arriving before submit reply is never lost", async () => {
  const app = simulate(yaml, true, { earlyStatus: true });
  app.focus();
  await app.pump();
  await app.pre.button.handlers.click({ isTrusted: true });
  assert.match(app.pre.button.textContent, /succeeded/);
  assert.equal(app.pre.button.disabled, true);
  assert.equal(app.messages.filter(x => x.type === "jobflick:submit").length, 1);
});

test("detached Run control removes itself without native submission or DOM observer", async () => {
  const app = simulate();
  app.focus();
  await app.pump();
  const button = app.pre.button;
  assert(button?.isConnected);
  app.pre.isConnected = false;
  await button.handlers.click({ isTrusted: true });
  assert.equal(button.isConnected, false);
  assert.equal(app.messages.filter(x => x.type === "jobflick:submit").length, 0);
});
