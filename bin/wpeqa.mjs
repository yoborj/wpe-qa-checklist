#!/usr/bin/env node
// Command line for the WPE QA Checklist: everything the web app's buttons do, for terminals and Claude Code.
// Run `node bin/wpeqa.mjs help` for usage.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, TABS, templates, listSites, getSite, saveSite, getState, setItem } from '../lib/store.mjs';
import { URLS_TAB, URL_STATUSES, CHOICES, effective, keepInfo, setUrlRow, recheckKeep, planRedirects } from '../lib/redirects.mjs';
import { LIVE_TAB, liveChecks, confirmLive, liveConfirmed } from '../lib/live.mjs';
import { checkJob, fixJob } from '../lib/jobs.mjs';
import { planFixes } from '../lib/fixers.mjs';
import { report } from '../lib/report.mjs';
import { claudeStatus, RULES } from '../lib/claude.mjs';

const HELP = `WPE QA Checklist — command line

  sites                                  List saved sites
  add <staging-url> [--prod LIVE-URL] [--name N] [--install I] [--admin-email E] [--reference OLD-URL] [--max-pages N]
                                         Add (or update) a site by the URL to audit; the WP Engine install is detected
  run <site> [tab|all]                   Run Tool for one tab or all four (read-only)
  status <site> [tab]                    Pass/fail counts and every failing or flagged item (with ids)
  report <site> <tab>                    Markdown report of a tab
  approve <site> <tab> <item-id…|--all-failing> [--note TEXT]
  decline <site> <tab> <item-id…>        Record fix decisions, as the Approve/Decline buttons do
  note <site> <tab> <item-id> <text>     Save a note on an item (e.g. the login slug for Hide the login URL)
  plan <site> <tab>                      What "Apply approved fixes" would do: automatic fixes and the rest
  fix <site> <tab> --yes [--claude]      Apply approved fixes: backup first, automatic fixes, verify.
                                         --claude also hands the rest to a headless Claude Code run.
                                         --yes is the confirmation; only pass it after the site owner approved the plan.
  confirm-live <site> [--yes]            QA — After Launch runs on the live site only: check it, then (--yes) confirm it
  urls <site> run                        Old → New URLs: test every old-site page on the new site (read-only)
  urls <site> [status]                   The URL list: status, proposed new URL, decision (ids in brackets)
  urls <site> approve <id…|--all-redirects>   /  urls <site> decline <id…>
  urls <site> set <id> </new-path>      Set the new page of a row that needs attention (the scan sets status)
  urls <site> choose <id> keep|new      Keep the old URL (move the page back) or use the new URL (301 from the old one)
  urls <site> plan                       The redirects "Apply" would add to the Redirection plugin
  urls <site> apply --yes                Backup, install/set up Redirection if needed, add the approved 301s, verify
  rules <site>                           The production rules for fixing this site by hand
  serve                                  Start the web app at http://localhost:4646

  <site> is the site id from \`sites\` or its URL.  Tabs: ${TABS.join(', ')}.  Add --json for machine-readable output.`;

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') && !['yes', 'claude', 'json', 'all-failing'].includes(k) ? argv[++i] : true; flags[k] = v; }
  else pos.push(a);
}
const json = !!flags.json;
const out = (human, data) => console.log(json ? JSON.stringify(data ?? human, null, 1) : human);
const die = msg => { console.error(msg); process.exit(1); };

const findSite = ref => getSite(ref) || listSites().find(x => { try { return new URL(/^https?:/.test(ref) ? ref : 'https://' + ref).hostname.replace(/^www\./, '') === new URL(x.url).hostname.replace(/^www\./, ''); } catch { return false; } });
function site(ref) {
  if (!ref) die('Which site? Pass its id or URL (see `sites`).');
  const s = findSite(ref);
  return s || die(`No saved site matches "${ref}". Add it first: node bin/wpeqa.mjs add <url>`);
}
const tabArg = (t, allowAll) => (allowAll && (!t || t === 'all')) ? TABS : TABS.includes(t) ? [t] : die(`Tab must be one of: ${TABS.join(', ')}${allowAll ? ', all' : ''}.`);
const items = tab => templates()[tab].sections.flatMap(s => s.items.map(i => ({ ...i, section: s.title })));

