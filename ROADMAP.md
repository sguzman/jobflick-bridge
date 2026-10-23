# 🗺️ Jobflick Bridge roadmap

Scope: a **complete**, Firefox Developer Edition-first bridge from ChatGPT Execarium code blocks to local Jobflick execution and correctly routed report attachment. This roadmap is not restricted to a toy streaming or proof-of-concept MVP.

## Evidence policy

Milestones are composed of named phases, features and **atomic tasks**. Every task has a stable ID in `progress.json`. Completion means acceptance evidence exists (test output, GitHub commit, documented manual Firefox QA or equivalent); code presence alone does not establish runtime acceptance. Milestone percent = verified tasks / planned tasks, rounded down; completion gates can keep a milestone below 100% even with all implementation tasks written. Do not mark an untested browser/desktop feature complete.

### 🧭 M0 — Independent foundation

**Phase F0: Inventory.**
- `M0-01` 📁 Confirm standalone `main` and keep repository independent.
- `M0-02` 🧬 Inventory old Script-Monkey extension files and reusable behavior.
- `M0-03` 🏗️ Document component ownership, message flow and Firefox-specific differences.

**Phase F1: Project contract.**
- `M0-04` 🗺️ Publish complete roadmap and task-level ledger.
- `M0-05` 🛡️ Document threats, permission scope and isolated QA policy.
- `M0-06` 🦊 Establish Firefox-first manifest and repository scaffold.
- `M0-07` 🧪 Establish automated baseline tests that run in CI.

### 🦊 M1 — Firefox platform and UX

**Phase F2: Browser integration.**
- `M1-01` 🦊 MV3 Firefox background event scripts, stable Gecko add-on ID.
- `M1-02` 🔐 Narrow ChatGPT-only content injection and native permission.
- `M1-03` 🧾 Detect supported Execarium YAML without transcript-wide observers.
- `M1-04` 👆 Intent-driven validation: pointer/focus and explicit visible scan.
- `M1-05` 🧩 Nonintrusive Run control, accessible keyboard states and sensible padding.

**Phase F3: Resilience.**
- `M1-06` ⏳ Bounded candidate queue, validation concurrency and message sizes.
- `M1-07` 🔄 Handle ChatGPT navigation/rerender and stale validation.
- `M1-08` 🧪 Firefox event-page lifecycle, reload, multi-tab synthetic tests.

### 🔌 M2 — Native Messaging and validation

**Phase F4: Registration.**
- `M2-01` 🪪 Native host manifest with Firefox `allowed_extensions` (not Chromium origins).
- `M2-02` 🐟 Fish installer for `jobflick native-host`, explicit invocation, no profile mutations.
- `M2-03` 🧵 Bounded JSON framing; malformed/disconnected host UX.
- `M2-04` 🔍 Host discovery diagnostics and safe uninstall path.

**Phase F5: Contract and guardrails.**
- `M2-05` ✅ Reuse **real** Jobflick `validate_spec`; schema 1–4 compatibility.
- `M2-06` 🚫 Reject untrusted senders, bad URLs, oversized or stale YAML.
- `M2-07` 🧪 Mock native host protocol tests and Firefox native-host smoke acceptance.

### ▶️ M3 — Explicit submission and execution tracking

**Phase F6: Queue semantics.**
- `M3-01` ▶️ Genuine user-click-only submission; no scriptable page auto-authorization.
- `M3-02` 🧾 Re-check exact YAML at click time, no implicit edits or coercion.
- `M3-03` 🪪 Browser-generated opaque origin token outside YAML.
- `M3-04` 🔌 One `submit_spec` per authorization; no blind retries on uncertain result.
- `M3-05` 📍 Persist confirmed job ID and exact originating conversation identity.

**Phase F7: Status.**
- `M3-06` ⏲️ Poll pending jobs through alarms, only while necessary.
- `M3-07` 🎨 Show native Jobflick state/name/job color in the UI (no project color).
- `M3-08` 🛑 Optional explicit cancel action, with clear running/cancellation ambiguity.
- `M3-09` 🧪 Double-click, timeout, failure and duplicate-submission regression tests.

### 📬 M4 — Results and routing

