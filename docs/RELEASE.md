# 🦊 Firefox packaging and signing gate

This repository builds an independent Firefox Developer Edition WebExtension.
No release is approved while authenticated ChatGPT attachment acknowledgment,
draft preservation and guarded same-conversation Send remain unverified.

## Reproducible unsigned source package

Run `fish scripts/package-unsigned.fish /path/to/jobflick-bridge-unsigned.zip`.
The script packages only the `extension/` tree: stable file ordering,
normalized UTC ZIP timestamps, no metadata extras, no compression variability,
and no symlink following. It refuses an existing output file. It does not
install anything, register a native host, change Firefox preferences, copy
personal files, sign or publish. The real native-integration CI builds the
archive twice, compares exact ZIP bytes, validates its members and records its
SHA-256. GitHub's separate `web-ext build` archive remains a short-lived
unsigned QA artifact rather than a signed release.

## Mozilla signing (not yet accepted)

Firefox normally requires Mozilla-signed add-ons for persistent installation.
Mozilla documents the [signing and distribution process](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
and the [`web-ext sign` CLI](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/).
A future approved unlisted distribution can request Mozilla signing with
`web-ext sign --channel=unlisted` and API credentials, then verify and
record the resulting signed XPI SHA-256. The fixed Gecko ID must match the
native-host `allowed_extensions` registration. AMO credentials must remain
in secret storage, never in this public repository, workflow logs, test
fixtures, issues or local CLI examples. No signing or publication has been
performed by this project yet.

Temporary add-on loading in a disposable Firefox Developer Edition QA profile
is appropriate during development; this is *not* a substitute for signed
distribution. There is no reason to turn off signing verification in the
user's everyday browser.

## Release acceptance

A future SemVer release requires all atomic acceptance gates in
`progress.json` verified, including authenticated Firefox Developer Edition
delivery and no-duplicate Send recovery, production signed-XPI installation,
and an explicit verified version/commit/tag/changelog match. Before release,
inspect the unsigned package for unexpected files, ensure that no user data
or private text appears in public artifacts, and record both source commit
and signed XPI hash. The package build does not confer release approval.
