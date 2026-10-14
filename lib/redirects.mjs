// Old → New URLs: every page of the old site, tested on the new site, with a proposed redirect where
// the old address no longer works. Approved redirects go into the Redirection plugin
// (https://wordpress.org/plugins/redirection/) over SSH, through the plugin's own Red_Item::create().
// Run Tool here is read-only; only "Apply approved redirects" changes the site (after a backup).
import crypto from 'node:crypto';
import { discoverUrls, fetchText, pool } from './crawl.mjs';
import { sshRun, fixPreamble } from './wpe.mjs';
import { backupSite } from './fixrun.mjs';
import { getState, updateState } from './store.mjs';

export const URLS_TAB = 'urls';
export const URL_STATUSES = { none: 'No redirect needed', redirect: 'Redirect', attention: 'Needs attention' };

const STOP = new Set(['the', 'and', 'for', 'with', 'our', 'your', 'you', 'page', 'new', 'old', 'www', 'html', 'php']);
const words = s => new Set(String(s || '').toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n); };
const lastSeg = p => (p.replace(/\/+$/, '').split('/').pop() || '').toLowerCase();
const normPath = p => { let x = p || '/'; try { x = decodeURI(x); } catch { /* keep as is */ } x = x.split('#')[0].replace(/\/+$/, ''); return (x || '/').toLowerCase(); };
const rowId = p => crypto.createHash('sha1').update(normPath(p)).digest('hex').slice(0, 12);
const HOME_ALIASES = new Set(['/home', '/index', '/index.html', '/index.php', '/home-page', '/homepage']);
const decode = s => s.replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
// "Back Pain — Example Clinic" → "Back Pain"
const cleanTitle = t => { const parts = decode(t).replace(/\s+/g, ' ').trim().split(/\s+[|–—·•-]\s+/); return (parts[0] || '').trim(); };

// Cloudflare/WP Engine answer 429 to bursts: wait and retry, so a busy server never reads as a missing page.
async function fetchPatient(url, opts) {
  let r;
  for (const wait of [0, 2000, 6000, 12000]) {
    if (wait) await new Promise(res => setTimeout(res, wait));
    r = await fetchText(url, opts);
    if (r.status !== 429 && r.status !== 0 && r.status < 500) break;
  }
  return r;
}

