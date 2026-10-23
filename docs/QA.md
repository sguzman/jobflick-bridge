# 🦊 Firefox Developer Edition QA

## Profile choice

**Initial stage: dedicated QA profile.** This preserves personal browsing state while debugging extension event pages and ChatGPT DOM changes. Do not launch Firefox with custom flags against an existing in-use personal profile. Do not call `web-ext run --keep-profile-changes` on a personal profile: Mozilla documents it modifies preferences for automated remote debugging. A disposable profile remains preferable.

Before any real shell job:
1. Static/automated tests pass and the add-on loads with no browser preference changes.
2. Install the native host only after reviewing its own script and only when execution is needed.
3. Verify native `validate_spec` rejects malformed YAML and never executes it.
4. Execute a harmless reviewed Fish command in a temporary directory; confirm **one** durable Jobflick job.
5. Compare report and destination; check close/navigate/edit-draft paths; only then assess personal-profile use.

## Acceptance matrix

| Test | Required observation | Status |
| --- | --- | --- |
| Firefox Developer Edition extension loads | Real disposable headless Firefox add-on install/uninstall; authenticated desktop still pending | Headless CI pass (not full live QA) |
| Missing native host | No jobs, clear failure | Not run |
| Invalid schema/unsupported command | No Run action available | Real native validator rejects malformed YAML in disposable CI; authenticated page pending |
| Synthetic page click | Real user click required; fake backend rejects invalid submission | Headless Firefox synthetic CI passed |
| Valid harmless job, explicit click | Exactly one confirmed Jobflick queue entry | Headless FDE → actual daemon → Fish `printf` passed in isolated CI; authenticated page pending |
| Lost submit reply | No blind retry | Not run |
| Multiple chats and tab ID reuse | No wrong-chat delivery | Not run |
| Occupied ChatGPT composer | Existing draft unchanged | Not run |
| Browser restart after completion | Orphaned result recoverable, no automatic reroute | Not run |
| Real report attachment and Send | Verified on authenticated FDE, original conversation only | Not run |
| Long histories, many tabs, idle hours | Bounded overhead, no runaway activity | Not run |

Do not mark tests passed based on code review alone. Automated QA should drive Firefox itself, not require the user to manually test repeatedly; initial one-time setup is acceptable when genuinely unavoidable.

## Local inbox pilot

The extension action opens a Firefox popup rather than immediately triggering a scan. Use the popup's **Scan visible YAML** control with an active ChatGPT conversation; validation still requires the native host, and execution still requires clicking **Run Jobflick** in the page. The popup lists saved jobs and supports read-only status refresh. **Save report** retrieves a finished report on explicit click; files are downloaded locally and not uploaded. This is tested with automated mocks but must still be accepted in real FDE.

## Launching the dedicated Firefox Developer Edition QA profile

Run `fish scripts/qa-firefox-developer.fish`. This script exclusively launches the Arch `firefox-developer-edition` executable with `--no-remote --profile` pointed at `$XDG_DATA_HOME/jobflick-bridge-fde-qa/profile` (normally under `~/.local/share`). It refuses symlinks at its owned profile boundaries and does not touch existing Firefox profiles, browser preferences, tabs, or running processes. The persistent QA profile is independent of Firefox's default profile selection. <https://firefox-source-docs.mozilla.org/browser/CommandLineParameters.html>

In the QA window, open `about:debugging` → **This Firefox** → **Load Temporary Add-on**, and select `extension/manifest.json`. Temporary add-ons ordinarily need loading again after browser restart; avoid recommending insecure signature preferences as the normal development workflow. <https://firefox-source-docs.mozilla.org/devtools-user/about_colon_debugging/index.html>

For the first browser-only smoke test, do **not** run the native-host installer: verify the extension popup opens, Scan Visible responds on ChatGPT, no browser instability occurs, and absence of the host does not queue work. Explicit native-host installation comes only after the browser-only gate; **Firefox's native host registration is per OS user, not isolated to this profile**.

## Bridge-only retention

