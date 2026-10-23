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
  const alarmActions = [];
  const activeAlarms = new Map();
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
        set: async data => {
          if (options.beforeSessionWrite) await options.beforeSessionWrite(data);
          Object.assign(session, data);
        },
        remove: async key => { delete session[key]; }
      }
    },
    alarms: {
      get: async name => activeAlarms.get(name) || null,
      create: async (name, details) => {
        alarmActions.push({ type: "create", name, details });
        activeAlarms.set(name,{ name, ...details });
      },
      clear: async name => {
        alarmActions.push({ type: "clear", name });
        return activeAlarms.delete(name);
      },
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
        if (options.beforeTabMessage) await options.beforeTabMessage({ tabId, message, tabs });
        if (message?.type === "jobflick:probe-upload") {
          return { ok: true, composerPresent: true, composerOccupied: false, fileInputPresent: false };
        }
        return { ok: true };
      },
      onUpdated: { addListener: callback => { listeners.updated = callback; } },
      onRemoved: { addListener: callback => { listeners.removed = callback; } }
    },
    action: { onClicked: { addListener: callback => { listeners.action = callback; } } },
    webNavigation: {
      onHistoryStateUpdated: {
        addListener: (callback, filter) => {
          listeners.historyState = callback;
          listeners.historyFilter = filter;
        }
      }
    }
  };
  vm.runInNewContext(source, {
    browser, URL, TextEncoder, crypto: { randomUUID: options.randomUUID ||
      (() => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") },
    console, Date, Set, Promise, Object,
    setTimeout: options.setTimeout
  }, { filename: "background.js" });
  return {
    listeners, storage, session, requests, tabs, sentTabMessages, alarmActions,
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

test("alarm checks at most 24 pending jobs and rotates fairly through 40", async () => {
  const records = {};
  for (let n = 0; n < 40; n++) {
    const id = "job_" + String(n).padStart(8, "0");
    records[id] = {
      id, tabId: 11, origin: "tab-old", conversation: "https://chatgpt.com/c/testing-1234",
      state: "running", submittedAt: n, orphaned: true
    };
  }
  const app = boot(request => {
    if (request.action === "inspect") return {
      ok: true, job: { id: request.id, state: "running" }
    };
    throw new Error("Only inspect is expected during polling");
  }, { storage: { jobflick_bridge_jobs_v1: records }, session: {} });
  await app.listeners.message({ type: "jobflick:refresh" }, app.popupSender);
  const first = app.requests.filter(r => r.action === "inspect");
  assert.equal(first.length, 24);
  await app.listeners.message({ type: "jobflick:refresh" }, app.popupSender);
  const all = app.requests.filter(r => r.action === "inspect");
  assert.equal(all.length, 48); // Two bounded 24-job inspection cycles.
  assert.equal(new Set(all.map(x => x.id)).size, 40); // Every job eventually checked.
});

test("connection diagnostics validate intentionally malformed YAML without execution", async () => {
  const app = boot(request => {
    if (request.action === "validate_spec") {
      return { ok: false, message: "Rejected unknown YAML key" };
    }
    throw new Error("Only validate_spec may be called for diagnostics");
  });
  const reject = await app.listeners.message({ type: "jobflick:diagnose" }, app.sender);
  assert.equal(reject.ok, false);
  const result = await app.listeners.message({ type: "jobflick:diagnose" }, app.popupSender);
  assert.equal(result.ok, true);
  assert.match(result.message, /reachable/);
  assert.deepEqual(app.requests.map(x => x.action), ["validate_spec"]);
});

test("missing host is reported as a failed connection check, not an implicit retry", async () => {
  const app = boot(() => { throw new Error("Native messaging host not found"); });
  const result = await app.listeners.message({ type: "jobflick:diagnose" }, app.popupSender);
  assert.equal(result.ok, false);
  assert.match(result.message, /Native messaging host not found/);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests.some(x => x.action === "submit_spec"), false);
});

test("unexpected successful validation of malformed probe fails connection check", async () => {
  const app = boot(() => ({ ok: true }));
  const result = await app.listeners.message({ type: "jobflick:diagnose" }, app.popupSender);
  assert.equal(result.ok, false);
  assert.match(result.message, /unexpectedly accepted/);
});

test("conversation routing accepts ordinary/project chats and denies share/settings pages", async () => {
  const app = boot();
  const candidates = [
    ["https://chatgpt.com/c/testing-1234", true],
    ["https://chatgpt.com/g/g-p-1234/c/chat-5678", true],
    ["https://chatgpt.com/uc/testing-1234", true],
    ["https://chatgpt.com/share/testing-1234", false],
    ["https://chatgpt.com/g/g-p-1234/project", false],
    ["https://chatgpt.com/settings", false],
    ["https://chatgpt.com/auth/login", false],
    ["https://chatgpt.com/c/short", true],
    ["https://chatgpt.com/c/", false],
    ["https://attacker.invalid/c/testing-1234", false]
  ];
  for (const [url, expected] of candidates) {
    const sender = { url, tab: { id: 11, url } };
    const answer = await app.listeners.message({ type: "jobflick:validate", yaml: sample }, sender);
    assert.equal(answer.ok, expected, url);
  }
  assert.equal(app.requests.filter(r => r.action === "submit_spec").length, 0);
});

test("composer capability check is popup-only and transfers flags, not user draft contents", async () => {
  const app = boot();
  const denied = await app.listeners.message({ type: "jobflick:probe-upload" }, app.sender);
  assert.equal(denied.ok, false);
  const response = await app.listeners.message({ type: "jobflick:probe-upload" }, app.popupSender);
  assert.equal(response.ok, true);
  assert.equal(response.composerPresent, true);
  assert.equal(response.composerOccupied, false);
  assert.equal(response.fileInputPresent, false);
  assert.equal("draft" in response, false);
  assert.equal(app.requests.length, 0);
  assert.equal(app.sentTabMessages.length, 1);
  assert.equal(app.sentTabMessages[0].message.type, "jobflick:probe-upload");
});

test("composer capability check fails closed away from conversation routes", async () => {
  const app = boot();
  app.tabs.set(11, { id: 11, url: "https://chatgpt.com/settings" });
  const result = await app.listeners.message({ type: "jobflick:probe-upload" }, app.popupSender);
  assert.equal(result.ok, false);
  assert.equal(app.sentTabMessages.length, 0);
  assert.equal(app.requests.length, 0);
});

test("simultaneous explicit submissions in one tab reuse a single origin token", async () => {
  let uuidCalls = 0;
  let submissions = 0;
  const app = boot(request => {
    if (request.action === "submit_spec") {
      submissions++;
      return {
        ok: true,
        job: { id: "job_" + String(submissions).padStart(8, "0"), state: "queued" }
      };
    }
    if (request.action === "inspect") {
      return { ok: true, job: { id: request.id, state: "running" } };
    }
    return { ok: false, message: "Unsupported" };
  }, { randomUUID: () => {
    uuidCalls++;
    return "token-sequence-" + uuidCalls;
  } });
  const [first, second] = await Promise.all([
    app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender),
    app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender)
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(uuidCalls, 1);
  assert.equal(app.requests.filter(x => x.action === "submit_spec").length, 2);
  const origins = app.requests.filter(x => x.action === "submit_spec")
    .map(x => x.origin_tab_id);
  assert.deepEqual(origins, ["tab-token-sequence-1", "tab-token-sequence-1"]);
  const jobs = app.storage.jobflick_bridge_jobs_v1;
  assert.equal(jobs.job_00000001.origin, jobs.job_00000002.origin);
  assert.equal(jobs.job_00000001.conversation, jobs.job_00000002.conversation);
});

test("cancel from Firefox popup requires a tracked active job and one explicit native call", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "running" }
    };
    if (request.action === "inspect") return {
      ok: true, job: { id: request.id, state: "running" }
    };
    if (request.action === "cancel") return { ok: true, message: "Stop requested" };
    throw new Error("Unexpected native request");
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  assert.equal((await app.listeners.message({
    type: "jobflick:cancel", id: "job_12345678"
  }, app.sender)).ok, false, "Content script cannot cancel");
  const result = await app.listeners.message({
    type: "jobflick:cancel", id: "job_12345678"
  }, app.popupSender);
  assert.equal(result.ok, true);
  assert.match(result.message, /final state is not yet confirmed/);
  assert.equal(app.requests.filter(request => request.action === "cancel").length, 1);
  assert.equal((await app.listeners.message({
    type: "jobflick:cancel", id: "job_12345678"
  }, app.popupSender)).ok, false);
  assert.equal(app.requests.filter(request => request.action === "cancel").length, 1);
  const inbox = await app.listeners.message({ type: "jobflick:inbox" }, app.popupSender);
  assert.equal(inbox.jobs[0].cancelRequested, true);
  assert.equal(inbox.jobs[0].state, "running", "Native acknowledgement is not a final state");
});

