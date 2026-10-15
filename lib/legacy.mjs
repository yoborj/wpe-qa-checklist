// Old site's redirects: the redirects the old site already has, imported from an export file (Redirection's JSON or
// CSV, a Yoast or Rank Math CSV, any source/target CSV, .htaccess or nginx rules) and pointed at where each page is
// now. Their addresses aren't pages, so the page scan never sees them; without this they would all 404 after launch.
// Importing is read-only; "Apply URL decisions" adds the approved ones to the Redirection plugin on the new site,
// in their own group.
import crypto from 'node:crypto';
import { pool } from './crawl.mjs';
import { getState, updateState } from './store.mjs';
import { normPath, toPath, fetchPatient, pageInfo, bestMatch, effective } from './redirects.mjs';

export const LEGACY_STATUSES = { ready: 'Ready', review: 'Check it', attention: 'Needs attention', unused: 'Not used' };
// Redirects that live outside any file: a person checks them.
export const BY_HAND = "Redirects set at Cloudflare or in the old host's control panel aren't in an export file: check them by hand.";
const YEAR = 365 * 24 * 3600 * 1000;

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const codeOf = (c, dflt = 301) => { const n = { permanent: 301, temp: 302, seeother: 303, gone: 410 }[String(c).toLowerCase()] ?? parseInt(c, 10); return n >= 300 && n < 600 ? n : dflt; };

// Apache rules: Redirect, RedirectMatch, and RewriteRule with an R or G flag. WordPress's own block and the
// HTTPS/www rules are skipped (WP Engine handles those); rules with other conditions are kept for a look.
export function parseHtaccess(text, source = 'htaccess') {
  const rules = [], skipped = { canonical: 0, rewrites: 0 };
  let conds = [], inWp = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#\s*BEGIN WordPress/i.test(line)) { inWp = true; continue; }
    if (/^#\s*END WordPress/i.test(line)) { inWp = false; continue; }
    if (inWp || !line || line.startsWith('#')) continue;
    const w = line.match(/"[^"]*"|\S+/g).map(x => x.replace(/^"|"$/g, ''));
    const d = w[0].toLowerCase();
    if (d === 'rewritecond') { conds.push(w.slice(1).join(' ')); continue; }
    if (d === 'redirect' || d === 'redirectpermanent' || d === 'redirecttemp') {
      const args = w.slice(1); const hasCode = args.length >= 3 || /^(permanent|temp|seeother|gone|\d{3})$/i.test(args[0]);
      const code = d === 'redirectpermanent' ? 301 : d === 'redirecttemp' ? 302 : hasCode ? codeOf(args[0], 302) : 302; // Apache's default is 302
      const [from, to = ''] = hasCode ? args.slice(1) : args;
      if (from) rules.push({ source, from, to: code === 410 ? '' : to, code, regex: false, prefix: true });
    } else if (d === 'redirectmatch') {
      const args = w.slice(1); const hasCode = args.length >= 3 || /^(permanent|temp|seeother|gone|\d{3})$/i.test(args[0]);
      const code = hasCode ? codeOf(args[0], 302) : 302; const [from, to = ''] = hasCode ? args.slice(1) : args;
      if (from) rules.push({ source, from, to: code === 410 ? '' : to, code, regex: true });
    } else if (d === 'rewriterule') {
      const [pat, to = '-', flags = ''] = w.slice(1); const f = flags.replace(/[[\]]/g, '').split(',').map(x => x.trim().toUpperCase());
      const r = f.find(x => /^R(=\d{3})?$/.test(x)); const gone = f.includes('G');
      if (!r && !gone) { skipped.rewrites++; conds = []; continue; }
      if (conds.some(c => /%\{(HTTPS|HTTP_HOST|SERVER_PORT|HTTP:X-Forwarded-Proto)\}/i.test(c))) { skipped.canonical++; conds = []; continue; }
      const code = gone ? 410 : r.includes('=') ? codeOf(r.split('=')[1]) : 302;
      // .htaccess patterns match the path without its leading slash; Redirection matches it with one.
      const lit = pat.match(/^\^((?:[A-Za-z0-9_~\-/]|\\\.)+?)(\/\?)?\$$/);
      const from = lit ? '/' + lit[1].replace(/\\\./g, '.') : pat.startsWith('^') ? '^/' + pat.slice(1).replace(/^\/\??/, '') : pat;
      rules.push({ source, from, to: gone || to === '-' ? '' : to, code, regex: !lit, cond: conds.length ? conds.join(' AND ') : null });
    }
    conds = [];
  }
  return { rules, skipped };
}

