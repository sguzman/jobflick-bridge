# Jobflick Bridge 🦊

**Firefox Developer Edition-first WebExtension** connecting ChatGPT-authored Execarium jobs to the user's local Jobflick executor. The repository is independent; [the legacy Script-Monkey extension](https://github.com/sguzman/script-monkey/tree/main/extensions/jobflick-bridge) is reference material, not the implementation baseline.

**Status:** **80% verified (51/63 atomic tasks)**. Disposable headless Firefox Developer Edition validates and queues through the actual Jobflick daemon, executes one hardcoded harmless Fish fixture, and displays successful terminal status. Firefox Run/rerender, native transport, explicit execution tracking and manual recovery have passed their isolated acceptance gates. Authenticated ChatGPT attachment, guarded Send, authenticated privileged-popup integration and release signing remain unverified. **Safety:** test first in a dedicated Firefox Developer Edition QA profile with harmless jobs. A browser profile does **not** sandbox commands run by Jobflick.

## Intended flow

1. 🧾 ChatGPT presents an Execarium YAML code block.
2. ✅ The real Jobflick/Execarium consumer validates the full document without executing it.
3. ▶️ The user deliberately clicks **Run Jobflick**. No automatic queueing from page content.
4. 🔌 Firefox Native Messaging submits the spec; Jobflick durably schedules and executes it.
5. 📬 Completion is associated with its exact originating ChatGPT conversation.
6. 📎 A report is returned as a file attachment, with guarded automatic submission only after live browser QA. Manual report export is a fallback, not the final design.

Execarium defines the format. Jobflick owns validation enforcement, Fish execution, scheduling, results, and cancellation. Jobflick Bridge owns Firefox integration, explicit browser authorization and result routing.

## Project navigation

- [🗺️ Roadmap](ROADMAP.md): milestones → phases → features → atomic tasks, with acceptance gates.
- [📊 Machine-readable progress](progress.json): completed work is recorded only with evidence; no untested 100% claims.
- [🏗️ Architecture](docs/ARCHITECTURE.md): Firefox event-page model, Native Messaging, durable origin mapping.
- [🛡️ Security](docs/SECURITY.md): browser scope, native execution boundary and threat model.
- [🧬 Legacy implementation audit](docs/LEGACY.md): reference files, reusable decisions, necessary replacements.
- [🦊 Firefox QA](docs/QA.md): isolated-first acceptance plan.
- [📦 Release and signing](docs/RELEASE.md): deterministic unsigned package, Mozilla signing and acceptance gates.
- [🔌 Protocol](docs/PROTOCOL.md): existing Jobflick contract.

## Constraints

- Firefox Developer Edition is the sole implementation/acceptance target; Chrome/Chromium/Edge are not QA substitutes.
- Work directly on `main`. No GitHub color/swatches required; emojis identify workstreams.
- No browser preference edits, default-profile manipulation, background transcript scanning, or automatic execution.
- No blind retries after uncertain native submission; never overwrite an occupied composer or deliver to an unrelated chat.
- Keep sensitive YAML, reports, tokens and private conversation material out of the public repository, issues and CI logs.
- Linux/EndeavourOS + Fish native host; keep the browser bridge small and dependency-light.

**Current pilot:** Firefox MV3 scripts implement intent-driven YAML validation, a genuine-click Run control, Native Messaging submission, durable job tracking, and background status inspection. Reports remain in Jobflick; **there is deliberately no automatic ChatGPT Send or file attachment yet**. Mocked Node tests and CI can pass without proving a real authenticated Firefox/ChatGPT session. See progress and acceptance gates.

## Local job inbox (Firefox toolbar)

The Firefox toolbar popup lists jobs previously submitted by this extension, including jobs whose originating tabs closed. `Scan visible YAML` replaces the old no-popup toolbar action. `Refresh jobs` checks pending statuses; `Save report` retrieves a finished report from Jobflick after an explicit click; a second **Download prepared report** click starts the local text-file download. Reports are not stored inside browser extension storage or automatically uploaded. The file export is bounded at 512 KiB; the authoritative complete report/log remains with Jobflick. `Open chat` is manual navigation, not automatic delivery.

This is a recovery and inspection surface, **not** a claim that the future ChatGPT attachment/auto-send milestone has passed.

## Isolated Firefox Developer Edition QA launcher

