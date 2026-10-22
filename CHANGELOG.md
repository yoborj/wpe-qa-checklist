# Changelog

All notable changes to WPE QA Checklist. Versions follow [semantic versioning](https://semver.org/); each one is
tagged `vX.Y.Z` with a GitHub release.

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
- Greenlight's README documents `wp greenlight set <key> <value>` but not yet the security setting keys. The fix
  assumes each key is the feature's name in `wp greenlight security` (marked TODO in `lib/fixers.mjs`). If a key
  differs, that fix fails with "Unknown setting …" and changes nothing else.

## 0.1.0

First version: QA Swarm, WP Site Audit, QA — Before Launch, QA — After Launch and Old → New URLs tabs, Run Tool,
approve → backup → apply fixes, Claude Code `/qa` and `/fix`, and the `wpeqa` command line.