test("cancel rejects unknown, invalid and finished jobs without contacting native host", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "succeeded" }
    };
    throw new Error("Unexpected native action");
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  for (const id of ["x", "unknown_job_234567", "job_12345678"]) {
    const result = await app.listeners.message({ type: "jobflick:cancel", id }, app.popupSender);
    assert.equal(result.ok, false);
  }
  assert.equal(app.requests.filter(request => request.action === "cancel").length, 0);
});

test("ambiguous cancel disconnection never triggers a background retry", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "running" }
    };
    if (request.action === "inspect") return {
      ok: true, job: { id: request.id, state: "running" }
    };
    if (request.action === "cancel") throw new Error("Native host disconnected");
    throw new Error("Unexpected native action");
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  const result = await app.listeners.message({
    type: "jobflick:cancel", id: "job_12345678"
  }, app.popupSender);
  assert.equal(result.ok, false);
  assert.match(result.message, /Native host disconnected/);
  await pause();
  assert.equal(app.requests.filter(request => request.action === "cancel").length, 1);
  assert.equal(app.requests.filter(request => request.action === "submit_spec").length, 1);
});

test("navigation during asynchronous tab-token creation prevents native submission", async () => {
  let app;
  app = boot(null, {
    beforeSessionWrite: async () => {
      app.tabs.set(11, { id: 11, url: "https://chatgpt.com/c/different-5678" });
    }
  });
  const result = await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  assert.equal(result.ok, false);
  assert.match(result.message, /Conversation changed before submission/);
  assert.equal(app.requests.some(x => x.action === "submit_spec"), false);
});

