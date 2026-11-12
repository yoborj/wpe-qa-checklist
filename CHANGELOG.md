# Changelog

All notable changes to WPE QA Checklist. Versions follow [semantic versioning](https://semver.org/); each one is
tagged `vX.Y.Z` with a GitHub release.

## Unreleased

### Added
- **Answer Claude in the app.** When a "Have Claude fix these" run needs your decision, the tab shows a
  **Claude needs your answer** box with each question. **Send answer and continue** backs up again, continues the
  same Claude Code conversation with your answer, and re-checks the tab. Items waiting for you show
  **Claude has a question** and are left out of **Apply fixes (N)**; the fix history keeps each question and answer.
- Command line: `fix … --claude` prints Claude's questions; `answer <site> <tab> <fix-run-id> "<answer>" --yes`
  sends the answer.
- **Retry fix request (N).** Once approved items are in a fix request, Apply fixes no longer offers them (until the
  checks run again), so the button disappeared and there was no way to send them to Claude. Now, when nothing else
  is waiting, the button reads **Retry fix request (N)** and opens the same confirmation window with those items.
  Command line: `fix … --yes --retry`.
- Tests for reading Claude's verdicts and questions (`test/claude.test.mjs`) and for which items a fix run plans
  (`test/fixers.test.mjs`).

### Fixed
- A headless Claude fix run could stop to ask for a go-ahead (it read the repository's interactive `CLAUDE.md`
  workflow), end without fixing anything, and leave its question only in the run log. It's now told that the
  approval is already given and to report a `question` per item instead; a run that still ends on a question is
  shown as one. Runs keep their Claude session, so the conversation can continue.

## 0.2.1 — 2026-11-03

Still requires **Greenlight v0.2.0 or newer**.

### Changed
- Checked against Greenlight 0.2.0 as released: its `wp greenlight set` keys are the feature names this app uses,
  and `wp greenlight security --format=json` prints the shape this app reads (schema 1). The fix's TODO is gone.
- The fix confirmation window shows the Greenlight command as plain text (no stray backticks).

### Added
- Tests with Greenlight 0.2.0's own example output and with a site just upgraded from 0.1.x (alert features off).
- README: the web app's Greenlight items, the version badge and the fix window, with screenshots.

## 0.2.0 — 2026-10-22

**Requires Greenlight v0.2.0 or newer** for the Greenlight security items. With an older Greenlight, or none,
the items say so ("update Greenlight to v0.2.0+", "not installed"); everything else works as before.

### Added
- **Greenlight security status.** Run Tool reads `wp greenlight security --format=json` over SSH (one short
  call per run): staging for QA — Before Launch, production for QA — After Launch.
- **QA — Before Launch → Greenlight security hardening.** Fails while any recommended feature is off (security
  headers, hide usernames, file editor off, email obfuscation, admin-change alerts, script-drift alerts, core-file
  check, content check). HSTS and CSP (report-only) are shown for information only.
- **QA — After Launch → No open Greenlight security alerts.** Open alerts grouped by severity; any high alert
  fails, medium and low need a look.
- **Fix:** approving Greenlight security hardening turns the off features on with `wp greenlight set <feature> 1`
  (one short command each) through the usual approve → backup → apply → re-check flow.
- Clear results when Greenlight is not installed, inactive, too old for the command, reports an unsupported
  schema (anything but schema 1), or prints invalid JSON. None of these stop a run.
- The HTTP Security Headers and Exposed email addresses suggestions name the matching Greenlight feature and
  say whether it is on.
- Greenlight in the Markdown report (a **Security:** line), in `status`, and a new read-only
  `node bin/wpeqa.mjs greenlight <site>` command (staging and production).
- `npm test`: the Greenlight parser, items, fix and report against saved output (valid, old Greenlight, not
  installed, inactive, bad JSON, schema 2). No site needed.
- The app's version next to its name in the header, in `npm start`'s output and in `wpeqa help`.

### Note
- At release, Greenlight's security setting keys weren't documented yet; 0.2.1 confirms them.

## 0.1.0

First version: QA Swarm, WP Site Audit, QA — Before Launch, QA — After Launch and Old → New URLs tabs, Run Tool,
approve → backup → apply fixes, Claude Code `/qa` and `/fix`, and the `wpeqa` command line.
