// Old → New URLs: every page of the old site, tested on the new site, with a proposed redirect where
// the old address no longer works. Approved redirects go into the Redirection plugin
// (https://wordpress.org/plugins/redirection/) over SSH, through the plugin's own Red_Item::create().
// Run Tool here is read-only; only "Apply approved redirects" changes the site (after a backup).
import crypto from 'node:crypto';
import { discoverUrls, fetchText, pool } from './crawl.mjs';
import { sshRun, fixPreamble, wpEvalJson } from './wpe.mjs';
import { backupSite } from './fixrun.mjs';
import { getState, updateState } from './store.mjs';
import { buildLegacy, planLegacy } from './legacy.mjs';

export const URLS_TAB = 'urls';
// The goal is to keep the old site's addresses: none = the old URL works as it is; redirect = the page moved, and a
// person chooses to keep the old URL (move the page back) or use the new one (301); attention = no confident match.
export const URL_STATUSES = { none: 'Same URL', redirect: 'URL changed', attention: 'Needs attention' };
export const CHOICES = { keep: 'Keep old URL', new: 'Use new URL' };

const STOP = new Set(['the', 'and', 'for', 'with', 'our', 'your', 'you', 'page', 'new', 'old', 'www', 'html', 'php']);
const words = s => new Set(String(s || '').toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n); };
const lastSeg = p => (p.replace(/\/+$/, '').split('/').pop() || '').toLowerCase();
export const normPath = p => { let x = p || '/'; try { x = decodeURI(x); } catch { /* keep as is */ } x = x.split('#')[0].replace(/\/+$/, ''); return (x || '/').toLowerCase(); };
const rowId = p => crypto.createHash('sha1').update(normPath(p)).digest('hex').slice(0, 12);
const HOME_ALIASES = new Set(['/home', '/index', '/index.html', '/index.php', '/home-page', '/homepage']);
const decode = s => s.replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
// "Back Pain — Example Clinic" → "Back Pain"
const cleanTitle = t => { const parts = decode(t).replace(/\s+/g, ' ').trim().split(/\s+[|–—·•-]\s+/); return (parts[0] || '').trim(); };

// Cloudflare/WP Engine answer 429 to bursts: wait and retry, so a busy server never reads as a missing page.
export async function fetchPatient(url, opts) {
  let r;
  for (const wait of [0, 2000, 6000, 12000]) {
    if (wait) await new Promise(res => setTimeout(res, wait));
    r = await fetchText(url, opts);
    if (r.status !== 429 && r.status !== 0 && r.status < 500) break;
  }
  return r;
}