test("tab closure during asynchronous token creation cannot queue a job", async () => {
  let app;
  app = boot(null, {
    beforeSessionWrite: async () => { app.tabs.delete(11); }
  });
  const response = await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  assert.equal(response.ok, false);
  assert.equal(app.requests.filter(x => x.action === "submit_spec").length, 0);
});

test("startup reconciles even terminal records against session tokens", async () => {
  const finished = {
    job_12345678: {
      id: "job_12345678", tabId: 11, origin: "tab-earlier-session",
      conversation: "https://chatgpt.com/c/testing-1234", state: "succeeded",
      orphaned: false, submittedAt: 100
    }
  };
  const app = boot(null, { storage: { jobflick_bridge_jobs_v1: finished }, session: {} });
  app.listeners.startup();
  for (let attempts = 0; attempts < 20; attempts++) {
    if (app.storage.jobflick_bridge_jobs_v1.job_12345678.orphaned) break;
    await pause();
  }
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.orphaned, true);
  const listing = await app.listeners.message({ type: "jobflick:inbox" }, app.popupSender);
  assert.equal(listing.jobs[0].orphaned, true);
  assert.equal(app.requests.filter(r => r.action === "submit_spec").length, 0);
});

test("startup keeps a verified living origin attached", async () => {
  const tabToken = "tab-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const record = {
    job_12345678: {
      id: "job_12345678", tabId: 11, origin: tabToken,
      conversation: "https://chatgpt.com/c/testing-1234", state: "succeeded",
      orphaned: false, submittedAt: 100
    }
  };
  const app = boot(null, {
    storage: { jobflick_bridge_jobs_v1: record },
    session: { jobflick_origin_11: tabToken }
  });
  app.listeners.startup();
  for (let n = 0; n < 10; n++) await pause();
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.orphaned, false);
});

test("tracked Firefox records have an explicit version and non-delivered result state", async () => {
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
  const initial = app.storage.jobflick_bridge_jobs_v1.job_12345678;
  assert.equal(initial.recordVersion, 1);
  assert.equal(initial.deliveryState, "awaiting_completion");
  await app.listeners.message({ type: "jobflick:refresh" }, app.popupSender);
  const record = app.storage.jobflick_bridge_jobs_v1.job_12345678;
  assert.equal(record.deliveryState, "report_pending_manual_delivery");
  assert.equal(record.orphaned, false);
  assert.equal("report" in record, false);
  assert.notEqual(record.deliveryState, "delivered", "No automatic Send exists");
});

test("unsupported future record versions survive untouched and cannot be exported or cancelled", async () => {
  const future = { job_12345678: {
    id: "job_12345678", recordVersion: 200, state: "running",
    tabId: 11, origin: "tab-other", conversation: "https://chatgpt.com/c/testing-1234"
  } };
  const app = boot(null, { storage: { jobflick_bridge_jobs_v1: future } });
  const inbox = await app.listeners.message({ type: "jobflick:inbox" }, app.popupSender);
  assert.equal(inbox.ok, true);
  assert.equal(inbox.jobs.length, 0);
  for (const type of ["jobflick:cancel", "jobflick:forget", "jobflick:report"]) {
    const response = await app.listeners.message({ type, id: "job_12345678" }, app.popupSender);
    assert.equal(response.ok, false);
  }
  await app.listeners.message({ type: "jobflick:refresh" }, app.popupSender);
  assert.equal(app.requests.length, 0);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.recordVersion, 200);
});

test("concurrent popup cancellation messages issue at most one native request", async () => {
  let finish;
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "running" }
    };
    if (request.action === "inspect") return { ok: true, job: { id: request.id, state: "running" } };
    if (request.action === "cancel") return new Promise(resolve => { finish = resolve; });
    throw new Error("Unexpected host action");
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  const first = app.listeners.message({ type: "jobflick:cancel", id: "job_12345678" }, app.popupSender);
  for (let i = 0; i < 10 && !finish; i++) await pause();
  assert.equal(typeof finish, "function");
  const second = await app.listeners.message({ type: "jobflick:cancel", id: "job_12345678" }, app.popupSender);
  assert.equal(second.ok, false);
  assert.equal(app.requests.filter(x => x.action === "cancel").length, 1);
  finish({ ok: true, message: "Stop requested" });
  assert.equal((await first).ok, true);
});

test("unknown future records do not keep the Firefox polling alarm alive", async () => {
  const unknown = { job_12345678: {
    id: "job_12345678", recordVersion: 999, state: "running",
    tabId: 11, origin: "unknown", conversation: "https://chatgpt.com/c/testing-1234"
  } };
  const app = boot(null, { storage: { jobflick_bridge_jobs_v1: unknown } });
  await app.listeners.message({ type: "jobflick:refresh" }, app.popupSender);
  assert.equal(app.requests.length, 0);
  assert.equal(app.alarmActions.some(action => action.type === "create"), false);
  assert.equal(app.alarmActions.at(-1).type, "clear");
  assert.deepEqual(app.storage.jobflick_bridge_jobs_v1.job_12345678, unknown.job_12345678);
});