function status(s, tab) {
  const st = getState(s.id).tabs[tab] || { items: {}, runs: [] };
  const list = items(tab).map(i => ({ id: i.id, title: i.title, section: i.section, auto: !!i.check, ...(st.items[i.id] || {}), status: st.items[i.id]?.status || 'todo' }));
  const counts = list.reduce((c, i) => (c[i.status] = (c[i.status] || 0) + 1, c), {});
  return { tab, title: templates()[tab].title, lastRun: st.runs?.[0]?.finishedAt || null, counts, attention: list.filter(i => ['fail', 'warn'].includes(i.status)).map(i => ({ id: i.id, title: i.title, status: i.status, summary: i.tool?.summary, details: (i.tool?.details || []).slice(0, 6), decision: i.decision || null, fix: i.fix?.state || null, note: i.note || '' })) };
}
const printStatus = r => {
  console.log(`\n${r.title}: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(' · ')}${r.lastRun ? ` (last run ${new Date(r.lastRun).toLocaleString()})` : ' (not run yet)'}`);
  for (const a of r.attention) {
    console.log(`  ${a.status === 'fail' ? 'FAIL' : 'LOOK'}  ${a.title}  [${a.id}]${a.decision ? `  fix ${a.decision}d` : ''}${a.fix ? `  (${a.fix})` : ''}`);
    if (a.summary) console.log(`        ${a.summary}`);
    for (const d of a.details) console.log(`          - ${d}`);
  }
};