export async function pageInfo(url) {
  const r = await fetchPatient(url);
  const m = (r.text || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return { url, path: (() => { const u = new URL(url); return u.pathname + u.search; })(), status: r.status, title: m ? cleanTitle(m[1]) : '' };
}

// Best page on the new site for an old page: same slug, same title, or most words in common.
export function bestMatch(old, pages) {
  const oSlug = lastSeg(old.path), oSlugW = words(oSlug), oTitleW = words(old.title), oAll = new Set([...oSlugW, ...oTitleW]);
  let best = null, second = null;
  for (const p of pages) {
    const pSlug = lastSeg(p.path); let score = 0, how = '';
    if (oSlug && pSlug === oSlug) { score = 1; how = 'same slug'; }
    else if (old.title && p.title && old.title.toLowerCase() === p.title.toLowerCase()) { score = 0.95; how = 'same page title'; }
    else {
      const s1 = jaccard(oSlugW, words(pSlug)), s2 = jaccard(oTitleW, words(p.title)), s3 = 0.9 * jaccard(oAll, new Set([...words(pSlug), ...words(p.title)]));
      score = Math.max(s1, s2, s3); how = score === s2 ? 'similar title' : 'similar address';
    }
    if (!best || score > best.score) { second = best; best = { path: p.path, title: p.title, score, how }; }
    else if (!second || score > second.score) second = { path: p.path, title: p.title, score, how };
  }
  return best ? { ...best, runnerUp: second } : null;
}

// Can the old URL be kept for the page in use? The scan checked its own pick; a page a person picked is checked on its own.
export const keepInfo = r => (r.target !== undefined ? r.keep : r.auto?.keep);

// The scan decides the status. Only rows that need attention take a new URL from a person.
// Rows that need attention never default to "Keep old URL": a person picks the page first, then chooses.
export const effective = r => { const status = r.auto?.status || 'attention'; return { status, target: (status === 'attention' ? r.target : undefined) ?? r.auto?.target ?? '', choice: r.choice || (status !== 'attention' && keepInfo(r)?.ok ? 'keep' : 'new') }; };

// Run Tool for this tab: read-only.
export async function buildUrlMap({ site, log, progress = () => {} }) {
  if (!site.referenceUrl) throw new Error("Set the old site's address (Old site URL) in Site settings first.");
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
    let status, target = '', reason, how = '', score = 0, alt;
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
        target = finalPath;
        if (normPath(finalPath) === normPath(o.path)) { status = 'none'; reason = 'Same address'; }
        // Reached only by a redirect (often WordPress guessing): the page itself moved.
        else if (lastSeg(finalPath) === lastSeg(o.path)) { status = 'redirect'; how = 'same slug'; score = 1; reason = `Moved to ${finalPath}`; }
        // WordPress "guesses" a page for unknown addresses by prefix (/test/ → /testimonials/): a person should confirm.
        else { status = 'attention'; reason = `WordPress guessed ${finalPath} · confirm`; }
      } else {
        const b = bestMatch(o, newPages);
        const tie = b && b.score < 1 && b.runnerUp && b.runnerUp.score >= b.score - 0.05;
        if (b && b.score >= 0.6 && !tie) { status = 'redirect'; target = b.path; how = b.how; score = b.score; reason = `${probe.status || 'No answer'} · ${b.how}`; }
        else if (b && b.score >= 0.6) { status = 'attention'; target = b.path; reason = '2 pages match · pick one'; alt = [b.path, b.runnerUp.path]; }
        else { status = 'attention'; target = b && b.score >= 0.3 ? b.path : ''; reason = `${probe.status || 'No answer'} · ${target ? 'best guess' : 'no match'}`; }
      }
    }
    m++; if (m % 10 === 0) progress(0.6 + 0.38 * m / oldPages.length);
    return { id: rowId(o.path), page: o.title || lastSeg(o.path) || 'Home', oldUrl: o.url, oldPath: o.path, oldStatus: o.status, auto: { status, target, reason, how, score, ...(alt ? { alt } : {}) } };
  });
  rows.sort((a, b) => a.oldPath.localeCompare(b.oldPath));
  // Duplicates: several old pages sent to one new page by a loose match (not the same slug, not the homepage).
  const byTarget = {};
  for (const r of rows) if (r.auto.status === 'redirect') (byTarget[normPath(r.auto.target)] ||= []).push(r);
  for (const list of Object.values(byTarget)) {
    if (list.length < 2) continue;
    // The best match keeps its redirect (with a clear lead); every other loose match needs a person.
    const ranked = [...list].sort((a, b) => b.auto.score - a.auto.score);
    const keep = ranked[0].auto.score > (ranked[1]?.auto.score ?? 0) ? ranked[0] : null;
    for (const r of list) {
      if (r === keep || r.auto.how === 'same slug' || normPath(r.auto.target) === '/') continue;
      const others = list.filter(x => x !== r).map(x => x.oldPath);
      r.auto = { ...r.auto, status: 'attention', reason: `Same new page as ${others[0]}${others.length > 1 ? ` +${others.length - 1}` : ''}` };
    }
  }
  // Can WordPress serve each moved page at its old address again? (read-only check over SSH)
  const movable = rows.filter(r => r.auto.status !== 'none' && r.auto.target);
  if (site.install && movable.length) {
    log(`Checking which of ${movable.length} moved pages can keep their old URL…`);
    try {
      const res = await wpEvalJson(site.install, KEEP_PHP(movable.map(r => ({ id: r.id, from: r.oldPath, to: r.auto.target, page: r.page })), false));
      for (const r of movable) { const k = res.results?.[r.id]; if (k) r.auto.keep = k.ok ? { ok: true, type: k.type } : { ok: false, why: k.why }; }
    } catch (e) { log(`  Could not check over SSH (${e.message}); "Keep old URL" will be checked when you apply.`); }
  }
  // Pages that only exist on the new site: nothing to redirect, listed for review.
  const covered = new Set(rows.flatMap(r => [normPath(r.oldPath), normPath(r.auto.target || '')]));
  const newOnly = newPages.filter(p => !covered.has(normPath(p.path))).map(p => ({ path: p.path, title: p.title }));
  const counts = rows.reduce((c, r) => (c[r.auto.status] = (c[r.auto.status] || 0) + 1, c), {});
  const meta = { id: null, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, counts, oldBase: site.referenceUrl, newBase: newOrigin, newPages: newPages.map(p => ({ path: p.path, title: p.title })) };
  // Keep what a person set (status, target, decision, applied) for addresses already in the list.
  updateState(site.id, s => {
    const prev = new Map((s.urls?.rows || []).map(r => [r.id, r]));
    const merged = rows.map(r => { const p = prev.get(r.id); if (!p) return r; const own = r.auto.status === 'attention' && p.target !== undefined; return { ...r, target: own ? p.target : undefined, keep: own ? p.keep : undefined, choice: p.choice, decision: p.decision, applied: p.applied }; });
    s.urls = { ...(s.urls || {}), rows: merged, newPages: meta.newPages, newOnly, runs: [{ ...meta, newPages: undefined }, ...(s.urls?.runs || [])].slice(0, 20) };
  });
  log(`Done: ${Object.entries(counts).map(([k, v]) => `${v} ${URL_STATUSES[k].toLowerCase()}`).join(', ')}.`);
  // Imported redirects from the old site follow the pages: map them again against this scan.
  if (getState(site.id).urls?.legacy?.files?.length) await buildLegacy({ site, log });
  return meta;
}

