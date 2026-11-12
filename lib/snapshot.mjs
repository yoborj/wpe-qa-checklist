// Read-only report: a snapshot of a site's checklist page, built from the app's own page, styles and script plus the
// saved data and screenshots, for someone who should see the results but not change anything (views only: tiles,
// tabs, sections, details and screenshots work; Run Tool, Apply fixes, Approve / Decline, notes and settings don't).
// The files go to data/reports/<site>/ (git-ignored). Claude publishes that folder as a new claude.ai artifact each time
// (every report is its own fixed snapshot with its own link); the links are listed in reports.json there, newest first.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, DATA, templates, listSites, getSite, getState } from './store.mjs';
import { agency } from './config.mjs';
import { GREENLIGHT_MIN_VERSION } from './greenlight.mjs';
import { claudeStatus } from './claude.mjs';

const VERSION = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const reportDir = siteId => path.join(DATA, 'reports', siteId);
// Published reports for a site, newest first: [{ url, generatedAt, publishedAt }].
export const reportList = siteId => { try { return JSON.parse(fs.readFileSync(path.join(reportDir(siteId), 'reports.json'), 'utf8')); } catch { return []; } };
export const reportLink = siteId => reportList(siteId)[0]?.url || null;

// The page's data, as the app's API would return it, with screenshots pointing at files next to the page.
function snapshotData(site, generatedAt, copyShot) {
  const state = structuredClone(getState(site.id));
  const L = state.urls?.legacy;
  if (L?.files) L.files = L.files.map(({ rules, ...f }) => ({ ...f, count: rules?.length ?? f.count }));
  for (const t of Object.values(state.tabs || {})) for (const it of Object.values(t.items || {})) {
    if (!it.tool) continue;
    for (const sh of it.tool.shots || []) sh.file = copyShot(sh.file);
    // Links into the app's run folders (e.g. "Open: /runs/…/shots.html") don't exist outside the app.
    if (it.tool.details) it.tool.details = it.tool.details.filter(d => !/(^|\s)\/runs\//.test(String(d)));
  }
  const a = agency();
  return {
    generatedAt,
    config: { adminEmail: a.adminEmail || '', configured: a._source === 'agency.json', version: VERSION(), greenlightMin: GREENLIGHT_MIN_VERSION },
    templates: templates(),
    sites: listSites().filter(s => s.id === site.id),
    site: { site, state, active: [] },
  };
}

// The artifact host wraps the page in its own <html>/<head>/<body>, so the page is the app's body markup plus a title,
// the font, the stylesheet and the scripts. Theme colors also follow an explicit light/dark choice in the viewer.
function pageHtml(site, generatedAt) {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  let body = src.slice(src.indexOf('<body>') + 6, src.lastIndexOf('</body>'));
  body = body.replace('<script src="/app.js" type="module"></script>', '<script src="snapshot.js"></script>\n<script src="app.js" type="module"></script>');
  const when = new Date(generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  body = body.replace('</header>', `  <div class="snapnote"><b>Read-only report</b><span>Generated ${esc(when)}</span></div>\n</header>`);
  const host = new URL(site.url).hostname.replace(/^www\./, '');
  const day = new Date(generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<title>${esc(host)} QA Report ${esc(day)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<link rel="stylesheet" href="app.css">
${body.trim()}
`;
}

function pageCss() {
  let css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const m = css.match(/@media \(prefers-color-scheme: dark\) \{ :root \{([\s\S]*?)\} \}/);
  if (m) css = css.replace(m[0], `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${m[1]}} }\n:root[data-theme="dark"] {${m[1]}}`);
  return css.replace(/(\.topbar \{\s*position: sticky; )top: 0;/, '$1top: env(safe-area-inset-top, 0px);');
}

export function buildSnapshot(siteRef) {
  const site = getSite(siteRef);
  if (!site) throw new Error('Unknown site.');
  const out = reportDir(site.id);
  fs.mkdirSync(out, { recursive: true });
  // Start clean (old screenshots go), but keep the list of published reports.
  for (const f of fs.readdirSync(out)) if (f !== 'reports.json') fs.rmSync(path.join(out, f), { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'shots'));
  const generatedAt = new Date().toISOString();
  const shots = new Map();
  const copyShot = file => {
    if (shots.has(file)) return shots.get(file);
    const rel = String(file).replace(/^\/runs\//, '');
    const from = path.join(DATA, 'runs', rel);
    const name = `shots/${rel.split('/').slice(1).join('-').replace(/[^A-Za-z0-9._-]/g, '-')}`;
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, name));
    shots.set(file, name);
    return name;
  };
  const data = snapshotData(site, generatedAt, copyShot);
  // ASCII only (every other character escaped): the data file reads the same whatever charset the host serves it with.
  const json = JSON.stringify(data).replace(/[\u007f-\uffff<]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  fs.writeFileSync(path.join(out, 'snapshot.js'), `window.WPEQA_SNAPSHOT = ${json};\n`);
  fs.writeFileSync(path.join(out, 'index.html'), pageHtml(site, generatedAt));
  fs.writeFileSync(path.join(out, 'app.css'), pageCss());
  fs.copyFileSync(path.join(ROOT, 'public', 'app.js'), path.join(out, 'app.js'));
  const files = ['app.css', 'app.js', 'snapshot.js', ...[...shots.values()].filter(f => fs.existsSync(path.join(out, f)))];
  const bytes = ['index.html', ...files].reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
  return { site, dir: out, page: path.join(out, 'index.html'), files, bytes, generatedAt, link: reportLink(site.id), missingShots: [...shots.values()].filter(f => !fs.existsSync(path.join(out, f))) };
}

// Add a published report to the site's list (newest first).
export function saveReportLink(siteRef, url, generatedAt = new Date().toISOString()) {
  const site = getSite(siteRef); if (!site) throw new Error('Unknown site.');
  fs.mkdirSync(reportDir(site.id), { recursive: true });
  const list = [{ url, generatedAt, publishedAt: new Date().toISOString() }, ...reportList(site.id).filter(r => r.url !== url)];
  fs.writeFileSync(path.join(reportDir(site.id), 'reports.json'), JSON.stringify(list, null, 1) + '\n');
  return list;
}

// "Generate report" in the app: build the snapshot, then have Claude Code (headless, on this Mac, signed in) publish it
// with its Artifact tool as a NEW artifact, so every report keeps its own link. Only Claude can publish to claude.ai, so
// the app hands it exactly one job: publish the folder and reply with the link.
export async function publishReport(siteRef, log = () => {}) {
  const st = claudeStatus();
  if (!st.ok) throw new Error(st.reason);
  const r = buildSnapshot(siteRef);
  log(`Report built: ${r.files.length + 1} files, ${(r.bytes / 1048576).toFixed(1)} MB. Publishing it as a new artifact…`);
  const rel = p => path.relative(ROOT, p);
  const files = Object.fromEntries(r.files.map(f => [f, rel(path.join(r.dir, f))]));
  const prompt = [
    `Publish the read-only QA report that is already built in ${rel(r.dir)}/ as a NEW claude.ai artifact. Do not create, edit or delete any file, do not pass a url (this must be a new artifact), and do nothing else.`,
    `1. Artifact publish with file_path "${rel(r.page)}", files ${JSON.stringify(files)}, icon "checklist", description "Read-only snapshot of the QA checklist app for ${r.site.name}, generated ${new Date(r.generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}: every checklist, tile and finding, views only."`,
    '2. Reply with only this line: REPORT_URL <the artifact URL>',
  ].join('\n');
  const text = await new Promise((resolve, reject) => {
    const p = spawn(st.bin, ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Artifact', '--max-turns', '6'], { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGTERM'); reject(new Error('Publishing took longer than 5 minutes.')); }, 5 * 60 * 1000);
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => { clearTimeout(t); try { resolve(String(JSON.parse(out).result || '')); } catch { reject(new Error(`Claude Code could not publish (exit ${code}). ${err.trim().split('\n').slice(-2).join(' ')}`)); } });
  });
  const url = (text.match(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/) || [])[0];
  if (!url) throw new Error(`Claude Code didn't return the report link: ${text.trim().slice(-300) || 'no reply'}`);
  if (reportList(r.site.id).some(x => x.url === url)) log(`Note: ${url} is an earlier report's link; Claude updated it instead of making a new one.`);
  saveReportLink(r.site.id, url, r.generatedAt);
  log(`Report published: ${url}`);
  return { url, generatedAt: r.generatedAt };
}
