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
  // Jobflick may complete before submit_spec's response reaches this tab.
  // Retain a small bounded status cache so early completion is not lost.
  const earlyStatus = new Map();
  const MAX_EARLY_STATUSES = 32;
  // A SPA may retain the exact same code node while changing conversations.
  // Bind each validation/Run control to the pathname that was inspected.
  // Query/hash changes on the same conversation do not revoke it.
  function routeIdentity() {
    const site = globalThis.location;
    if (typeof site?.origin !== "string" ||
        typeof site?.pathname !== "string") return null;
    return site.origin + (site.pathname.replace(/\\/+$/, "") || "/");
  }
  function paintStatus(state, message) {
    if (!state?.button?.isConnected || state.route !== routeIdentity()) return;
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
          states.get(pre) !== state || state.route !== routeIdentity() ||
          candidate(pre) !== state.yaml) return;
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
            state.route !== routeIdentity()) {
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
          if (!result?.ok || typeof result.job?.id !== "string") {
            button.textContent = "Submission uncertain — inspect Jobflick";
            button.title = result?.message || "Do not automatically retry";
            return;
          }
          state.jobId = result.job.id;
          byJob.set(state.jobId, state);
          const early = earlyStatus.get(state.jobId);
          if (early) earlyStatus.delete(state.jobId);
          // A harmless job can finish before submit_spec replies. Do not
          // display "Queued" forever when the reply already knows it is
          // terminal. Conversely an early terminal event must beat a stale
          // queued/running submission acknowledgement.
          const terminal = new Set([
            "succeeded", "failed", "cancelled", "timed_out", "interrupted"
          ]);
          const precedence = value => terminal.has(value) ? 2 :
            value === "running" ? 1 : 0;
          const acknowledged = {
            jobId: state.jobId,
            state: result.job.state,
            color: result.job.color || ""
          };
          const latest = early &&
            precedence(early.state) >= precedence(acknowledged.state)
            ? early : acknowledged;
          if (latest.state && latest.state !== "queued") {
            paintStatus(state, latest);
          } else {
            button.textContent = "Queued " + result.job.id.slice(0, 8);
          }
          if (/^#[0-9a-f]{6}$/i.test(result.job.color || "")) {
            button.style.borderColor = result.job.color;
          }
        } catch (error) {
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
          (old.button?.isConnected || old.validating)) continue;
      if (old?.jobId) byJob.delete(old.jobId);
      old?.button?.remove();
      const state = { yaml, route, submitted: false, button: null, jobId: null, validating: true };
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
    if (message?.type === "jobflick:probe-upload") {
      // Bounded, read-only inspection. We never read/return draft text or
      // file names, click attachment controls, create File objects, or send.
      const composers = [...document.querySelectorAll(
        '#prompt-textarea[contenteditable="true"], ' +
        '[data-testid="composer-rich-text-input"][contenteditable="true"], ' +
        'textarea#prompt-textarea, textarea[data-testid="composer-textarea"]'
      )];
      const fileInputs = [...document.querySelectorAll('input[type="file"]')];
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
          Number.isInteger(input.files?.length) && input.files.length > 0)
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
