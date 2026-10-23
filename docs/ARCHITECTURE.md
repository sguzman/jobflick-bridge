# 🏗️ Architecture

```text
ChatGPT DOM (allowed host only)
  └─ content script: intent-based candidate discovery, UI, explicit click
        │ browser.runtime.sendMessage
Firefox extension background event script
  ├─ validates sender tab/origin and YAML size
  ├─ nativeMessaging: validate_spec, submit_spec, inspect, show
  ├─ browser.storage.local: durable job routing/delivery state
  ├─ browser.storage.session: instance-specific per-tab origin token
  └─ alarms: periodic checks only while pending
        │ length-prefixed JSON over stdio
User-installed native host: jobflick native-host
        └─ Jobflick daemon: real validator, queue, Fish execution, reports
```

**Boundaries:** [Execarium](https://github.com/sguzman/execarium) defines versioned YAML only; [Jobflick](https://github.com/sguzman/jobflick) executes and persists; this repository owns Firefox UI, origin routing and browser delivery. Do not duplicate schema parsing or turn Jobflick Bridge into a new executor.

## Firefox-specific choices

- Firefox Developer Edition is the implementation and QA target; MV3 `background.scripts` event pages, **not** Chrome `background.service_worker`.
- Promise-based `browser.*` APIs; stable `browser_specific_settings.gecko.id`.
- Firefox native host uses `allowed_extensions` and Linux `~/.mozilla/native-messaging-hosts`. Chromium `allowed_origins` and `~/.config/google-chrome` directories are wrong here.
- The host registration is *user-level*, not profile-level. A dedicated Firefox QA profile separates browsing state, **not** native command authority.
- Only allowed ChatGPT origins receive content scripts. The broad `tabs` permission is omitted; matching ChatGPT host permissions provide the tab URL needed for precise routing. No extension-wide DOM observer, clipboard watcher, arbitrary website access or browser preference modifications.

## Routing and lifecycle

Never accept a conversation identity authored inside the YAML. Derive the current canonical HTTPS ChatGPT route from the browser-provided sender tab; store job ID, route, tab ID and random session origin token separately. Before attempting delivery, verify the tab still exists, has the same session token, and is at the exact same conversation route. A numeric tab ID alone is insufficient because IDs may be reused.

Keep finished but undelivered reports inspectable; browser restart cannot prove a new tab is the original. Never automatically send to a guessed replacement tab. A native submission transport failure is **uncertain**, not necessarily failed; do not retry it blindly. Delivery retries are a separate operation from **job submission**.

Attachment delivery is subject to live Firefox/ChatGPT integration testing. Do not claim upload success based only on dispatching synthetic file input events.

## Pending-job polling budget

Firefox alarms are used only while there are unfinished tracked jobs. A poll inspects **at most 24 jobs**, ordered by the oldest `lastCheckedAt`. Even if a native host inspection fails, its attempt time advances so other jobs are not starved. This limits per-minute process creation without losing durable queue records. Explicit Refresh shares any current inspection run. The 40-job mock test checks that two polling cycles cover all 40 IDs exactly once; runtime/idle load still requires actual Firefox QA.

## Conversation-route allowlist

Origin routing accepts only exact HTTPS `chatgpt.com` / `chat.openai.com` conversation routes: `/c/{id}`, `/uc/{id}`, and `/g/{gpt-or-project-id}/c/{id}`, with bounded opaque segments. Settings, shares, project landing pages, homepage and unrelated routes are not valid job origins or result destinations. Query strings and hash fragments do not participate in identity. These patterns are evidence-guided but must remain a tested browser compatibility boundary as ChatGPT evolves; fail closed on new route types instead of posting to an assumed destination.