test("per-job preflight is read-only and checks exact original tab + conversation", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "succeeded" }
    };
    throw new Error("No native action expected for preflight");
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  const bad = await app.listeners.message({
    type: "jobflick:preflight", id: "job_12345678"
  }, app.sender);
  assert.equal(bad.ok, false);
  const ok = await app.listeners.message({
    type: "jobflick:preflight", id: "job_12345678"
  }, app.popupSender);
  assert.equal(ok.ok, true);
  assert.equal(ok.originalConversationVerified, true);
  assert.equal(ok.composerPresent, true);
  assert.equal(ok.fileInputPresent, false);
  assert.equal(ok.composerOccupied, false);
  assert.equal("report" in ok, false);
  assert.equal("draft" in ok, false);
  assert.equal(app.sentTabMessages.filter(x =>
    x.message.type === "jobflick:probe-upload").length, 1);
  assert.equal(app.requests.filter(x => x.action === "show").length, 0);
});

test("per-job preflight fails closed on navigation and never reroutes", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "succeeded" }
    };
    throw new Error("No native action expected");
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  app.tabs.set(11, { id: 11, url: "https://chatgpt.com/c/unrelated-5678" });
  const result = await app.listeners.message({
    type: "jobflick:preflight", id: "job_12345678"
  }, app.popupSender);
  assert.equal(result.ok, false);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.orphaned, true);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.deliveryState, "manual_only");
  assert.equal(app.sentTabMessages.filter(x =>
    x.message.type === "jobflick:probe-upload").length, 0);
});

test("finished status after same-tab navigation becomes manual-only, never deliverable", async () => {
  let completeInspect;
  const app = boot(request => {
    if (request.action === "submit_spec") return {
      ok: true, job: { id: "job_12345678", state: "queued" }
    };
    if (request.action === "inspect") return new Promise(resolve => {
      completeInspect = resolve;
    });
    throw new Error("Unexpected action");
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  for (let i = 0; i < 20 && !completeInspect; i++) await pause();
  assert.equal(typeof completeInspect, "function");
  app.tabs.set(11, { id: 11, url: "https://chatgpt.com/c/different-after-submit" });
  completeInspect({ ok: true, job: { id: "job_12345678", state: "succeeded" } });
  await app.listeners.message({ type: "jobflick:refresh" }, app.popupSender);
  const record = app.storage.jobflick_bridge_jobs_v1.job_12345678;
  assert.equal(record.state, "succeeded");
  assert.equal(record.orphaned, true);
  assert.equal(record.deliveryState, "manual_only");
  assert.equal(app.sentTabMessages.length, 0);
});

test("preflight navigation during read-only tab message cannot assert original chat", async () => {
  const app = boot(request => {
    if (request.action === "submit_spec") {
      return { ok: true, job: { id: "job_12345678", state: "succeeded" } };
    }
    throw new Error("Preflight must not make a native request");
  }, {
    beforeTabMessage: ({ message, tabs }) => {
      if (message.type === "jobflick:probe-upload") {
        tabs.set(11, { id: 11, url: "https://chatgpt.com/c/navigated-during-probe" });
      }
    }
  });
  await app.listeners.message({ type: "jobflick:submit", yaml: sample }, app.sender);
  const result = await app.listeners.message({
    type: "jobflick:preflight", id: "job_12345678"
  }, app.popupSender);
  assert.equal(result.ok, false);
  assert.match(result.message, /navigated during inspection/);
  const record = app.storage.jobflick_bridge_jobs_v1.job_12345678;
  assert.equal(record.orphaned, true);
  assert.equal(record.deliveryState, "manual_only");
  assert.equal(app.requests.some(x => ["show", "submit_spec"].includes(x.action)), true,
    "The only submit is the initial user-authorized job");
  assert.equal(app.requests.filter(x => x.action === "submit_spec").length, 1);
  assert.equal(app.requests.filter(x => x.action === "show").length, 0);
});

test("conversation navigation irreversibly orphans older jobs even after returning", async () => {
  const app=boot(request=>{
    if(request.action==="submit_spec") return {
      ok:true, job:{id:"job_12345678",state:"succeeded"}
    };
    throw new Error("Unexpected native action");
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  const origin=app.storage.jobflick_bridge_jobs_v1.job_12345678.origin;
  assert(origin);
  await app.listeners.updated(11,{url:"https://chatgpt.com/c/new-conversation"});
  for(let i=0;i<10;i++) await pause();
  const record=app.storage.jobflick_bridge_jobs_v1.job_12345678;
  assert.equal(record.orphaned,true);
  assert.equal(record.deliveryState,"manual_only");
  assert.equal(app.session.jobflick_origin_11,undefined);
  await app.listeners.updated(11,{url:"https://chatgpt.com/c/testing-1234"});
  for(let i=0;i<10;i++) await pause();
  assert.equal(record.orphaned,true);
  const result=await app.listeners.message({
    type:"jobflick:preflight",id:"job_12345678"
  },app.popupSender);
  assert.equal(result.ok,false);
});

test("same canonical conversation reload preserves active origin token", async () => {
  const app=boot(request=>{
    if(request.action==="submit_spec") return {
      ok:true,job:{id:"job_12345678",state:"succeeded"}
    };
    throw new Error("Unexpected native action");
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  const token=app.session.jobflick_origin_11;
  app.listeners.updated(11,{
    url:"https://chatgpt.com/c/testing-1234?newQuery=irrelevant"
  });
  for(let i=0;i<10;i++)await pause();
  assert.equal(app.session.jobflick_origin_11,token);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.orphaned,false);
});

test("navigation while native submission completes records job as manual-only",async()=>{
  let app;
  app=boot(request=>{
    if(request.action==="submit_spec"){
      app.tabs.set(11,{
        id:11,url:"https://chatgpt.com/c/navigation-during-host"
      });
      return {ok:true,job:{id:"job_12345678",state:"queued"}};
    }
    return {ok:true};
  });
  const result=await app.listeners.message({
    type:"jobflick:submit",yaml:sample
  },app.sender);
  assert.equal(result.ok,true,"The job may have been accepted by Jobflick");
  const record=app.storage.jobflick_bridge_jobs_v1.job_12345678;
  assert.equal(record.orphaned,true);
  assert.equal(record.deliveryState,"manual_only");
  const verified=await app.listeners.message({
    type:"jobflick:preflight",id:"job_12345678"
  },app.popupSender);
  assert.equal(verified.ok,false);
  assert.equal(app.requests.filter(x=>x.action==="submit_spec").length,1);
});

test("Firefox pushState to a different conversation permanently revokes old origin",async()=>{
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"succeeded"}
    };
    return {ok:true};
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  assert.deepEqual(
    JSON.parse(JSON.stringify(app.listeners.historyFilter)),
    {url:[{hostEquals:"chatgpt.com"},{hostEquals:"chat.openai.com"}]}
  );
  app.listeners.historyState({
    tabId:11,frameId:0,url:"https://chatgpt.com/c/different-through-pushstate"
  });
  for(let i=0;i<12;i++)await pause();
  const old=app.storage.jobflick_bridge_jobs_v1.job_12345678;
  assert.equal(old.orphaned,true);
  assert.equal(old.deliveryState,"manual_only");
  assert.equal(app.session.jobflick_origin_11,undefined);
  app.listeners.historyState({
    tabId:11,frameId:0,url:"https://chatgpt.com/c/testing-1234"
  });
  for(let i=0;i<12;i++)await pause();
  assert.equal(old.orphaned,true);
  const result=await app.listeners.message({
    type:"jobflick:preflight",id:"job_12345678"
  },app.popupSender);
  assert.equal(result.ok,false);
});

test("iframe History API changes do not affect the parent ChatGPT delivery token",async()=>{
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"succeeded"}
    };
    return {ok:true};
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  const token=app.session.jobflick_origin_11;
  app.listeners.historyState({
    tabId:11,frameId:2,url:"https://chatgpt.com/c/embedded-history"
  });
  for(let i=0;i<5;i++)await pause();
  assert.equal(app.session.jobflick_origin_11,token);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.orphaned,false);
});

