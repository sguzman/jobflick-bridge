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
| Firefox Developer Edition extension loads | No manifest/background errors | Not run |
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