async function pageInfo(url) {
  const r = await fetchPatient(url);
  const m = (r.text || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return { url, path: (() => { const u = new URL(url); return u.pathname + u.search; })(), status: r.status, title: m ? cleanTitle(m[1]) : '' };
}

// Best page on the new site for an old page: same slug, same title, or most words in common.
function bestMatch(old, pages) {
  const oSlug = lastSeg(old.path), oSlugW = words(oSlug), oTitleW = words(old.title), oAll = new Set([...oSlugW, ...oTitleW]);
  let best = null;
  for (const p of pages) {
    const pSlug = lastSeg(p.path); let score = 0, how = '';
    if (oSlug && pSlug === oSlug) { score = 1; how = 'same slug'; }
    else if (old.title && p.title && old.title.toLowerCase() === p.title.toLowerCase()) { score = 0.95; how = 'same page title'; }
    else {
      const s1 = jaccard(oSlugW, words(pSlug)), s2 = jaccard(oTitleW, words(p.title)), s3 = 0.9 * jaccard(oAll, new Set([...words(pSlug), ...words(p.title)]));
      score = Math.max(s1, s2, s3); how = score === s2 ? 'similar title' : 'similar address';
    }
    if (!best || score > best.score) best = { path: p.path, title: p.title, score, how };
  }
  return best;
}

export const effective = r => ({ status: r.status || r.auto?.status || 'attention', target: r.target ?? r.auto?.target ?? '' });

// Run Tool for this tab: read-only.
export async function buildUrlMap({ site, log, progress = () => {} }) {
  if (!site.referenceUrl) throw new Error("Set the old site's address (Reference (old) site URL) in Site settings first.");
  const t0 = Date.now(); const newOrigin = new URL(site.url).origin;
  log(`Finding the old site's pages (${site.referenceUrl})…`);
  const od = await discoverUrls(site.referenceUrl, 400);
  log(`Old site: ${od.total} pages${od.fromSitemap ? ' from its sitemap' : od.fromLinks ? ' by following its links' : ''}.`);
  log(`Finding the new site's pages (${newOrigin})…`);
  const nd = await discoverUrls(newOrigin, 400);
  log(`New site: ${nd.total} pages${nd.fromSitemap ? ' from its sitemap' : nd.fromLinks ? ' by following its links' : ''}.`);
  progress(0.15);
  let n = 0; const total = od.urls.length + nd.urls.length;
  const tick = () => { n++; if (n % 10 === 0) progress(0.15 + 0.45 * n / total); };
  const newPages = (await pool(nd.urls, 2, async u => { const i = await pageInfo(u); tick(); return i; })).filter(p => p.status === 200);
  const oldPages = await pool(od.urls, 2, async u => { const i = await pageInfo(u); tick(); return i; });
  log(`Testing ${oldPages.length} old addresses on the new site…`);
  let m = 0;
  const rows = await pool(oldPages, 2, async o => {
    let status, target = '', reason;
    if (normPath(o.path) === '/' || HOME_ALIASES.has(normPath(o.path))) {
      const probe = normPath(o.path) === '/' ? { status: 200, url: newOrigin + '/' } : await fetchPatient(newOrigin + o.path);
      if (normPath(o.path) === '/' || (probe.status === 200 && normPath(new URL(probe.url).pathname) === '/')) { status = 'none'; target = '/'; reason = normPath(o.path) === '/' ? 'Homepage' : 'Lands on the homepage'; }
      else { status = 'redirect'; target = '/'; reason = 'Old homepage address'; }
    } else {
      const probe = await fetchPatient(newOrigin + o.path);
      const finalPath = probe.url ? new URL(probe.url).pathname : null;
      if (probe.status === 429 || probe.status === 0 || probe.status >= 500) {
        status = 'attention'; reason = `Couldn't check (${probe.status || 'no answer'}) · run again`;
      } else if (probe.status === 200 && finalPath) {
        status = 'none'; target = finalPath;
        reason = normPath(finalPath) === normPath(o.path) ? 'Same address' : `Lands on ${finalPath}`;
      } else {
        const b = bestMatch(o, newPages);
        if (b && b.score >= 0.6) { status = 'redirect'; target = b.path; reason = `${probe.status || 'No answer'} · ${b.how}`; }
        else { status = 'attention'; target = b && b.score >= 0.3 ? b.path : ''; reason = `${probe.status || 'No answer'} · ${target ? 'best guess' : 'no match'}`; }
      }
    }
    m++; if (m % 10 === 0) progress(0.6 + 0.38 * m / oldPages.length);
    return { id: rowId(o.path), page: o.title || lastSeg(o.path) || 'Home', oldUrl: o.url, oldPath: o.path, oldStatus: o.status, auto: { status, target, reason } };
  });
  rows.sort((a, b) => a.oldPath.localeCompare(b.oldPath));
  const counts = rows.reduce((c, r) => (c[r.auto.status] = (c[r.auto.status] || 0) + 1, c), {});
  const meta = { id: null, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, counts, oldBase: site.referenceUrl, newBase: newOrigin, newPages: newPages.map(p => ({ path: p.path, title: p.title })) };
  // Keep what a person set (status, target, decision, applied) for addresses already in the list.
  updateState(site.id, s => {
    const prev = new Map((s.urls?.rows || []).map(r => [r.id, r]));
    const merged = rows.map(r => { const p = prev.get(r.id); return p ? { ...r, status: p.status, target: p.target, decision: p.decision, applied: p.applied } : r; });
    s.urls = { ...(s.urls || {}), rows: merged, newPages: meta.newPages, runs: [{ ...meta, newPages: undefined }, ...(s.urls?.runs || [])].slice(0, 20) };
  });
  log(`Done: ${Object.entries(counts).map(([k, v]) => `${v} ${URL_STATUSES[k].toLowerCase()}`).join(', ')}.`);
  return meta;
}

export function setUrlRow(siteId, id, patch) {
  let out;
  updateState(siteId, s => {
    const r = (s.urls?.rows || []).find(x => x.id === id);
    if (!r) throw new Error('Unknown row.');
    if ('status' in patch) r.status = patch.status === null || patch.status === r.auto?.status ? undefined : (URL_STATUSES[patch.status] ? patch.status : r.status);
    if ('target' in patch) { const t = String(patch.target || '').trim(); r.target = t === (r.auto?.target || '') ? undefined : toPath(t, s); }
    if ('decision' in patch) r.decision = ['approve', 'decline'].includes(patch.decision) ? patch.decision : null;
    out = r;
  });
  return out;
}

// Targets are stored as paths on the new site, so redirects keep working after the domain moves.
function toPath(t) {
  if (!t) return '';
  try { const u = new URL(t, 'https://x.invalid'); return u.pathname + u.search; } catch { return t.startsWith('/') ? t : '/' + t; }
}

export function planRedirects(siteId) {
  const rows = getState(siteId).urls?.rows || [];
  const todo = [], skipped = [];
  for (const r of rows) {
    if (r.decision !== 'approve') continue;
    const e = effective(r);
    if (e.status !== 'redirect') { skipped.push({ ...r, why: `Status is “${URL_STATUSES[e.status]}”.` }); continue; }
    if (!e.target) { skipped.push({ ...r, why: 'No new URL set.' }); continue; }
    if (normPath(e.target) === normPath(r.oldPath)) { skipped.push({ ...r, why: 'Old and new address are the same.' }); continue; }
    if (r.applied?.state === 'verified' && r.applied.target === e.target) continue;
    todo.push({ id: r.id, page: r.page, from: r.oldPath, to: toPath(e.target) });
  }
  return { todo, skipped };
}

export const ADD_PHP = pairs => String.raw`<?php
$pairs = json_decode( base64_decode( '${Buffer.from(JSON.stringify(pairs)).toString('base64')}' ), true );
$done = function ( $data ) { echo '<<<WPEQA>>>' . wp_json_encode( $data ) . '<<</WPEQA>>>'; };
if ( ! class_exists( 'Red_Item' ) || ! class_exists( 'Red_Group' ) || ! class_exists( 'Red_Url_Match' ) ) { $done( array( 'error' => 'The Redirection plugin did not load.' ) ); return; }
global $wpdb;
$gid = (int) $wpdb->get_var( "SELECT id FROM {$wpdb->prefix}redirection_groups WHERE module_id = 1 AND status = 'enabled' ORDER BY ( name = 'Redirections' ) DESC, position ASC, id ASC LIMIT 1" );
if ( ! $gid ) { $g = Red_Group::create( 'Redirections', 1 ); $gid = $g ? (int) $g->get_id() : 0; }
if ( ! $gid ) { $done( array( 'error' => 'No Redirection group to add redirects to.' ) ); return; }
$out = array();
foreach ( $pairs as $p ) {
	$m     = new Red_Url_Match( $p['from'] );
	$match = $m->get_url();
	$have  = $wpdb->get_row( $wpdb->prepare( "SELECT id, action_data FROM {$wpdb->prefix}redirection_items WHERE match_url = %s AND status = 'enabled' LIMIT 1", $match ) );
	if ( $have ) { $out[ $p['id'] ] = array( 'state' => 'exists', 'redirect_id' => (int) $have->id, 'existing_target' => $have->action_data ); continue; }
	$r = Red_Item::create( array(
		'url'         => $p['from'],
		'match_type'  => 'url',
		'action_type' => 'url',
		'action_code' => 301,
		'action_data' => array( 'url' => $p['to'] ),
		'group_id'    => $gid,
		'regex'       => 0,
		'title'       => 'Old site: ' . $p['page'],
	) );
	$out[ $p['id'] ] = is_wp_error( $r ) ? array( 'state' => 'failed', 'error' => $r->get_error_message() ) : array( 'state' => 'added', 'redirect_id' => (int) $r->get_id() );
}
$done( array( 'group' => $gid, 'results' => $out ) );
`;

// Apply approved redirects: backup, Redirection installed and set up if needed, add each redirect, verify.
export async function applyRedirects({ site, runId, log, progress = () => {} }) {
  if (!site.install) throw new Error('This site has no WP Engine install, so redirects cannot be added. Add it in Site settings.');
  const { todo } = planRedirects(site.id);
  if (!todo.length) throw new Error('No approved redirects to add. Approve rows with the status “Redirect” first.');
  const startedAt = new Date().toISOString();
  log(`${todo.length} redirect${todo.length === 1 ? '' : 's'} to add on ${site.url} (WP Engine install ${site.install}).`);
  const backup = await backupSite(site, runId, {}, log);
  progress(0.3);
  log('Making sure the Redirection plugin is installed and set up…');
  const setup = await sshRun(site.install, `${fixPreamble(site.install)}
if ! wp plugin is-installed redirection; then wp plugin install redirection --quiet && echo "Installed Redirection."; fi
if ! wp plugin is-active redirection; then wp plugin activate redirection --quiet && echo "Activated Redirection."; fi
P=$(wp db prefix)
if [ -z "$(wp db query "SHOW TABLES LIKE '\${P}redirection_items'" --skip-column-names 2>/dev/null)" ]; then wp redirection database install && echo "Created Redirection's tables."; fi
wp plugin get redirection --field=version | sed 's/^/Redirection version /'
echo SETUP_OK
`);
  setup.out.split('\n').filter(l => l && l !== 'SETUP_OK').forEach(l => log('  ' + l));
  if (setup.code !== 0 || !setup.out.includes('SETUP_OK')) throw new Error(`Could not set up the Redirection plugin. ${setup.err.split('\n').slice(-2).join(' ')}`);
  progress(0.45);
  log('Adding the redirects…');
  const add = await sshRun(site.install, `${fixPreamble(site.install)}php_eval <<'WPEQA_PHP'
${ADD_PHP(todo)}
WPEQA_PHP
`);
  const mm = add.out.match(/<<<WPEQA>>>([\s\S]*?)<<<\/WPEQA>>>/);
  if (!mm) throw new Error(`Adding redirects failed. ${[add.err, add.out].join(' ').split('\n').slice(-3).join(' ')}`);
  const res = JSON.parse(mm[1]);
  if (res.error) throw new Error(res.error);
  for (const t of todo) { const r = res.results[t.id]; log(`  ${t.from} → ${t.to}: ${r.state === 'added' ? 'added' : r.state === 'exists' ? 'a redirect for this address already exists (left as is)' : 'failed: ' + r.error}`); }
  progress(0.7);
  log('Clearing caches…');
  await sshRun(site.install, `${fixPreamble(site.install)}wp cache flush >/dev/null 2>&1
wp eval 'if ( class_exists( "WpeCommon" ) ) { WpeCommon::purge_memcached(); WpeCommon::purge_varnish_cache(); } if ( function_exists( "rocket_clean_domain" ) ) { rocket_clean_domain(); }' >/dev/null 2>&1
wp page-cache flush >/dev/null 2>&1; wp cdn-cache flush >/dev/null 2>&1; echo done`);
  log('Checking each old address now redirects…');
  const origin = new URL(site.url).origin; const outcomes = {};
  await pool(todo, 3, async t => {
    const r = res.results[t.id];
    if (r.state === 'failed') { outcomes[t.id] = { state: 'failed', error: r.error }; return; }
    const probe = await fetchText(origin + t.from, { redirect: 'manual' }); // no cache-buster: Redirection matches query strings exactly
    let landed = probe.headers?.location || '';
    try { landed = new URL(landed, origin).pathname; } catch { /* keep raw */ }
    const ok = [301, 302, 307, 308].includes(probe.status) && normPath(landed) === normPath(t.to.split('?')[0]);
    outcomes[t.id] = { state: ok ? 'verified' : r.state === 'exists' ? 'exists' : 'applied', status: probe.status, landed, redirectId: r.redirect_id };
  });
  for (const t of todo) { const o = outcomes[t.id]; if (o.state !== 'verified') log(`  ${t.from}: ${o.state === 'failed' ? 'not added' : `answers ${o.status}${o.landed ? ' → ' + o.landed : ''}, not ${t.to} yet (cache, or an existing rule)`}`); }
  const states = Object.values(outcomes).reduce((c, o) => (c[o.state] = (c[o.state] || 0) + 1, c), {});
  const meta = { id: runId, startedAt, finishedAt: new Date().toISOString(), backup, states, count: todo.length };
  updateState(site.id, s => {
    for (const r of s.urls?.rows || []) { const o = outcomes[r.id]; const t = todo.find(x => x.id === r.id); if (o) r.applied = { ...o, target: t.to, at: meta.finishedAt, runId }; }
    s.urls.applyRuns = [meta, ...(s.urls.applyRuns || [])].slice(0, 30);
  });
  log(`Done: ${Object.entries(states).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
  progress(1);
  return meta;
}