Finished records may be forgotten from the toolbar inbox through two explicit clicks: **Forget bridge record** and **Confirm forget**. This removes only Firefox-extension routing metadata. It neither cancels, consumes, nor deletes jobs or logs inside Jobflick. Running jobs cannot be forgotten via this control. This is a local data-management action, not an execution action.

### Local report download behavior

To avoid attempting a popup download from the asynchronous continuation of a native-host request, **Save report** first retrieves the report into popup memory. A second explicit click on **Download prepared report** constructs a bounded `File` and requests the local download synchronously from that new user gesture. Closing the popup discards the prepared copy without altering the durable Jobflick report. The extension still does not upload or send files to ChatGPT. Actual download behavior must be verified in Firefox Developer Edition.

## Automated Firefox Developer Edition smoke

CI also runs `tests/fde-smoke.cjs` in a disposable headless Firefox **Developer Edition** instance using Selenium/geckodriver. It temporarily installs the actual `extension/` add-on and uninstalls it, confirming the manifest is accepted by the target Firefox runtime. The driver creates an anonymous profile and does not register the Jobflick native host or authenticate to ChatGPT. This verifies **add-on loading only**, not the Run → Fish execution → report attachment flow. See the separate `fde-smoke` workflow job.

## Native host registration test

CI runs a **disposable Fish installer integration test** with a fake, never-executed `jobflick` binary and temporary `HOME`/`XDG_DATA_HOME`. It checks the Firefox manifest, `allowed_extensions`, file permissions, refusal to overwrite an existing host, and uninstall semantics. It cannot prove the actual installed Jobflick daemon/native protocol works; that requires real Linux/FDE integration.

## CI-built temporary test package

Successful CI runs upload an unsigned `jobflick-bridge-fde-qa-unsigned` ZIP artifact containing **only** `extension/` sources, built with Mozilla `web-ext`. In Firefox Developer Edition's isolated `about:debugging` page, **Load Temporary Add-on** can select this ZIP instead of a local `extension/manifest.json`. Temporary installation still expires on restart. The package is **not signed, not released, and not approved for the personal browser profile**. Its availability is bounded by CI artifact retention.

## Read-only native host diagnostic

The popup includes **Check connection**. It sends an intentionally invalid, non-executable document to Jobflick's existing `validate_spec` action and requires a structured rejection. This establishes that Firefox can reach the native host and that validation failed closed, without submitting a job. A missing host shows a clear error. **A successful diagnostic is not permission to execute arbitrary YAML** and does not establish end-to-end native execution acceptance.

## Safe preliminary attachment discovery

The toolbar's **Inspect composer** action is a read-only probe of the active permitted ChatGPT conversation. It reports only whether a recognized editable composer exists, whether that composer has content, and whether a file input is currently present in the DOM. It does not transmit any draft text or filenames, open an attachment menu, assign a `FileList`, dispatch file-change events, or press Send. Absence of a file input is **inconclusive**, since ChatGPT may construct one only after opening the attachment menu. This is only a first diagnostic toward the eventual verified file-upload milestone.

## Explicit stop request

For queued or running jobs, the popup offers **Request stop** and then **Confirm stop**. Only a confirmed popup action issues the existing Jobflick `cancel` native request; content scripts cannot invoke it. Once Jobflick acknowledges the request, the browser records a stop-request flag and suppresses duplicate offers while the job remains active. **Accepted is not the same as cancelled**: the job might finish concurrently or a process may take time to stop. On an uncertain native disconnect the popup does not retry automatically; inspect Jobflick before another stop. Confirm real cancellation behavior separately in FDE/local Jobflick acceptance.

## Per-job read-only destination preflight

For a finished job whose originating tab identity is still live, **Check original chat** verifies both the session token and exact ChatGPT conversation URL, then asks that *same tab* for composer presence, draft occupancy and exposed file-input flags. No report, draft text, attachment name, or content is transferred. A changed tab becomes **manual-only** and cannot be automatically reattached. Presence flags are not permission or proof that upload works; the real attachment and Send gates remain locked until live FDE acceptance.

## Actual Firefox synthetic code-block test (QA-only manifest)