export function setUrlRow(siteId, id, patch) {
  let out;
  updateState(siteId, s => {
    const r = (s.urls?.rows || []).find(x => x.id === id);
    if (!r) throw new Error('Unknown row.');
    if ('target' in patch) {
      if (r.auto?.status !== 'attention') throw new Error('Only rows that need attention take a new URL; the scan set this one.');
      const t = String(patch.target || '').trim(), next = t === (r.auto?.target || '') ? undefined : toPath(t, s);
      // A different page: its "Keep old URL" check and the earlier choice no longer apply.
      if (next !== r.target) { r.target = next; delete r.keep; delete r.choice; }
    }
    if ('choice' in patch) {
      if (!CHOICES[patch.choice]) throw new Error('Choose keep or new.');
      const k = keepInfo(r);
      if (patch.choice === 'keep' && k && !k.ok) throw new Error(`The old URL can't be kept: ${k.why}`);
      r.choice = patch.choice;
    }
    if ('decision' in patch) r.decision = ['approve', 'decline'].includes(patch.decision) ? patch.decision : null;
    out = r;
  });
  return out;
}

// After a person picks a page: can that page keep the old URL? Read-only over SSH. If it can't be checked
// now, the button stays available and apply checks again before moving anything.
export async function recheckKeep(site, id) {
  const r = (getState(site.id).urls?.rows || []).find(x => x.id === id);
  if (!r || r.target === undefined) return r;
  let keep;
  if (r.target && site.install) {
    try {
      const res = await wpEvalJson(site.install, KEEP_PHP([{ id, from: r.oldPath, to: r.target, page: r.page }], false));
      const k = res.results?.[id]; if (k) keep = k.ok ? { ok: true, type: k.type } : { ok: false, why: k.why };
    } catch { /* unknown: apply checks again */ }
  }
  let out;
  updateState(site.id, s => {
    const x = (s.urls?.rows || []).find(y => y.id === id);
    if (x && x.target === r.target) { if (keep) x.keep = keep; else delete x.keep; if (x.choice === 'keep' && keep && !keep.ok) delete x.choice; }
    out = x;
  });
  return out;
}

