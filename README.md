# WPE QA Checklist

A local web app for QA on **WP Engine** WordPress sites. One tab per checklist, each with a
**Run Tool** button that runs the automatic checks and fills the checklist in:

| Tab | What Run Tool does |
|---|---|
| **QA Swarm** | Crawls every sitemap page on desktop and phone: HTTP status, internal links, accessibility/SEO basics, 375 px fit, phone menu, screenshots, and (with a reference site) content completeness. Scores each page and the whole site, like the `qa-swarm` skill. |
| **WP Site Audit** | The `wp-site-audit` skill's checks: collapsed and empty links, asset URLs used as links, duplicate images, junk posts and slug collisions, exposed emails, mu-plugins, long H1s, alt text, phone formats, CPT featured images, Yoast title suffix, placeholder leaks, page-local styles. |
| **QA — Before Launch** | The Audit Sheet's "QA — Before Launch" tab. 45 of 132 items are checked automatically (WordPress settings, plugins, updates, login URL, 404, alt text, tap-to-call phones, headings, tap targets, consent, security headers, schema, Lighthouse…). The rest are manual. |
| **QA — After Launch** | The Audit Sheet's "QA — After Launch" tab. 24 of 48 items are automatic (indexable, old/staging URLs in the database, SSL and mixed content, sitemap, robots.txt, noindex, staging links, consent, schema drift, console errors, Lighthouse…). |

Every item has **Pass / Fail / Look / N/A / To do** buttons and a note. Items that fail or need a look
get **Fix: Approve / Decline**, so a round of fixes can be signed off item by item. **Report** opens a
Markdown summary of the tab for pasting into the sheet, a ticket or a message.

Elementor and YOOtheme sections are kept but marked N/A automatically unless the site uses them.

## Requirements

- macOS with **Google Chrome** installed (or set `CHROME_PATH`).
- **Node 20+**.
- Your SSH key added to WP Engine (User Portal → Profile → SSH keys), so
  `ssh <install>@<install>.ssh.wpengine.net` works without a password.
- For re-importing checklists: Python 3 with `openpyxl`.

## Run it

```
npm install
npm start
```

Open http://localhost:4646, click **Add site**, and enter the WP Engine install name (the part
before `.wpenginepowered.com`). The app only listens on this Mac (127.0.0.1).

## What Run Tool touches

Everything is **read-only**:

- Over SSH it runs one `wp eval-file` that reads settings, plugins, users, posts and options and
  prints them as JSON. It changes nothing. (It does ask WordPress to refresh its plugin/core
  update check, the same thing WP-Admin does on its own.)
- In Chrome it loads the site's pages like a visitor: no logins, no form submissions, no clicks
  except opening the phone menu.
- Lighthouse runs against the homepage from this Mac.

Results, screenshots, Lighthouse reports and your checklist ticks are saved under `data/`
(git-ignored). A status you set by hand is kept when Run Tool runs again; the tool's latest
finding still shows, with **use tool result** to switch back.

## Updating the checklists from the Audit Sheet

```
npm run import-sheet -- "/path/to/Audit Sheet.xlsx"
```

This rewrites `checklists/before-launch.json` and `checklists/after-launch.json` from the
"QA — Before Launch" and "QA — After Launch" tabs. Which rows are automatic is set by the `AUTO`
map in `scripts/import-sheet.py`; a renamed row there stops the import with an error rather than
silently losing its check. Saved ticks are keyed by section + title, so renaming a row starts it
fresh.

## Adding a check

1. Write the function in `lib/checks.mjs` (`CHECKS`, `SWARM` or `AUDIT`). It gets `ctx` with
   `ctx.facts()` (WordPress data), `ctx.pages()` (desktop snapshot of every page),
   `ctx.mobilePages()`, `ctx.homeSnap()`, `ctx.linkCheck()`, `ctx.lighthouse()` and `ctx.home`, and
   returns `{ status: 'pass' | 'fail' | 'warn' | 'na', summary, details }`.
2. Point the item at it: the `AUTO` map in `scripts/import-sheet.py` for sheet rows, or the
   `check` field in `checklists/qa-swarm.json` / `wp-site-audit.json`.

## Layout

```
server.mjs              local web server and run queue (SSE progress)
lib/wpe.mjs             SSH + WP-CLI facts (read-only)
lib/crawl.mjs           sitemap discovery and Chrome page snapshots
lib/checks.mjs          every automatic check
lib/run.mjs             runs a tab: loads data once, runs its checks, writes results
lib/lighthouse.mjs      Lighthouse phone + desktop
lib/store.mjs           sites, checklist state, run history (data/)
lib/report.mjs          Markdown report
checklists/*.json       the four checklists
scripts/import-sheet.py Audit Sheet → checklists
public/                 the app (no build step)
```
