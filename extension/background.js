"use strict";

// Firefox MV3 background event script. Source of truth: Jobflick's native host.
const HOST = "io.github.sguzman.jobflick";
const KEY = "jobflick_bridge_jobs_v1";
const ALARM = "jobflick_bridge_pending_v1";
const MAX_YAML_BYTES = 262144;
const MAX_STATUS_PER_POLL = 24;
const FAST_RECHECK_LIMIT = 6;
const FAST_RECHECK_DELAY_MS = 1200;
const FAST_RECHECK_BATCH = 4;
const MAX_FAST_RECHECK_JOBS = 32;
const FINISHED = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const SITES = new Set(["chatgpt.com", "chat.openai.com"]);

let serializedWrite = Promise.resolve();
let checking = null;
const fastRechecks = new Map();
let fastRecheckTimer = null;
const originFlights = new Map();
const cancelFlights = new Set();
const RECORD_VERSION = 1;
const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
const MAX_NAME_CHARS = 160;
const boundedName = value => typeof value === "string" ?
  value.slice(0, MAX_NAME_CHARS) : "";
const boundedColor = value => typeof value === "string" &&
  /^#[0-9a-f]{6}$/i.test(value) ? value : "";

// Native IDs are dynamic keys in a plain storage object. In addition to the
// wire format, reject reserved/inherited keys such as "__proto__" and
// "constructor" so a malformed native reply can never mutate that object's
// prototype or collide with an inherited member.
function validJobId(id) {
  return typeof id === "string" && JOB_ID_PATTERN.test(id) &&
    id !== "prototype" &&
    !Object.prototype.hasOwnProperty.call(Object.prototype, id);
}

// Optional fields from older hosts may be absent, but if a native host
// *supplies* identity metadata it must match exactly. Reject malformed types
// and null as contradictions rather than treating them as omissions.
function contradictsIdentity(object, field, expected) {
  return object && typeof object === "object" &&
    Object.prototype.hasOwnProperty.call(object, field) &&
    object[field] !== expected;
}

// Existing unversioned records from the Firefox pilot are v1-compatible.
// Future unsupported records are kept untouched, not guessed or discarded.
const knownRecord = record => record && typeof record === "object" &&
  (record.recordVersion === undefined || record.recordVersion === RECORD_VERSION);
// A local storage map's key is the authority for native lookups. If an
// imported, corrupted or future record claims another ID, never expose it
// through the popup, poll it, or use it as an origin for report routing.
const matchedRecord = (id, record) =>
  validJobId(id) && knownRecord(record) && record.id === id;

// Retain only non-sensitive identity fields across asynchronous native/DOM
// operations. A record may be forgotten, quarantined, or replaced while a
// response is in flight. Never use a stale snapshot to authorize output.
function recordIdentity(record) {
  return {
    origin: record.origin, tabId: record.tabId,
    conversation: record.conversation, submittedAt: record.submittedAt
  };
}
function sameIdentity(id, record, identity) {
  return matchedRecord(id, record) &&
    record.origin === identity.origin &&
    record.tabId === identity.tabId &&
    record.conversation === identity.conversation &&
    record.submittedAt === identity.submittedAt;
}

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
  const hasPending = Object.entries(jobs).some(([id, record]) =>
    matchedRecord(id, record) && !record.integrityIssue &&
    !FINISHED.has(record.state) && record.state !== "unknown");
  if (hasPending) {
    // Recreating an existing alarm on every metadata write moves its next
    // deadline. A busy or rapidly changing inbox must not indefinitely
    // postpone the durable once-per-minute status check.
    if (!await browser.alarms.get(ALARM)) {
      await browser.alarms.create(ALARM, { periodInMinutes: 1 });
    }
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
  const records = Object.entries(await saved());
  const orphanIds = [];
  for (const [id, record] of records) {
    if (!matchedRecord(id, record) || record.orphaned) continue;
    try {
      const tab = await trustedTab(record.tabId, record.conversation, record.origin);
      if (!tab) orphanIds.push([id, recordIdentity(record)]);
    } catch {
      orphanIds.push([id, recordIdentity(record)]);
    }
  }
  if (orphanIds.length) {
    await mutate(jobs => {
      for (const [id, identity] of orphanIds) {
        // Reconciliation runs asynchronously across browser startup. A job
        // ID can have been replaced or quarantined since the tab probe.
        if (sameIdentity(id, jobs[id], identity) &&
            !jobs[id].orphaned && !jobs[id].integrityIssue) {
          jobs[id].orphaned = true;
          jobs[id].deliveryState = "manual_only";
        }
      }
    });
  }
}

