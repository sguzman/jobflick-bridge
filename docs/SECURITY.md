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