test("post-submit fast checks finish a short job without waiting for minute alarm",async()=>{
  const timers=[];
  let inspectCalls=0;
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"queued"}
    };
    if(request.action==="inspect")return {
      ok:true,job:{id:request.id,state:++inspectCalls===1?"running":"succeeded"}
    };
    return {ok:true};
  },{
    setTimeout:(fn,delay)=>{
      timers.push({fn,delay});
      return timers.length;
    }
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  for(let i=0;i<8;i++)await pause();
  assert.equal(inspectCalls,1);
  assert.equal(timers.length,1);
  assert.equal(timers[0].delay,1200);
  await timers.shift().fn();
  assert.equal(inspectCalls,2);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.state,"succeeded");
  assert.equal(timers.length,0);
  assert.equal(app.requests.filter(x=>x.action==="submit_spec").length,1);
  assert.equal(app.requests.filter(x=>x.action==="show").length,0);
});

test("fast native status polling stops after six bounded checks of a slow job",async()=>{
  const timers=[];
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"queued"}
    };
    if(request.action==="inspect")return {
      ok:true,job:{id:request.id,state:"running"}
    };
    return {ok:true};
  },{
    setTimeout:(fn,delay)=>{
      timers.push({fn,delay});
      return timers.length;
    }
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  for(let i=0;i<8;i++)await pause();
  let ticks=0;
  while(timers.length&&ticks<20){
    await timers.shift().fn();
    ticks++;
  }
  assert.equal(ticks,6);
  assert.equal(timers.length,0);
  assert.equal(app.requests.filter(x=>x.action==="inspect").length,7);
  assert.equal(app.requests.filter(x=>x.action==="submit_spec").length,1);
});