async function checkJobs(onlyId = null) {
  // Multiple callers (alarms, tab updates and popup Refresh) share one
  // in-flight inspection. Refresh never claims completion prematurely.
  // An existing full refresh might be inspecting other jobs. A targeted
  // burst check must not be counted as consumed merely because it waited for
  // that shared operation to finish.
  if (checking) {
    await checking;
    return false;
  }
  let release;
  checking = new Promise(resolve => { release = resolve; });
  try {
    await serializedWrite;
    // Bounded polling: a busy developer with many chats must not launch an
    // unbounded number of short-lived native host processes at each alarm.
    // Oldest-checked-first ordering rotates fairly through pending jobs.
    const pending = Object.entries(await saved())
      .filter(([id, record]) => (onlyId === null || id === onlyId) &&
        matchedRecord(id, record) && !record.integrityIssue &&
        !FINISHED.has(record.state) && record.state !== "unknown")
      .sort((a, b) => (a[1].lastCheckedAt || 0) - (b[1].lastCheckedAt || 0))
      .slice(0, MAX_STATUS_PER_POLL);
    // Idle event-page wakes and unrelated tab completions remain read-only.
    if (!pending.length) return true;
    // Record attempts even if the native host is temporarily unavailable;
    // otherwise one broken record can starve later jobs indefinitely.
    const checkedAt = Date.now();
    await mutate(jobs => {
      for (const [id, record] of pending) {
        if (sameIdentity(id, jobs[id], recordIdentity(record)) &&
            !jobs[id].integrityIssue) {
          jobs[id].lastCheckedAt = checkedAt;
        }
      }
    });
    for (const [id, record] of pending) {
      if (FINISHED.has(record.state) || record.state === "unknown") continue;
      try {
        const status = await native({ action: "inspect", id });
        if (!status.ok || !status.job || typeof status.job.state !== "string") continue;
        const state = status.job.state;
        if (!["queued", "running", ...FINISHED].includes(state)) continue;
        // A native response for a different Jobflick job must never mutate
        // this record. Conflicting origin tokens have the same severity.
        // Quarantine once to avoid repeatedly polling corrupted identity.
        // Older hosts omitting these optional fields remain supported.
        const wrongId = contradictsIdentity(status, "id", id) ||
          contradictsIdentity(status.job, "id", id);
        const wrongOrigin = contradictsIdentity(
          status, "origin_tab_id", record.origin) ||
          contradictsIdentity(status.job, "origin_tab_id", record.origin);
        if (wrongId || wrongOrigin) {
          await mutate(jobs => {
            if (sameIdentity(id, jobs[id], recordIdentity(record)) &&
                !jobs[id].integrityIssue) {
              jobs[id].orphaned = true;
              jobs[id].deliveryState = "manual_only";
              jobs[id].integrityIssue = wrongId
                ? "native_job_id_mismatch" : "native_origin_mismatch";
            }
          });
          continue;
        }
        // A long-running job often reports the same state for hours. The
        // poll's batched lastCheckedAt write is sufficient in that case:
        // avoid rewriting the entire stored inbox and notifying the tab on
        // every identical native result.
        const name = typeof status.job.name === "string" ?
          boundedName(status.job.name) : boundedName(record.name);
        const color = typeof status.job.color === "string" ?
          boundedColor(status.job.color) : boundedColor(record.color);
        const changed = state !== record.state ||
          name !== record.name || color !== record.color;
        if (changed) {
          await mutate(jobs => {
            if (!sameIdentity(id, jobs[id], recordIdentity(record)) ||
                jobs[id].integrityIssue) return;
            jobs[id].state = state;
            if (FINISHED.has(state) && !jobs[id].orphaned) {
              jobs[id].deliveryState = "report_pending_manual_delivery";
            }
            jobs[id].name = name;
            jobs[id].color = color;
          });
        }
        // A user can Forget a terminal record, or an independent request
        // can quarantine it, while native inspect is still pending. Do not
        // send any status to a stale UI owner or resurrect a removed record.
        await serializedWrite;
        const latest = (await saved())[id];
        if (!sameIdentity(id, latest, recordIdentity(record)) ||
            latest.integrityIssue) continue;
        // Once an origin is lost, do not silently reattach this record
        // even when the user later navigates to a matching conversation.
        const tab = latest.orphaned ? null
          : await trustedTab(latest.tabId, latest.conversation, latest.origin);
        if (!tab) {
          if (!latest.orphaned) {
            await mutate(jobs => {
              if (sameIdentity(id, jobs[id], recordIdentity(record)) &&
                  !jobs[id].orphaned) {
                jobs[id].orphaned = true;
                jobs[id].deliveryState = "manual_only";
              }
            });
          }
          continue;
        }
        if (changed) {
          await browser.tabs.sendMessage(latest.tabId, {
            type: "jobflick:status", jobId: id, state,
            name: name || "", color: color || ""
          }).catch(() => {});
        }
        // No automatic delivery. A finished report stays durable in Jobflick until an
        // authorized user retrieves it; never store potentially large logs here.
        // Intentionally NO automated ChatGPT composer injection in this stage.
        // Real attachment + send must pass explicit FDE acceptance first.
      } catch {
        // Report remains in Jobflick. A failed check is not an instruction to
        // submit (or resubmit) another job.
      }
    }
    return true;
  } finally {
    release();
    checking = null;
  }
}

