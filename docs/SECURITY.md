# 🛡️ Security and browser safety

## Risk decision

Use a **dedicated Firefox Developer Edition QA profile initially**. The WebExtension itself is limited to ChatGPT pages and native messaging, so browser corruption should be unlikely after proper testing; however a crash, bad selector, recursive DOM handler or wrong-tab send could still disrupt a personal browser session. Jobflick runs local Fish commands as the current OS user. A QA browser profile **does not sandbox filesystem access, process execution or Jobflick's daemon**.

**Do not test with an unreviewed command against real projects.** Start with harmless read-only commands in an isolated temporary directory. Progressing to the personal FDE profile requires G3 acceptance in the roadmap.

## Trust boundaries and mitigations

| Threat | Planned invariant |
| --- | --- |
| Web page supplies malicious YAML | User must deliberately authorize via genuine click; validation is syntactic/consumer policy, **not command safety**. |
| Page synthesizes click on inserted button | Reject untrusted DOM click events; test that page JavaScript cannot queue jobs. |
| Background message forged/misattributed | Verify `sender.tab` and exact allowed HTTPS origins for **every** request; never trust page-provided destination. |
| Native host missing or hacked | Explicit installer and static add-on ID allowlist; bounded JSON; no HTTP listener; detect malformed responses. |
| Submit reply lost after daemon persisted job | Mark submission uncertain; never automatically resubmit. |
| Tab closed, ID reused, or navigated | Per-session opaque token + exact URL match; no automatic delivery to another tab. |
| Prompt already contains a draft or attachment | Never overwrite or auto-send without proving composer ownership and state. |
| Completion report contains sensitive data | Keep local; never commit or log reports into public GitHub; attachment requires deliberate QA. |
| Infinite polling or huge conversations | Intent-based inspection and bounded queues; alarms run only with active records. |
| UI changes at chatgpt.com | Fail closed; retain result in Jobflick rather than improvising a destructive send. |

No browser extension can establish that a command is harmless simply because its YAML validates. `privilege: none` is not a sandbox and does not prevent explicit privileged commands in the Fish source.

## Install and rollback

Do not run host install scripts automatically from CI, a package installation, or extension startup. Document exact changes, offer explicit uninstall, and never touch existing personal Firefox profiles or prefs. The Linux native host manifest directory is shared by Firefox profiles for the OS user; remove only this app's own manifest, never the directory itself.

No telemetry. No remote job execution backend. No clipboard watcher. No self-update of Jobflick from inside a running Jobflick job.

## Firefox least-privilege tab access

The extension intentionally does **not** request the broad `tabs` permission. Firefox 86+ allows `tabs.get` and `tabs.query` to expose `Tab.url` when the target tab has a matching narrow `host_permissions` grant; the rest of the tabs API is available without the broad permission. Since Jobflick Bridge targets Firefox Developer Edition 140+, only the exact ChatGPT host matches are needed. Reading a URL outside those hosts is unsupported and fails the exact-origin check. Source: [Mozilla tabs API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs).

## Submission navigation race

The background worker validates sender and conversation URL when the user-triggered message first arrives **and again after asynchronously obtaining the tab-origin token**, immediately before Native Messaging submission. If the tab closed or navigated away during origin creation, the job is not queued. Once Native Messaging starts, a subsequent navigation cannot undo a legitimately authorized command; the delivered result still requires an exact surviving origin check. Mocked tests cover navigation and close during token creation; real FDE execution remains separately gated.

## Native-host installation hardening

The Fish registration script refuses existing native-host manifests (including dangling symlinks), symlinked host directories, and symlinked manifests during uninstall. CI tests verify refusal without touching an outside target, plus an actual executable-wrapper round trip with little-endian native-messaging JSON framing using an ephemeral, non-executing fake host. Real Jobflick daemon integration still requires separate acceptance.

## Same-tab navigation during status or destination inspection

When status inspection discovers that the original tab identity has disappeared, the bridge now sets both `orphaned` and `deliveryState: manual_only`; it does not imply a finished job can return automatically. A read-only per-job composer probe checks the exact session token and conversation **again after** receiving the probe response. If the tab navigates in between, the popup receives a failure and the record becomes manual-only. Neither action retrieves report contents, changes a draft, or initiates Send.

## Manual destination reopening

The trusted Firefox popup offers `Open chat` only for exact, syntactically validated ChatGPT conversation routes. It requires a separate human click, creates a normal browser tab, and discards stale query and fragment parameters. It never attaches a report, edits a draft, rebinds an orphan's provenance token, or triggers Send. Tests reject foreign domains, URL userinfo, non-conversation routes and script URLs.

## Navigation-origin invalidation

The Firefox tab URL update listener revokes a job's automatic-delivery eligibility when the tab transitions away from the saved canonical conversation, even if the tab subsequently returns to that URL. The previous tab token is discarded once no non-orphaned record for that conversation remains; normal same-route reloads preserve the token. After `submit_spec` returns, the bridge also rechecks the origin **inside** its serialized record write, so a navigation while the native call is in flight records an accepted job as `manual_only`. These transitions never retry execution or discard the durable Jobflick report.

## History API navigation and permissions

The bridge requests Firefox's read-only `webNavigation` permission to detect `history.pushState()` / `replaceState()` conversation switches that may not trigger a full page load. Its history listener is filtered to top-level frames at the two already-authorized ChatGPT hostnames. No browsing history is stored or sent anywhere; only the current route comparison invalidates stale Jobflick delivery metadata.

## Native job ID collision handling

A Jobflick native response may have been accepted before the browser sees it. If its ID collides with an existing saved job, the bridge refuses to overwrite any previous origin, version, state or manual recovery metadata. The content script receives a submission-uncertain error and must not retry automatically. The extension does not assume that a second response with an identical ID authorizes a different chat. The durable Jobflick daemon remains responsible for its own queue and report identity.
