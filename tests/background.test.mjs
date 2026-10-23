import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function boot(nativeOverride = null) {
  const listeners = {};
  const storage = {};
  const session = {};
  const requests = [];
  const tabs = new Map([[11, { id: 11, url: "https://chatgpt.com/c/testing-1234" }]]);
  const browser = {
    runtime: {
      sendNativeMessage: async (_host, request) => {
        requests.push(request);
        if (nativeOverride) return nativeOverride(request);
        if (request.action === "validate_spec") return { ok: true, message: "valid" };
        if (request.action === "submit_spec") return {
          ok: true, job: { id: "job_12345678", state: "queued", name: "Read only" }
        };
        if (request.action === "inspect") return {
          ok: true, job: { id: request.id, state: "running", name: "Read only" }
        };
        if (request.action === "show") return { ok: true, report: "finished" };
        throw new Error("Unexpected action " + request.action);
      },
      onMessage: { addListener: callback => { listeners.message = callback; } },
      onStartup: { addListener: callback => { listeners.startup = callback; } },
      onInstalled: { addListener: callback => { listeners.installed = callback; } }
    },
    storage: {
      local: {
        get: async key => ({ [key]: storage[key] }),
        set: async data => Object.assign(storage, data)
      },
      session: {
        get: async key => ({ [key]: session[key] }),
        set: async data => Object.assign(session, data),
        remove: async key => { delete session[key]; }
      }
    },
    alarms: {
      create: async () => {},
      clear: async () => {},
      onAlarm: { addListener: callback => { listeners.alarm = callback; } }
    },
    tabs: {
      get: async id => {
        if (!tabs.has(id)) throw new Error("Unknown tab");
        return tabs.get(id);
      },
      sendMessage: async () => ({ ok: true }),
      onUpdated: { addListener: callback => { listeners.updated = callback; } },
      onRemoved: { addListener: callback => { listeners.removed = callback; } }
    },
    action: { onClicked: { addListener: callback => { listeners.action = callback; } } }
  };
  vm.runInNewContext(source, {
    browser, URL, TextEncoder, crypto: { randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    console, Date, Set, Promise, Object
  }, { filename: "background.js" });
  return {
    listeners, storage, session, requests, tabs,
    sender: {
      url: "https://chatgpt.com/c/testing-1234",
      tab: { id: 11, url: "https://chatgpt.com/c/testing-1234" }
    }
  };
}
const sample = "schema: 4\nname: QA read only\nshell: fish\ncwd: /tmp\nprivilege: none\ntimeout_seconds: 5\ncommand: pwd\n";
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

test("reject messages from the wrong site or mismatched tab without contacting host", async () => {
  const app = boot();
  const wrongSite = { url: "https://attacker.invalid/c/123", tab: { id: 11, url: "https://attacker.invalid/c/123" } };
  assert.equal((await app.listeners.message({ type: "jobflick:validate", yaml: sample }, wrongSite)).ok, false);
  const mismatchedTab = { ...app.sender, tab: { id: 11, url: "https://chatgpt.com/c/other-chat" } };
  assert.equal((await app.listeners.message({ type: "jobflick:validate", yaml: sample }, mismatchedTab)).ok, false);
  assert.equal(app.requests.length, 0);
});

test("real validation calls the host but never submits a job", async () => {
  const app = boot();
  const response = await app.listeners.message({ type: "jobflick:validate", yaml: sample }, app.sender);
  assert.equal(response.ok, true);
  assert.deepEqual(app.requests.map(v => v.action), ["validate_spec"]);
});

test("invalid, oversized and unsupported browser messages fail closed", async () => {
  const app = boot();
  for (const message of [
    { type: "jobflick:submit", yaml: "x".repeat(262145) },
    { type: "jobflick:submit", yaml: null },
    { type: "jobflick:cancel", yaml: sample }
  ]) {
    assert.equal((await app.listeners.message(message, app.sender)).ok, false);
  }
  assert.equal(app.requests.length, 0);
});

test("one confirmed submit records independent origin and durable routing", async () => {
  const app = boot();
  const response = await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  assert.equal(response.job.id, "job_12345678");
  const jobs = app.storage.jobflick_bridge_jobs_v1;
  assert.equal(jobs.job_12345678.conversation, "https://chatgpt.com/c/testing-1234");
  assert.equal(jobs.job_12345678.origin, "tab-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(jobs.job_12345678.orphaned, false);
  assert.equal(app.requests.filter(v => v.action === "submit_spec").length, 1);
  assert.equal(app.requests.find(v => v.action === "submit_spec").origin_tab_id, jobs.job_12345678.origin);
});

test("lost submit reply is uncertain and no second submission is attempted", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") throw new Error("Native transport dropped");
    return { ok: true };
  });
  const result = await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  assert.equal(result.ok, false);
  assert.match(result.message, /submission may have succeeded/);
  await pause();
  assert.equal(app.requests.filter(v => v.action === "submit_spec").length, 1);
});

test("closed origin tab flags confirmed job orphaned without discarding it", async () => {
  const app = boot();
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  app.tabs.delete(11);
  app.listeners.removed(11);
  for (let n = 0; n < 10; n++) await pause();
  const record = app.storage.jobflick_bridge_jobs_v1.job_12345678;
  assert(record);
  assert.equal(record.orphaned, true);
  assert.equal(app.session.jobflick_origin_11, undefined);
});
