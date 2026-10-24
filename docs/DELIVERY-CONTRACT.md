# 📎 Report attachment and Send acceptance contract

**Status: design contract only.** Automatic ChatGPT attachment and Send are NOT implemented or enabled. This document defines what must be proven in an isolated, authenticated Firefox Developer Edition QA profile before that can change.

## 🔒 Preconditions

1. A Jobflick job was created after the user intentionally activated a trusted Run control. Its YAML has no model-supplied browser origin.
2. Jobflick has an authoritative, terminal job record. The native `origin_tab_id`, when supplied, matches the extension-minted token.
3. The exact original Firefox tab instance, canonical ChatGPT conversation URL and session token remain valid. A route change invalidates automatic delivery permanently for that job even if the URL later returns.
4. A bounded, explicitly named `text/plain` File can be built from a native Jobflick report. Never paste full report logs into the chat composer as a substitute for a verified attachment.
5. The composer and any existing draft/attachments can be inspected without changing them. If the state is occupied or uncertain, hold the result for manual delivery.
6. An initial rollout requires an explicit per-job or user-setting opt-in to automatic report Send. A Run click by itself is not used to bypass any failed downstream safety check.

## 🧾 Delivery-state model

| State | Meaning | Permitted action |
| --- | --- | --- |
| `awaiting_completion` | Job is unfinished | Bounded native status inspection only |
| `report_pending_manual_delivery` | Terminal job and report available | Explicit local Save report or verified destination preflight |
| `attachment_preparing` | A separately gated adapter is building a local File | Bounded local preparation; never Send |
| `attachment_confirmed` | Real site UI confirmed the *specific* report file is attached | Guarded Send may be considered if draft and origin still valid |
| `send_requested` | Exactly one Send action may have been dispatched | No automatic repeat; reconcile outcome |
| `delivery_verified` | ChatGPT showed reliable completion of that exact file/message | Can report success; no repeat |
| `delivery_uncertain` | Upload or Send outcome not authoritative | Show manual follow-up; never silently retry |
| `manual_only` | Origin/draft/attachment gate failed or provenance was lost | Preserve native report and local export; no auto-rebind |

The automated attachment and Send states are reserved concepts, not claims about today's code. The production inbox now recognizes a persisted `delivery_uncertain` outcome and protects it across orphaning/reconciliation, but it does not initiate a ChatGPT upload or Send. This is state-model acceptance, not evidence of site delivery.

## 📤 Attachment acceptance

The adapter must demonstrate in **actual authenticated Firefox Developer Edition** that a supported user-facing upload mechanism accepts a File, that ChatGPT displays the expected name, and that the expected file is associated with the same composer. Mere presence of `input[type=file]`, a `change` event, an HTTP request, or file-picker attributes is **not** evidence of attachment.

A prepared File is never transmitted to a different tab or conversation. Existing messages, selected attachments, clipboard contents and draft text must remain untouched. The bridge must fail closed if the origin changes at any point before a confirmed Send.

## 💬 Guarded Send

A Send action requires: valid original tab identity, an unoccupied verified draft, no unexplained preexisting attachments, confirmed target File, and one-time authorization for this job's delivery. Recheck immediately before Send. Neither a timed-out upload nor an ambiguous acknowledgement authorizes another click. Do not equate button invocation with delivery completion.

If a future site change prevents reliable confirmation, disable that route and retain manual report export. Never invent selectors or assume private ChatGPT APIs are stable.

## 🧪 Required QA matrix

- ✅ Valid, harmless Jobflick job finishes through real Firefox Native Messaging (already independently covered).
- ☐ Authenticated Firefox attaches the specific bounded `text/plain` report and confirms name/association.
- ☐ Existing nonempty draft blocks automated Send without deleting or changing it.
- ☐ Existing attachment(s) block automated Send unless explicitly accepted in the future contract.
- ☐ Navigate A→B→A during upload or between attachment and Send: no misrouted content or automatic retry.
- ☐ Close tab, restart Firefox, suspend event page or lose native connection: durable result becomes manual/uncertain, never duplicated.
- ☐ 16 independent conversations, long transcript and DOM re-render: each report stays tied to exactly one provenance token.
- ☐ Failure/cancelled job report handling has an explicit non-invented delivery policy.
- ☐ Repeated callbacks and racing status events cannot attach/send twice.
- ☐ Manual Save report remains available after any failure, without deleting the underlying Jobflick report.

## 🛟 Rollout boundary

The current production add-on remains manual-export-only. Activation of real attachment and Send requires new, evidence-backed roadmap tasks, verified real-site FDE QA, and a versioned user-facing opt-in. Synthetic browser fixtures and Node mocks provide useful negative tests but cannot independently unlock production Send.

## 🦊 Verified local handoff building block

An inert helper, `extension/attachment-adapter.js`, can construct a bounded `text/plain` File with a stable `jobflick-{id}.txt` name and transfer it to an explicitly supplied, empty, connected file input using Firefox's `DataTransfer` API. The helper refuses existing file selections and explicitly returns `domHandoffOnly` rather than treating a synthetic `change` event as successful upload.

The helper has no message listener, no ChatGPT selectors, no outbound API requests and **no Send path**. It is bundled with the extension but is not invoked by the production UI. The localhost test invokes it independently and is not acceptance of uploading into ChatGPT.

