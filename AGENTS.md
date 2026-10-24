# Autonomous repository agent contract

This is the active direction for local coding agents and Codex on
`sguzman/jobflick-bridge`. Follow it before making changes.

## Mission and authority

Complete the Firefox Developer Edition-first Jobflick Bridge through verified,
authenticated file attachment, one-time guarded Send, Mozilla-signed Firefox
installation and a provenance-backed release. Work **directly on `main`**;
commit small validated changes, do not create PRs or long-lived branches.
`ROADMAP.md`, `progress.json`, `acceptance-gates.json`,
`docs/DELIVERY-CONTRACT.md`, `docs/LIVE-ACCEPTANCE.md` and
`docs/SECURITY.md` define the objective and its safety boundaries.
Do not replace these gates with a smaller proof of concept.

The user defines goals and constraints. The agent plans, investigates,
implements, debugs, tests, reviews and documents without using the user
as an intermediary for terminal commands, browser QA, file edits, GitHub
operations or iterative debugging. Work through the dependency graph
until an environmental or authorization boundary genuinely prevents
further safe progress. At that boundary record exact missing evidence and
continue independent work wherever possible.

## First action on each invocation

1. Read this document, `docs/LIVE-ACCEPTANCE.md`, `progress.json` and
   `acceptance-gates.json`. Run `node scripts/qa-next.mjs`.
2. Inspect `git status`, current `main` HEAD and recent CI results.
   Do not overwrite independent local work. Resolve concurrent changes
   carefully; do not force push.
3. Choose the earliest open dependency-compatible acceptance gate. Create
   minimal testable implementation steps; do not simply mark tasks done.
4. Run `npm run check`, appropriate Firefox Developer Edition QA, and
   real pinned Jobflick integration for native-facing changes.
   Inspect failures, fix regressions and rerun until evidence is obtained.
5. Commit directly on `main` only after tests and a source/privacy review.
   Record verifiable test identifiers and environment in the relevant
   ledger item. A successful mock cannot verify a live-site requirement.

## Production boundaries

- **No automatic job execution**. Only a trusted Run Jobflick click can
  submit a reviewed Execarium document; no stale route or retries after
  uncertain native acceptance.
- **No unaccepted automatic attachment or Send**. Current production is
  manual report export. The File adapter and delivery-policy module are
  preparatory only. Require the specific authenticated Firefox site
  attachment acknowledgment and separate guarded per-job Send consent
  before wiring them into production. Never infer delivery from a
  `FileList`, a change event, a button click or a completed browser request.
- Preserve original conversation identity across navigation, tab closure,
  process restart and asynchronous callbacks. A->B->A is not a renewal
  of an earlier grant. Persist the one-time Send reservation *before*
  side effects; ambiguous results never self-retry.
- Preserve user drafts, clipboard and existing attachments. Never
  overwrite, delete or move another person's content to make a test pass.
- Firefox Developer Edition on Linux is the sole acceptance browser.
  Do not substitute Chrome, Chromium or Edge, or change the user's
  personal/default Firefox profile.

## Live and local QA

Use an isolated dedicated Firefox Developer Edition QA profile and the
least invasive probes first. After legitimate one-time authentication
performed outside source control, automate all repeatable harmless QA.
Never bypass sign-in, security checks, or an account's permissions.
The read-only `tests/live-composer-audit.cjs` can collect sanitized
counts without authorizing any live Send. A functioning dedicated
profile does not itself establish authentication. No site-specific
selector or attachment acknowledgment is accepted without an
observed real signed-in session.

Never test arbitrary commands: native execution fixtures must be
deterministic, harmless and isolated from personal data. GitHub Actions
and synthetic localhost fixtures may verify plumbing, not authenticated
ChatGPT behavior. Signing is manual, gated and unlisted until all
prerequisite live acceptance is complete; do not publish a signed XPI,
tag or release until signed installation and release evidence pass.

## Privacy and public history

This repository is public. Never put private conversations, drafts, job
YAML, actual reports, account names, session URLs or tokens, cookies,
personally identifying data, private venting text, personal file paths,
screenshots of authenticated pages, proprietary assets or secrets in
source code, fixtures, comments, logs, test artifacts, commits or issues.
Use synthetic content, boolean assertions and scrubbed evidence.
Do not collect browser network traffic, browser profiles or transcript
contents for debugging. Review the staged diff *and commit message*
before pushing. Do not copy material from the separate legacy
Script-Monkey repository beyond appropriately licensed reference work.

## Progress integrity and communication

`progress.json` is authoritative. Percentages reflect **verified** atomic
tasks only; implementation and planning do not count. No unsupported
100%. Preserve stable task IDs, milestone totals and machine-readable
evidence. Cite the exact CI job/source SHA or safe reproducible local
acceptance log, with honest remaining limitations. Stop reporting
completed tasks as active work; report only in-progress milestones and
specific blockers. Avoid verbose logs or unneeded user questions.
If actual authenticated Firefox access is unavailable, state that
explicitly and work on independent production quality and validation
rather than inventing live-site success.
