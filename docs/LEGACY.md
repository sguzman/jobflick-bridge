# 🧬 Prior implementation audit (reference, not baseline)

Previous source: [Script-Monkey / extensions/jobflick-bridge](https://github.com/sguzman/script-monkey/tree/main/extensions/jobflick-bridge), inspected on 2026-10-23.

| Old path | Reusable intent | Firefox-specific work |
| --- | --- | --- |
| `manifest.json` | MV3, narrow ChatGPT match, native messaging | Replace Chrome service worker with Firefox background scripts; stable Gecko ID |
| `content.js` | Bounded YAML candidates, hover/focus validation, Run control, conservative composer behavior | Promise-based `browser` messaging; synthetic-click rejection; Firefox DOM acceptance; real attachment mechanism |
| `worker.js` | Durable IDs/alarms, origin tokens, no blind submit retry, exact-route guard | Event-page lifecycle, preserve orphaned reports, test Firefox storage/session API |
| `install-native-host.fish` | Wrapper that executes `jobflick native-host` | `allowed_extensions`, Firefox manifest location, stable Gecko ID; explicit safe install/rollback |
| `tests/bridge.test.cjs` | Static safety invariants | Adapt and expand into Firefox-first behavioral tests |
| `tests/mv3-integration.py` | Prior synthetic 16-tab/8k-message/4k-mutation ideas | Do **not** migrate Python/Chromium harness; implement Firefox-native automated checks |
| `qa-isolated-chrome.fish`, `qa-isolated-edge.fish` | QA isolation intent | Discard browser-specific launchers; use Firefox Developer Edition isolated profile |
| `README.md`, `package.json` | Protocol and design notes | Rewrite for standalone public repo and new acceptance gates |

Older synthetic Chromium tests were **reported** passing; this is not Firefox acceptance evidence. Older delivery inserted a textual report into ChatGPT and clicked Send when DOM conditions matched. It did **not** attach a real report file. Do not overstate this as implemented. The legacy path remains untouched during this restart.

Related contract: [Jobflick browser bridge](https://github.com/sguzman/jobflick/blob/main/docs/BROWSER-BRIDGE.md) and [Execarium schema definitions](https://github.com/sguzman/execarium).