test("burst of 40 jobs has a fixed-size fast polling queue; others use alarms",async()=>{
  const timers=[];
  let nextId=0;
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{
        id:"job_"+String(++nextId).padStart(8,"0"),
        state:"queued"
      }
    };
    if(request.action==="inspect")return {
      ok:true,job:{id:request.id,state:"running"}
    };
    return {ok:true};
  },{
    setTimeout:(fn,delay)=>{
      timers.push(fn);
      return timers.length;
    }
  });
  for(let i=0;i<40;i++){
    await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  }
  for(let i=0;i<8;i++) await pause();
  assert.equal(timers.length,1);
  let ticks=0;
  while(timers.length&&ticks<100){
    await timers.shift()();
    ticks++;
  }
  assert.equal(ticks,48,"32 queued jobs × six checks, four per timer tick");
  assert.equal(timers.length,0);
  assert.equal(app.requests.filter(r=>r.action==="submit_spec").length,40);
  assert.equal(app.requests.filter(r=>r.action==="show").length,0);
  assert.equal(app.storage.jobflick_bridge_jobs_v1 &&
    Object.keys(app.storage.jobflick_bridge_jobs_v1).length,40);
});

test("frequent native status metadata writes cannot defer the existing durable alarm",async()=>{
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"running"}
    };
    if(request.action==="inspect")return {
      ok:true,job:{id:request.id,state:"running"}
    };
    return {ok:true};
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  assert.equal(app.alarmActions.filter(x=>x.type==="create").length,1);
  for(let i=0;i<20;i++)await app.listeners.message({
    type:"jobflick:refresh"
  },app.popupSender);
  assert.equal(app.alarmActions.filter(x=>x.type==="create").length,1,
    "Repeated metadata writes must not reset Firefox's next alarm deadline");
  assert.equal(app.alarmActions.filter(x=>x.type==="clear").length,0);
  assert.equal(app.requests.filter(x=>x.action==="submit_spec").length,1);
});

test("terminal status clears the durable alarm once no jobs remain active",async()=>{
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"running"}
    };
    if(request.action==="inspect")return {
      ok:true,job:{id:request.id,state:"succeeded"}
    };
    return {ok:true};
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  await app.listeners.message({type:"jobflick:refresh"},app.popupSender);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.state,"succeeded");
  assert.equal(app.alarmActions.some(x=>x.type==="clear"),true);
  assert.equal(app.requests.filter(x=>x.action==="show").length,0);
});

test("overlapping alarm inspection does not consume a target's fast check budget",async()=>{
  const timers=[];
  let finishFirst=null;
  let checks=0;
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"queued"}
    };
    if(request.action==="inspect"){
      checks++;
      if(checks===1)return new Promise(resolve=>{finishFirst=resolve;});
      return {ok:true,job:{id:request.id,state:"succeeded"}};
    }
    return {ok:true};
  },{
    setTimeout:fn=>{timers.push(fn);return timers.length;}
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  for(let i=0;i<12&&!finishFirst;i++)await pause();
  assert.equal(typeof finishFirst,"function");
  assert.equal(timers.length,1);
  const coincident=timers.shift()();
  for(let i=0;i<4;i++)await pause();
  assert.equal(checks,1,"Targeted check coalesced with in-flight inspection");
  finishFirst({ok:true,job:{id:"job_12345678",state:"running"}});
  await coincident;
  assert.equal(timers.length,1,"Coalescing must preserve a future fast attempt");
  assert.equal(checks,1);
  await timers.shift()();
  assert.equal(checks,2);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.state,"succeeded");
  assert.equal(timers.length,0);
  assert.equal(app.requests.filter(x=>x.action==="submit_spec").length,1);
});

test("trusted inbox exposes older records in capped pages without reading native reports",async()=>{
  const jobs={};
  for(let i=0;i<325;i++){
    const id="job_"+String(i).padStart(8,"0");
    jobs[id]={
      id,recordVersion:1,state:"succeeded",name:"Saved "+i,
      submittedAt:325-i,orphaned:true,deliveryState:"manual_only"
    };
  }
  const app=boot(null,{storage:{jobflick_bridge_jobs_v1:jobs}});
  let offset=0;
  const visited=[];
  while(true){
    const response=await app.listeners.message({
      type:"jobflick:inbox",offset,limit:40
    },app.popupSender);
    assert.equal(response.ok,true);
    assert(response.jobs.length<=40);
    visited.push(...response.jobs.map(job=>job.id));
    if(!response.hasMore)break;
    assert.equal(response.nextOffset,offset+response.jobs.length);
    offset=response.nextOffset;
  }
  assert.equal(visited.length,325);
  assert.equal(new Set(visited).size,325);
  assert.equal(visited[0],"job_00000000");
  assert.equal(visited[324],"job_00000324");
  assert.equal(app.requests.length,0,"Browsing local metadata never invokes the native host");
});

test("inbox rejects hostile pagination arguments and oversized page requests",async()=>{
  const app=boot();
  for(const fields of [
    {offset:-1,limit:40},
    {offset:"0",limit:40},
    {offset:0,limit:0},
    {offset:0,limit:51},
    {offset:Infinity,limit:40},
    {offset:100001,limit:40},
    {offset:0,limit:1.5}
  ]){
    const response=await app.listeners.message({
      type:"jobflick:inbox",...fields
    },app.popupSender);
    assert.equal(response.ok,false,JSON.stringify(fields));
  }
  assert.equal(app.requests.length,0);
});

