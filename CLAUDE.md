# WPE QA Checklist — instructions for Claude

This repo is a QA tool for WordPress sites hosted on **WP Engine**. It has four checklists
(QA Swarm, WP Site Audit, QA — Before Launch, QA — After Launch), automatic checks for each
("Run Tool"), Approve/Decline per item, and a fix runner that backs the site up first.
You drive it with the command line `node bin/wpeqa.mjs` (run it with `help` for every command).
The same data is shown in the web app (`npm start` → http://localhost:4646).

## First time in a fresh clone

1. `node -v` must be 20 or newer; Google Chrome must be installed (or `CHROME_PATH` set).
2. If `node_modules/` is missing, run `npm install`.
3. WP Engine SSH must work with the person's key, without a password:
   `ssh -o BatchMode=yes <install>@<install>.ssh.wpengine.net 'bash -s' <<< 'echo ok'`.
   If it fails, tell them to add their public key in the WP Engine User Portal (Profile → SSH keys).
   Never ask for or type a password.
4. The pre-approved commands in `.claude/settings.json` only apply once the folder is trusted:
   if you are asked for permission on read-only `wpeqa` commands, tell the person to open `claude`
   in this folder once and accept the trust prompt.
5. The `--claude` hand-off (and the web app's "Have Claude fix these") needs the `claude` command
   signed in on this Mac: `claude auth status`. If it isn't, they run `claude auth login`.

## When someone asks you to QA a site

1. `node bin/wpeqa.mjs add <url>` — the URL to audit (staging before launch, the real domain after).
   It detects the WP Engine install. If it reports none, ask the person for the install name and
   run `add <url> --install <name>`.
2. `node bin/wpeqa.mjs run <site> all` — all four checklists, read-only, about 5–8 minutes.
   Run it in the background and tell the person it's running.
3. `node bin/wpeqa.mjs status <site>` — summarise per checklist: counts, then each FAIL / LOOK item
   in plain language with what was found. Check obvious false positives before reporting them
   (e.g. rate-limited requests, lazy-load placeholders) and say which items are judgment calls.
   Offer the web app for the full list (`npm start`, background).
4. Ask which items to fix. Record their answers: `approve <site> <tab> <item-ids…>` /
   `decline …`. Items that need a value (login slug, category name) take it as a note:
   `note <site> <tab> <item-id> <text>`.
5. `node bin/wpeqa.mjs plan <site> <tab>` — show the plan: the backup, each automatic fix, and the
   items that need a developer. **Ask for an explicit yes for these changes on this URL.**
6. Only after that yes: `node bin/wpeqa.mjs fix <site> <tab> --yes`. It backs up (database + theme,
   plugins when updating them) to `_wpeprivate/wpeqa-backups/<run>/` on the server, applies the
   automatic fixes, clears caches and re-runs the checks to verify. Report what was verified, the
   backup path and the restore commands it prints.
7. Items left in the fix request (`data/runs/<site>/<run>/fix-request.md`): fix them yourself in
   this conversation, following `node bin/wpeqa.mjs rules <site>` exactly. The fix run already took
   a backup. Then `run <site> <tab>` again to verify, and report item by item. (If the person prefers
   to hand them off, `fix … --yes --claude` runs a separate headless Claude Code session instead.)

## Rules that always apply

- These are **production** sites. Read-only commands (`sites`, `add`, `run`, `status`, `report`,
  `plan`, `rules`, `approve`, `decline`, `note`) are fine to run. **Never pass `--yes` to `fix`, and
  never change a site by hand, without the person's explicit approval in this conversation** for
  those specific changes on that URL.
- Never overwrite someone else's edits: compare the server file's md5 with your copy before uploading.
- Upload PHP to `_wpeprivate/stage/`, `php -l` it, then copy into place.
- After a PHP deploy, wait ~2 minutes before purging caches, and verify at the origin
  (`curl -sk --connect-to <host>:443:<install>.wpengine.com:443 https://<host>/…`) because
  Cloudflare can serve stale copies for a while.
- Never print, request or store passwords, API keys or other credentials.

## Where things live

- `data/` (git-ignored): saved sites, checklist state, every run's log, results, screenshots,
  Lighthouse reports, fix requests and Claude transcripts.
- Backups: on the server in `~/sites/<install>/_wpeprivate/wpeqa-backups/<run>/`.
- Checks: `lib/checks.mjs` · automatic fixes: `lib/fixers.mjs` · checklists: `checklists/*.json`
  (Before/After Launch come from the Audit Sheet via `npm run import-sheet -- <xlsx>`).