`fish scripts/qa-firefox-developer.fish` starts a **separate, persistent QA profile** under `$XDG_DATA_HOME/jobflick-bridge-fde-qa/profile`. It does not load the add-on, register the native host, or modify the user's regular Firefox profile. In the QA browser use `about:debugging` → **This Firefox** → **Load Temporary Add-on** → `extension/manifest.json`. Consult [QA instructions](docs/QA.md) before enabling real local execution.

## Verified CI gates

The automated suite runs Node behavioral tests, Fish native-host installer tests in a disposable HOME, Mozilla `web-ext lint`, and a separate **real Firefox Developer Edition** WebDriver job that installs/uninstalls the production add-on in an anonymous profile. A further disposable QA-only manifest runs the unmodified content script on synthetic ChatGPT-style HTML, confirming intent-driven Run button insertion, mouse-click handling, and rejection of YAML changed after validation. It uses disposable CI directories; a separate real-daemon gate executes only a fixed harmless `printf` fixture and never accesses the user's machine. [Current Firefox CI](https://github.com/sguzman/jobflick-bridge/actions/runs/40033764547).

An unsigned Firefox QA ZIP is also produced by CI (artifact `jobflick-bridge-fde-qa-unsigned`). It is intended only for **temporary installation** in the dedicated QA profile via `about:debugging`, not for a release or an automatic native-host setup.

Before testing real local work, use the toolbar popup's **Check connection** action. It invokes `validate_spec` on intentionally invalid YAML, never `submit_spec`; it helps distinguish a missing Firefox native host from a malformed Execarium document.

## Read-only attachment capability probe

The Firefox popup's **Inspect composer** button checks only whether the active ChatGPT conversation exposes a recognized editable composer, whether it appears occupied, and whether a file input is currently present. It reads neither draft contents nor filenames. It makes no DOM mutations and cannot attach or send a report. These observations are deliberately only preliminary evidence; the actual upload path is still an unaccepted milestone.

The popup also provides an explicit two-step **Request stop → Confirm stop** control for unfinished jobs. This asks Jobflick to stop the job and does not infer that the process actually stopped. No stop requests are sent automatically.

## Exact-origin preflight and job lifecycle

Finished jobs whose original tab still matches its opaque session token and **exact conversation URL** can be checked via **Check original chat**. This returns read-only composer/file-input flags, never a draft, report or uploaded file. If the tab closes or changes, the record becomes manual-only. Job records are versioned and retain their manual-delivery states without falsely claiming a ChatGPT send. A two-click stop action is available on unfinished jobs; native stop acknowledgement does not prove the process terminated.

## 🦊 Current verified integration boundary

The full **synthetic Firefox Developer Edition → actual Jobflick native-host → durable daemon → harmless Fish execution → finished-status UI** path passes in CI. The runner compiles a pinned upstream Jobflick revision and operates on private temporary XDG paths with a separate Gecko test ID. The exact executed command is a hardcoded `printf`, and no authenticated ChatGPT session is used. A separate no-execution native fixture continues to verify that the browser does not automatically fetch reports or send messages.

The **actual Firefox `moz-extension://` toolbar popup** now has disposable Developer Edition acceptance for inbox search, Native Messaging report retrieval, exact local File download and bridge-only Forget. This does not prove an authenticated ChatGPT attachment or automatic Send, which remain disabled.

## 🧭 Conversation navigation and responsive status

Jobflick Bridge uses a narrowly filtered, read-only Firefox `webNavigation` listener for ChatGPT's History API transitions, in addition to normal tab URL updates. If the tab visits a different conversation, the old job becomes permanently `manual_only` for automatic delivery, even if the URL is later revisited. This was exercised with actual `history.pushState()` in disposable Firefox Developer Edition; nothing is read from another website or saved as browser history.

After a confirmed submission, short-lived status rechecks run every 1.2 seconds for at most six attempts, with at most four jobs checked per tick and 32 jobs in the fast queue. The existing one-minute Firefox alarm remains responsible for long-running jobs and event-page restarts. There is no continuous idle poll. This behavior is verified with Node burst tests and actual Firefox-to-Jobflick completion checks.

## ♻️ Browsing older jobs