// nginx: `rewrite ^/old$ /new permanent;` and `location = /old { return 301 /new; }`.
export function parseNginx(text) {
  const rules = [];
  for (const m of String(text).matchAll(/rewrite\s+(\S+)\s+(\S+)\s+(permanent|redirect)\s*;/g)) {
    const lit = m[1].match(/^\^(\/(?:[A-Za-z0-9_~\-/]|\\\.)*?)\/?\$$/);
    rules.push({ source: 'nginx', from: lit ? lit[1].replace(/\\\./g, '.') : m[1], to: m[2], code: m[3] === 'permanent' ? 301 : 302, regex: !lit });
  }
  for (const m of String(text).matchAll(/location\s*=\s*(\S+)\s*\{\s*return\s+(\d{3})\s*(\S*?)\s*;\s*\}/g)) rules.push({ source: 'nginx', from: m[1], to: m[3] || '', code: +m[2], regex: false });
  return rules;
}

// A CSV export (Redirection, Yoast, Rank Math or a hand-made one): columns are found by their names.
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter(r => r.some(c => c.trim()));
  if (!clean.length) return [];
  const head = clean[0].map(h => h.trim().toLowerCase());
  const col = names => head.findIndex(h => names.includes(h));
  let iFrom = col(['source', 'origin', 'from', 'old', 'old url', 'source url', 'url', 'redirect from']);
  let iTo = col(['target', 'destination', 'to', 'new', 'new url', 'url_to', 'target url', 'redirect to']);
  const iCode = col(['code', 'type', 'status code', 'header_code', 'http code', 'redirect type']);
  const iRe = col(['regex', 'format', 'matching', 'comparison']);
  const iHits = col(['hits', 'count', 'last_count']);
  const hasHead = iFrom >= 0 || iTo >= 0;
  if (!hasHead) { iFrom = 0; iTo = 1; }
  return clean.slice(hasHead ? 1 : 0).map(r => {
    const re = iRe >= 0 ? String(r[iRe] || '').trim().toLowerCase() : '';
    return { source: 'file', from: String(r[iFrom] || '').trim(), to: String(r[iTo] || '').trim(), code: iCode >= 0 ? codeOf(r[iCode]) : 301, regex: ['1', 'true', 'yes', 'regex'].includes(re), match: ['contains', 'start', 'end'].includes(re) ? re : undefined, hits: iHits >= 0 && r[iHits] !== '' ? +r[iHits] || 0 : null };
  }).filter(r => r.from);
}

