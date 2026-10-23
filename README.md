# Jobflick Bridge 🦊

**Firefox Developer Edition-first WebExtension** connecting ChatGPT-authored Execarium jobs to the user's local Jobflick executor. The repository is independent; [the legacy Script-Monkey extension](https://github.com/sguzman/script-monkey/tree/main/extensions/jobflick-bridge) is reference material, not the implementation baseline.

**Status:** Firefox restart / development; no live acceptance claims. **Safety:** test first in a dedicated Firefox Developer Edition QA profile with harmless jobs. A browser profile does **not** sandbox commands run by Jobflick.

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

**The manifest/scaffold is not proof of a tested, working extension.** See progress and acceptance gates.
