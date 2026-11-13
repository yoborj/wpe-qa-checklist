# Changelog

All notable changes to WPE QA Checklist. Versions follow [semantic versioning](https://semver.org/); each one is
tagged `vX.Y.Z` with a GitHub release.

## Unreleased

### Added
- **Revert fix.** Fixed cards whose fix a fix run made (by the app or Claude) get a Revert fix button (`revert <site>
  <tab> <item> --yes` on the command line). After you confirm, it takes a fresh backup, has Claude undo only what that
  fix changed, from the backup taken just before it (single files and values, never the whole database or theme, never
  the other items from that run, nothing edited since), waits for new PHP, clears caches and re-checks the item. A
  reverted item shows "Fix reverted" and asks for a decision again, so the next Apply fixes doesn't redo it.
- **Why it's still failing.** Every Fix Failed card shows what the fix did (Claude's own summary, or the app's command
  output), what the re-check still finds, and what to do next (Confirm fix if what's left is on purpose, else retry).
- **Child findings.** A check can report separate problems as child cards under one item, each with its own status,
  note and Approve / Decline. Children are items of their own (`<item>::<finding>` in the CLI), so fix runs, fix
  requests, Fix Failed and Fixed work for each; the item becomes a container showing the worst of them, and a finding
  a later run no longer reports passes (an approved one moves to Fixed). The tiles count the children, not the item.
- **"Everything rendered is editable" is automatic** (WP Site Audit). It reviews the custom post types and ACF fields
  over WP-CLI and fetches every post type page, then adds a child finding for each problem: admin labels falling back to
  "Posts", fields no entry fills in, pages without a meta description, big field groups with no help text, SEO fields
  stored twice, field groups only in the database, ACF missing from the REST API, URLs that no longer match their
  entry, plural hub URLs that 404, hub pages titled "Archive", the brand missing from titles, titles over 65
  characters, abbreviations written two ways, and links between entries typed as slugs.
- **Old → New URLs arranged like the site**, so the list lines up with a hand-made URL sheet. Run Tool reads both
  sites' main menus: old pages are grouped by the old menu (its order, sub-pages indented under their parent), then
  pages not in the menu, sections such as /team/ or /location/ (hub first, entries A–Z with the words every title
  repeats dropped), legal and thank-you pages, and blog posts. Pages only the new site has are listed in their own
  groups, in the new menu's order, instead of a separate list.
  Every level of both menus keeps its depth (Programs › Medical Detox › Benzodiazepine Detox), drawn as a tree; a
  group's own page is its row (like a sheet's parent row); sections follow the order the site registers its post types
  (its public REST API), and the blog comes last. Statuses use a URL sheet's wording: No Redirection Needed, Redirect,
  Needs Attention, New Page (New Site Only). `urls <site> arrange` re-arranges a saved list without testing again.

### Fixed
- **Apply URL decisions failed with only a PHP warning** on sites with many redirects. WP Engine's WP-CLI silently runs
  nothing when a script has one very long line, and the redirect list was one ~10 KB line; data now goes in short lines
  (also the "can it keep its old URL" check). Errors leave out PHP warnings some sites print on every call.
- **Redirects named "Old site: Just a moment..."**: when the old site answered with a bot check (Cloudflare's "Just a
  moment..."), its title was taken as the page's name. Bot-check titles are never used now, and redirects are named
  the way a URL sheet names pages: the old menu label, else a name from the address ("Old site: Detox"), instead of the
  old page's SEO title; imported ones are "Old site redirect: /old-path/".

### Changed
- **Old → New URLs tiles count what's left.** A page whose redirect is in place moves from Redirect / Needs Attention
  to Done; a new **Redirect Failed** tile lists any whose apply didn't take; the Approved tile is gone (Done covers it).
  The old site's imported redirects count and filter the same way: under All the whole section shows (with its import
  box); under another tile only the redirects that belong to it, and the section is hidden when none do.
- **SSH reuses one connection per WP Engine host** (the app and Claude's fix runs, through `lib/sshbin/ssh`): each call
  takes about 1 second instead of about 20, which was most of a fix run's time (14 SSH calls in a 2-item run). Claude is
  told SSH is cheap but each WP-CLI command isn't, and to use rsync, not scp (which WP Engine's gateway refuses).
- **Runs share one crawl.** What a Run Tool loads (WordPress settings, Greenlight status, sitemap, desktop and phone
  crawls, internal link check, old-site comparison) is reused by the next module's run on the same site for 15
  minutes, with a log line saying so: QA Swarm after WP Site Audit took 3 minutes instead of 5.5. A fix run clears it
  and its re-check never uses it; Shift-click Run Tool (or `run --fresh`) loads everything again.
- **"Everything rendered is editable" reuses the crawl** for the post type pages it already loaded and fetches only the
  rest (under 1 minute instead of 3.6 on a 131-entry site).
- **A fix run re-checks only the findings it touched.** For "Everything rendered is editable", findings read over
  WP-CLI are re-checked without loading every post type page (18 seconds instead of about 4 minutes); the others keep
  their last result until the next full run.
- **Faster fix runs.** The verify step re-checks only the items the run worked on instead of the whole tab (two
  items: about 40 seconds instead of 7-9 minutes; a homepage-only check no longer crawls every page). Background Claude
  gets a site map read in one SSH call (theme files, plugins, post types, ACF field groups, pages) and is told to batch
  its SSH work. The 2-minute wait for new PHP happens only when a PHP file or `.htaccess` changed during the run.
