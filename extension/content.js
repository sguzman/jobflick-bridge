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
  let timer = null;
  let validating = 0;

  function candidate(pre) {
    const code = pre?.querySelector("code");
    if (!code) return null;
    const yaml = code.textContent || "";
    if (new TextEncoder().encode(yaml).byteLength > MAX_YAML_BYTES) return null;
    if (!/^\s*schema:\s*[1-4]\s*$/m.test(yaml.slice(0,256))) return null;
    if (!/^\s*(command|commands):/m.test(yaml)) return null;
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
      if (!reply?.ok || !pre.isConnected || states.get(pre) !== state) return;
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
        if (!event.isTrusted || state.submitted || !pre.isConnected || !button.isConnected) return;
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
          button.textContent = "Queued " + result.job.id.slice(0, 8);
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
      if (!yaml) continue;
      const old = states.get(pre);
      if (old?.yaml === yaml && old.button?.isConnected) continue;
      if (old?.jobId) byJob.delete(old.jobId);
      old?.button?.remove();
      const state = { yaml, submitted: false, button: null, jobId: null };
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
    if (message?.type === "jobflick:scan") {
      for (const pre of document.querySelectorAll("main pre")) {
        const rect = pre.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < innerHeight) queue(pre);
      }
      return Promise.resolve({ ok: true });
    }
    if (message?.type === "jobflick:status") {
      const state = byJob.get(message.jobId);
      if (state?.button?.isConnected) {
        state.button.textContent =
          (message.state === "succeeded" ? "✓ " : "● ") +
          message.state + " · " + message.jobId.slice(0, 8);
        if (/^#[0-9a-f]{6}$/i.test(message.color || "")) {
          state.button.style.borderColor = message.color;
        }
        // Reports remain in Jobflick; attachment + guarded send are future gates.
      }
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });
})();
