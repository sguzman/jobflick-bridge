(() => {
  "use strict";
  if (globalThis.__jobflickBridgeInitialized) return;
  globalThis.__jobflickBridgeInitialized = true;

  const MAX_YAML_BYTES = 262144;
  const MAX_DIRTY = 16;
  const MAX_VALIDATIONS = 4;
  const dirty = new Set();
  const states = new WeakMap();
  const byJob = new Map();
  // A ChatGPT SPA tab can survive thousands of jobs. Retain only a bounded
  // number of live Run controls; older status lives in Jobflick's inbox.
  const MAX_LIVE_STATUSES = 128;
  function trackJob(id, state) {
    if (!byJob.has(id) && byJob.size >= MAX_LIVE_STATUSES) {
      byJob.delete(byJob.keys().next().value);
    }
    byJob.set(id, state);
  }
  // Jobflick may complete before submit_spec's response reaches this tab.
  // Retain a small bounded status cache so early completion is not lost.
  const earlyStatus = new Map();
  const MAX_EARLY_STATUSES = 32;
  // Firefox reports History API changes even when React reuses a DOM node.
  // The epoch invalidates A->B->A round trips that URL equality alone misses.
  let navigationEpoch = 0;
  const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
  const rank = value => TERMINAL.has(value) ? 2 : value === "running" ? 1 : 0;
  // A SPA may retain the exact same code node while changing conversations.
  // Bind each validation/Run control to the pathname that was inspected.
  // Query/hash changes on the same conversation do not revoke it.
  function routeIdentity() {
    const site = globalThis.location;
    if (typeof site?.origin !== "string" ||
        typeof site?.pathname !== "string") return null;
    return site.origin + (site.pathname.replace(/\/+$/, "") || "/");
  }
  function paintStatus(state, message) {
    if (!state?.button?.isConnected || state.epoch !== navigationEpoch ||
        state.route !== routeIdentity()) return;
    // Native completion is terminal. Firefox event delivery can lag behind
    // a newer acknowledgement; never repaint completion as running/queued.
    if (TERMINAL.has(state.renderedStatus) ||
        (state.renderedStatus && rank(message.state) < rank(state.renderedStatus))) return;
    if (!["queued", "running", ...TERMINAL].includes(message.state)) return;
    state.renderedStatus = message.state;
    state.button.textContent =
      (message.state === "succeeded" ? "✓ " : "● ") +
      message.state + " · " + message.jobId.slice(0, 8);
    if (/^#[0-9a-f]{6}$/i.test(message.color || "")) {
      state.button.style.borderColor = message.color;
    }
  }
  let timer = null;
  let validating = 0;

  function candidate(pre) {
    const code = pre?.querySelector("code");
    if (!code) return null;
    const yaml = code.textContent || "";
    if (yaml.length > MAX_YAML_BYTES) return null;
    if (!/^\s*schema:\s*[1-4]\s*$/m.test(yaml.slice(0,256))) return null;
    if (!/^\s*(command|commands):/m.test(yaml)) return null;
    if (new TextEncoder().encode(yaml).byteLength > MAX_YAML_BYTES) return null;
    return yaml;
  }

  function queue(pre) {
    if (!pre?.isConnected || !pre.matches("pre") || dirty.size >= MAX_DIRTY) return;
    dirty.add(pre);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(drain, 150);
  }

  async function validate(pre, state) {
    validating++;
    try {
      const reply = await browser.runtime.sendMessage({ type: "jobflick:validate", yaml: state.yaml });
      if (!reply?.ok || !pre.isConnected || !pre.closest("main") ||
          states.get(pre) !== state || state.epoch !== navigationEpoch ||
          state.route !== routeIdentity() || candidate(pre) !== state.yaml) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "jobflick-bridge-run";
      button.textContent = "▶ Run Jobflick";
      button.title = "Queue this validated Execarium job on your computer";
      button.style.cssText = [
        "display:inline-block", "margin:10px 0 14px", "padding:8px 14px",
        "border-radius:8px", "border:1px solid currentColor",
        "background:transparent", "color:inherit", "cursor:pointer",
        "font:inherit", "font-size:0.875rem"
      ].join(";");
      state.button = button;
      pre.insertAdjacentElement("afterend", button);
      button.addEventListener("click", async event => {
        // The page can call button.click(), but that is not a user grant.
        if (!event.isTrusted || state.submitted || !button.isConnected) return;
        // A chat rerender may detach its code block but retain our button.
        // Remove the orphaned control lazily, without an idle DOM observer.
        if (!pre.isConnected || !pre.closest("main") ||
            state.epoch !== navigationEpoch || state.route !== routeIdentity()) {
          button.remove();
          return;
        }
        if (candidate(pre) !== state.yaml) {
          button.textContent = "YAML changed; hover to revalidate";
          queue(pre);
          return;
        }
        state.submitted = true;
        button.disabled = true;
        button.textContent = "Submitting…";
        try {
          const result = await browser.runtime.sendMessage({
            type: "jobflick:submit", yaml: state.yaml
          });
          // A real native submission can finish after this tab navigates.
          // Jobflick owns that durable job; do not paint a result into a
          // different conversation or claim its old button is actionable.
          if (!button.isConnected || !pre.isConnected || !pre.closest("main") ||
              state.epoch !== navigationEpoch || state.route !== routeIdentity()) {
            button.remove();
            return;
          }
          if (!result?.ok || typeof result.job?.id !== "string") {
            button.textContent = "Submission uncertain — inspect Jobflick";
            button.title = result?.message || "Do not automatically retry";
            return;
          }
          state.jobId = result.job.id;
          trackJob(state.jobId, state);
          const early = earlyStatus.get(state.jobId);
          if (early) earlyStatus.delete(state.jobId);
          // A harmless job can finish before submit_spec replies. Do not
          // display "Queued" forever when the reply already knows it is
          // terminal. Conversely an early terminal event must beat a stale
          // queued/running submission acknowledgement.
          const acknowledged = {
            jobId: state.jobId,
            state: result.job.state,
            color: result.job.color || ""
          };
          const latest = early &&
            rank(early.state) >= rank(acknowledged.state)
            ? early : acknowledged;
          if (latest.state && latest.state !== "queued") {
            paintStatus(state, latest);
          } else {
            button.textContent = "Queued " + result.job.id.slice(0, 8);
            state.renderedStatus = "queued";
          }
          // The DOM retains its final label; there is no reason to keep a
          // strong JavaScript reference to this control after completion.
          if (TERMINAL.has(state.renderedStatus)) byJob.delete(state.jobId);
          if (/^#[0-9a-f]{6}$/i.test(result.job.color || "")) {
            button.style.borderColor = result.job.color;
          }
        } catch (error) {
          if (!button.isConnected || !pre.isConnected || !pre.closest("main") ||
              state.epoch !== navigationEpoch || state.route !== routeIdentity()) {
            button.remove();
            return;
          }
          button.textContent = "Submission uncertain — inspect Jobflick";
          button.title = String(error);
        }
      });
    } catch {
      // Absent native host / unloaded event page; no automatic retry or scan.
    } finally {
      state.validating = false;
      validating--;
      if (dirty.size && timer === null) timer = setTimeout(drain, 150);
    }
  }

  function drain() {
    timer = null;
    const capacity = Math.max(0, MAX_VALIDATIONS - validating);
    const batch = [...dirty].slice(0, capacity);
    for (const pre of batch) {
      dirty.delete(pre);
      const yaml = candidate(pre);
      const route = routeIdentity();
      if (!yaml || !route || !pre.closest("main")) continue;
      const old = states.get(pre);
      // A validated button from a prior SPA route cannot authorize code
      // under a new conversation, even if the DOM node and YAML are reused.
      if (old?.yaml === yaml && old.route === route &&
          old.epoch === navigationEpoch &&
          (old.button?.isConnected || old.validating)) continue;
      if (old?.jobId) byJob.delete(old.jobId);
      old?.button?.remove();
      const state = { yaml, route, epoch: navigationEpoch,
        submitted: false, button: null, jobId: null,
        validating: true, renderedStatus: null };
      states.set(pre, state);
      void validate(pre, state);
    }
    if (dirty.size && capacity > 0 && timer === null) timer = setTimeout(drain, 150);
  }

  function intent(event) {
    const element = event.target instanceof Element ? event.target : null;
    const pre = element?.closest("pre");
    if (pre?.closest("main")) queue(pre);
  }

  document.addEventListener("pointerover", intent, { capture: true, passive: true });
  document.addEventListener("focusin", intent, { capture: true });

  browser.runtime.onMessage.addListener(message => {
    if (message?.type === "jobflick:route-revoked") {
      // Only the extension background can deliver runtime.onMessage to a
      // content script. Revoke stale Run controls on any top-level SPA event,
      // including A->B->A when the URL has already returned to A.
      navigationEpoch++;
      dirty.clear();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      byJob.clear();
      earlyStatus.clear();
      for (const button of document.querySelectorAll(".jobflick-bridge-run")) {
        button.remove();
      }
      return Promise.resolve({ ok: true });
    }
    if (message?.type === "jobflick:probe-upload") {
      // Bounded, read-only inspection. We never read/return draft text or
      // file names, click attachment controls, create File objects, or send.
      const composers = [...document.querySelectorAll(
        '#prompt-textarea[contenteditable="true"], ' +
        '[data-testid="composer-rich-text-input"][contenteditable="true"], ' +
        'textarea#prompt-textarea, textarea[data-testid="composer-textarea"]'
      )];
      const fileInputs = [...document.querySelectorAll('input[type="file"]')];
      // A generic input[type=file] is not a supported general-document
      // destination. ChatGPT may expose distinct photo/camera controls.
      // These fixed selectors are discovery *candidates*, NOT live-accepted
      // selectors or proof that a synthetic change event triggers upload.
      const generalFileInputs = fileInputs.filter(input =>
        input.id === "upload-files" && input.type === "file");
      const addButtons = [...document.querySelectorAll(
        'button[data-testid="composer-plus-btn"]'
      )];
      // No draft text, file names, or input references leave this content
      // script. A selected FileList is not proof of existing ChatGPT chips,
      // so future uploads must separately confirm the application's state.
      return Promise.resolve({
        ok: true,
        composerPresent: composers.length > 0,
        composerAmbiguous: composers.length > 1,
        composerOccupied: composers.some(node =>
          !!String(node.value ?? node.textContent ?? "").trim()),
        fileInputPresent: fileInputs.length > 0,
        fileInputAmbiguous: fileInputs.length > 1,
        selectedFilePresent: fileInputs.some(input =>
          Number.isInteger(input.files?.length) && input.files.length > 0),
        // Saturate counts at 2 (2 means ambiguous); never return UI labels,
        // transcript text, filenames, IDs, DOM elements or current page URL.
        generalUploadInputCandidates: Math.min(2, generalFileInputs.length),
        generalUploadInputUsable: generalFileInputs.length === 1 &&
          generalFileInputs[0].isConnected && !generalFileInputs[0].disabled,
        composerAddButtonCandidates: Math.min(2, addButtons.length),
        composerAddButtonUsable: addButtons.length === 1 &&
          addButtons[0].isConnected && !addButtons[0].disabled
      });
    }
    if (message?.type === "jobflick:scan") {
      for (const pre of document.querySelectorAll("main pre")) {
        const rect = pre.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < innerHeight) queue(pre);
      }
      return Promise.resolve({ ok: true });
    }
    if (message?.type === "jobflick:status") {
      const state = byJob.get(message.jobId);
      if (state) {
        paintStatus(state, message);
        if (TERMINAL.has(message.state)) byJob.delete(message.jobId);
      } else if (typeof message.jobId === "string" &&
                 /^[a-zA-Z0-9_-]{8,128}$/.test(message.jobId) &&
                 typeof message.state === "string") {
        if (earlyStatus.size >= MAX_EARLY_STATUSES) {
          earlyStatus.delete(earlyStatus.keys().next().value);
        }
        earlyStatus.set(message.jobId, {
          jobId: message.jobId, state: message.state, color: message.color
        });
      }
      // Reports remain in Jobflick; attachment + guarded send are future gates.
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });
})();
