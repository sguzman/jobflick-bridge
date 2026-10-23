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

These future states are reserved concepts, not claims about today's code. Only existing current states appear in the active extension.

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