// Targets are stored as paths on the new site, so redirects keep working after the domain moves.
export function toPath(t) {
  if (!t) return '';
  try { const u = new URL(t, 'https://x.invalid'); return u.pathname + u.search; } catch { return t.startsWith('/') ? t : '/' + t; }
}

export function planRedirects(siteId) {
  const rows = getState(siteId).urls?.rows || [];
  const todo = [], skipped = [];
  for (const r of rows) {
    if (r.decision !== 'approve') continue;
    const e = effective(r);
    if (e.status === 'none') { skipped.push({ ...r, why: 'The old URL already works.' }); continue; }
    if (!e.target) { skipped.push({ ...r, why: 'No new page picked.' }); continue; }
    if (normPath(e.target) === normPath(r.oldPath)) { skipped.push({ ...r, why: 'Old and new address are the same.' }); continue; }
    if (r.applied?.state === 'verified' && r.applied.target === e.target && r.applied.choice === e.choice) continue;
    todo.push({ id: r.id, page: r.page, from: r.oldPath, to: toPath(e.target), choice: e.choice });
  }
  const old = planLegacy(siteId);
  return { todo: [...todo, ...old.todo], skipped: [...skipped, ...old.skipped] };
}

// Can the page at `to` live at the old address `from`? With apply=true, move it there (slug + parent) and report
// its former address so a 301 can be added from it; anything WordPress doesn't accept exactly is put back.
export const KEEP_PHP = (rows, apply) => String.raw`<?php
$rows  = json_decode( base64_decode( '${Buffer.from(JSON.stringify(rows)).toString('base64')}' ), true );
$apply = ${apply ? 'true' : 'false'};
$done  = function ( $data ) { echo '<<<WPEQA>>>' . wp_json_encode( $data ) . '<<</WPEQA>>>'; };
$struct = trim( (string) get_option( 'permalink_structure' ), '/' );
$check = function ( $r ) use ( $struct ) {
	$old = trim( (string) wp_parse_url( $r['from'], PHP_URL_PATH ), '/' );
	if ( '' === $old ) { return array( 'ok' => false, 'why' => 'The homepage address cannot be moved.' ); }
	if ( false !== strpos( $r['from'], '?' ) || preg_match( '/\.[a-z0-9]{2,5}$/i', $old ) ) { return array( 'ok' => false, 'why' => "WordPress page addresses can't end in a file extension or carry a query string." ); }
	$pid = $r['to'] ? url_to_postid( home_url( $r['to'] ) ) : 0;
	if ( ! $pid ) { return array( 'ok' => false, 'why' => 'The new URL is not a WordPress page or post.' ); }
	$p = get_post( $pid ); $segs = explode( '/', $old ); $last = end( $segs ); $slug = sanitize_title( $last );
	if ( $slug !== strtolower( $last ) ) { return array( 'ok' => false, 'why' => "The old address has characters WordPress slugs can't use." ); }
	if ( (int) get_option( 'page_on_front' ) === $pid ) { return array( 'ok' => false, 'why' => 'The new page is the homepage.' ); }
	$ex = get_page_by_path( $old, OBJECT, array( 'page', 'post' ) );
	if ( $ex && (int) $ex->ID !== $pid ) { return array( 'ok' => false, 'why' => "Another page already uses /$old/." ); }
	if ( 'page' === $p->post_type ) {
		$parent = 0; $pp_path = implode( '/', array_slice( $segs, 0, -1 ) );
		if ( '' !== $pp_path ) { $pp = get_page_by_path( $pp_path ); if ( ! $pp ) { return array( 'ok' => false, 'why' => "There is no page at /$pp_path/ for it to sit under." ); } $parent = (int) $pp->ID; }
		return array( 'ok' => true, 'post' => $pid, 'type' => 'page', 'slug' => $slug, 'parent' => $parent );
	}
	if ( 'post' === $p->post_type ) {
		if ( 1 === count( $segs ) && '%postname%' === $struct ) { return array( 'ok' => true, 'post' => $pid, 'type' => 'post', 'slug' => $slug, 'parent' => 0 ); }
		return array( 'ok' => false, 'why' => 'Posts follow the permalink structure (/' . $struct . '/), which this old address does not match.' );
	}
	return array( 'ok' => false, 'why' => "It is a {$p->post_type} entry; its address follows that post type's prefix." );
};
$out = array();
foreach ( $rows as $r ) {
	$c = $check( $r );
	if ( ! $apply || ! $c['ok'] ) { $out[ $r['id'] ] = $apply && ! $c['ok'] ? array_merge( $c, array( 'state' => 'failed' ) ) : $c; continue; }
	$before = array( 'name' => get_post_field( 'post_name', $c['post'] ), 'parent' => (int) get_post_field( 'post_parent', $c['post'] ), 'url' => wp_make_link_relative( get_permalink( $c['post'] ) ) );
	$res = wp_update_post( array( 'ID' => $c['post'], 'post_name' => $c['slug'], 'post_parent' => $c['parent'] ), true );
	clean_post_cache( $c['post'] );
	$now  = wp_make_link_relative( get_permalink( $c['post'] ) );
	$want = '/' . trim( (string) wp_parse_url( $r['from'], PHP_URL_PATH ), '/' ) . '/';
	if ( is_wp_error( $res ) || untrailingslashit( $now ) !== untrailingslashit( $want ) ) {
		wp_update_post( array( 'ID' => $c['post'], 'post_name' => $before['name'], 'post_parent' => $before['parent'] ) ); // put it back
		clean_post_cache( $c['post'] );
		$out[ $r['id'] ] = array( 'ok' => false, 'state' => 'failed', 'why' => is_wp_error( $res ) ? $res->get_error_message() : "WordPress gave it $now instead, so it was left at {$before['url']}." );
		continue;
	}
	$out[ $r['id'] ] = array( 'ok' => true, 'state' => 'moved', 'post' => $c['post'], 'was' => $before['url'], 'now' => $now );
}
$done( array( 'results' => $out ) );
`;

