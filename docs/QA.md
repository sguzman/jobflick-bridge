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
| Invalid schema/unsupported command | No Run action available | Not run |
| Synthetic page click | No submission | Not run |
| Valid harmless job, explicit click | Exactly one confirmed Jobflick queue entry | Not run |
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