The Firefox popup paginates local job records in batches of 40. **Load older jobs** makes saved history beyond the previous 300-row display limit accessible without bulk-rendering the full inbox. Firefox status checks reuse an existing durable alarm rather than postponing its next run whenever metadata changes. Short post-submit checks remain bounded and do not consume attempts while another full native inspection is in progress.

## 🔎 Local inbox search

The popup's keyboard-accessible search form filters saved Jobflick records by job name, ID or state. Results still load in 40-job pages, and searching never reads job output or calls Native Messaging. A blank search restores the complete saved history.

## 🧪 Two-tier Firefox CI

`Firefox Bridge Checks` runs Node/behavioral tests, Mozilla lint, unsigned QA packaging, and actual headless Firefox Developer Edition installation/UI checks on every `main` update. `Firefox Bridge Real Jobflick Integration` separately builds pinned Jobflick and verifies a harmless Fish job through Native Messaging when production native-facing code, native test fixtures, host installer or its workflow changes. Documentation and popup-only changes do not trigger a needless Rust rebuild; their fast Firefox checks still run.

## 📎 Future automatic report delivery

Automatic report attachment and Send are deliberately disabled until their real authenticated Firefox acceptance gates pass. The safety and idempotency requirements are documented in [Report attachment and Send acceptance contract](docs/DELIVERY-CONTRACT.md). The current supported workflow is explicit local Save report → Download prepared report, with Jobflick retaining the durable original.

