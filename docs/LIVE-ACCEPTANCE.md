# 🧪 Remaining delivery acceptance program

This is an execution contract for a local development/QA agent working directly
on `main`, not a prompt to bypass an incomplete test. The structured source of
truth is [acceptance-gates.json](../acceptance-gates.json), consumed by
`node scripts/qa-next.mjs`. Only atomic tasks with evidence in
[progress.json](../progress.json) can become verified.

The acceptance order starts with M5-01: discover the **real authenticated
Firefox Developer Edition** file-upload path in a dedicated QA profile.
Proceed from native report attachment to acknowledged upload, draft safety,
separate guarded Send and uncertain-delivery recovery. Run the 16-conversation
and restart matrix before the final live acceptance gate. Request signing only
after all other tasks are verified, then test the signed XPI persistently
before release.

The one-time account sign-in, if needed, is separate from recurring QA;
subsequent executions should be automated rather than delegating manual
click-through to the user. Never use a personal browser profile as an
automation target. The read-only composer harness is a preliminary observation
tool; it **does not** prove authentication, attachment or Send.

## Evidence protocol

Record for each task: exact tested source SHA, test implementation and command,
actual target environment (Node mock, synthetic disposable Firefox, real
pinned Jobflick, or live authenticated Firefox), pass/fail assertions,
run URL or sanitized reproducible test log, and specific untested residuals.
The absence of a screenshot or logging of private content is intentional:
prefer safe boolean assertions and scrubbed QA fixtures.

Do not promote a task to verified because code exists, a flag was observed, a
FileList was assigned, a page received an event, or an unsigned ZIP loaded.
Failed or interrupted Send must never produce an automatic retry. If the
origin session is lost or the outcome is ambiguous, retain durable local
Jobflick results and the manual export path.

## Guardrails

No personal Firefox profile alteration; no private conversation data in
public commits or GitHub Actions logs; no command execution except reviewed
harmless fixtures in isolated environments; no automatic Send before
authenticated acceptance. Work directly on `main` with narrow commits.
Retain machine-readable percentages and cite the test run that justified a
verified state. Never force an unsupported 100% completion claim.

## General-file upload discovery hypothesis (not accepted)

Public ChatGPT upload instructions use the composer add-files menu. Independent
third-party DOM references from 2026 describe a general file input named
`#upload-files`, separate from photo/camera inputs, and a composer add menu
button named `[data-testid="composer-plus-btn"]`. These references are
**hypotheses** only: they are not evidence that the current authenticated
Firefox site still exposes or honors either selector.

The production read-only content probe now reports separate bounded
candidate counts and usable/disabled flags for the *general document* target
and add-files control. Seeing multiple `input[type=file]` nodes is therefore
not mistaken for several general-report destinations. Probe output never
contains drafts, file names or URLs and never clicks, uploads or sends.
Disposable Firefox QA exercises one general + two other inputs. M5-01 stays
unverified until the dedicated authenticated Firefox Developer Edition
profile independently establishes the supported route, upload behavior,
and selector compatibility.

References: https://openai.com/academy/working-with-files/
https://github.com/Dworrall21/chatgpt-bridge/blob/main/dom-selectors.md
https://github.com/veithly/gpt-pro-think/blob/main/references/dom-selectors.md
