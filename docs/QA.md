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

## Native identity quarantine acceptance

Adversarial Node tests return an inspected native job with a different ID or origin token. The bridge must never paint the unrelated status, change the original job's name, or call `show`. The record becomes manual-only with an explicit integrity issue; subsequent Refresh and alarms cannot automatically re-inspect it. The native report stays in Jobflick for manual recovery. Authentic Firefox Developer Edition acceptance of mismatched responses remains distinct.

## Firefox File handoff (synthetic page; not authenticated ChatGPT)

CI runs `tests/fde-attachment.cjs` with a disposable Firefox Developer Edition extension and a localhost HTML file input. The probe imports the **same inert** `extension/attachment-adapter.js` that is bundled before the production content script, and checks that a plain-text Jobflick-named `File` is readable from a page-realm `change` listener. It additionally verifies that selecting a report **cannot overwrite an already-selected user file**, and that a report larger than 512 KiB is rejected before any handoff. No network upload is made; no native host, account session, or ChatGPT Send is involved.

Passing this probe validates Firefox cross-realm FileList transfer but does not establish that ChatGPT's current attachment UI will ingest, display, upload, or send the file. Only real authenticated Firefox Developer Edition QA can verify that later stage.

## Read-only composer ambiguity inspection

The popup's existing **Inspect composer** and per-job **Check original chat** checks now distinguish whether the site exposes multiple plausible composer elements or file inputs, and whether the discovered file inputs already have a selected `FileList`. The content script only returns booleans: no draft contents, existing attachment names or File objects are sent to the background. Known `textarea` values also count as occupied drafts without disclosing them. Legacy or missing advanced flags are shown as **unknown**, not safe.

This probe remains *read-only*. It does not determine whether the ChatGPT composer already has uploaded file chips if its file input is empty, hidden or created on demand. Ambiguity, missing selectors and unrecognized states must keep any future automated attachment/Send disabled until live Firefox acceptance.

## Firefox real local-report download acceptance

`tests/fde-report-download.cjs` runs the actual production popup HTML, CSS and JavaScript through a disposable localhost page in headless Firefox Developer Edition. A **test-only runtime stub** supplies one synthetic finished job and bounded text report. Selenium checks that opening the panel does not download anything, the first **Save report** gesture only prepares the File, and a second separate **Download prepared report** gesture creates a local file whose bytes match the synthetic report. It checks that no submit, native action, ChatGPT message or network upload is initiated.

Because Marionette cannot directly automate a privileged `moz-extension://` popup, this test covers real Firefox Blob/download behavior but **not** the production extension popup's privileged origin. That remains an unpassed acceptance gate.

## Real native report → browser File → synthetic page + route revocation

The separate `Firefox Bridge Real Jobflick Integration` workflow now tests this additional **QA-only, explicitly clicked** path after confirmed terminal state: real Jobflick native `show` → bounded production `attachment-adapter.js` `File` → Firefox `DataTransfer` → localhost file input → page-realm content/name verification. The background test adapter checks the original tab's session token and canonical route both **before and after** the asynchronous native `show` request.