const [cmd, ...rest] = pos;
try {
  switch (cmd) {
    case 'sites': {
      const list = listSites();
      out(list.length ? list.map(s => `${s.id.padEnd(28)} ${s.url}${s.install ? `  (install ${s.install})` : '  (no WP Engine install)'}`).join('\n') : 'No sites yet. Add one: node bin/wpeqa.mjs add <url>', list);
      break;
    }
    case 'add': {
      if (!rest[0]) die('Usage: add <url> [--name N] [--install I] …');
      const s = await saveSite({ url: rest[0], name: flags.name, install: flags.install, adminEmail: flags['admin-email'], referenceUrl: flags.reference, prodUrl: flags.prod, maxPages: flags['max-pages'], id: findSite(rest[0])?.id });
      out(`Saved ${s.name} as "${s.id}": ${s.url}${s.install ? `, WP Engine install ${s.install} (${s.installHow})` : '. No WP Engine install found: WordPress checks and fixes need one (add --install <name>).'}`, s);
      break;
    }
    case 'run': {
      const s = site(rest[0]);
      for (const tab of tabArg(rest[1], true)) {
        if (tab === LIVE_TAB && !liveConfirmed(s)) { console.log(`\nSkipping QA — After Launch: it runs on the live site only. Confirm it first: node bin/wpeqa.mjs confirm-live ${s.id} --yes`); continue; }
        await checkJob({ site: s, tab, log: undefined });
        if (!json) printStatus(status(s, tab));
      }
      if (json) out(null, tabArg(rest[1], true).filter(t => t !== LIVE_TAB || liveConfirmed(s)).map(t => status(s, t)));
      break;
    }
    case 'status': {
      const s = site(rest[0]); const tabs = tabArg(rest[1], true);
      const r = tabs.map(t => status(s, t));
      if (json) out(null, r); else { console.log(`${s.name} — ${s.url}`); r.forEach(printStatus); }
      break;
    }
    case 'report': { const s = site(rest[0]); const [tab] = tabArg(rest[1]); console.log(report(s, tab, templates()[tab], getState(s.id))); break; }
    case 'approve': case 'decline': {
      const s = site(rest[0]); const [tab] = tabArg(rest[1]);
      let ids = rest.slice(2);
      if (flags['all-failing']) ids = status(s, tab).attention.map(a => a.id);
      if (!ids.length) die('Which items? Pass item ids (see `status`) or --all-failing.');
      const known = new Set(items(tab).map(i => i.id));
      for (const id of ids) { if (!known.has(id)) die(`Unknown item id: ${id}`); setItem(s.id, tab, id, { decision: cmd === 'approve' ? 'approve' : 'decline', ...(typeof flags.note === 'string' ? { note: flags.note } : {}) }); }
      out(`${cmd === 'approve' ? 'Approved' : 'Declined'} ${ids.length} item${ids.length === 1 ? '' : 's'}.`, { ids });
      break;
    }
    case 'note': { const s = site(rest[0]); const [tab] = tabArg(rest[1]); if (!rest[2] || !rest[3]) die('Usage: note <site> <tab> <item-id> <text>'); setItem(s.id, tab, rest[2], { note: rest.slice(3).join(' ') }); out('Note saved.'); break; }
    case 'plan': {
      const s = site(rest[0]); const [tab] = tabArg(rest[1]);
      const p = planFixes(templates()[tab], getState(s.id).tabs[tab] || { items: {} }, s);
      const data = { site: s.url, install: s.install, automatic: p.auto.map(a => ({ id: a.id, title: a.title, action: a.action })), needsDeveloper: p.manual.map(m => ({ id: m.id, title: m.title, reason: m.reason })), claude: claudeStatus() };
      if (json) out(null, data);
      else {
        console.log(`Apply approved fixes on ${s.url} (${templates()[tab].title}):`);
        console.log(data.automatic.length ? `\n1. Backup first (database + theme${p.auto.some(a => a.check === 'wp.plugins') ? ' + plugins' : ''}) to _wpeprivate/wpeqa-backups/ on the server.\n2. Automatic fixes:` : '\nNo automatic fixes.');
        data.automatic.forEach((a, i) => console.log(`   ${i + 1}. ${a.title}: ${a.action}`));
        if (data.needsDeveloper.length) { console.log('\nNeed a developer (fix request, or --claude):'); data.needsDeveloper.forEach(m => console.log(`   - ${m.title} [${m.id}]: ${m.reason}`)); if (!data.claude.ok) console.log(`   (--claude unavailable: ${data.claude.reason})`); }
        if (!data.automatic.length && !data.needsDeveloper.length) console.log('Nothing approved. Approve items first (approve <site> <tab> <ids>).');
      }
      break;
    }
    case 'fix': {
      const s = site(rest[0]); const [tab] = tabArg(rest[1]);
      if (flags.yes !== true) die('Fixes change the site. Show the plan to the site owner (`plan`), get their OK, then re-run with --yes.');
      const r = await fixJob({ site: s, tab, claude: !!flags.claude });
      out(`\nFix run ${r.meta.id}: ${Object.entries(r.meta.states).map(([k, v]) => `${v} ${k}`).join(', ')}${r.meta.backup ? `\nBackup: ${r.meta.backup.path}\nRestore: ${r.meta.backup.restore.join(' && ')}` : ''}${r.request ? `\nFix request (items still to do): data/runs/${s.id}/${r.meta.id}/fix-request.md` : ''}`, r);
      break;
    }
    case 'confirm-live': {
      const s = site(rest[0]); const lc = await liveChecks(s);
      if (!json) { console.log(`Live-site checks for ${s.prodUrl || '(no production URL set)'}:`); lc.checks.forEach(c => console.log(`  ${c.ok ? '✓' : c.hard ? '✕' : '!'} ${c.text}`)); }
      if (!lc.ready) die('\nNot confirmed: fix the ✕ items first (set the live domain: add <staging-url> --prod <live-url>).');
      if (flags.yes !== true) { out('\nAll checks pass. Ask the site owner to confirm the new site is live on this address, then re-run with --yes.', lc); break; }
      out(`\nConfirmed: ${s.prodUrl} is the live site. QA — After Launch is unlocked.`, await confirmLive(s)); break;
    }
    case 'urls': {
      const s = site(rest[0]); const sub = rest[1] || 'status';
      const rows = () => getState(s.id).urls?.rows || [];
      const line = r => { const e = effective(r); return `  [${r.id}] ${URL_STATUSES[e.status].padEnd(16)} ${r.oldPath}${e.target ? ' → ' + e.target : ''}${e.status !== 'none' && e.target ? `  (${CHOICES[e.choice]}${keepInfo(r) && !keepInfo(r).ok ? `; can't keep: ${keepInfo(r).why}` : ''})` : ''}${r.decision ? `  (${r.decision}d)` : ''}${r.applied ? `  [${r.applied.state}]` : ''}${e.status === 'attention' && r.auto?.alt?.length ? `\n      matches: ${r.auto.alt.join('  |  ')}` : ''}`; };
      if (sub === 'run') { await checkJob({ site: s, tab: URLS_TAB, log: undefined }); if (!json) rows().forEach(r => console.log(line(r))); else out(null, rows()); break; }
      if (sub === 'status') { if (json) out(null, rows()); else { if (!rows().length) die('Not run yet: urls <site> run'); rows().forEach(r => console.log(line(r))); } break; }
      if (sub === 'approve' || sub === 'decline') {
        let ids = rest.slice(2); if (flags['all-redirects']) ids = rows().filter(r => effective(r).status === 'redirect').map(r => r.id);
        if (!ids.length) die('Which rows? Pass ids (see `urls <site>`) or --all-redirects.');
        ids.forEach(id => setUrlRow(s.id, id, { decision: sub === 'approve' ? 'approve' : 'decline' }));
        out(`${sub === 'approve' ? 'Approved' : 'Declined'} ${ids.length} row${ids.length === 1 ? '' : 's'}.`, { ids }); break;
      }
      if (sub === 'choose') { const [id, v] = rest.slice(2); if (!id || !CHOICES[v]) die('Usage: urls <site> choose <id> keep|new'); out(line(setUrlRow(s.id, id, { choice: v }))); break; }
      if (sub === 'set') { const [id, v] = rest.slice(2); if (!id || !v) die('Usage: urls <site> set <id> </new-path>'); setUrlRow(s.id, id, { target: v }); out(line(await recheckKeep(s, id))); break; }
      if (sub === 'plan') { const p = planRedirects(s.id); if (json) { out(null, p); break; } console.log(p.todo.length ? `Would add ${p.todo.length} redirect(s) to the Redirection plugin on ${s.url} (backup first):` : 'Nothing approved yet.'); p.todo.forEach(t => console.log(t.choice === 'keep' ? `  KEEP ${t.from}  (move ${t.to} back to it; 301 ${t.to} → ${t.from})` : `  301  ${t.from} → ${t.to}`)); p.skipped.forEach(r => console.log(`  skipped ${r.oldPath}: ${r.why}`)); break; }
      if (sub === 'apply') { if (flags.yes !== true) die('This adds redirects on the site. Show the plan (`urls <site> plan`), get the site owner\'s OK, then re-run with --yes.'); const r = await fixJob({ site: s, tab: URLS_TAB }); out(`\nRedirects: ${Object.entries(r.meta.states).map(([k, v]) => `${v} ${k}`).join(', ')}\nBackup: ${r.meta.backup.path}\nRestore: ${r.meta.backup.restore.join(' && ')}`, r); break; }
      die('Usage: urls <site> [run|status|approve|decline|set|plan|apply --yes]');
    }
    case 'rules': { const s = site(rest[0]); if (!s.install) die('This site has no WP Engine install.'); console.log(RULES(s)); break; }
    case 'serve': { spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { stdio: 'inherit' }); break; }
    case undefined: case 'help': case '-h': console.log(HELP); break;
    default: die(`Unknown command "${cmd}".\n\n${HELP}`);
  }
} catch (e) { die(e.message); }