// An exported file: Redirection's JSON, a CSV, .htaccess rules or nginx rules.
export function parseFile(name, text) {
  const t = String(text).replace(/^﻿/, '');
  if (/^\s*[{[]/.test(t)) {
    const j = JSON.parse(t); const list = Array.isArray(j) ? j : j.redirects || [];
    return { rules: list.filter(r => r.enabled !== false && r.status !== 'disabled').map(r => {
      const d = typeof r.action_data === 'object' && r.action_data ? r.action_data : { url: r.action_data };
      return { source: 'file', from: String(r.url || r.source || r.from || ''), to: r.action_type === 'error' ? '' : String(d.url || d.url_from || r.target || r.to || ''), code: codeOf(r.action_code || r.code || 301), regex: !!(r.regex && r.regex !== '0'), hits: r.hits ?? r.last_count ?? null, last: r.last_access && !/^(0000|1970)/.test(r.last_access) ? r.last_access : null, cond: r.match_type && r.match_type !== 'url' ? r.match_type : null, kind: r.action_type };
    }).filter(r => r.from), skipped: {} };
  }
  if (/^\s*(Redirect|RedirectMatch|RewriteRule|RewriteEngine|<IfModule)\b/im.test(t)) { const h = parseHtaccess(t, 'file'); return h; }
  if (/\b(rewrite\s+\S+\s+\S+\s+(permanent|redirect)|location\s*=)/.test(t)) return { rules: parseNginx(t), skipped: {} };
  if (/\.(csv|txt)$/i.test(name) || t.includes(',')) return { rules: parseCsv(t), skipped: {} };
  throw new Error(`Couldn't read ${name}: expected a Redirection JSON export, a CSV, .htaccess or nginx rules.`);
}

// Rules → rows: normalized, deduplicated, keyed by source + address.
function toRows(raw, oldHosts) {
  const rows = [], seen = new Map(); let dropped = 0;
  for (const r of raw) {
    let from = String(r.from || '').trim(); if (!from) continue;
    let regex = !!r.regex;
    if (r.match && r.match !== 'exact') { // Rank Math: contains / starts with / ends with / regex
      const e = esc(from.replace(/^\//, ''));
      from = r.match === 'regex' ? from : r.match === 'start' ? `^/${e}` : r.match === 'end' ? `${e}$` : e; regex = true;
    } else if (r.match === 'exact') from = '/' + from.replace(/^\//, '');
    if (!regex) { from = toPath(/^https?:\/\//i.test(from) ? from : '/' + from.replace(/^\//, '')); if (from.includes('*')) { from = '^' + from.split('*').map(esc).join('(.*)') + '$'; regex = true; } }
    let to = String(r.to || '').trim(), external = false;
    if (to) {
      try { const u = new URL(to, 'https://old.invalid'); if (u.hostname === 'old.invalid' || oldHosts.has(u.hostname.replace(/^www\./, ''))) to = u.pathname + u.search + u.hash; else { to = u.href; external = true; } }
      catch { /* keep as written */ }
    }
    const key = regex ? 're:' + from : normPath(from);
    const row = { id: 'L' + crypto.createHash('sha1').update(r.source + '|' + from).digest('hex').slice(0, 11), source: r.source, from, regex, oldTo: to, external, code: r.code || 301, gone: !to && [404, 410, 451].includes(r.code), hits: r.hits ?? null, last: r.last ?? null, cond: r.cond || null, kind: r.kind || 'url', prefix: !!r.prefix };
    const prev = seen.get(key);
    if (prev) { if (normPath(prev.oldTo) === normPath(row.oldTo)) { dropped++; continue; } prev.conflict = `${row.source} sends it to ${row.oldTo || '410'}`; continue; }
    seen.set(key, row); rows.push(row);
  }
  return { rows, dropped };
}

// The page decisions above decide where a redirect to an old page should now go.
const viaTarget = (m) => { const e = effective(m); return e.status === 'none' || (e.choice === 'keep' && m.decision === 'approve') ? m.oldPath : e.target; };

// Where each row goes on the new site, and its status. Probes the new site (read-only).
async function resolve(rows, { site, mapRows, newPages, log }) {
  const origin = new URL(site.url).origin;
  const byOld = new Map(mapRows.map(m => [normPath(m.oldPath), m]));
  const byFrom = new Map(rows.filter(r => !r.regex).map(r => [normPath(r.from), r]));
  const now = Date.now(); let n = 0;
  await pool(rows, 2, async r => {
    const a = {}; const why = [];
    if (r.cond || !['url', 'error'].includes(r.kind)) { a.status = 'review'; a.byHand = true; a.reason = r.cond ? `Only when ${r.cond.replace(/_/g, ' ')} · recreate it by hand` : `"${r.kind}" action · recreate it by hand`; r.auto = a; return; }
    if (byOld.has(normPath(r.from)) && !r.regex) { a.status = 'covered'; r.auto = a; return; } // the page list above handles it
    // Follow redirect chains on the old site (A → B → C) and map the end onto the new site.
    let to = r.oldTo, hops = 0;
    while (!r.external && to && !r.regex && byFrom.has(normPath(to)) && hops < 5 && byFrom.get(normPath(to)) !== r) { const nx = byFrom.get(normPath(to)); if (nx.external || nx.regex || nx.gone) break; to = nx.oldTo; hops++; }
    if (hops) why.push(`${hops + 1}-hop chain on the old site, now one`);
    if (r.gone) { a.status = 'ready'; a.target = ''; why.unshift(`Gone (${r.code})`); }
    else if (r.regex) { a.status = 'review'; a.target = to; why.unshift('Pattern rule · copied as is'); }
    else if (r.external) { a.status = 'review'; a.target = to; why.unshift('Points to another site'); }
    else if (!to) { a.status = 'attention'; a.target = ''; why.unshift('No target'); }
    else if (byOld.has(normPath(to.split('?')[0]))) { a.status = 'ready'; a.via = byOld.get(normPath(to.split('?')[0])).id; why.unshift(`Follows the old page ${to}`); }
    else if (normPath(to) === '/') { a.status = 'ready'; a.target = '/'; why.unshift('Homepage'); }
    else {
      const p = await fetchPatient(origin + to); const at = p.url ? new URL(p.url).pathname : '';
      if (p.status === 200 && normPath(at) === normPath(to.split('?')[0])) { a.status = 'ready'; a.target = to; why.unshift('Page exists on the new site'); }
      else if (p.status === 200 && at && at.replace(/\/$/, '').split('/').pop() === to.split('?')[0].replace(/\/$/, '').split('/').pop()) { a.status = 'ready'; a.target = at; why.unshift(`${to} moved to ${at}`); }
      else {
        const info = await pageInfo(new URL(site.referenceUrl).origin + to).catch(() => ({ path: to, title: '' }));
        const b = bestMatch({ path: to, title: info.title }, newPages);
        a.status = 'attention'; a.target = b && b.score >= 0.3 ? b.path : '';
        why.unshift(`${to} ${p.status === 200 ? `lands on ${at}` : 'is missing'} on the new site${a.target ? ' · best guess' : ''}`);
      }
    }
    if (!r.regex && !r.gone && a.status !== 'attention') {
      // Copying a redirect over a real page would hide that page.
      const s = await fetchPatient(origin + r.from); const at = s.url ? new URL(s.url).pathname : '';
      if (s.status === 200 && normPath(at) === normPath(r.from)) { a.status = 'attention'; why.length = 0; why.push(`${r.from} is a page on the new site · copying would hide it`); }
    }
    if (r.conflict) { a.status = 'attention'; why.length = 0; why.push(`Two old redirects for this address (${r.conflict}) · pick one`); }
    if (a.status === 'review' && [302, 303, 307].includes(r.code) && !r.regex && !r.external) why.push(`temporary (${r.code}) · still needed?`);
    else if (a.status === 'ready' && [302, 303, 307].includes(r.code)) { a.status = 'review'; why.push(`temporary (${r.code}) · still needed?`); }
    const stale = r.hits !== null && (r.hits === 0 || (r.last && now - Date.parse(r.last.replace(' ', 'T') + 'Z') > YEAR));
    if (stale && ['ready', 'review'].includes(a.status)) { a.status = 'unused'; why.push(r.hits === 0 ? 'never used' : `last used ${r.last.slice(0, 10)}`); }
    a.reason = why.join(' · ');
    if (normPath(a.target || '') === normPath(r.from) && !r.regex && !a.via) { a.status = 'covered'; a.reason = 'Points to itself'; }
    r.auto = a;
    if (++n % 25 === 0) log(`  ${n}/${rows.length} old redirects checked…`);
  });
  return rows.filter(r => r.auto.status !== 'covered');
}

// Import a file (replacing an earlier import of the same name) and map every imported rule onto the new site.
// Run Tool calls it without a file after each page scan, so the redirects follow the page decisions.
export async function buildLegacy({ site, log, file, remove }) {
  if (file || remove) updateState(site.id, s => {
    s.urls ||= {}; const L = (s.urls.legacy ||= {});
    let files = (L.files || []).filter(f => f.name !== (file?.name ?? remove));
    if (file) {
      const p = parseFile(file.name, file.text);
      if (!p.rules.length) throw new Error(`No redirects found in ${file.name}.`);
      files = [...files, { name: file.name, at: new Date().toISOString(), rules: p.rules.map(r => ({ ...r, source: file.name })), skipped: p.skipped || {} }];
      log(`Read ${p.rules.length} redirect${p.rules.length === 1 ? '' : 's'} from ${file.name}.`);
    }
    L.files = files;
  });
  const st = getState(site.id); const L = st.urls?.legacy || {}; const files = L.files || [];
  if (!files.length) { updateState(site.id, s => { if (s.urls?.legacy) Object.assign(s.urls.legacy, { rows: [], notes: [], tally: {} }); }); return null; }
  const mapRows = st.urls?.rows || []; const newPages = st.urls?.newPages || [];
  const oldHosts = new Set([site.referenceUrl, site.url, site.prodUrl].filter(Boolean).map(u => new URL(u).hostname.replace(/^www\./, '')));
  const notes = [BY_HAND];
  const canonical = files.reduce((n, f) => n + (f.skipped?.canonical || 0), 0);
  if (canonical) notes.push(`${canonical} HTTPS/www rule${canonical === 1 ? '' : 's'} skipped (WP Engine handles those).`);
  const { rows, dropped } = toRows(files.flatMap(f => f.rules), oldHosts);
  if (dropped) notes.push(`${dropped} duplicate${dropped === 1 ? '' : 's'} merged.`);
  log(`Mapping ${rows.length} old redirect${rows.length === 1 ? '' : 's'} onto the new site…`);
  const kept = await resolve(rows, { site, mapRows, newPages, log });
  const covered = rows.length - kept.length; if (covered) notes.push(`${covered} already covered by the page list (or pointing to themselves).`);
  if (rows.length > 1000) notes.push(`${rows.length} rules: above about a thousand, WP Engine's server-level redirect rules are faster than a plugin.`);
  const tally = kept.reduce((c, r) => (c[r.auto.status] = (c[r.auto.status] || 0) + 1, c), {});
  updateState(site.id, s => {
    const L = s.urls.legacy;
    const prev = new Map((L.rows || []).map(r => [r.id, r]));
    // Keep what a person set on rows that are still there.
    L.rows = kept.map(r => { const p = prev.get(r.id); return p ? { ...r, target: r.auto.status === 'attention' ? p.target : undefined, decision: p.decision, applied: p.applied } : r; });
    Object.assign(L, { notes, tally, mappedAt: new Date().toISOString() });
  });
  log(`Old site's redirects: ${Object.entries(tally).map(([k, v]) => `${v} ${LEGACY_STATUSES[k].toLowerCase()}`).join(', ') || 'none to carry over'}.`);
  return { count: kept.length, tally };
}

// Where a row goes now: a person's pick, the page decision above (for redirects to an old page), or the scan's.
export function legacyEffective(r, mapById) {
  const a = r.auto || {};
  if (a.via) {
    const m = mapById.get(a.via);
    const t = m ? viaTarget(m) : '';
    if (!t) return { status: 'attention', target: '', reason: m ? `${a.reason} · pick its new page in the list above first` : 'Run Tool again', waiting: true };
    return { status: a.status, target: t, reason: a.reason };
  }
  return { status: a.status, target: (a.status === 'attention' ? r.target : undefined) ?? a.target ?? '', reason: a.reason };
}

export const legacyRows = siteId => getState(siteId).urls?.legacy?.rows || [];

export function setLegacyRow(siteId, id, patch) {
  let out;
  updateState(siteId, s => {
    const r = (s.urls?.legacy?.rows || []).find(x => x.id === id);
    if (!r) throw new Error('Unknown row.');
    if ('target' in patch) {
      if (r.auto?.status !== 'attention' || r.auto?.via) throw new Error('Only rows that need attention take a new target; the scan set this one.');
      const t = String(patch.target || '').trim(); r.target = t === (r.auto?.target || '') ? undefined : /^https?:\/\//i.test(t) ? t : toPath(t);
    }
    if ('decision' in patch) {
      if (patch.decision === 'approve' && r.auto?.byHand) throw new Error('This one has a condition the app can\'t copy: recreate it by hand.');
      r.decision = ['approve', 'decline'].includes(patch.decision) ? patch.decision : null;
    }
    out = r;
  });
  return out;
}

// Approved rows → redirects to add (in their own Redirection group).
export function planLegacy(siteId) {
  const st = getState(siteId); const mapById = new Map((st.urls?.rows || []).map(m => [m.id, m]));
  const todo = [], skipped = [];
  for (const r of legacyRows(siteId)) {
    if (r.decision !== 'approve') continue;
    const e = legacyEffective(r, mapById);
    if (!e.target && !r.gone) { skipped.push({ page: 'Old redirect', oldPath: r.from, why: e.waiting ? 'Waiting for its page in the list above.' : 'No target picked.' }); continue; }
    if (r.applied?.state === 'verified' && r.applied.target === e.target) continue;
    todo.push({ id: r.id, legacy: true, page: `Old redirect (${r.source})`, from: r.from, to: e.target, code: r.gone ? r.code : (r.code || 301), regex: r.regex, gone: r.gone, external: r.external });
  }
  return { todo, skipped };
}