The test then uses the real Firefox History API to navigate A→B→A. An attempted second report handoff is rejected, demonstrating that the completed native report cannot be rebound automatically to a formerly matching URL. There is no account, network upload, user draft, ChatGPT conversation Send or personal browser access. Real privileged popup upload and authenticated site acceptance remain independent gates. [Passing real integration](https://github.com/sguzman/jobflick-bridge/actions/runs/40025229365). [Passing lightweight Firefox checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40025229446).

## Quarantined identity operations

Adversarial Node tests cover an unfinished quarantined job (no popup stop and no native cancel), a finished quarantined job (no extension report export or per-chat preflight, but manual metadata Forget remains available), and native `show` responses that report a mismatched job ID or origin. A mismatch permanently records the reason and forbids repeat extension `show` calls. This is a trust-boundary test only: it does not establish authenticated ChatGPT file upload or Send.

## Actual FDE synthetic draft and file-selection preservation

The disposable Firefox Developer Edition synthetic test additionally uses the **production** read-only composer probe, routed through a test-only background messenger. It creates a nonempty contenteditable draft and two file inputs, preselects a harmless test File, and confirms the returned message contains **only seven boolean flags**: no draft text, file names or bytes. The test compares the actual DOM draft and File selection after inspection and confirms they are unchanged. It then clears those synthetic elements and confirms the empty/single-input flags.

This is a no-side-effect read-only test on localhost. It does not establish recognition of the real ChatGPT attachment chip UI or consent to upload/Send.

## Idle browser and long-running-job write bounds

Jobflick's status loop records `lastCheckedAt` once per nonempty bounded poll batch. Unchanged native job states no longer rewrite the whole local inbox or send duplicate Firefox tab messages. The first terminal state or changed metadata is still persisted and reported. With an empty pending batch, explicit refresh and unrelated tab events perform no local storage write.

Only tracked/changed ChatGPT routes can orphan existing jobs. Repeated same-conversation route events, navigation in unrelated tabs, and closing unrelated tabs do not rewrite the local inbox. Browser tab closures wait for an in-progress token mint to settle before removing the session key, preventing a delayed `storage.session.set` from restoring a closed tab's identity. Node tests measure write counts, cancellation-safe identity cleanup, and the ability of explicit Refresh to inspect pending jobs after unrelated browsing. Real long-duration desktop idle profiling is still outstanding.

## Prototype-collision job ID adversarial coverage

Mock native submission returns reserved JavaScript property names, including `__proto__` and `constructor`. Every case is refused before persisting or binding browser origin, with no automatic resubmission. The popup likewise rejects those IDs for preflight, report retrieval, cancellation and Forget. JSON-imported future/malformed local mappings containing such keys are not polled, exported or displayed as valid jobs. Real Jobflick-generated UUIDs are unaffected.

## Very fast native job completion at submit acknowledgement

A very short Fish job may finish before the native `submit_spec` response arrives. The Run control now accepts a terminal state directly from that response rather than displaying a stale Queued label indefinitely. When a terminal `inspect` status arrived even earlier, a subsequent queued or running submission acknowledgement must never downgrade it. Node regression cases cover all Jobflick terminal states, early-running vs queued and early-terminal vs queued/running. This does not enable automatic report retrieval or Send.

## Malformed native metadata regression

Adversarial mocked host replies include `origin_tab_id: null`, numeric IDs, arrays and objects during submission, inspection and explicit report retrieval. Each supplied contradictory field must fail closed: no browser origin bind, no status propagation for the mismatched job, and no report export. Omitted optional metadata remains accepted for older compatible native hosts. Real pinned Jobflick returns valid UUIDs and a browser-origin token in CI.

## Two-tier CI Linux package installation

The isolated real Jobflick workflow attempts its pinned Linux dependency installation from the GitHub runner's existing apt indexes first. If those are stale or missing, it refreshes indexes and retries, with bounded HTTP timeouts and package retries. This avoids redundant slow Ubuntu mirror refreshes while retaining a real Fish + Rust/Firefox acceptance path. Successful CI installation is not evidence of local EndeavourOS/Hyprland acceptance.

## Pending native validation and stale YAML replies

A repeated pointer/focus event for the same unchanged code block must not
issue another `validate_spec` request while the previous check is pending.
If the YAML changes before the asynchronous validation response arrives, that
response must not insert a Run control for obsolete source text. A new,
explicit pointer/focus event can validate the edited block separately.
Behavioral tests use an intentionally unresolved native validation promise to
exercise both races; no `submit_spec` occurs. These are Node acceptance
checks, not a claim that the current authenticated ChatGPT React DOM has been
tested. [Passing Firefox checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40030357579).

## Synchronous application rejection of file handoff

The inert attachment adapter validates the assigned Firefox `FileList`
before notifying the page and checks it again afterward. If a page-side
`change` listener immediately clears or replaces the selection, disables
the input or detaches it from the document, the adapter refuses to claim
even DOM-level success. Disposable Firefox Developer Edition tests include
both synchronous clearing and detachment on `change`. A successful return
still means only that the file remained assigned in the DOM at that instant;
it is **not** evidence of ChatGPT upload acknowledgment or server persistence.
[Passing Firefox file-handoff checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40030357579).

## Keyboard activation and stored-record ID consistency

The disposable Firefox Developer Edition synthetic page now activates a
production Run control through both Enter and Space. In both tests, the
QA-only background explicitly refuses native submission; no command runs.
These native browser keyboard tests support accessibility work but do not
constitute screen-reader or authenticated ChatGPT acceptance.
[Passing keyboard/browser CI](https://github.com/sguzman/jobflick-bridge/actions/runs/40030568393).

For each persisted browser record, the native job ID is the local map key.
An older, imported or corrupted object that claims a different `record.id`
cannot appear as an actionable inbox row, be status-polled, be selected for
report export, pass original-chat preflight, or be forgotten under the false
identity. The mismatched record remains in browser storage for explicit
recovery rather than being deleted or rewritten. Node regression tests and
the Firefox check workflow passed.
[Passing identity consistency CI](https://github.com/sguzman/jobflick-bridge/actions/runs/40030699492).

## Asynchronous native results and revoked local authorization

Jobflick's durable executor may answer after the user has forgotten a
finished bridge record, after a native-identity contradiction quarantines it,
or after a browser route changes. The browser bridge must compare the saved
job ID **key**, origin, tab ID, canonical conversation and submission identity
again before exposing a fetched report or claiming original-chat verification.
A late `show` cannot return a report after Forget/quarantine/replacement.
A late `inspect` cannot paint an old chat or overwrite a replacement record.
A late accepted `cancel` does not annotate a replacement/quarantined record,
and must be reconciled manually rather than blindly retried.

The regression fixtures delay native requests and popup composer probes while
in-process state is explicitly changed. Tests also ensure that a deliberately
orphaned result can still be downloaded by a separate explicit manual action,
that malformed stored IDs cannot keep tab session tokens alive or participate
in tab cleanup, and that an active-tab read-only probe or visible scan refuses
stale destination feedback after a SPA route change or tab switch.

These are mock-native and synthetic Firefox Developer Edition acceptance
checks, not tests of real authenticated ChatGPT attachment chips, upload
acknowledgment, browser profile restart, or automatic Send. The production
extension retains **no automatic attachment or Send path**.
[Passing Firefox checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40032306863).

## Route-bound Run controls on a Firefox SPA

The production content script records the normalized origin/pathname of each
code block when requesting native validation. A delayed `validate_spec`
response cannot add a Run button if the code block left `main`, its YAML
changed, or the browser has navigated to a different conversation. A trusted
click on an earlier route's still-connected button removes the stale control
without sending `submit_spec`. Even if a React rerender reuses exactly the
same code DOM node and YAML on the new route, a fresh pointer/focus event must
cause a new validation. Query parameters and fragments do not by themselves
change the conversation route identity.

Node regressions include pending validation across navigation and moving
code outside the chat main area. A disposable Firefox Developer Edition
integration test uses the real content script, retains the old DOM node
through `history.pushState`, verifies that the earlier button is removed,
and then obtains a newly validated control on the new route. Its synthetic
background explicitly refuses submission. This does not establish live
authenticated ChatGPT DOM compatibility, report attachment or Send.
[Passing Firefox checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40032659397).

## Same-ID replacement, pending submission, and bounded Run status

Browser-local job IDs can be deleted/replaced while an explicit **Forget**
request or browser startup reconciliation is waiting on storage and session
lookups. Both operations now check the original recorded tab ID, origin,
conversation and submission identity inside the serialized mutation before
deleting or orphaning a record. An older operation must not mutate a newer
same-ID mapping. The tests deliberately replace storage entries between
the first read and the final mutation.

When Firefox navigation races a pending session token write, SPA route
reconciliation waits for that in-flight write before clearing the origin
token. A late token mint must not revive the identity of the previous
conversation. When a native submission response arrives after navigation,
the original content-script Run control is removed rather than painting
a queued/failed acknowledgment into the new chat. Native submission still
happens **exactly once**; the authoritative result remains in Jobflick.

Displayed Run status is monotonic: terminal states cannot be downgraded by
delayed queued/running or conflicting terminal events. The DOM keeps its
terminal label but its strong JS job-to-control mapping is released. To
avoid holding thousands of DOM buttons in a long-lived ChatGPT SPA, the
content script retains at most 128 active job mappings. When that capacity
is exceeded, the oldest live status mapping is evicted; the complete and
authoritative history remains in the Jobflick daemon and the extension's
bounded inbox. A 140-job Node stress fixture exercises eviction, newest
status reporting, and terminal immutability.

These are native-protocol and synthetic Firefox safety/scale checks, not
live authenticated ChatGPT file delivery, real desktop memory profiling,
or automatic Send acceptance. [Passing Firefox checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40033650901).

## Bounded fast checks and native-host registration integrity

Short-lived post-submit status checks are limited to six attempts per job.
Transient or persistent `browser.storage.local` errors now consume that
finite budget instead of rescheduling a timer indefinitely; durable Firefox
alarms remain responsible for later recovery. Jobs quarantined for a native
identity mismatch leave the fast-check list immediately. Adversarial Node
tests passed in [Firefox checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40036931931).

The optional user-invoked Fish native-host installer uses a disposable
staged wrapper and manifest. It refuses existing conflicting or symlinked
wrapper files, publishes new files without clobbering a concurrent
registration, and permits reinstall after uninstall only when the retained
wrapper exactly matches the proposed executable. Disposable HOME tests also
verify that binary Native Messaging framing remains intact. No CI test
changed a personal native-host manifest. The pinned Jobflick daemon plus
Firefox native acceptance passed [real integration](https://github.com/sguzman/jobflick-bridge/actions/runs/40036931862).

## Native identity metadata and bounded inbox entries

Optional native `id` and `origin_tab_id` fields are treated as authoritative
if explicitly supplied, whether on the response object or its nested
`job` object. A conflicting field fails closed on submission, quarantines
an inspected job, or prevents finished report export. Null and wrong-type
values also contradict the expected identity; absence is permitted for
older Jobflick host versions.

Native/legacy job names displayed in the Firefox inbox are capped at
160 characters and the optional color must be a valid six-digit hexadecimal
value. Legacy URLs are canonicalized before the popup receives them; foreign
or unsupported routes cannot become Open chat targets. Old records are not
silently rewritten. Normalized comparisons preserve the earlier low-idle
guarantee when optional native name and color are missing.
[Passing Firefox checks](https://github.com/sguzman/jobflick-bridge/actions/runs/40036931931).

These tests do not establish authenticated ChatGPT upload, attachment
acknowledgment, guarded Send or production-profile idle power measurements.

## Verified M5-04: no giant report text injection

The full Jobflick report is not pasted into any ChatGPT composer.
The production inert File builder imposes the 512 KiB upper bound, stable
text/plain report identity and explicit file-input-only handoff. The
production bridge leaves attachment and Send disabled pending authenticated
site acceptance.

An isolated Firefox Developer Edition run exercised a real pinned Jobflick
daemon with a fixed harmless Fish job and then retrieved the real native
terminal report. A synthetic page intentionally contained a nonempty,
contenteditable draft and existing user-attachment indicator. After native
completion and an explicit QA-only local File handoff, both remained byte-for-
byte unchanged, with no controls injected into the composer. The exact
job-specific filename was checked independently. This is **not** confirmation
that ChatGPT accepted any upload, and does not complete M5-03/M5-05/M5-06
or guarded Send. [Real pinned daemon acceptance](https://github.com/sguzman/jobflick-bridge/actions/runs/40039054521) ·
[Firefox/static tests](https://github.com/sguzman/jobflick-bridge/actions/runs/40039054482).

## Verified M1-05: Firefox Run-control accessibility semantics

The actual production Run button exposes a computed `button` role and
`Run Jobflick` in its accessible name through Firefox's WebDriver
accessibility APIs. Firefox accepts both native Enter and Space activation
as user input; once submission is uncertain, the button is disabled so
another keyboard/pointer action cannot enqueue a duplicate. This runs
in disposable Firefox Developer Edition, without native execution or
access to a user's browser profile.

The focused acceptance evidence is [Firefox CI](https://github.com/sguzman/jobflick-bridge/actions/runs/40039332191). The broader
screen-reader, reduced-motion and high-contrast usability audit remains
unverified under M7-04; this gate covers the accessible Run control itself.

## Verified one-command isolated QA launcher

The target-side command `fish scripts/qa-firefox-developer.fish` starts
Firefox Developer Edition with its own `--no-remote --profile` directory,
without registering a native host or changing personal Firefox profiles.
Empty, relative or root-level `XDG_DATA_HOME` overrides are rejected, as
are symlinked QA profile boundaries. Loading the temporary add-on into this
separate QA window remains an explicit one-time step.

[Passing Firefox/Fish launcher acceptance](https://github.com/sguzman/jobflick-bridge/actions/runs/40039689984)
runs the actual Fish launcher against a fake Firefox executable and private
HOME/XDG tree, proving its arguments, directory permissions, symlink denial,
and preservation of sentinel files representing personal Firefox profiles
and native-host registration. The same run loads the production add-on in a
disposable Firefox Developer Edition profile. This does not establish
real authenticated ChatGPT attachment, Send or signed release acceptance.

## Verified M1-08: Firefox multi-tab and event-script reload

Disposable Firefox Developer Edition Native Messaging acceptance opens a
second independent conversation tab with identical valid YAML. Without
a user Run gesture it gains no Run control and does not orphan the first
tab's result. After the original route changes A→B→A, delivery stays
manual-only. A CI-only action calls actual Firefox `browser.runtime.reload()`;
the page is refreshed, the durable record remains manual-only, and the
native host receives no duplicate `submit_spec`.

The test uses unchanged production content and background logic except
localhost-only test routing and explicit CI diagnostics; it passes with
both the nonexecuting native fixture and the isolated pinned real Jobflick
daemon executing a fixed harmless Fish job.
[Firefox acceptance](https://github.com/sguzman/jobflick-bridge/actions/runs/40039689984) ·
[real native integration](https://github.com/sguzman/jobflick-bridge/actions/runs/40039686846).

This verifies the M1-08 Firefox lifecycle task, not a full browser-process
restart, authenticated site delivery, or real desktop compositor recovery.

## Verified M7-01: adversarial Firefox and native protocol behavior

Disposable Firefox Developer Edition explicitly tested both directions of
the Run authorization boundary. A hostile `data:` page with Execarium-like
YAML received no production extension control, reflecting the restrictive
manifest host permissions. Separately, a synthetic QA conversation loaded
the unmodified production content script and invoked `.click()` plus a
dispatched `MouseEvent` from page JavaScript: zero `submit_spec` messages
were emitted. Real WebDriver-generated trusted mouse and Enter/Space
activation was tested separately and cannot implicitly retry an uncertain
submission.

The existing Node adversarial matrix also rejects prototype-property job
IDs, conflicting top-level/nested native job ID or origin, quarantined
report/cancel requests, missing or stale tab authorization, oversized
or modified YAML and forged extension popup messages. A failed native
submission is never automatically retried. Static tests, Mozilla lint,
Firefox add-on installation, forged-click checks, local File checks and
manual export all passed in
[Firefox CI](https://github.com/sguzman/jobflick-bridge/actions/runs/40040280329).
This closes M7-01's browser/native safety-test gate, not authenticated
ChatGPT site end-to-end validation or user-profile security assessment.