CI now also boots **headless Firefox Developer Edition** with a separate, disposable QA add-on whose content script is the unmodified production `extension/content.js`. Its temporary manifest alone permits `127.0.0.1` to serve synthetic ChatGPT-like `main pre code` markup; its mock background **never invokes native messaging or queues real jobs**. Selenium triggers a code-block focus, checks that **Run Jobflick** appears, then sends a browser click and verifies the mock deliberately refuses submission. This exercises actual Firefox DOM/event behavior while leaving production host permissions, the production background worker, the user's Firefox profiles, and Jobflick untouched. It is **not** authenticated ChatGPT or native-host execution acceptance.

## Native Messaging in actual headless Firefox (no command execution)

A separate CI test, `tests/fde-native.cjs`, temporarily installs a QA-only copy of the production background/content scripts in **Firefox Developer Edition**. It adapts only the URL allowlist to a localhost synthetic conversation, and registers a purpose-built Node Native Messaging fixture under a disposable `HOME` with `allowed_extensions` set to the QA Gecko ID. The fake host parses the length-prefixed protocol and **never executes Fish or starts Jobflick**. The browser must validate the synthetic Execarium block, show Run, send exactly one `submit_spec` after a real click, and generate an opaque origin token. The test checks there is no automatic report retrieval, cancellation or duplicate submission. The fixture never logs YAML or report contents. This verifies Firefox-to-Native-Messaging wiring, not the actual Jobflick daemon or authenticated ChatGPT.

## Firefox Native Messaging integration: observed acceptance

The headless Firefox Developer Edition QA test now passes with the production content/background logic and synthetic localhost origin substitution. With a disposable, non-executing Native Messaging fixture it observes the validate → Run click → one submit → opaque origin token → inspect → terminal status path. It explicitly verifies that the report is **not** fetched automatically. The test can neither assert the real installed Jobflick daemon's Fish execution nor control Firefox's privileged `moz-extension://` popup via ordinary WebDriver. Popup controls are tested separately with behavioral mocks; authenticated Firefox Developer Edition QA remains a distinct, unpassed acceptance gate.

A regression test also simulates terminal status arriving before the asynchronous submit acknowledgement, ensuring that the Run button does not regress from finished to queued.

## Isolated real-daemon Firefox acceptance

CI's `real-jobflick` job checks out **pinned upstream Jobflick commit `cbff2a4cb90be4487e1bbb406777cf7fe3b6cc1d`** into a temporary build directory (not this repository), compiles it with Cargo, then validates the real `jobflick native-host` protocol, a single schema-4 job, a durable browser-origin token, and a finished report. The only executed command is a hardcoded `printf` in a temporary work directory.

The same job then runs the unchanged production content script and production background logic in headless **Firefox Developer Edition**, with a test-only localhost route and dedicated Gecko ID, connected to the **real** Jobflick daemon. It checks the browser's Run button, one persisted job, an opaque origin ID, successful Fish output, and the terminal-status update. This is actual Firefox-to-real-Jobflick integration but **not authenticated ChatGPT acceptance**. No report attachment or Send is activated. The `fake-native-host` acceptance remains a separate no-execution gate.

Results for same-tab navigation or a composer probe interrupted by navigation become permanently **manual-only** for automatic delivery. The bridge never silently reattaches a result to a reopened/reused tab, and manual report export remains available.

## Real native cancellation and manual reopening acceptance

The pinned, isolated Jobflick backend CI now exercises a second harmless schema-4 job (`sleep` followed by an unreachable `printf`) and sends the real `cancel` Native Messaging action. It waits for the durable `cancelled` state and refuses to equate a native acknowledgement with completed cancellation. The popup's two-step confirmation remains independently covered by behavioral tests; privileged popup click-through in authenticated Firefox is still pending.

The popup's `Open chat` control requires an explicit click and opens only a validated ChatGPT conversation URL, stripping old query/fragment parameters. It is a manual navigation helper, never an auto-delivery or provenance-rebinding mechanism. Its behavioral tests reject foreign domains, userinfo and non-conversation routes.

## Native Firefox rerender and keyboard gate

