"use strict";

// Firefox MV3 background event script. Source of truth: Jobflick's native host.
const HOST = "io.github.sguzman.jobflick";
const KEY = "jobflick_bridge_jobs_v1";
const ALARM = "jobflick_bridge_pending_v1";
const MAX_YAML_BYTES = 262144;
const FINISHED = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const SITES = new Set(["chatgpt.com", "chat.openai.com"]);

let serializedWrite = Promise.resolve();
let checking = false;

function canonical(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || !SITES.has(u.hostname) ||
        u.port || u.username || u.password) return null;
    // Homepage cannot be a durable conversation destination.
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return path === "/" ? null : u.origin + path;
  } catch {
    return null;
  }
}

function validYaml(yaml) {
  return typeof yaml === "string" &&
    yaml.length > 0 && yaml.length <= MAX_YAML_BYTES &&
    new TextEncoder().encode(yaml).byteLength <= MAX_YAML_BYTES;
}

async function native(request) {
  const reply = await browser.runtime.sendNativeMessage(HOST, request);
  if (!reply || typeof reply.ok !== "boolean") {
    throw new Error("Malformed native host response");
  }
  return reply;
}

async function saved() {
  const state = await browser.storage.local.get(KEY);
  return state[KEY] && typeof state[KEY] === "object" ? state[KEY] : {};
}

async function refreshAlarm(jobs) {
  const hasPending = Object.values(jobs).some(record =>
    !FINISHED.has(record.state) && record.state !== "unknown");
  if (hasPending) {
    await browser.alarms.create(ALARM, { periodInMinutes: 1 });
  } else {
    await browser.alarms.clear(ALARM);
  }
}

async function mutate(change) {
  serializedWrite = serializedWrite.catch(() => {}).then(async () => {
    const jobs = await saved();
    await change(jobs);
    await browser.storage.local.set({ [KEY]: jobs });
    await refreshAlarm(jobs);
  });
  return serializedWrite;
}

async function originFor(tabId) {
  const key = "jobflick_origin_" + tabId;
  const result = await browser.storage.session.get(key);
  if (typeof result[key] === "string") return result[key];
  const token = "tab-" + crypto.randomUUID();
  await browser.storage.session.set({ [key]: token });
  return token;
}

async function trustedTab(tabId, expectedUrl, token) {
  if (!Number.isInteger(tabId) || !expectedUrl || !token) return null;
  const key = "jobflick_origin_" + tabId;
  const current = await browser.storage.session.get(key);
  if (current[key] !== token) return null;
  try {
    const tab = await browser.tabs.get(tabId);
    return canonical(tab.url) === expectedUrl ? tab : null;
  } catch {
    return null;
  }
}

async function checkJobs() {
  if (checking) return;
  checking = true;
  try {
    await serializedWrite;
    for (const [id, record] of Object.entries(await saved())) {
      if (FINISHED.has(record.state) || record.state === "unknown") continue;
      try {
        const status = await native({ action: "inspect", id });
        if (!status.ok || !status.job || typeof status.job.state !== "string") continue;
        const state = status.job.state;
        if (!["queued", "running", ...FINISHED].includes(state)) continue;
        let report = null;
        if (FINISHED.has(state)) {
          const response = await native({ action: "show", id });
          if (response.ok && typeof response.report === "string") {
            report = response.report;
          }
        }
        await mutate(jobs => {
          if (!jobs[id]) return;
          jobs[id].state = state;
          jobs[id].name = typeof status.job.name === "string" ? status.job.name : jobs[id].name;
          jobs[id].color = typeof status.job.color === "string" ? status.job.color : jobs[id].color;
          if (report !== null) jobs[id].report = report;
        });
        const tab = await trustedTab(record.tabId, record.conversation, record.origin);
        if (!tab) {
          await mutate(jobs => { if (jobs[id]) jobs[id].orphaned = true; });
          continue;
        }
        await browser.tabs.sendMessage(record.tabId, {
          type: "jobflick:status", jobId: id, state, name: status.job.name || "",
          color: status.job.color || ""
        }).catch(() => {});
        // Intentionally NO automated ChatGPT composer injection in this stage.
        // Real attachment + send must pass explicit FDE acceptance first.
      } catch {
        // Report remains in Jobflick. A failed check is not an instruction to
        // submit (or resubmit) another job.
      }
    }
  } finally {
    checking = false;
  }
}

async function onBridgeMessage(message, sender) {
  const url = canonical(sender?.url);
  const tabUrl = canonical(sender?.tab?.url);
  if (!url || url !== tabUrl || !Number.isInteger(sender.tab?.id)) {
    return { ok: false, message: "Unauthorized or stale ChatGPT tab" };
  }
  if (!message || !["jobflick:validate", "jobflick:submit"].includes(message.type) ||
      !validYaml(message.yaml)) {
    return { ok: false, message: "Invalid or oversized Execarium document" };
  }
  if (message.type === "jobflick:validate") {
    return native({ action: "validate_spec", spec_yaml: message.yaml });
  }
  // The trusted DOM click is checked in the content script. The extension
  // background does not take authorizations from the page's JS context.
  const origin = await originFor(sender.tab.id);
  const result = await native({
    action: "submit_spec", spec_yaml: message.yaml, origin_tab_id: origin
  });
  if (!result.ok) return result;
  const id = result.job?.id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
    throw new Error("Submission uncertain; inspect Jobflick before retrying");
  }
  await mutate(jobs => {
    jobs[id] = {
      id, tabId: sender.tab.id, origin, conversation: url,
      state: result.job.state || "queued", name: result.job.name || "",
      color: result.job.color || "", orphaned: false, report: null,
      submittedAt: Date.now()
    };
  });
  void checkJobs();
  return result;
}

browser.runtime.onMessage.addListener((message, sender) =>
  onBridgeMessage(message, sender).catch(error => ({
    ok: false,
    message: String(error?.message || error) +
      (message?.type === "jobflick:submit" ?
        "; submission may have succeeded; inspect the Jobflick inbox before trying again" : "")
  }))
);
browser.action.onClicked.addListener(tab => {
  if (Number.isInteger(tab.id)) {
    void browser.tabs.sendMessage(tab.id, { type: "jobflick:scan" }).catch(() => {});
  }
});
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) void checkJobs();
});
browser.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === "complete" || change.url) void checkJobs();
});
browser.tabs.onRemoved.addListener(id => {
  void browser.storage.session.remove("jobflick_origin_" + id);
  // Keep job data; do not interpret a recycled numeric tab ID as its origin.
  void mutate(jobs => {
    for (const record of Object.values(jobs)) {
      if (record.tabId === id) record.orphaned = true;
    }
  });
});
browser.runtime.onStartup.addListener(() => { void checkJobs(); });
browser.runtime.onInstalled.addListener(() => { void checkJobs(); });
