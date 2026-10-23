"use strict";

// Firefox MV3 background event script. Source of truth: Jobflick's native host.
const HOST = "io.github.sguzman.jobflick";
const KEY = "jobflick_bridge_jobs_v1";
const ALARM = "jobflick_bridge_pending_v1";
const MAX_YAML_BYTES = 262144;
const MAX_STATUS_PER_POLL = 24;
const FINISHED = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const SITES = new Set(["chatgpt.com", "chat.openai.com"]);

let serializedWrite = Promise.resolve();
let checking = null;
const originFlights = new Map();
const cancelFlights = new Set();
const RECORD_VERSION = 1;

// Existing unversioned records from the Firefox pilot are v1-compatible.
// Future unsupported records are kept untouched, not guessed or discarded.
const knownRecord = record => record && typeof record === "object" &&
  (record.recordVersion === undefined || record.recordVersion === RECORD_VERSION);

function canonical(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || !SITES.has(u.hostname) ||
        u.port || u.username || u.password) return null;
    // Only established conversation routes have stable destination identity.
    // Handles ordinary /c/{id}, /uc/{id} and GPT/project /g/{id}/c/{id}.
    // In particular /share, /settings, /auth and /g/{id}/project fail closed.
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const parts = path.split("/").filter(Boolean);
    const segment = value => typeof value === "string" &&
      /^[a-zA-Z0-9_-]{4,256}$/.test(value);
    const direct = parts.length === 2 &&
      (parts[0] === "c" || parts[0] === "uc") && segment(parts[1]);
    const nested = parts.length === 4 && parts[0] === "g" &&
      segment(parts[1]) && parts[2] === "c" && segment(parts[3]);
    return direct || nested ? u.origin + path : null;
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
    knownRecord(record) && !FINISHED.has(record.state) && record.state !== "unknown");
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
  // Two different visible YAML blocks can be submitted concurrently within
  // one tab. They must reuse ONE tab identity, not race to overwrite it.
  if (originFlights.has(tabId)) return originFlights.get(tabId);
  const flight = (async () => {
    const key = "jobflick_origin_" + tabId;
    const result = await browser.storage.session.get(key);
    if (typeof result[key] === "string") return result[key];
    const token = "tab-" + crypto.randomUUID();
    await browser.storage.session.set({ [key]: token });
    return token;
  })();
  originFlights.set(tabId, flight);
  try {
    return await flight;
  } finally {
    if (originFlights.get(tabId) === flight) originFlights.delete(tabId);
  }
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

// Session identity can disappear on full browser restart. Reconcile even
// FINISHED records, which the ordinary pending-job poll intentionally skips.
// Never infer that a restored numeric tab ID belongs to an old conversation.
async function reconcileOrigins() {
  await serializedWrite;
  const records = Object.values(await saved());
  const orphanIds = [];
  for (const record of records) {
    if (!knownRecord(record) || record.orphaned || typeof record.id !== "string") continue;
    try {
      const tab = await trustedTab(record.tabId, record.conversation, record.origin);
      if (!tab) orphanIds.push(record.id);
    } catch {
      orphanIds.push(record.id);
    }
  }
  if (orphanIds.length) {
    await mutate(jobs => {
      for (const id of orphanIds) {
        if (knownRecord(jobs[id])) {
          jobs[id].orphaned = true;
          jobs[id].deliveryState = "manual_only";
        }
      }
    });
  }
}