test("search is bounded to local job metadata and never reads native reports",async()=>{
  const records={
    job_12345678:{id:"job_12345678",name:"Alpha compile",state:"succeeded",submittedAt:2},
    job_87654321:{id:"job_87654321",name:"Beta archive",state:"running",submittedAt:1}
  };
  const app=boot(null,{storage:{jobflick_bridge_jobs_v1:records}});
  const results=await app.listeners.message({
    type:"jobflick:inbox",query:"ARCHIVE",offset:0,limit:40
  },app.popupSender);
  assert.deepEqual(results.jobs.map(x=>x.id),["job_87654321"]);
  assert.equal(results.hasMore,false);
  const bad=await app.listeners.message({
    type:"jobflick:inbox",query:"A".repeat(129)
  },app.popupSender);
  assert.equal(bad.ok,false);
  assert.equal(app.requests.length,0);
});

test("duplicate native job IDs cannot overwrite existing origin or report routing",async()=>{
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"succeeded",name:"New from host"}
    };
    if(request.action==="inspect")return {
      ok:true,job:{id:request.id,state:"running"}
    };
    return {ok:true};
  });
  const first=await app.listeners.message({
    type:"jobflick:submit",yaml:sample
  },app.sender);
  assert.equal(first.ok,true);
  const original=JSON.stringify(app.storage.jobflick_bridge_jobs_v1.job_12345678);
  const second=await app.listeners.message({
    type:"jobflick:submit",yaml:sample
  },app.sender);
  assert.equal(second.ok,false);
  assert.match(second.message,/existing job ID/);
  assert.match(second.message,/submission may have succeeded/);
  assert.equal(JSON.stringify(app.storage.jobflick_bridge_jobs_v1.job_12345678),original);
  assert.equal(app.requests.filter(x=>x.action==="submit_spec").length,2);
  assert.equal(Object.keys(app.storage.jobflick_bridge_jobs_v1).length,1);
});

test("unsupported future record cannot be overwritten by a reused native job ID",async()=>{
  const record={id:"job_12345678",recordVersion:999,state:"running",
    origin:"protected",conversation:"https://chatgpt.com/c/original-file"};
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"queued"}
    };
    return {ok:true};
  },{storage:{jobflick_bridge_jobs_v1:{job_12345678:record}}});
  const result=await app.listeners.message({
    type:"jobflick:submit",yaml:sample
  },app.sender);
  assert.equal(result.ok,false);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.recordVersion,999);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.origin,"protected");
});

test("native status with a conflicting browser origin is preserved as manual-only",async()=>{
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"queued"}
    };
    if(request.action==="inspect")return {
      ok:true,job:{id:request.id,state:"succeeded",
        origin_tab_id:"tab-different-browser"}
    };
    return {ok:true};
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  await app.listeners.message({type:"jobflick:refresh"},app.popupSender);
  const record=app.storage.jobflick_bridge_jobs_v1.job_12345678;
  assert.equal(record.orphaned,true);
  assert.equal(record.deliveryState,"manual_only");
  assert.equal(app.sentTabMessages.filter(x=>x.message.type==="jobflick:status").length,0);
  assert.equal(app.requests.filter(x=>x.action==="submit_spec").length,1);
});

test("wrong native origin in accepted submission response fails without stored rebind",async()=>{
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{
        id:"job_12345678",state:"queued",
        origin_tab_id:"tab-host-provenance-conflict"
      }
    };
    return {ok:true};
  });
  const result=await app.listeners.message({
    type:"jobflick:submit",yaml:sample
  },app.sender);
  assert.equal(result.ok,false);
  assert.match(result.message,/origin did not match/);
  assert.match(result.message,/submission may have succeeded/);
  assert.equal(app.storage.jobflick_bridge_jobs_v1,undefined);
  assert.equal(app.requests.filter(x=>x.action==="submit_spec").length,1);
});

test("matching native origin is accepted when real backend includes it",async()=>{
  const token="tab-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"succeeded",origin_tab_id:token}
    };
    return {ok:true};
  });
  const result=await app.listeners.message({
    type:"jobflick:submit",yaml:sample
  },app.sender);
  assert.equal(result.ok,true);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.origin,token);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.orphaned,false);
});

test("native inspect cannot substitute a different Jobflick job ID",async()=>{
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"queued"}
    };
    if(request.action==="inspect")return {
      ok:true,job:{id:"job_87654321",state:"succeeded",
        name:"Unrelated native job",origin_tab_id:"tab-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}
    };
    return {ok:true};
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  await app.listeners.message({type:"jobflick:refresh"},app.popupSender);
  const record=app.storage.jobflick_bridge_jobs_v1.job_12345678;
  assert.equal(record.orphaned,true);
  assert.equal(record.deliveryState,"manual_only");
  assert.equal(record.integrityIssue,"native_job_id_mismatch");
  assert.equal(record.state,"queued");
  assert.notEqual(record.name,"Unrelated native job");
  assert.equal(app.sentTabMessages.filter(x=>x.message.type==="jobflick:status").length,0);
  assert.equal(app.requests.filter(x=>x.action==="inspect").length,1);
  for(let i=0;i<4;i++)await app.listeners.message({
    type:"jobflick:refresh"
  },app.popupSender);
  assert.equal(app.requests.filter(x=>x.action==="inspect").length,1,
    "Quarantined native identity must not be repeatedly inspected");
  const inbox=await app.listeners.message({type:"jobflick:inbox"},app.popupSender);
  assert.equal(inbox.jobs[0].integrityIssue,"native_job_id_mismatch");
  assert.equal(app.alarmActions.at(-1).type,"clear");
});