export const ADD_PHP = pairs => String.raw`<?php
$pairs = json_decode( base64_decode( '${Buffer.from(JSON.stringify(pairs)).toString('base64')}' ), true );
$done = function ( $data ) { echo '<<<WPEQA>>>' . wp_json_encode( $data ) . '<<</WPEQA>>>'; };
if ( ! class_exists( 'Red_Item' ) || ! class_exists( 'Red_Group' ) || ! class_exists( 'Red_Url_Match' ) ) { $done( array( 'error' => 'The Redirection plugin did not load.' ) ); return; }
global $wpdb;
// New-site page moves go in the main group; redirects carried over from the old site get their own group.
$group = function ( $name ) use ( $wpdb ) {
	$order = 'Redirections' === $name ? "( name = 'Redirections' ) DESC, position ASC, id ASC" : 'id ASC';
	$where = 'Redirections' === $name ? '' : $wpdb->prepare( ' AND name = %s', $name );
	$gid   = (int) $wpdb->get_var( "SELECT id FROM {$wpdb->prefix}redirection_groups WHERE module_id = 1 AND status = 'enabled'$where ORDER BY $order LIMIT 1" );
	if ( ! $gid ) { $g = Red_Group::create( $name, 1 ); $gid = $g ? (int) $g->get_id() : 0; }
	return $gid;
};
$gids = array();
$out = array();
foreach ( $pairs as $p ) {
	$name = empty( $p['legacy'] ) ? 'Redirections' : 'Migrated from old site';
	$gid  = $gids[ $name ] ?? ( $gids[ $name ] = $group( $name ) );
	if ( ! $gid ) { $done( array( 'error' => "No Redirection group \"$name\" to add redirects to." ) ); return; }
	$regex = ! empty( $p['regex'] );
	if ( $regex ) {
		$have = $wpdb->get_row( $wpdb->prepare( "SELECT id, action_data FROM {$wpdb->prefix}redirection_items WHERE url = %s AND regex = 1 AND status = 'enabled' LIMIT 1", $p['from'] ) );
	} else {
		$m    = new Red_Url_Match( $p['from'] );
		$have = $wpdb->get_row( $wpdb->prepare( "SELECT id, action_data FROM {$wpdb->prefix}redirection_items WHERE match_url = %s AND regex = 0 AND status = 'enabled' LIMIT 1", $m->get_url() ) );
	}
	if ( $have ) { $out[ $p['id'] ] = array( 'state' => 'exists', 'redirect_id' => (int) $have->id, 'existing_target' => $have->action_data ); continue; }
	$gone = ! empty( $p['gone'] );
	$r = Red_Item::create( array(
		'url'         => $p['from'],
		'match_type'  => 'url',
		'action_type' => $gone ? 'error' : 'url',
		'action_code' => (int) ( $p['code'] ?? 301 ),
		'action_data' => array( 'url' => $gone ? '' : $p['to'] ),
		'group_id'    => $gid,
		'regex'       => $regex ? 1 : 0,
		'title'       => 'Old site: ' . $p['page'],
	) );
	$out[ $p['id'] ] = is_wp_error( $r ) ? array( 'state' => 'failed', 'error' => $r->get_error_message() ) : array( 'state' => 'added', 'redirect_id' => (int) $r->get_id() );
}
$done( array( 'groups' => $gids, 'results' => $out ) );
`;