## Verified synthetic full-local path, remaining real-site gate

Real Firefox Developer Edition now exercises a complete **local** path from a real, fixed harmless Jobflick job to the user's page-side File API. A test-only background handler retrieves the finished native report on a real browser click; the production File helper creates a bounded `text/plain` File, and a synthetic localhost page reads it. Navigating away and back revokes further transfer. This tests local protocol, provenance and DOM handoff, not ChatGPT's actual file-upload acceptance, attachment chip, server persistence or message submission.

Production does not register the QA-only report-read handler, and automatic attachment and Send remain disabled.

## Empty-composer handoff primitive (inert; not live acceptance)

The site-neutral `handoffToEmptyComposer` helper composes the bounded FileList
handoff with fail-closed checks for exactly one identified editable composer,
exactly one identified file input, an empty draft, verified absence of existing
attachments, and both original conversation route and monotonic navigation
epoch. It rechecks route, epoch and draft immediately after the page's synchronous
change handler, catching even an A→B→A transition. If authorization is lost
during that handler, it clears the staged selection **only if it still points
to the identical File supplied by the bridge**. A file replaced by the page
is not cleared. This is best-effort DOM cleanup, not a guarantee that a page
did not begin asynchronous upload before the check. The caller must supply
these preflight observations from a separately verified site adapter; the
helper neither discovers live ChatGPT controls nor sends a message.

This helper is not invoked by the production UI. Its return value remains
`domHandoffOnly`; a real site's attachment chip/server acknowledgment and
authenticated Firefox Developer Edition QA are still necessary.

## Synthetic draft-preservation acceptance

Disposable real Firefox now tests the production read-only probe against an occupied synthetic contenteditable draft and a preselected `File`. Both remain unchanged; the background receives only booleans, and the probe also recognizes an empty composer after a deliberate QA reset. Because no production upload is enabled, this is a negative-test building block rather than completion of the authenticated preserve-draft and Send gates.

## Inert delivery proposal state machine (not a production Send feature)

`extension/delivery-policy.js` offers a side-effect-free `propose` transition
function with negative tests. It requires per-job original tab/token/route and
navigation-epoch matching, a single empty composer, absence of existing files,
a separately confirmed **site** attachment receipt for the exact report and
composer, and an independent per-job Send opt-in. It never interprets a
FileList handoff as site acknowledgment. Send is only proposed after an
`attachment_confirmed` state; a duplicate request, lost origin, restart, or
unconfirmed outcome is blocked and transitions toward manual or uncertain
recovery.

The function only **proposes** a next state. A future controller must atomically
persist its `attachment_preparing` and `send_requested` reservations and
recheck live site authorization before carrying out any page action. This
script is not loaded by production and has no network, DOM, Native Messaging,
or Send side effects. Its tests are necessary negative acceptance evidence,
not proof of a real ChatGPT site receipt or delivery. Production remains
manual-export-only.

## Failed/cancelled job report policy

The inert delivery policy permits future *automatic* attachment and guarded
Send only for Jobflick `succeeded` records. Failed, cancelled, timed-out and
interrupted job reports remain accessible through the existing manual
`Save report` fallback. A known-orphaned record or any record carrying a
native-identity integrity issue is never allowed to regain automatic
attachment or Send authorization, even if a later URL/token claim matches.
Origin loss updates the proposed `orphaned` metadata and keeps previous
Send uncertainty visible. These are tested policy rules, not enabled Send.

## Visibility of interrupted reservations

The production inbox projects any persisted `attachment_preparing`,
`attachment_confirmed`, or `send_requested` record as
`delivery_uncertain`, without rewriting the underlying record. This avoids
misleading users into treating a staged/possibly-dispatched delivery as an
ordinary fresh manual result. The popup continues to offer explicit report
recovery; it never automatically retries upload or Send.

When the original tab is lost or a browser restart interrupts a staged
File or Send, production changes the durable state itself to
`delivery_uncertain` and permanently revokes the original automatic-delivery
grant. A confirmed-but-not-sent attachment becomes `manual_only` when the
origin is lost. Unit tests and the disposable Firefox process-restart QA cover
these futures, but no production automatic attachment/Send has been enabled.

## Live-candidate revalidation after File handoff

The inert `handoffToEmptyComposer` helper now requires trusted callbacks
`currentComposerCandidates()` and `currentFileInputCandidates()` in addition
to its original unique composer/input lists. It checks the freshly resolved
unique identity immediately before and after the synchronous File change
event. If the page adds another input, replaces the composer or changes
the attachment target, the helper rejects the handoff and clears **only**
the exact File it staged in the still-connected input. Existing user files
in other inputs are untouched. Disposable Firefox Developer Edition covers
the mutated-candidate case; this is not evidence of ChatGPT upload acceptance.

## File cleanup on failed synchronous DOM handoff

Both the direct File handoff and the guarded original-composer wrapper now
clean up their own File selection after a failed assignment, a page-side
disable/detach, or a changed route, epoch, draft or live candidate set.
The cleanup matches **object identity**, not filename/size, so it never
removes a page-replaced File. It also attempts to clear its File from a
detached input still held in memory. Cleanup is best effort: a page may have
started asynchronous upload before any synchronous failure becomes visible,
so successful DOM cleanup is never an authenticated site acknowledgment or
proof that bytes were not previously transmitted.