async function checkJobs() {
  // Multiple callers (alarms, tab updates and popup Refresh) share one
  // in-flight inspection. Refresh never claims completion prematurely.
  if (checking) return checking;
  let release;
  checking = new Promise(resolve => { release = resolve; });
  try {
    await serializedWrite;
    // Bounded polling: a busy developer with many chats must not launch an
    // unbounded number of short-lived native host processes at each alarm.
    // Oldest-checked-first ordering rotates fairly through pending jobs.
    const pending = Object.entries(await saved())
      .filter(([, record]) => knownRecord(record) && !FINISHED.has(record.state) &&
        record.state !== "unknown")
      .sort((a, b) => (a[1].lastCheckedAt || 0) - (b[1].lastCheckedAt || 0))
      .slice(0, MAX_STATUS_PER_POLL);
    // Record attempts even if the native host is temporarily unavailable;
    // otherwise one broken record can starve later jobs indefinitely.
    const checkedAt = Date.now();
    await mutate(jobs => {
      for (const [id] of pending) {
        if (jobs[id]) jobs[id].lastCheckedAt = checkedAt;
      }
    });
    for (const [id, record] of pending) {
      if (FINISHED.has(record.state) || record.state === "unknown") continue;
      try {
        const status = await native({ action: "inspect", id });
        if (!status.ok || !status.job || typeof status.job.state !== "string") continue;
        const state = status.job.state;
        if (!["queued", "running", ...FINISHED].includes(state)) continue;
        await mutate(jobs => {
          if (!jobs[id]) return;
          jobs[id].state = state;
          if (FINISHED.has(state) && !jobs[id].orphaned) {
            jobs[id].deliveryState = "report_pending_manual_delivery";
          }
          jobs[id].name = typeof status.job.name === "string" ? status.job.name : jobs[id].name;
          jobs[id].color = typeof status.job.color === "string" ? status.job.color : jobs[id].color;
        });
        // Once an origin is lost, do not silently reattach this record
        // even when the user later navigates to a matching conversation.
        const tab = record.orphaned ? null
          : await trustedTab(record.tabId, record.conversation, record.origin);
        if (!tab) {
          await mutate(jobs => { if (jobs[id]) jobs[id].orphaned = true; });
          continue;
        }
        await browser.tabs.sendMessage(record.tabId, {
          type: "jobflick:status", jobId: id, state, name: status.job.name || "",
          color: status.job.color || ""
        }).catch(() => {});
        // No automatic delivery. A finished report stays durable in Jobflick until an
        // authorized user retrieves it; never store potentially large logs here.
        // Intentionally NO automated ChatGPT composer injection in this stage.
        // Real attachment + send must pass explicit FDE acceptance first.
      } catch {
        // Report remains in Jobflick. A failed check is not an instruction to
        // submit (or resubmit) another job.
      }
    }
  } finally {
    release();
    checking = null;
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
  // Origin allocation is asynchronous. The user might have closed or
  // navigated the tab before Native Messaging starts. Reject stale work
  // rather than enqueueing against a former conversation's authorization.
  const stillHere = await trustedTab(sender.tab.id, url, origin);
  if (!stillHere) {
    return { ok: false, message: "Conversation changed before submission; nothing was queued" };
  }
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
      id, recordVersion: RECORD_VERSION,
      tabId: sender.tab.id, origin, conversation: url,
      state: result.job.state || "queued", name: result.job.name || "",
      color: result.job.color || "", orphaned: false,
      deliveryState: FINISHED.has(result.job.state)
        ? "report_pending_manual_delivery" : "awaiting_completion",
      submittedAt: Date.now()
    };
  });
  void checkJobs();
  return result;
}


// Firefox extension popup is trusted only by its own sender identity and URL.
// An arbitrary ChatGPT content script cannot call these privileged operations.
function isPopup(sender) {
  return sender?.id === browser.runtime.id &&
    !sender?.tab &&
    sender.url === browser.runtime.getURL("popup/index.html");
}