test("conflicting native origin is quarantined once without background polling",async()=>{
  const app=boot(request=>{
    if(request.action==="submit_spec")return {
      ok:true,job:{id:"job_12345678",state:"queued"}
    };
    if(request.action==="inspect")return {
      ok:true,job:{id:"job_12345678",state:"running",
        origin_tab_id:"tab-wrong-token"}
    };
    return {ok:true};
  });
  await app.listeners.message({type:"jobflick:submit",yaml:sample},app.sender);
  await app.listeners.message({type:"jobflick:refresh"},app.popupSender);
  assert.equal(app.storage.jobflick_bridge_jobs_v1.job_12345678.integrityIssue,
    "native_origin_mismatch");
  await app.listeners.message({type:"jobflick:refresh"},app.popupSender);
  assert.equal(app.requests.filter(x=>x.action==="inspect").length,1);
  assert.equal(app.requests.filter(x=>x.action==="show").length,0);
});

test("read-only advanced composer flags are explicitly unknown on legacy content scripts",async()=>{
  const app=boot();
  const response=await app.listeners.message({
    type:"jobflick:probe-upload"
  },app.popupSender);
  assert.equal(response.ok,true);
  assert.equal(response.composerAmbiguous,null);
  assert.equal(response.fileInputAmbiguous,null);
  assert.equal(response.selectedFilePresent,null);
  assert.equal(app.requests.length,0);
});

test("quarantined running job cannot be cancelled through popup native messaging",async()=>{
  const id="job_12345678";
  const record={id,recordVersion:1,state:"running",origin:"tab-test",
    orphaned:true,deliveryState:"manual_only",
    integrityIssue:"native_origin_mismatch"};
  const app=boot(null,{storage:{jobflick_bridge_jobs_v1:{[id]:record}}});
  const reply=await app.listeners.message({type:"jobflick:cancel",id},app.popupSender);
  assert.equal(reply.ok,false);
  assert.equal(app.requests.length,0);
  assert.equal(record.integrityIssue,"native_origin_mismatch");
});

test("finished quarantined job cannot retrieve a report through the extension",async()=>{
  const id="job_12345678";
  const app=boot(null,{storage:{jobflick_bridge_jobs_v1:{[id]:{
    id,recordVersion:1,state:"succeeded",origin:"tab-original",
    orphaned:true,deliveryState:"manual_only",
    integrityIssue:"native_job_id_mismatch"
  }}}});
  const reply=await app.listeners.message({type:"jobflick:report",id},app.popupSender);
  assert.equal(reply.ok,false);
  assert.match(reply.message,/identity mismatch/i);
  assert.equal(app.requests.length,0);
  const forget=await app.listeners.message({type:"jobflick:forget",id},app.popupSender);
  assert.equal(forget.ok,true,"A user can still forget local terminal metadata");
  assert.equal(app.requests.length,0);
});

test("report response identity mismatch is quarantined without exposing content",async()=>{
  const id="job_12345678";
  const app=boot(request=>{
    if(request.action==="show")return {
      ok:true,report:"secret from unrelated job",id:"job_87654321"
    };
    return {ok:true};
  },{storage:{jobflick_bridge_jobs_v1:{[id]:{
    id,recordVersion:1,state:"succeeded",origin:"tab-original",orphaned:false
  }}}});
  const reply=await app.listeners.message({type:"jobflick:report",id},app.popupSender);
  assert.equal(reply.ok,false);
  assert.equal(reply.report,undefined);
  assert.equal(app.storage.jobflick_bridge_jobs_v1[id].integrityIssue,
    "native_job_id_mismatch");
  assert.equal(app.storage.jobflick_bridge_jobs_v1[id].orphaned,true);
  const again=await app.listeners.message({type:"jobflick:report",id},app.popupSender);
  assert.equal(again.ok,false);
  assert.equal(app.requests.filter(x=>x.action==="show").length,1);
});

test("report response conflicting origin is quarantined without export",async()=>{
  const id="job_12345678";
  const app=boot(request=>{
    if(request.action==="show")return {
      ok:true,report:"other-origin",job:{
        id,origin_tab_id:"tab-foreign"
      }
    };
    return {ok:true};
  },{storage:{jobflick_bridge_jobs_v1:{[id]:{
    id,recordVersion:1,state:"succeeded",origin:"tab-original",orphaned:false
  }}}});
  const reply=await app.listeners.message({type:"jobflick:report",id},app.popupSender);
  assert.equal(reply.ok,false);
  assert.equal(reply.report,undefined);
  assert.equal(app.storage.jobflick_bridge_jobs_v1[id].integrityIssue,
    "native_origin_mismatch");
});