// Short-lived post-submit checks improve completion latency for quick jobs.
// A single timer batches at most four job IDs, with six attempts each.
// Firefox may suspend an event page at any time; durable alarms remain the
// recovery path. With no submitted jobs there is no timer or CPU wakeup.
function requestFastRecheck(id) {
  if (typeof setTimeout !== "function") return;
  // Native status alarms cover excess bursts. Never retain an unbounded
  // timer worklist even if many conversations are submitted rapidly.
  if (!fastRechecks.has(id) && fastRechecks.size >= MAX_FAST_RECHECK_JOBS) return;
  fastRechecks.set(id, FAST_RECHECK_LIMIT);
  if (fastRecheckTimer === null) {
    fastRecheckTimer = setTimeout(drainFastRechecks, FAST_RECHECK_DELAY_MS);
  }
}

async function drainFastRechecks() {
  fastRecheckTimer = null;
  const batch = [...fastRechecks.keys()].slice(0, FAST_RECHECK_BATCH);
  for (const id of batch) {
    const remaining = fastRechecks.get(id);
    if (!remaining) continue;
    try {
      const inspected = await checkJobs(id);
      const record = (await saved())[id];
      if (!matchedRecord(id, record) || record.integrityIssue ||
          FINISHED.has(record.state) || record.state === "unknown") {
        fastRechecks.delete(id);
      } else if (inspected) {
        fastRechecks.set(id, remaining - 1);
      }
      // A coalesced check does not use up this job's attempt budget.
    } catch {
      // A failed browser storage operation must not turn an otherwise
      // six-attempt fast path into an infinite 1.2-second timer loop.
      // The durable minute alarm handles future reconciliation; no resubmit.
      fastRechecks.set(id, remaining - 1);
    }
    if (fastRechecks.get(id) === 0) fastRechecks.delete(id);
  }
  if (fastRechecks.size && fastRecheckTimer === null) {
    fastRecheckTimer = setTimeout(drainFastRechecks, FAST_RECHECK_DELAY_MS);
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
  if (!validJobId(id)) {
    throw new Error("Submission uncertain; inspect Jobflick before retrying");
  }
  if (contradictsIdentity(result, "origin_tab_id", origin) ||
      contradictsIdentity(result.job, "origin_tab_id", origin)) {
    // The command may already be queued. Do not bind its report to a
    // contradictory native origin or attempt a new submission.
    throw new Error("Native job origin did not match this Firefox tab; inspect Jobflick");
  }
  // A native host can take long enough that the user leaves this chat
  // after the last pre-submit check. Never record such a job as eligible for
  // automatic delivery, even though Jobflick accepted the command.
  await mutate(async jobs => {
    // A duplicate ID would otherwise silently replace an older result's
    // provenance. The native submit may have succeeded, so fail closed and
    // require inspecting Jobflick rather than ever resubmitting.
    if (Object.prototype.hasOwnProperty.call(jobs, id)) {
      throw new Error("Native returned an existing job ID; inspect Jobflick. Earlier routing metadata is preserved");
    }
    const stillOriginal = await trustedTab(sender.tab.id, url, origin);
    const orphaned = !stillOriginal;
    jobs[id] = {
      id, recordVersion: RECORD_VERSION,
      tabId: sender.tab.id, origin, conversation: url,
      state: result.job.state || "queued", name: boundedName(result.job.name),
      color: boundedColor(result.job.color), orphaned,
      deliveryState: orphaned ? "manual_only" : FINISHED.has(result.job.state)
        ? "report_pending_manual_delivery" : "awaiting_completion",
      submittedAt: Date.now()
    };
  });
  void checkJobs();
  requestFastRecheck(id);
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
      // The full saved inbox is durable. Display only a bounded page, but
      // let the user access older records instead of silently hiding them.
      const offset = message.offset === undefined ? 0 : message.offset;
      const limit = message.limit === undefined ? 40 : message.limit;
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000 ||
          !Number.isInteger(limit) || limit < 1 || limit > 50) {
        return { ok: false, message: "Invalid inbox page request" };
      }
      const query = message.query === undefined ? "" : message.query;
      if (typeof query !== "string" || query.length > 128) {
        return { ok: false, message: "Invalid inbox search" };
      }
      const search = query.trim().toLocaleLowerCase();
      const items = Object.entries(jobs).filter(([id, item]) =>
        matchedRecord(id, item) &&
        (!search || [item.id, boundedName(item.name), item.state]
          .some(value => String(value || "").toLocaleLowerCase().includes(search))))
        .map(([, item]) => ({
          id: item.id,
          name: boundedName(item.name),
          state: typeof item.state === "string" &&
            ["queued", "running", ...FINISHED].includes(item.state)
            ? item.state : "unknown",
          color: boundedColor(item.color),
          conversation: canonical(item.conversation) || "",
          orphaned: !!item.orphaned,
          submittedAt: item.submittedAt || 0,
          cancelRequested: !!item.cancelRequestedAt,
          integrityIssue: typeof item.integrityIssue === "string" ?
            item.integrityIssue : "",
          deliveryState: item.deliveryState ||
            (item.orphaned ? "manual_only" :
              FINISHED.has(item.state) ? "report_pending_manual_delivery" :
                "awaiting_completion")
        })).sort((a, b) =>
          (b.submittedAt - a.submittedAt) || b.id.localeCompare(a.id));
      const page = items.slice(offset, offset + limit);
      return {
        ok: true, jobs: page, hasMore: offset + limit < items.length,
        nextOffset: offset + page.length
      };
    }
    case "jobflick:preflight": {
      const id = message.id;
      if (!validJobId(id)) {
        return { ok: false, message: "Invalid job ID" };
      }
      const record = (await saved())[id];
      if (!matchedRecord(id, record) || !FINISHED.has(record.state) ||
          record.orphaned || record.integrityIssue) {
        return { ok: false, message: "This job has no verified active original conversation" };
      }
      const identity = recordIdentity(record);
      const tab = await trustedTab(record.tabId, record.conversation, record.origin);
      if (!tab) {
        await mutate(jobs => {
          if (sameIdentity(id, jobs[id], identity)) {
            jobs[id].orphaned = true;
            jobs[id].deliveryState = "manual_only";
          }
        });
        return { ok: false, message: "Original tab changed or closed; use manual report delivery" };
      }
      const response = await browser.tabs.sendMessage(record.tabId, {
        type: "jobflick:probe-upload"
      });
      if (!response || response.ok !== true ||
          typeof response.composerPresent !== "boolean" ||
          typeof response.fileInputPresent !== "boolean" ||
          typeof response.composerOccupied !== "boolean") {
        return { ok: false, message: "Unrecognized composer probe response" };
      }
      // The page may navigate between the first identity check and its
      // asynchronous response. Reverify before claiming any destination.
      if (!await trustedTab(record.tabId, record.conversation, record.origin)) {
        await mutate(jobs => {
          if (sameIdentity(id, jobs[id], identity)) {
            jobs[id].orphaned = true;
            jobs[id].deliveryState = "manual_only";
          }
        });
        return { ok: false, message: "Original chat navigated during inspection; use manual report delivery" };
      }
      // The original local authorization might have been forgotten or
      // quarantined during the composer probe, even if the URL still matches.
      // Never issue a stale "verified" result on that earlier snapshot.
      await serializedWrite;
      const latest = (await saved())[id];
      if (!sameIdentity(id, latest, identity) ||
          !FINISHED.has(latest.state) || latest.orphaned || latest.integrityIssue) {
        return { ok: false, message: "Original chat record changed during inspection; use manual recovery" };
      }
      // No report payload, draft text, file names, DOM edits or Send action.
      // Flags alone never imply an attachment can safely be inserted.
      return {
        ok: true, originalConversationVerified: true,
        composerPresent: response.composerPresent,
        composerOccupied: response.composerOccupied,
        fileInputPresent: response.fileInputPresent,
        composerAmbiguous: typeof response.composerAmbiguous === "boolean"
          ? response.composerAmbiguous : null,
        fileInputAmbiguous: typeof response.fileInputAmbiguous === "boolean"
          ? response.fileInputAmbiguous : null,
        selectedFilePresent: typeof response.selectedFilePresent === "boolean"
          ? response.selectedFilePresent : null
      };
    }
    case "jobflick:probe-upload": {
      const active = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = active[0];
      const expected = canonical(tab?.url);
      if (!tab || !Number.isInteger(tab.id) || !expected) {
        return { ok: false, message: "Open an existing ChatGPT conversation to inspect its composer" };
      }
      const response = await browser.tabs.sendMessage(tab.id, { type: "jobflick:probe-upload" });
      if (!response || response.ok !== true ||
          typeof response.composerPresent !== "boolean" ||
          typeof response.fileInputPresent !== "boolean" ||
          typeof response.composerOccupied !== "boolean") {
        return { ok: false, message: "No supported ChatGPT composer inspection response" };
      }
      // A popup is not bound to a tab. If the user switches tabs or a SPA
      // route changes while the read-only probe is pending, do not present
      // stale composer flags as observations of the current conversation.
      const current = await browser.tabs.get(tab.id).catch(() => null);
      const stillActive = await browser.tabs.query({ active: true, currentWindow: true });
      if (canonical(current?.url) !== expected || stillActive[0]?.id !== tab.id) {
        return { ok: false, message: "Active conversation changed during inspection; retry read-only check" };
      }
      // Report presence flags only, never the draft or attached file names.
      return {
        ok: true,
        composerPresent: response.composerPresent,
        composerOccupied: response.composerOccupied,
        fileInputPresent: response.fileInputPresent,
        composerAmbiguous: typeof response.composerAmbiguous === "boolean"
          ? response.composerAmbiguous : null,
        fileInputAmbiguous: typeof response.fileInputAmbiguous === "boolean"
          ? response.fileInputAmbiguous : null,
        selectedFilePresent: typeof response.selectedFilePresent === "boolean"
          ? response.selectedFilePresent : null
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
      const expected = canonical(tab?.url);
      if (!tab || !Number.isInteger(tab.id) || !expected) {
        return { ok: false, message: "Open a ChatGPT conversation to scan" };
      }
      const current = await browser.tabs.get(tab.id).catch(() => null);
      if (canonical(current?.url) !== expected) {
        return { ok: false, message: "Conversation changed before scan" };
      }
      const reply = await browser.tabs.sendMessage(tab.id, { type: "jobflick:scan" });
      const after = await browser.tabs.get(tab.id).catch(() => null);
      if (canonical(after?.url) !== expected || reply?.ok !== true) {
        return { ok: false, message: "Conversation changed during scan" };
      }
      return { ok: true };
    }
    case "jobflick:cancel": {
      const id = message.id;
      if (!validJobId(id)) {
        return { ok: false, message: "Invalid job ID" };
      }
      const current = (await saved())[id];
      if (!matchedRecord(id, current) || current.integrityIssue ||
          !["queued", "running"].includes(current.state)) {
        return { ok: false, message: "Only queued or running jobs can be stopped" };
      }
      if (current.cancelRequestedAt || cancelFlights.has(id)) {
        return { ok: false, message: "Stop already requested; check Jobflick before another attempt" };
      }
      // An explicit popup confirmation is required. A successful native
      // acknowledgement means the request was accepted, NOT that a running
      // process definitely stopped before completion. Never auto-retry.
      const identity = recordIdentity(current);
      cancelFlights.add(id);
      try {
        const response = await native({ action: "cancel", id });
        if (!response.ok) {
          return { ok: false, message: response.message || "Jobflick did not accept the stop request" };
        }
        let recorded = false;
        await mutate(jobs => {
          if (sameIdentity(id, jobs[id], identity) &&
              !jobs[id].integrityIssue &&
              ["queued", "running"].includes(jobs[id].state) &&
              !jobs[id].cancelRequestedAt) {
            jobs[id].cancelRequestedAt = Date.now();
            recorded = true;
          }
        });
        if (!recorded) {
          // The native host already accepted the request. Do not retry it,
          // and do not mark an unrelated replacement record as cancelled.
          return { ok: false, message: "Stop accepted by Jobflick, but the browser record changed; inspect Jobflick for final status" };
        }
        return { ok: true, message: "Stop request accepted; final state is not yet confirmed" };
      } finally {
        cancelFlights.delete(id);
      }
    }
    case "jobflick:forget": {
      const id = message.id;
      if (!validJobId(id)) {
        return { ok: false, message: "Invalid job ID" };
      }
      const current = (await saved())[id];
      if (!matchedRecord(id, current) || !FINISHED.has(current.state)) {
        return { ok: false, message: "Only finished bridge records may be forgotten" };
      }
      // Forget only the extension's routing metadata. A concurrent native
      // reconciliation may replace the same ID while this request waits for
      // the serialized writer. Never delete that replacement.
      const identity = recordIdentity(current);
      let forgotten = false;
      await mutate(jobs => {
        if (sameIdentity(id, jobs[id], identity) &&
            FINISHED.has(jobs[id].state)) {
          delete jobs[id];
          forgotten = true;
        }
      });
      return forgotten ? { ok: true } :
        { ok: false, message: "Bridge record changed before Forget; refresh the inbox" };
    }
    case "jobflick:report": {
      const id = message.id;
      if (!validJobId(id)) {
        return { ok: false, message: "Invalid job ID" };
      }
      const record = (await saved())[id];
      if (!matchedRecord(id, record) || !FINISHED.has(record.state)) {
        return { ok: false, message: "The job is unknown or not finished" };
      }
      if (record.integrityIssue) {
        return { ok: false, message: "Native identity mismatch; recover this report directly in Jobflick" };
      }
      const identity = recordIdentity(record);
      const response = await native({ action: "show", id });
      // A user may Forget this bridge record, or another inspection may
      // quarantine it, while the native process is responding. A report
      // cannot outlive that authorization. Orphaning alone is allowed:
      // explicit manual download is intentionally the recovery fallback.
      await serializedWrite;
      const latest = (await saved())[id];
      if (!sameIdentity(id, latest, identity) ||
          !FINISHED.has(latest.state) || latest.integrityIssue) {
        return { ok: false, message: "Bridge record changed during report retrieval; recover directly in Jobflick" };
      }
      // A host's optional response metadata may reveal a different record.
      // Once this happens never continue exposing reports through the
      // extension, even when the local job previously finished.
      const wrongJobId = contradictsIdentity(response, "id", id) ||
        contradictsIdentity(response.job, "id", id);
      const wrongOrigin = contradictsIdentity(
        response, "origin_tab_id", record.origin) ||
        contradictsIdentity(response.job, "origin_tab_id", record.origin);
      if (wrongJobId || wrongOrigin) {
        await mutate(jobs => {
          if (!sameIdentity(id, jobs[id], identity)) return;
          jobs[id].orphaned = true;
          jobs[id].deliveryState = "manual_only";
          jobs[id].integrityIssue = wrongJobId
            ? "native_job_id_mismatch" : "native_origin_mismatch";
        });
        return { ok: false, message: "Native report identity mismatch; recover directly in Jobflick" };
      }
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
    ["jobflick:inbox", "jobflick:refresh", "jobflick:scan", "jobflick:report", "jobflick:forget", "jobflick:cancel", "jobflick:diagnose", "jobflick:probe-upload", "jobflick:preflight"].includes(message.type);
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
// SPA conversation navigation must revoke an old result's delivery identity,
// even if the same numeric tab later returns to its former URL. A normal
// reload of the SAME canonical route does not revoke its origin.
async function reconcileTabRoute(tabId, nextUrl) {
  if (!Number.isInteger(tabId)) return;
  const next = canonical(nextUrl);
  await serializedWrite;
  const before = Object.entries(await saved());
  // Unrecognized/mismatched stored IDs never count as valid owners of a
  // tab's session token or influence its navigation lifecycle.
  if (before.some(([id, record]) => matchedRecord(id, record) &&
      record.tabId === tabId && !record.orphaned &&
      record.conversation !== next)) {
    await mutate(jobs => {
      for (const [id, record] of Object.entries(jobs)) {
        if (!matchedRecord(id, record) ||
            record.tabId !== tabId || record.orphaned) continue;
        if (record.conversation !== next) {
          record.orphaned = true;
          record.deliveryState = "manual_only";
        }
      }
    });
  }
  // A new chat in this tab must receive a fresh token. Do not remove the
  // identity while a record for the SAME conversation is still valid.
  const records = Object.entries(await saved());
  if (!records.some(([id, record]) => matchedRecord(id, record) &&
      record.tabId === tabId && !record.orphaned &&
      record.conversation === next)) {
    // A previous conversation may still be minting its tab token. Clear
    // session identity *after* that in-flight write, just like tab closure,
    // or a late session.set can resurrect a revoked browser origin.
    const flight = originFlights.get(tabId);
    if (flight) await flight.catch(() => {});
    await browser.storage.session.remove("jobflick_origin_" + tabId);
  }
}

browser.tabs.onUpdated.addListener((id, change, tab) => {
  if (typeof change.url === "string") {
    void reconcileTabRoute(id, change.url)
      .then(() => canonical(change.url) ? checkJobs() : null).catch(() => {});
  } else if (change.status === "complete" && canonical(tab?.url)) {
    // Unrelated sites aren't Jobflick activity. Native alarm/startup paths
    // still reconcile unfinished jobs while Firefox is browsing elsewhere.
    void checkJobs();
  }
});
// ChatGPT changes conversations with the History API without a full reload.
// Observe only top-level route changes on the already-authorized hosts.
browser.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0 || !Number.isInteger(details.tabId)) return;
  void reconcileTabRoute(details.tabId, details.url)
    .then(() => checkJobs()).catch(() => {});
}, { url: [{ hostEquals: "chatgpt.com" }, { hostEquals: "chat.openai.com" }] });