Initial acceptance evidence: [Firefox/static checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40021961943) · [real Jobflick Native Messaging acceptance](https://github.com/sguzman/jobflick-bridge/actions/runs/40021742503). These earlier runs do not establish authenticated ChatGPT file upload or automatic Send.

## 📄 Inert report File adapter

A small bounded File constructor/DOM handoff helper is included in `extension/attachment-adapter.js`. It is deliberately **not activated** by the current extension UI. Synthetic Firefox Developer Edition QA checks that the page can read the file and that an already-selected file is never replaced. This is a preparatory file-transfer primitive, not a verified ChatGPT upload or Send.

## ✅ Verified local File and manual export gates

Real disposable Firefox Developer Edition accepted the inert report File constructor/DOM transfer, rejected oversized reports, and preserved existing file selections. Another browser test loaded the production popup JavaScript against a localhost mock and confirmed that **Save report** only prepared data while **Download prepared report** saved exactly that file on a second explicit click. [Acceptance evidence](https://github.com/sguzman/jobflick-bridge/actions/runs/40024074527). These tests do not establish a live ChatGPT upload, privileged popup acceptance or automatic Send.

## 🔗 Verified native-report-to-File QA (not ChatGPT upload)

Disposable Firefox Developer Edition now completes one real pinned Jobflick Fish job, explicitly retrieves its finished report through actual Firefox Native Messaging, then uses the same bounded production File helper to hand that report to a localhost synthetic file input. The receiving page verifies the report contents and **exact job ID-based filename**. After the original conversation route changes A→B→A, the same test confirms a second file handoff is rejected, preserving manual-only provenance. [Real backend/browser acceptance](https://github.com/sguzman/jobflick-bridge/actions/runs/40025229365).

Only **QA-only** code exposes the report-read action or uses the synthetic page input; the production extension still has no automatic report fetch/attachment/Send. Authenticated ChatGPT attachment and message delivery are still untested.

## Native identity quarantine

If Jobflick's inspection or optional report metadata ever disagrees with the saved job ID or browser-origin token, Firefox permanently marks that record as requiring manual recovery. Its popup hides **Request stop** and **Save report** to avoid acting on the wrong native job; the authoritative Jobflick inbox still retains the original job/report, and an explicit finished-record Forget only removes Firefox metadata.

## 💤 Low-overhead Firefox idle operation

Unrelated site navigation and tab completion do not cause Jobflick native inspections. Empty-job refreshes and duplicate same-conversation route notifications avoid storage writes; repeated unchanged native status replies likewise avoid redundant UI notifications and full inbox writes. The durable Firefox alarm continues recovering long-running jobs.

## ✅ Earlier isolation and low-idle CI evidence

[Firefox/Node safety and idle tests](https://github.com/sguzman/jobflick-bridge/actions/runs/40027477393) · [Real Jobflick/Firefox native integration](https://github.com/sguzman/jobflick-bridge/actions/runs/40027477573). Additional regression tests reject prototype-property job IDs, prevent report/Cancel actions for quarantined native identity, preserve draft/File selection on synthetic pages, and avoid full-inbox writes during empty or unchanged status checks. These do not establish authenticated ChatGPT attachment or automatic Send.

## 🧪 Earlier native and Firefox regression evidence

[Fast Firefox checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40028499706) · [Real Jobflick native integration](https://github.com/sguzman/jobflick-bridge/actions/runs/40028499789). The fast suite now includes terminal-before-acknowledgement status ordering and adversarial null/nonstring native identity fields; the real suite also confirms the runner-index-first Ubuntu dependencies work. As before, automatic ChatGPT upload/Send remains blocked pending authenticated Firefox Developer Edition acceptance.


## 🧪 Current verified CI and memory bounds

[Latest verified Firefox checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40041874551) · [real pinned Jobflick/Firefox integration](https://github.com/sguzman/jobflick-bridge/actions/runs/40041196148).

The latest checks cover stale asynchronous response authorization, exact original-chat routing, Firefox keyboard and synthetic file acceptance, native cancellation/report recovery, bounded fast retries during storage errors, and conflicting native metadata quarantine. Run status stays monotonic, completed controls release their JavaScript status references, and each long-lived ChatGPT content script keeps at most 128 live status mappings; older jobs remain accessible through the authoritative Jobflick inbox. Firefox host registration now refuses clobbering a foreign native wrapper or manifest while allowing safe reinstall. Stored job names and colors are bounded, and malformed legacy inbox URLs are never used as Open chat destinations. These are verified synthetic and native-transport checks, **not** authenticated ChatGPT file upload, automatic Send, or long-duration desktop profiling.


## 📄 M5-04 verified: no composer log injection

Real isolated Firefox Developer Edition now verifies that a fixed harmless job's native report is passed as a bounded local text/plain File without altering a preoccupied composer or an existing user attachment indicator. [Real Jobflick acceptance](https://github.com/sguzman/jobflick-bridge/actions/runs/40039054521). This independently completes the atomic *avoid giant text injection* task, not authenticated ChatGPT upload or Send.


## 📬 Verified manual recovery and Firefox routing

The complete Firefox platform/UX milestone now passes its atomic acceptance
matrix, including the A→B→A SPA rerender regression in real disposable
Firefox Developer Edition. The production content script revokes stale
validation/Run grants when the background observes a History API navigation.
An unrelated tab cannot inherit execution or report-delivery authorization.

The explicit local inbox and fallback flow has also passed browser-level
acceptance: the unchanged production popup HTML/JS/CSS displayed and searched
325 synthetic jobs with 40-record pages and a final partial page; an explicit
Open chat action requested only the canonical stored conversation; two
separate Save/Download gestures wrote a complete bounded report File; and
two separate Forget gestures removed only browser tracking metadata.
These popup checks ran on localhost with a synthetic runtime, **not** in a
privileged `moz-extension:` toolbar popup or an authenticated ChatGPT
session. [Firefox CI evidence](https://github.com/sguzman/jobflick-bridge/actions/runs/40041874551).

The authoritative work ledger is [progress.json](progress.json); live
ChatGPT attachment acknowledgment, draft-safe Send and release signing remain
required gates. Synthetic browser results never establish automatic delivery.


## 🦊 Real Firefox toolbar popup acceptance

[Firefox Developer Edition privileged popup CI](https://github.com/sguzman/jobflick-bridge/actions/runs/40042283563) now opens the
actual `moz-extension://` action popup and verifies unmodified background
popup authorization, a 45-record inbox/search, fake-host Native Messaging
report retrieval, an exact local File and bridge-only Forget. The CI-only
popup gestures are programmatic; separate disposable Firefox tests cover
real keyboard download gestures. **Authenticated ChatGPT attachment and
Send remain unverified and disabled.**

## 🚧 Explicit uncertain delivery state (not automatic Send)

A saved finished record with `delivery_uncertain` is displayed distinctly
from `report_pending_manual_delivery` and `manual_only`. It warns against
automatic retries while keeping Save report available. Native terminal-state
reconciliation preserves uncertainty rather than reverting it to pending;
unknown/untrusted persisted delivery labels never become a claim of a verified
ChatGPT Send. The current production path cannot create an automatic upload
or Send attempt, so this supports future outcome reconciliation rather than
claiming an already completed delivery.