- **Declined and confirmed items count as Passed** and show a green Passed pill (hover: what the check reported), so
  Passed + Manual To Do + N/A + Needs Attention add up to All.

### Fixed
- Screenshots taken while verifying a fix run linked to the wrong folder.

## 0.3.0 — 2026-11-12

Still requires **Greenlight v0.2.0 or newer** for the Greenlight security items.

### Added
- **Generate report.** A toolbar button that publishes an exact, view-only copy of the site's page (same tabs, tiles,
  cards and screenshots; no action buttons, notes as text) as a private claude.ai artifact, through Claude Code. Each
  report is a new artifact with its own link; **Reports (N) ▾** in the toolbar lists them all with their dates,
  newest first. Command line: `snapshot <site>` builds it, `snapshot <site> --link <url>` records a published one. The old
  **Report** button (the Markdown summary) is now **Markdown**.
- **Decided cards stay put.** An approved item stays in **Needs Attention** until its fix has run (then Fixed, or Fix
  Failed if the check still fails). Decline or Confirm fix no longer makes a card vanish from the view you're in: it
  stays with a **Moved to …** note until you pick another tile, tab or site. The counts update right away.
- **Flagged items stand out.** Items that fail or need a look with no Approve / Decline yet are flagged: a solid red
  **Needs Attention** tile (in the Flagged panel), a ring in the status color and a **⚑ Needs your decision** bar on
  each card. `status` lists them under "Needs attention".
- **Confirm fix.** For an approved fix that's done but that its check can't verify, **Confirm fix** on the item
  moves it to Fixed (**Done · confirmed by you**) until a later run finds something different. Command line:
  `confirm-fix <site> <tab> <item-id…> [--undo]`. Confirmed items are left out of Apply fixes and retries.
- **Fix Failed / Fixed / Declined views.** Decided items leave the main list, the count tiles and the tab's red badge, so
  **All** and **Needs attention** show only what still needs a decision. Each checklist gets **Approved (N)** (fix in
  progress), **Fixed (N)** (approved and passing now) and **Declined (N)**, as filter buttons and clickable count tiles.
  `status` groups items the same way, and `approve --all-failing` only approves items not decided yet (it no longer
  overrides a decline).
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
- Tests for reading Claude's verdicts and questions (`test/claude.test.mjs`), for which items a fix run plans
  (`test/fixers.test.mjs`), the email, search and GA4 checks and Confirm fix.

### Changed
- **GTM and GA4 are two clearly separate cards** in QA — Before Launch: **Google Tag Manager (GTM) container** (a GTM-…
  container in the page source) and **Google Analytics 4 (GA4) tag** (a G-… measurement ID on the page or inside the
  site's GTM container, read from Google's gtm.js). The GA4 card no longer passes on a GTM ID alone. The new names live
  in `scripts/import-sheet.py` (RELABEL), so re-importing the Audit Sheet keeps them; item ids are unchanged.
- **The count tiles are the filters.** The All / Needs attention / Manual / Approved / Done / Declined buttons are gone:
  click a count tile to show only those items; click it again or **All** to show everything. Tiles in two panels: **Checklist** (All = every item ·
  Passed, Fixed items included · Manual To Do · N/A · Automatic) and **Flagged** (Needs Attention: failed and to-look-at
  items with no decision, replacing the Failed and To Look At tiles · Fix Failed (orange: a fix ran and the check still fails) · Fixed · Declined). Every tile
  is a part of All and the list uses the same rule as the counts, so they add up exactly. Manual To Do lists manual items
  still to mark (it replaces "to do"). The section pills follow the picked tile: each shows how many cards that section has
  for it, so the section All always equals the tile (before, they showed the section's total items or a ✓). The Old → New URLs tiles filter its page list the same way.
- **QA — Before Launch → Search page** verifies itself: it passes when the site has a search form, or when it has
  none and WordPress's `/?s=` results page is turned off (redirects or answers 404/410). It needs a look only when
  there's no form but `/?s=` still shows results.
- **WP Site Audit → Exposed email addresses reviewed** is now verified automatically: it passes when every email
  shown on the site is a working mailto link (Greenlight-encoded links count) and still lists each address with its
  pages, so you can see what's public. It needs a look only for addresses shown as plain text, with a screenshot of
  each. Before, it flagged any visible email, so it could never pass once emails were meant to be there.

### Fixed
- A headless Claude fix run could start the 2-minute wait in the background, schedule a wake-up and end without
  reporting, so items it had fixed showed as skipped. Headless runs are now told never to sleep, background or schedule,
  and the app does the wait itself: after Claude reports a fix (or stops without reporting), it waits 2 minutes, clears
  every cache and re-runs the checks. `rules <site>` (interactive) keeps the wait and cache steps.
- Fix pills say where each item stands: what's happening with an approved fix (not applied yet, in a fix request,
  skipped or unfinished by Claude, waiting for your answer, applied but still flagged, failed), how a done item got
  there (fixed by the app or by Claude, including fixes a later re-check confirmed; passes now), or **Declined · won’t fix**.
- An item's fix pill kept showing the last fix run's outcome after the item passed (e.g. "Claude has a question ·
  answer above" on a done item). An item that passes now reads **Passes now**, and a question from before the checks
  ran again reads **Claude asked earlier**.
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