**Phase F8: Result retrieval.**
- `M4-01` 📡 Inspect terminal states; show full durable report by ID.
- `M4-02` 📏 Bound report size, truncation and diagnostic handling.
- `M4-03` 🔁 Resume inspection across Firefox event-page wakeups.

**Phase F9: Exact destination.**
- `M4-04` 🔒 Verify original tab instance *and* exact ChatGPT conversation route.
- `M4-05` 🗂️ Preserve undeliverable reports when origin tab closes or restarts.
- `M4-06` 📝 Safe composer handoff without overwriting an existing draft.
- `M4-07` 📮 Guarded send, with explicit ambiguous-state and no-duplicate policy.
- `M4-08` 🧪 Multi-tab/multi-conversation, navigation, draft/race integration tests.

### 📎 M5 — Real report attachment delivery

**Phase F10: Attachment mechanism.**
- `M5-01` 📎 Verify ChatGPT's current Firefox upload control and event behavior in live QA.
- `M5-02` 📄 Generate a bounded report artifact with stable name/MIME.
- `M5-03` 📤 Attach report to correct composer using validated, supported browser DOM interactions.
- `M5-04` 🧼 Avoid massive report text injection and accidental secret exposure.

**Phase F11: Reliable send.**
- `M5-05` ✅ Confirm file is actually attached before any automated send.
- `M5-06` 🧾 Preserve draft, user edits, and any preexisting attachments.
- `M5-07` 💬 Guard automatic submission against misrouting and uncertain state.
- `M5-08` 🧪 Live Firefox acceptance of attachment + same-chat submission.
- `M5-09` 🛟 Explicit manual delivery fallback when browser upload cannot be verified.

### ♻️ M6 — Recovery, inbox, and lifecycle

**Phase F12: Durable state.**
- `M6-01` 💾 Crash-safe browser-side job records with versioned migrations.
- `M6-02` 🔁 Reconcile browser restart and orphaned/closed tabs with Jobflick inbox.
- `M6-03` 🚧 Distinguish queued, executing, finished, delivery-pending, delivery-uncertain.
- `M6-04` 🧷 Reopen/select destination without silently switching to a different chat.

**Phase F13: User visibility.**
- `M6-05` 📬 Inspectable job/results panel and safe manual retry *of delivery only*.
- `M6-06` 🗑️ Explicit retention, pruning and export behavior.
- `M6-07` 🧪 Restart, stale-tab-ID, event-page suspension and offline recovery tests.

### 🛡️ M7 — Hardening, scale, release

**Phase F14: Safety/scale.**
- `M7-01` 🔎 Malicious page, forged click, unexpected host message, schema mutation tests.
- `M7-02` 💤 Low-idle overhead; large chat history, 16-tab and DOM churn acceptance.
- `M7-03` 🔐 Permission review, dependency audit, no secret/log leaks.
- `M7-04` ♿ Accessibility, reduced motion, keyboard and light/dark compatibility.

**Phase F15: Ship.**
- `M7-05` 🧰 One-command QA setup that never alters a personal Firefox profile.
- `M7-06` 🦊 Real authenticated Firefox Developer Edition end-to-end acceptance.
- `M7-07` 📦 Signed/permitted install and reproducible packaging strategy.
- `M7-08` 🏷️ Changelog, SemVer tag and release only after accepted evidence.

## Delivery gates

**G1 — Browser-safe pilot:** static lint/tests + extension loads in isolated Firefox; no host registered or jobs run.  
**G2 — Harmless execution:** native host registration is explicit; a reviewed harmless job queues exactly once and reports to Jobflick.  
**G3 — Personal profile candidate:** no crashes, tab interference, draft overwrite, or unintended execution in isolated live QA.  
**G4 — Full acceptance:** real attachment and guarded same-conversation submission survive adverse lifecycle tests.  
**G5 — Release:** signed deployment path, real FDE QA evidence, documentation and no secret leaks.

Safety gates are not bypassed by an attractive percentage.

Overall progress is the same evidence policy applied across all atomic tasks, recorded in the machine-readable `progress.json` `overall` field. `implemented` is reported separately from `verified`; only verified work changes the percentage.
