import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function boot(nativeOverride = null, options = {}) {
  const listeners = {};
  const storage = options.storage || {};
  const session = options.session || {};
  const requests = [];
  const sentTabMessages = [];
  const tabs = new Map([[11, { id: 11, url: "https://chatgpt.com/c/testing-1234" }]]);
  const browser = {
    runtime: {
      id: "jobflick-bridge@sguzman.github.io",
      getURL: path => "moz-extension://unit/" + path,
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
      query: async () => [...tabs.values()].filter(tab => tab.active !== false),
      get: async id => {
        if (!tabs.has(id)) throw new Error("Unknown tab");
        return tabs.get(id);
      },
      sendMessage: async (tabId, message) => {
        sentTabMessages.push({ tabId, message });
        return { ok: true };
      },
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
    listeners, storage, session, requests, tabs, sentTabMessages,
    popupSender: {
      id: "jobflick-bridge@sguzman.github.io",
      url: "moz-extension://unit/popup/index.html"
    },
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

test("only the exact extension popup can list jobs or retrieve reports", async () => {
  const app = boot();
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  const action = { type: "jobflick:inbox" };
  assert.equal((await app.listeners.message(action, app.sender)).ok, false);
  assert.equal((await app.listeners.message(action, {
    id: app.popupSender.id, url: "moz-extension://unit/other.html"
  })).ok, false);
  const response = await app.listeners.message(action, app.popupSender);
  assert.equal(response.ok, true);
  assert.equal(response.jobs.length, 1);
  assert.equal(response.jobs[0].id, "job_12345678");
  assert.equal(app.requests.some(r => r.action === "show"), false);
});

test("report is only fetched on explicit popup request for a finished job", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "queued", name: "Read only" }
    };
    if (request.action === "inspect") return {
      ok: true, job: { id: request.id, state: "succeeded", name: "Read only" }
    };
    if (request.action === "show") return { ok: true, report: "completed report" };
    return { ok: true };
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  // Status polling updates metadata, not a report containing local output.
  await app.listeners.message({ type: "jobflick:refresh" }, app.popupSender);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.state, "succeeded");
  assert.equal("report" in app.storage.jobflick_bridge_jobs_v1.job_12345678, false);
  assert.equal(app.requests.filter(v => v.action === "show").length, 0);
  const response = await app.listeners.message({
    type: "jobflick:report", id: "job_12345678"
  }, app.popupSender);
  assert.equal(response.ok, true);
  assert.equal(response.report, "completed report");
  assert.equal(app.requests.filter(v => v.action === "show").length, 1);
});

test("oversized finished report is rejected without browser storage disclosure", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "succeeded" }
    };
    if (request.action === "show") return { ok: true, report: "z".repeat(524289) };
    return { ok: true, job: { id: request.id, state: "succeeded" } };
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  const result = await app.listeners.message({
    type: "jobflick:report", id: "job_12345678"
  }, app.popupSender);
  assert.equal(result.ok, false);
  assert.match(result.message, /512 KiB/);
  assert.equal("report" in app.storage.jobflick_bridge_jobs_v1.job_12345678, false);
});

test("restarted event page keeps finished Jobflick inbox without reviving tab identity", async () => {
  const first = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "succeeded" }
    };
    return { ok: true, job: { id: request.id, state: "succeeded" } };
  });
  await first.listeners.message({ type: "jobflick:submit", yaml: sample }, first.sender);
  const second = boot(null, { storage: first.storage, session: {} });
  const listing = await second.listeners.message({ type: "jobflick:inbox" }, second.popupSender);
  assert.equal(listing.ok, true);
  assert.equal(listing.jobs.length, 1);
  assert.equal(listing.jobs[0].id, "job_12345678");
  assert.equal(second.session.jobflick_origin_11, undefined);
  assert.equal(second.requests.filter(r => r.action === "submit_spec").length, 0);
});

test("untrusted sender cannot invoke scan or report even with valid IDs", async () => {
  const app = boot();
  for (const type of ["jobflick:scan", "jobflick:report", "jobflick:refresh"]) {
    const result = await app.listeners.message({ type, id: "job_12345678" }, app.sender);
    assert.equal(result.ok, false);
  }
  assert.equal(app.requests.length, 0);
});

test("forgetting requires a finished job and cannot cancel or delete its native output", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "queued" }
    };
    if (request.action === "inspect") return {
      ok: true, job: { id: request.id, state: "succeeded" }
    };
    return { ok: true };
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  const bad = await app.listeners.message({ type: "jobflick:forget", id: "job_12345678" }, app.sender);
  assert.equal(bad.ok, false);
  await app.listeners.message({ type: "jobflick:refresh" }, app.popupSender);
  const forgotten = await app.listeners.message({
    type: "jobflick:forget", id: "job_12345678"
  }, app.popupSender);
  assert.equal(forgotten.ok, true);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678, undefined);
  assert.equal(app.requests.some(v => ["cancel", "consume", "delete"].includes(v.action)), false);
});

test("Firefox restart cannot deliver an old completed job into a reused numeric tab ID", async () => {
  const previous = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "queued" }
    };
    return { ok: true, job: { id: request.id, state: "running" } };
  });
  await previous.listeners.message({ type: "jobflick:submit", yaml: sample }, previous.sender);
  await previous.listeners.message({ type: "jobflick:refresh" }, previous.popupSender);
  const current = boot(request => {
    if (request.action === "inspect") return {
      ok: true, job: { id: request.id, state: "succeeded" }
    };
    throw new Error("Only inspect is expected during restart recovery");
  }, { storage: previous.storage, session: {} });
  // Tab 11 looks numerically identical after the restart but has no old session origin.
  await current.listeners.message({ type: "jobflick:refresh" }, current.popupSender);
  assert.equal(current.storage.jobflick_bridge_jobs_v1.job_12345678.state, "succeeded");
  assert.equal(current.storage.jobflick_bridge_jobs_v1.job_12345678.orphaned, true);
  assert.equal(current.sentTabMessages.length, 0);
  assert.equal(current.requests.some(request => request.action === "submit_spec"), false);
});

test("navigation to a different chat blocks even a same-tab status message", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "queued" }
    };
    if (request.action === "inspect") return {
      ok: true, job: { id: request.id, state: "succeeded" }
    };
    return { ok: true };
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  // The tab navigates away before the status inspection completes.
  app.tabs.set(11, { id: 11, url: "https://chatgpt.com/c/another-conversation" });
  await app.listeners.message({ type: "jobflick:refresh" }, app.popupSender);
  assert.equal(app.sentTabMessages.length, 0);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.orphaned, true);
});