// Apply the approved rows: backup; set up Redirection; move "keep old URL" pages back to their old address (with a
// 301 from where they were); add a 301 old → new for "use new URL" rows; clear caches; check every old address.
export async function applyRedirects({ site, runId, log, progress = () => {} }) {
  if (!site.install) throw new Error('This site has no WP Engine install, so nothing can be changed. Add it in Site settings.');
  const { todo } = planRedirects(site.id);
  if (!todo.length) throw new Error('Nothing approved. Choose “Keep old URL” or “Use new URL” on the changed rows and approve them first.');
  const keep = todo.filter(t => t.choice === 'keep'), move = todo.filter(t => t.choice !== 'keep');
  const carried = move.filter(t => t.legacy).length;
  const startedAt = new Date().toISOString();
  log(`${keep.length} page${keep.length === 1 ? '' : 's'} to move back to the old URL, ${move.length - carried} old URL${move.length - carried === 1 ? '' : 's'} to redirect${carried ? `, ${carried} redirect${carried === 1 ? '' : 's'} carried over from the old site` : ''}, on ${site.url} (WP Engine install ${site.install}).`);
  const backup = await backupSite(site, runId, {}, log);
  progress(0.25);
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
  const runPhp = async (php, what) => {
    const r = await sshRun(site.install, `${fixPreamble(site.install)}php_eval <<'WPEQA_PHP'\n${php}\nWPEQA_PHP\n`);
    const m = r.out.match(/<<<WPEQA>>>([\s\S]*?)<<<\/WPEQA>>>/);
    if (!m) throw new Error(`${what} failed. ${[r.err, r.out].join(' ').split('\n').slice(-3).join(' ')}`);
    const j = JSON.parse(m[1]); if (j.error) throw new Error(j.error); return j;
  };
  const results = {};
  const pairs = move.map(t => ({ id: t.id, page: t.page, from: t.from, to: t.to, code: t.code || 301, regex: !!t.regex, gone: !!t.gone, legacy: !!t.legacy }));
  if (keep.length) {
    progress(0.4); log('Moving pages back to their old URLs…');
    const k = await runPhp(KEEP_PHP(keep, true), 'Moving pages');
    for (const t of keep) {
      const r = k.results[t.id] || { state: 'failed', why: 'No result.' }; results[t.id] = r;
      log(`  ${t.to} → ${t.from}: ${r.state === 'moved' ? `moved (was ${r.was})` : 'not moved: ' + r.why}`);
      if (r.state === 'moved' && normPath(r.was) !== normPath(r.now)) pairs.push({ id: t.id + ':was', page: t.page, from: r.was, to: r.now }); // links to the new URL keep working
    }
  }
  if (pairs.length) {
    progress(0.55); log('Adding the redirects…');
    const add = await runPhp(ADD_PHP(pairs), 'Adding redirects');
    for (const p of pairs) { const r = add.results[p.id]; log(`  ${p.code} ${p.from}${p.gone ? ' (gone)' : ' → ' + p.to}: ${r.state === 'added' ? 'added' : r.state === 'exists' ? 'already in Redirection (left as is)' : 'failed: ' + r.error}`); if (!p.id.endsWith(':was')) results[p.id] = r; }
  }
  progress(0.7);
  log('Clearing caches…');
  await sshRun(site.install, `${fixPreamble(site.install)}wp cache flush >/dev/null 2>&1
wp eval 'if ( class_exists( "WpeCommon" ) ) { WpeCommon::purge_memcached(); WpeCommon::purge_varnish_cache(); } if ( function_exists( "rocket_clean_domain" ) ) { rocket_clean_domain(); }' >/dev/null 2>&1
wp page-cache flush >/dev/null 2>&1; wp cdn-cache flush >/dev/null 2>&1; echo done`);
  log('Checking each old URL…');
  const origin = new URL(site.url).origin; const outcomes = {};
  await pool(todo, 3, async t => {
    const r = results[t.id];
    if (!r || r.state === 'failed') { outcomes[t.id] = { state: 'failed', error: r?.why || r?.error || 'not applied', choice: t.choice }; return; }
    if (t.legacy && t.regex) { outcomes[t.id] = { state: r.state === 'exists' ? 'exists' : 'applied', redirectId: r.redirect_id }; return; } // a pattern: no one address to open
    if (t.legacy) {
      const probe = await fetchText(origin + t.from, { redirect: 'manual' });
      let landed = probe.headers?.location || ''; try { const u = new URL(landed, origin); landed = u.origin === origin ? u.pathname + u.search : u.href; } catch { /* keep raw */ }
      const ok = t.gone ? probe.status === t.code : probe.status === t.code && (t.external ? landed === t.to : normPath(landed.split('?')[0]) === normPath(t.to.split('?')[0]));
      outcomes[t.id] = { state: ok ? 'verified' : r.state === 'exists' ? 'exists' : 'applied', status: probe.status, landed, redirectId: r.redirect_id };
      return;
    }
    if (t.choice === 'keep') {
      // The old URL should now serve the page itself (a trailing-slash redirect is fine).
      const probe = await fetchText(origin + t.from); const at = probe.url ? new URL(probe.url).pathname : '';
      outcomes[t.id] = { state: probe.status === 200 && normPath(at) === normPath(t.from) ? 'verified' : 'applied', status: probe.status, landed: at, choice: 'keep' };
    } else {
      const probe = await fetchText(origin + t.from, { redirect: 'manual' }); // no cache-buster: Redirection matches query strings exactly
      let landed = probe.headers?.location || ''; try { landed = new URL(landed, origin).pathname; } catch { /* keep raw */ }
      const ok = [301, 308].includes(probe.status) && normPath(landed) === normPath(t.to.split('?')[0]);
      outcomes[t.id] = { state: ok ? 'verified' : r.state === 'exists' ? 'exists' : 'applied', status: probe.status, landed, redirectId: r.redirect_id, choice: 'new' };
    }
  });
  for (const t of todo) { const o = outcomes[t.id]; if (o.state !== 'verified') log(`  ${t.from}: ${o.state === 'failed' ? 'not changed: ' + o.error : `answers ${o.status}${o.landed ? ' → ' + o.landed : ''} (cache, or an existing rule)`}`); }
  const states = Object.values(outcomes).reduce((c, o) => (c[o.state] = (c[o.state] || 0) + 1, c), {});
  const meta = { id: runId, startedAt, finishedAt: new Date().toISOString(), backup, states, count: todo.length, kept: keep.length, redirected: move.length - carried, carried };
  updateState(site.id, s => {
    for (const r of [...(s.urls?.rows || []), ...(s.urls?.legacy?.rows || [])]) { const o = outcomes[r.id]; const t = todo.find(x => x.id === r.id); if (o) r.applied = { ...o, target: t.to, at: meta.finishedAt, runId }; }
    s.urls.applyRuns = [meta, ...(s.urls.applyRuns || [])].slice(0, 30);
  });
  log(`Done: ${Object.entries(states).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
  progress(1);
  return meta;
}