browser.tabs.onRemoved.addListener(id => {
  // A tab may close while originFor() is still writing the session token.
  // Clear it *after* that write finishes, so a delayed session.set cannot
  // revive the identity of a closed/recycled numeric tab ID.
  void (async () => {
    const flight = originFlights.get(id);
    if (flight) await flight.catch(() => {});
    await browser.storage.session.remove("jobflick_origin_" + id);
  })().catch(() => {});
  // Closing an unrelated Firefox tab must not rewrite the entire stored
  // inbox. Existing records stay durable, but lose delivery eligibility.
  void (async () => {
    await serializedWrite;
    const records = Object.entries(await saved());
    if (!records.some(([jobId, record]) => matchedRecord(jobId, record) &&
        record.tabId === id && !record.orphaned)) return;
    await mutate(jobs => {
      for (const [jobId, record] of Object.entries(jobs)) {
        if (matchedRecord(jobId, record) && record.tabId === id) {
          record.orphaned = true;
          record.deliveryState = "manual_only";
        }
      }
    });
  })().catch(() => {});
});
browser.runtime.onStartup.addListener(() => {
  void reconcileOrigins().then(() => checkJobs()).catch(() => {});
});
browser.runtime.onInstalled.addListener(() => {
  void reconcileOrigins().then(() => checkJobs()).catch(() => {});
});