async function onPopupMessage(message, sender) {
  if (!isPopup(sender)) return { ok: false, message: "Unauthorized extension page" };
  switch (message?.type) {
    case "jobflick:inbox": {
      await serializedWrite;
      const jobs = await saved();
      const items = Object.values(jobs).filter(item =>
        knownRecord(item) && typeof item.id === "string")
        .map(item => ({
          id: item.id,
          name: item.name || "",
          state: item.state || "unknown",
          color: item.color || "",
          conversation: item.conversation || "",
          orphaned: !!item.orphaned,
          submittedAt: item.submittedAt || 0,
          cancelRequested: !!item.cancelRequestedAt,
          deliveryState: item.deliveryState ||
            (item.orphaned ? "manual_only" :
              FINISHED.has(item.state) ? "report_pending_manual_delivery" :
                "awaiting_completion")
        })).sort((a, b) => b.submittedAt - a.submittedAt).slice(0, 300);
      return { ok: true, jobs: items };
    }
    case "jobflick:probe-upload": {
      const active = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = active[0];
      if (!tab || !Number.isInteger(tab.id) || !canonical(tab.url)) {
        return { ok: false, message: "Open an existing ChatGPT conversation to inspect its composer" };
      }
      const response = await browser.tabs.sendMessage(tab.id, { type: "jobflick:probe-upload" });
      if (!response || response.ok !== true ||
          typeof response.composerPresent !== "boolean" ||
          typeof response.fileInputPresent !== "boolean" ||
          typeof response.composerOccupied !== "boolean") {
        return { ok: false, message: "No supported ChatGPT composer inspection response" };
      }
      // Report presence flags only, never the draft or attached file names.
      return {
        ok: true,
        composerPresent: response.composerPresent,
        composerOccupied: response.composerOccupied,
        fileInputPresent: response.fileInputPresent
      };
    }
    case "jobflick:diagnose": {
      // Deliberately malformed schema. Validation is read-only, and any
      // structured native response proves the installed host is reachable.
      // No submission or Fish execution is possible from this diagnostic.
      const response = await native({
        action: "validate_spec",
        spec_yaml: "invalid: not-an-execarium-document"
      });
      if (response.ok) {
        return { ok: false, message: "Native validator unexpectedly accepted an invalid document" };
      }
      return { ok: true, message: "Jobflick native host is reachable; validator rejected invalid YAML as expected" };
    }
    case "jobflick:refresh": {
      await checkJobs();
      return { ok: true };
    }
    case "jobflick:scan": {
      const active = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = active[0];
      if (!tab || !Number.isInteger(tab.id) || !canonical(tab.url)) {
        return { ok: false, message: "Open a ChatGPT conversation to scan" };
      }
      await browser.tabs.sendMessage(tab.id, { type: "jobflick:scan" });
      return { ok: true };
    }
    case "jobflick:cancel": {
      const id = message.id;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
        return { ok: false, message: "Invalid job ID" };
      }
      const current = (await saved())[id];
      if (!knownRecord(current) || !["queued", "running"].includes(current.state)) {
        return { ok: false, message: "Only queued or running jobs can be stopped" };
      }
      if (current.cancelRequestedAt || cancelFlights.has(id)) {
        return { ok: false, message: "Stop already requested; check Jobflick before another attempt" };
      }
      // An explicit popup confirmation is required. A successful native
      // acknowledgement means the request was accepted, NOT that a running
      // process definitely stopped before completion. Never auto-retry.
      cancelFlights.add(id);
      try {
        const response = await native({ action: "cancel", id });
        if (!response.ok) {
          return { ok: false, message: response.message || "Jobflick did not accept the stop request" };
        }
        await mutate(jobs => {
          if (knownRecord(jobs[id]) && !FINISHED.has(jobs[id].state)) {
            jobs[id].cancelRequestedAt = Date.now();
          }
        });
        return { ok: true, message: "Stop request accepted; final state is not yet confirmed" };
      } finally {
        cancelFlights.delete(id);
      }
    }
    case "jobflick:forget": {
      const id = message.id;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
        return { ok: false, message: "Invalid job ID" };
      }
      const current = (await saved())[id];
      if (!knownRecord(current) || !FINISHED.has(current.state)) {
        return { ok: false, message: "Only finished bridge records may be forgotten" };
      }
      // Forget only the extension's routing metadata. No native action, no
      // cancellation, no deletion of Jobflick's durable job or output.
      await mutate(jobs => { if (FINISHED.has(jobs[id]?.state)) delete jobs[id]; });
      return { ok: true };
    }
    case "jobflick:report": {
      const id = message.id;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
        return { ok: false, message: "Invalid job ID" };
      }
      const record = (await saved())[id];
      if (!knownRecord(record) || !FINISHED.has(record.state)) {
        return { ok: false, message: "The job is unknown or not finished" };
      }
      const response = await native({ action: "show", id });
      if (!response.ok || typeof response.report !== "string") {
        return { ok: false, message: "Report unavailable in Jobflick" };
      }
      // Browser messaging and Blob export are bounded independently of the
      // native host's framing limit. Full logs remain available in Jobflick.
      if (response.report.length > 524288 ||
          new TextEncoder().encode(response.report).byteLength > 524288) {
        return { ok: false, message: "Report exceeds 512 KiB; use the Jobflick inbox to access its full log" };
      }
      return { ok: true, report: response.report };
    }
    default:
      return { ok: false, message: "Unsupported popup action" };
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  const fromPopup = typeof message?.type === "string" &&
    ["jobflick:inbox", "jobflick:refresh", "jobflick:scan", "jobflick:report", "jobflick:forget", "jobflick:cancel", "jobflick:diagnose", "jobflick:probe-upload"].includes(message.type);
  return (fromPopup ? onPopupMessage(message, sender) : onBridgeMessage(message, sender))
    .catch(error => ({
      ok: false,
      message: String(error?.message || error) +
        (message?.type === "jobflick:submit" ?
          "; submission may have succeeded; inspect the Jobflick inbox before trying again" : "")
    }));
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
      if (knownRecord(record) && record.tabId === id) {
        record.orphaned = true;
        record.deliveryState = "manual_only";
      }
    }
  });
});
browser.runtime.onStartup.addListener(() => {
  void reconcileOrigins().then(() => checkJobs()).catch(() => {});
});
browser.runtime.onInstalled.addListener(() => {
  void reconcileOrigins().then(() => checkJobs()).catch(() => {});
});