The synthetic FDE browser test also removes a validated code block while leaving its Run button in the DOM. A click on this detached control must be inert; a newly inserted code block is separately validated and gains its own Run button. The new button is activated with Firefox WebDriver's Enter key, which must reach the same intentionally non-executing QA background. This proves key handling and detached-node rejection in actual Firefox, not a screen-reader audit or authenticated ChatGPT React-internals compatibility.

When React removes the original code block but its adjacent Run button survives, a real click removes the orphaned button without contacting the native host. Cleanup is triggered by interaction, not by any page-wide observer or idle scan.

## Actual Firefox SPA navigation and bounded fast-status checks

CI now opens a synthetic ChatGPT-like conversation in **headless Firefox Developer Edition**, runs a Jobflick job using the genuine native host, and performs two real History API transitions: from conversation A to B and back to A. A QA-only read-only probe checks that the old saved result stays `manual_only` and cannot become automatically deliverable again. The QA URL adapter and probe never enter the production extension. A separate mock proves iframe history events do not revoke a top-level conversation token.

A short post-submission status burst catches quickly finished native jobs without waiting for the once-per-minute recovery alarm. There are no idle timers; at most 32 pending job IDs are tracked, four per tick, with six checks per ID and 1.2-second spacing. Excess submissions use the normal durable Jobflick inbox/alarm flow. Synthetic 40-job stress and quick/slow-job timer tests pass. Actual authenticated ChatGPT upload and Send remain unaccepted.

## Durable alarms and bounded results pagination

Job status metadata writes no longer replace an existing Firefox alarm. This preserves its next scheduled check during heavy submission/status activity rather than repeatedly deferring recovery. Fast checks are counted only when the targeted job actually enters a native inspection; a concurrent full refresh does not burn the limited attempt budget. Mocked tests cover both races, terminal alarm cleanup and a continuous 20-refresh update burst.

The Firefox popup now loads 40 job records at a time with a keyboard-accessible **Load older jobs** control. Records beyond the former 300-item display cap remain discoverable and can still be manually exported. The background validates page bounds (maximum 50 entries); popup tests page through 325 saved jobs without calling `show`, attaching a file or submitting a command. Refresh restarts pagination, ignoring late responses from earlier generations. This changes only the browser's bounded view of local metadata; all durable reports remain in Jobflick.

These behaviors are covered by CI mocks; authenticated Firefox Developer Edition popup UX remains a separate acceptance gate.

## Local job search acceptance

Background inbox pagination accepts at most 128 characters of search text and filters existing local job metadata before bounded page delivery. Case-insensitive queries match IDs, titles and states; malformed or excessive queries fail closed. The popup offers a native search form (Enter or Find), preserving keyboard navigation and pagination. Node behavioral tests cover search over 130 records, paging through matching results, clearing a search, no-result feedback, and rejection of oversized queries. Search neither reads a report nor submits/executes any job. Real authenticated FDE popup visual QA remains outstanding.

## CI change scoping

The lightweight workflow runs on every push to `main` and on explicit dispatch. The separate real-backend workflow runs automatically only for changes to the native-facing background/content/manifest, real-host tests and fixtures, native-host installer, package manifest, or integration workflow. It can still be dispatched manually. A passing lightweight run is **not** evidence of newly rerun real Jobflick integration; both statuses must be reported separately, using the latest native run relevant to the changed code. No release or authenticated ChatGPT automation is inferred from either.

## Duplicate host job ID regression

Mocked tests submit a terminal job and then make a second native response return the same ID; the second browser message must fail closed while the original routing metadata stays intact. The same rule protects a future-version record that the current extension cannot interpret. No implicit resubmission, replacement or report fetch occurs. Actual Jobflick uses unique persisted job IDs; these are defensive adversarial tests, not evidence that normal native IDs collide.

## Native origin disagreement regression

Synthetic tests cover three outcomes: (1) real-backend-style matching submission origin accepted; (2) a conflicting submission origin rejected as uncertain, without creating an extension routing record; (3) a subsequent inspection with conflicting origin permanently orphaned for automatic delivery, with no status message sent to the previous tab. This protects the conversation association but does not substitute for authenticated attachment/Send QA.
