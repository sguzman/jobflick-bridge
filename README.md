# Jobflick Bridge 🦊

**Firefox Developer Edition-first WebExtension** connecting ChatGPT-authored Execarium jobs to the user's local Jobflick executor. The repository is independent; [the legacy Script-Monkey extension](https://github.com/sguzman/script-monkey/tree/main/extensions/jobflick-bridge) is reference material, not the implementation baseline.

**Status:** Actual headless Firefox Developer Edition temporary add-on install/uninstall passed in CI. Authenticated ChatGPT, native Jobflick execution and attachment/auto-send acceptance remain pending. **Safety:** test first in a dedicated Firefox Developer Edition QA profile with harmless jobs. A browser profile does **not** sandbox commands run by Jobflick.

## Intended flow

1. 🧾 ChatGPT presents an Execarium YAML code block.
2. ✅ The real Jobflick/Execarium consumer validates the full document without executing it.
3. ▶️ The user deliberately clicks **Run Jobflick**. No automatic queueing from page content.
4. 🔌 Firefox Native Messaging submits the spec; Jobflick durably schedules and executes it.
5. 📬 Completion is associated with its exact originating ChatGPT conversation.
6. 📎 A report is returned as a file attachment, with guarded automatic submission only after live browser QA. Text delivery is a fallback, not the final design.

Execarium defines the format. Jobflick owns validation enforcement, Fish execution, scheduling, results, and cancellation. Jobflick Bridge owns Firefox integration, explicit browser authorization and result routing.

## Project navigation

- [🗺️ Roadmap](ROADMAP.md): milestones → phases → features → atomic tasks, with acceptance gates.
- [📊 Machine-readable progress](progress.json): completed work is recorded only with evidence; no untested 100% claims.
- [🏗️ Architecture](docs/ARCHITECTURE.md): Firefox event-page model, Native Messaging, durable origin mapping.
- [🛡️ Security](docs/SECURITY.md): browser scope, native execution boundary and threat model.
- [🧬 Legacy implementation audit](docs/LEGACY.md): reference files, reusable decisions, necessary replacements.
- [🦊 Firefox QA](docs/QA.md): isolated-first acceptance plan.
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

The Firefox toolbar popup lists jobs previously submitted by this extension, including jobs whose originating tabs closed. `Scan visible YAML` replaces the old no-popup toolbar action. `Refresh jobs` checks pending statuses; `Save report` requests a finished report from Jobflick **only after a user click** and saves a local text file. Reports are not stored inside browser extension storage or automatically uploaded. The file export is bounded at 512 KiB; the authoritative complete report/log remains with Jobflick. `Open chat` is manual navigation, not automatic delivery.

This is a recovery and inspection surface, **not** a claim that the future ChatGPT attachment/auto-send milestone has passed.

## Isolated Firefox Developer Edition QA launcher

`fish scripts/qa-firefox-developer.fish` starts a **separate, persistent QA profile** under `$XDG_DATA_HOME/jobflick-bridge-fde-qa/profile`. It does not load the add-on, register the native host, or modify the user's regular Firefox profile. In the QA browser use `about:debugging` → **This Firefox** → **Load Temporary Add-on** → `extension/manifest.json`. Consult [QA instructions](docs/QA.md) before enabling real local execution.

## Verified CI gates

The automated suite runs Node behavioral tests, Fish native-host installer tests in a disposable HOME, Mozilla `web-ext lint`, and a separate **real Firefox Developer Edition** WebDriver job that installs/uninstalls the temporary add-on in an anonymous profile. It never accesses the user's machine or starts real Jobflick jobs. [Latest passing CI run](https://github.com/sguzman/jobflick-bridge/actions/runs/39996913809).
