// WPE QA Checklist front end (no build step).
const TAB_ORDER = ['qa-swarm', 'wp-site-audit', 'before-launch', 'after-launch', 'urls'];
const URLST = { none: 'No Redirection Needed', redirect: 'Redirect', attention: 'Needs Attention' }; // a URL sheet's own wording
// An applied URL decision: done = in place (verified, added, or already there); failed = the apply didn't take.
// Declined counts as done too (no redirect wanted, nothing left to do), like a declined checklist item counts as passed.
const urlDone = r => ['verified', 'applied', 'exists'].includes(r.applied?.state) || (r.decision === 'decline' && !urlFailed(r));
const urlFailed = r => r.applied?.state === 'failed';
// The tile an old-site redirect counts under, like a page row: Done once it's in place, Redirect Failed if the apply
// didn't take, else by its status (Ready → Redirect; Check it / Needs attention → Needs Attention; Not used → nothing to do).
const LTILE = { ready: 'u:redirect', review: 'u:attention', attention: 'u:attention', unused: 'u:none' };
const ltile = (r, byId) => (urlDone(r) ? 'u:done' : urlFailed(r) ? 'u:failed' : LTILE[leff(r, byId).status] || 'u:attention');
// Same rules as lib/redirects.mjs keepInfo/effective: the "can keep" check belongs to the page in use.
const keepOf = r => (r.target !== undefined ? r.keep : r.auto?.keep);
const eff = r => { const status = r.auto?.status || 'attention'; return { status, target: (status === 'attention' ? r.target : undefined) ?? r.auto?.target ?? '', choice: r.choice || (status !== 'attention' && keepOf(r)?.ok ? 'keep' : 'new') }; };
// Same rules as lib/legacy.mjs legacyEffective: an old redirect to an old page follows that page's decision.
const LST = { ready: 'Ready', review: 'Check it', attention: 'Needs attention', unused: 'Not used' };
const LCLS = { ready: 'none', review: 'redirect', attention: 'attention', unused: 'unused' };
const viaTarget = m => { const e = eff(m); return e.status === 'none' || (e.choice === 'keep' && m.decision === 'approve') ? m.oldPath : e.target; };
const leff = (r, byId) => {
  const a = r.auto || {};
  if (a.via) { const m = byId.get(a.via); const t = m ? viaTarget(m) : ''; return t ? { status: a.status, target: t, reason: a.reason } : { status: 'attention', target: '', reason: m ? `${a.reason} · pick its new page in the page list first` : 'Run Tool again', waiting: true }; }
  return { status: a.status, target: (a.status === 'attention' ? r.target : undefined) ?? a.target ?? '', reason: a.reason };
};
const legacyPending = u => { const byId = new Map((u.rows || []).map(m => [m.id, m])); return (u.legacy?.rows || []).filter(r => { if (r.decision !== 'approve' || r.auto?.byHand) return false; const e = leff(r, byId); return (e.target || r.gone) && !(r.applied?.state === 'verified' && r.applied.target === e.target); }); };
const urlsPending = rows => rows.filter(r => r.decision === 'approve' && eff(r).status !== 'none' && eff(r).target && !(r.applied?.state === 'verified' && r.applied.target === eff(r).target && r.applied.choice === eff(r).choice));
const STATUS = [['pass', 'Pass'], ['fail', 'Fail'], ['warn', 'Look'], ['na', 'N/A'], ['todo', 'To do']];
const LABEL = { pass: 'Passed', fail: 'Failed', warn: 'Needs a look', na: 'N/A', todo: 'To do' };
const TILE = { pass: 'Passed', fail: 'Failed', warn: 'To Look At', na: 'N/A', todo: 'Manual To Do' };

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat()) if (c != null) e.append(c); return e; };
// Read-only report: a snapshot built by `wpeqa snapshot` carries its data in window.WPEQA_SNAPSHOT. The page then reads
// from it, refuses every change, and shows views only (no action buttons, notes as text).
const SNAP = window.WPEQA_SNAPSHOT || null;
function snapApi(path, opts) {
  if ((opts.method || 'GET') !== 'GET') throw new Error('This is a read-only report.');
  if (path === '/config') return SNAP.config;
  if (path === '/checklists') return SNAP.templates;
  if (path === '/sites') return SNAP.sites;
  if (path === `/sites/${SNAP.site.site.id}`) return structuredClone(SNAP.site);
  throw new Error('Not part of this report.');
}
const api = async (path, opts = {}) => { if (SNAP) return snapApi(path, opts); const r = await fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
const ago = iso => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString(); };
const linkify = text => { const frag = document.createDocumentFragment(); let last = 0; for (const m of text.matchAll(/(https?:\/\/\S+|\/runs\/\S+)/g)) { frag.append(text.slice(last, m.index)); frag.append(el('a', { href: m[0], target: '_blank', rel: 'noopener', text: m[0].length > 70 ? m[0].slice(0, 67) + '…' : m[0] })); last = m.index + m[0].length; } frag.append(text.slice(last)); return frag; };
const FIXSTATE = { verified: 'Fixed · verified', applied: 'Fix applied · still flagged', failed: 'Fix failed', manual: 'In fix request', question: 'Claude asked you', reverted: 'Fix reverted', 'not-reverted': 'Revert not done' };
const fixLabel = f => f.by === 'claude' ? ({ verified: 'Fixed by Claude · verified', applied: 'Fixed by Claude · check it', manual: 'Claude skipped · in fix request', question: 'Claude has a question · answer above' }[f.state] || FIXSTATE[f.state]) : FIXSTATE[f.state] || f.state;
// The pill says where an item stands, in plain words. Fix Failed: what's happening with the fix. Fixed: how it
// got there. Declined: won't fix. The current check result wins over the last fix run (fix.toolAt is the finding that
// run worked on), so a passing item is always Done and an old question stops asking for an answer.
function fixPill(s) {
  const f = s.fix, bad = ['fail', 'warn'].includes(s.status);
  if (s.decision === 'decline') return bad ? { cls: 'declined', text: 'Declined · won’t fix', title: 'You declined this fix. Press Decline again to undo.' } : null;
  if (s.decision === 'approve' && bad && s.confirmed) return { cls: 'done', text: 'Done · confirmed by you', title: `You confirmed this fix ${ago(s.confirmed.at)}. The check can't tell by itself; the item comes back if a later run finds something different.` };
  if (s.decision === 'approve' && s.status === 'pass') {
    // A fix that ran (verified at once, or applied and confirmed by a later re-check) gets the credit.
    const how = ['verified', 'applied'].includes(f?.state) ? (f.by === 'claude' ? 'fixed by Claude' : 'fixed by the app') : 'passes now';
    return { cls: 'done', text: `Done · ${how}`, title: f ? `Last fix run: ${f.action || f.reason || f.state}` : 'The check passes now.' };
  }
  if (s.decision === 'approve' && bad) {
    if (!f) return { cls: 'approved', text: 'Approved · not applied yet', title: 'Runs with the next Apply fixes.' };
    const stale = f.toolAt !== (s.tool?.at || null);
    const unreported = f.unreported || /did not report/i.test(f.reason || '');
    const text = f.state === 'question' ? (stale ? 'Claude asked earlier · run Apply fixes' : 'Claude has a question · answer above')
      : f.state === 'manual' ? (f.by !== 'claude' ? 'In fix request · needs a developer' : unreported ? 'Claude didn’t finish · in fix request' : 'Claude skipped it · in fix request')
      : f.state === 'applied' ? (f.by === 'claude' ? 'Claude fixed it · still flagged' : 'Fix applied · still flagged')
      : f.state === 'failed' ? 'Fix failed'
      : fixLabel(f);
    return { cls: f.state === 'question' && !stale ? 'question' : f.state === 'failed' ? 'failed' : f.state === 'applied' ? 'applied' : 'manual', text, title: f.reason || f.action || '' };
  }
  return f ? { cls: f.state, text: fixLabel(f), title: f.reason || f.action || '' } : null;
}
const copy = async (text, btn) => { try { await navigator.clipboard.writeText(text); const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1500); } catch { prompt('Copy this:', text); } };
// Child findings (same rules as lib/children.mjs; keep the two in step). A check can report separate findings as child
// cards under one item. Each child is its own item in the state (`<parent>::<key>`) with its own status, note and
// Approve / Decline; the parent becomes a container that shows them and that nobody decides on.
const SEP = '::';
const childItems = (it, items = {}) => { const pre = it.id + SEP; return Object.keys(items).filter(id => id.startsWith(pre) && items[id]?.tool).sort((a, b) => (items[a].tool.order ?? 1e3) - (items[b].tool.order ?? 1e3) || a.localeCompare(b)).map(id => ({ id, title: items[id].tool.title || id.slice(pre.length), description: items[id].tool.description || '', owner: it.owner, ownerLabel: it.ownerLabel, check: it.check, parent: it.id })); };
const kidsOf = (t, it) => (it.parent ? [] : childItems(it, tabState(t).items));
const isContainer = (t, it) => kidsOf(t, it).length > 0;
// The checklist with each container's children after it, and the items that count (tiles, badges, fixes): every
// item except containers, whose children count instead.
const tplOf = t => templates[t] && { ...templates[t], sections: templates[t].sections.map(sec => ({ ...sec, items: sec.items.flatMap(it => [it, ...kidsOf(t, it)]) })) };
const countable = t => tplOf(t).sections.flatMap(s => s.items).filter(it => !isContainer(t, it));
const pendingFixes = t => countable(t).filter(it => { const s = tabState(t).items[it.id]; return s && s.decision === 'approve' && ['fail', 'warn'].includes(s.status) && !s.confirmed && !(['verified', 'manual', 'question'].includes(s.fix?.state) && s.fix.toolAt === s.tool?.at); });
// Approved items an earlier fix run left in a fix request (same finding): "Retry fix request" runs them again.
const retryFixes = t => countable(t).filter(it => { const s = tabState(t).items[it.id]; return s && s.decision === 'approve' && ['fail', 'warn'].includes(s.status) && !s.confirmed && s.fix?.state === 'manual' && s.fix.toolAt === s.tool?.at; });
let fixRetry = false;
// Cards you just decided on stay in the current view (with a note) until you pick another tile, tab or site.
const kept = new Set();
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let config = {}, templates = {}, sites = [], current = null, data = null, tab = store.get('wpeqa.tab') || 'qa-swarm', filter = 'all', stream = null;
// Which section each checklist tab shows ('all' or a section title), remembered per tab.
let secSel = (() => { try { return JSON.parse(store.get('wpeqa.sec') || '{}'); } catch { return {}; } })();

async function boot() {
  if (SNAP) document.body.classList.add('readonly');
  [templates, config] = await Promise.all([api('/checklists'), api('/config')]);
  if (config.version) { $('appVersion').textContent = 'v' + config.version; $('appVersion').title = `Reads Greenlight v${config.greenlightMin}+ security status`; }
  await loadSites(store.get('wpeqa.site'));
}

async function loadSites(select) {
  sites = await api('/sites');
  const pick = $('sitePick'); pick.replaceChildren(...sites.map(s => el('option', { value: s.id, text: `${s.name} · ${s.url.replace(/^https?:\/\//, '')}` })));
  $('empty').hidden = !!sites.length; $('siteView').hidden = !sites.length; $('editSite').hidden = !sites.length; pick.hidden = !sites.length;
  if (!sites.length) return;
  const id = sites.some(s => s.id === select) ? select : sites[0].id;
  pick.value = id; await openSite(id);
}

async function openSite(id) {
  if (id !== current?.id) kept.clear();
  store.set('wpeqa.site', id);
  data = await api('/sites/' + id); current = data.site;
  $('siteName').textContent = current.name;
  // Published reports (each its own artifact): the Reports menu lists every one with its date, newest first.
  const reports = data.reports || [], when = r => new Date(r.generatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  $('reportMenu').hidden = !reports.length; $('reportsBtn').textContent = `Reports (${reports.length}) ▾`;
  $('reportList').replaceChildren(...reports.map((r, i) => el('a', { class: 'reportitem', role: 'listitem', href: r.url, target: '_blank', rel: 'noopener' },
    el('b', { text: when(r) }), el('span', { text: i === 0 ? 'newest · open ↗' : 'open ↗' }))));
  $('siteHome').href = current.url; $('siteHome').textContent = current.url.replace(/^https?:\/\//, '') + (current.prodUrl ? ' (staging)' : '');
  $('siteProd').hidden = !current.prodUrl; if (current.prodUrl) { $('siteProd').querySelector('a').href = current.prodUrl; $('siteProd').querySelector('a').textContent = current.prodUrl.replace(/^https?:\/\//, ''); }
  $('siteInstall').replaceChildren(current.install
    ? el('span', { title: current.installHow || '' }, 'WP Engine install ', el('code', { text: current.install }), current.installHow ? ` (${current.installHow})` : '')
    : el('span', { class: 'warnline', text: 'No WP Engine install found, so WordPress checks are skipped. Add it in Site settings.' }));
  render();
  const active = data.active.find(a => a.tab === tab) || data.active[0];
  if (active) { if (active.tab !== tab) { tab = active.tab; render(); } follow(active.id); } else { $('runPanel').hidden = true; setRunning(false); }
}

function tabState(t) { return data.state.tabs?.[t] || { items: {}, runs: [] }; }
function statusOf(t, it) { return tabState(t).items[it.id]?.status || 'todo'; }
// Decided items leave the normal lists, counts and badges and show in their own view instead:
//   approved: fix approved, still failing or flagged (in progress) · done: fix approved and the check passes now ·
//   declined: fix declined, still failing or flagged. A declined item that passes later is back to normal; a done
//   item that fails again is approved (in progress) again.
const BUCKETS = { approved: 'Fix Failed', done: 'Fixed', declined: 'Declined' };
function bucketOf(t, it) {
  const s = tabState(t).items[it.id]; if (!s?.decision) return null;
  const bad = ['fail', 'warn'].includes(s.status);
  if (s.decision === 'decline') return bad ? 'declined' : null;
  if (!bad) return s.status === 'pass' ? 'done' : null;
  if (s.confirmed) return 'done';
  // Approved and still failing: Fix Failed only once a fix has run and the check still fails (failed, applied but still
  // flagged, or fixed earlier and failing again). Until then it stays in Needs Attention with its pill.
  return fixRan(s) ? 'approved' : null;
}
const fixRan = s => ['failed', 'applied', 'verified'].includes(s.fix?.state);
const isBad = (t, it) => ['fail', 'warn'].includes(statusOf(t, it)) && !bucketOf(t, it); // = Needs Attention

function render() {
  // Tabs with a badge for items that need attention.
  $('tabs').replaceChildren(...TAB_ORDER.map(t => {
    if (t === 'urls') {
      const u = data.state.urls || {}; const byId = new Map((u.rows || []).map(m => [m.id, m]));
      const open = (u.rows || []).filter(r => eff(r).status !== 'none' && !r.decision).length + (u.legacy?.rows || []).filter(r => leff(r, byId).status === 'attention' && !r.decision).length;
      return el('button', { role: 'tab', 'aria-selected': String(t === tab), onclick: () => { tab = t; kept.clear(); store.set('wpeqa.tab', t); render(); } }, 'Old → New URLs', u.runs?.length ? el('span', { class: 'badge' + (open ? '' : ' ok'), text: open ? String(open) : '✓' }) : null);
    }
    if (t === 'after-launch' && !(data.state.prod && current.prodUrl && data.state.prod.url === current.prodUrl)) return el('button', { role: 'tab', 'aria-selected': String(t === tab), title: 'Unlocks once the production site is confirmed live', onclick: () => { tab = t; kept.clear(); store.set('wpeqa.tab', t); render(); } }, templates[t].title, el('span', { class: 'badge lock', text: '🔒' }));
    const tpl = templates[t]; const items = countable(t);
    const bad = items.filter(i => isBad(t, i)).length;
    const ran = tabState(t).runs?.length;
    return el('button', { role: 'tab', 'aria-selected': String(t === tab), onclick: () => { tab = t; kept.clear(); store.set('wpeqa.tab', t); render(); } }, tpl.title, ran ? el('span', { class: 'badge' + (bad ? '' : ' ok'), text: bad ? String(bad) : '✓' }) : null);
  }));
  $('reportLink').hidden = tab === 'urls'; $('runTool').hidden = false;
  // Filters live on the count tiles; a filter from another kind of tab doesn't carry over.
  if ((tab === 'urls') !== filter.startsWith('u:') && filter !== 'all') filter = 'all';
  $('secNav').hidden = tab === 'urls'; $('askPanel').hidden = true; fixRetry = false;
  if (tab === 'urls') return renderUrls();
  if (tab === 'after-launch' && !(data.state.prod && current.prodUrl && data.state.prod.url === current.prodUrl)) return renderLiveGate();
  const tpl = templates[tab]; const ts = tabState(tab);
  const last = ts.runs?.find(r => !r.partial) || ts.runs?.[0]; // a fix run's re-check of a few items isn't a full run
  $('lastRun').textContent = last ? `Ran ${ago(last.finishedAt)} · ${Math.round(last.durationMs / 1000)} s` : 'Not run yet';
  $('reportLink').href = `/api/sites/${current.id}/report/${tab}`;
  $('runTool').textContent = `Run Tool`;
  // Nothing new to fix, but approved items are sitting in a fix request: offer to retry them (e.g. with Claude).
  const pend = pendingFixes(tab).length, retry = pend ? 0 : retryFixes(tab).length;
  fixRetry = !pend && retry > 0;
  $('applyFixes').hidden = !pend && !retry;
  $('applyFixes').textContent = pend ? `Apply fixes (${pend})` : `Retry fix request (${retry})`;
  $('applyFixes').title = fixRetry ? 'These approved items were left in a fix request by an earlier run. Run them again, for example with Claude.' : '';
  renderHistory(); renderAsk();
  $('runTool').title = `Run the automatic ${tpl.title} checks on ${current.name}. Reuses the crawl from a run in the last 15 minutes; Shift-click to load everything again.`;

  const items = countable(tab); // child findings count one by one; their container doesn't
  const inBucket = Object.fromEntries(Object.keys(BUCKETS).map(b => [b, items.filter(i => bucketOf(tab, i) === b).length]));
  // Tile counts use the same rule as the list (tileHas). All is every item; every other tile is a part of it.
  const n = key => items.filter(i => tileHas(i, key)).length;
  const shown = Object.fromEntries(['all', 'pass', 'manualtodo', 'na', 'auto', 'decide', ...Object.keys(BUCKETS)].map(k => [k, n(k)]));
  const needs = shown.decide;
  if (filter !== 'all' && !shown[filter]) filter = 'all';
  // Two panels: Checklist (where the site stands) and Flagged (what needs a decision, and how the fixes went).
  const fixed = inBucket.done, failedFix = inBucket.approved;
  $('counts').replaceChildren(
    countGroup('Checklist', `${shown.pass} of ${shown.all - shown.na} applicable items pass`, [
      countTile('all', 'c-all', shown.all, 'All', 'Every item in this checklist, decided ones included'),
      countTile('pass', 'c-pass', shown.pass, TILE.pass, 'Items that pass now, including Fixed ones'),
      countTile('manualtodo', 'c-todo', shown.manualtodo, TILE.todo, 'Manual items (no tool checks them) still to mark: Pass, Fail, Look or N/A'),
      countTile('na', 'c-na', shown.na, TILE.na),
      countTile('auto', 'c-auto', shown.auto, 'Automatic', 'Items Run Tool checks automatically')]),
    countGroup('Flagged', flaggedHint(items, needs, failedFix, fixed), [
      countTile('decide', 'c-decide' + (needs ? ' is-flagged' : ''), needs, 'Needs Attention', 'Items that fail or need a look and have no Approve / Decline yet'),
      ...Object.keys(BUCKETS).map(b => countTile(b, `c-${b}`, inBucket[b], BUCKETS[b]))], needs ? 'is-flagged' : ''));

  $('sections').replaceChildren(...tpl.sections.map(sec => {
    const rows = sec.items.map(it => itemRow(it));
    return el('section', { class: 'section', 'data-sec': sec.title }, el('h2', {}, sec.title, sec.appliesIf ? el('small', { text: { elementor: '· only when Elementor is active', yootheme: '· only for YOOtheme sites', tailwind: '· only for Tailwind builds', reference: '· needs a reference site' }[sec.appliesIf] }) : null), el('div', { class: 'items' }, rows));
  }));
  applyFilter();
}

// Does this checklist item show under the picked tile? (The same rule the list uses.) All = not decided yet;
// a status tile = not decided with that status; Manual To Do = not decided, checked by hand, not marked yet;
// Fix Failed / Fixed / Declined = that decided view.
// The one rule for "does this item count under / show for a tile" (`key`, default the picked tile). The tile numbers
// and the list both use it, so they always agree. All = every item; Passed = passes now or Fixed; Needs Attention =
// fails or needs a look with no decision yet; the Fixes tiles = that decided view.
function tileHas(it, key = filter) {
  // A container shows wherever one of its child findings does (it doesn't count itself: see countable()).
  if (isContainer(tab, it)) return key === 'all' || key === 'auto' || kidsOf(tab, it).some(k => tileHas(k, key));
  const b = bucketOf(tab, it), st = statusOf(tab, it);
  if (BUCKETS[key]) return b === key;
  switch (key) {
    case 'all': return true;
    case 'pass': return st === 'pass' || b === 'done' || b === 'declined'; // passes, Fixed (incl. confirmed) or Declined
    case 'decide': return !b && ['fail', 'warn'].includes(st);
    case 'manualtodo': return !it.check && st === 'todo';
    case 'auto': return !!it.check;
    default: return st === key;
  }
}
const itemShown = it => tileHas(it);
// Where a card went after a decision, for the "Moved to …" note: its Flagged tile, or the Checklist tile it counts under.
function movedTo(it) {
  const b = bucketOf(tab, it); if (b) return BUCKETS[b];
  const st = statusOf(tab, it);
  return st === 'pass' ? TILE.pass : st === 'na' ? TILE.na : tileHas(it, 'decide') ? 'Needs Attention' : tileHas(it, 'manualtodo') ? TILE.todo : 'All';
}

// Section switcher: one pill per section. Its number is how many cards that section shows for the picked tile, so
// "All" always equals the tile's number. Red when any of them fails or needs a look, green when they all pass.
function renderSecNav(tpl) {
  const secs = tpl.sections;
  if (secSel[tab] && secSel[tab] !== 'all' && !secs.some(s => s.title === secSel[tab])) secSel[tab] = 'all';
  if (!secSel[tab]) secSel[tab] = 'all';
  const pick = t => { secSel[tab] = t; store.set('wpeqa.sec', JSON.stringify(secSel)); applyFilter(); window.scrollTo({ top: $('secNav').offsetTop - 90, behavior: 'smooth' }); };
  const badge = items => {
    const shown = items.filter(i => !isContainer(tab, i) && itemShown(i)); const st = shown.map(i => statusOf(tab, i));
    const cls = shown.some(i => isBad(tab, i)) ? ' bad' : shown.length && st.every(x => x === 'pass') ? ' ok' : ''; // red: still needs a decision
    return el('span', { class: 'sbadge' + cls, text: String(shown.length) });
  };
  const count = items => items.filter(i => !isContainer(tab, i) && itemShown(i)).length;
  $('secNav').replaceChildren(
    el('button', { type: 'button', 'aria-pressed': String(secSel[tab] === 'all'), onclick: () => pick('all') }, 'All', badge(secs.flatMap(s => s.items))),
    ...secs.map(sec => el('button', { type: 'button', 'aria-pressed': String(secSel[tab] === sec.title), class: count(sec.items) ? null : 'is-empty', title: count(sec.items) ? null : 'Nothing in this section for the picked tile', onclick: () => pick(sec.title) }, sec.title, badge(sec.items))));
}

// Fix Failed cards: why it's still failing. What the fix did (Claude's own summary, or the app's command output), what
// the re-check still finds, and what to do next.
function failWhy(it, s) {
  if (bucketOf(tab, it) !== 'approved' || !s.fix) return null;
  const f = s.fix, who = f.by === 'claude' ? 'Claude' : 'The app';
  const when = f.at ? new Date(f.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const did = f.state === 'failed'
    ? [`${who}'s fix didn't complete${f.action ? ` (${f.action})` : ''}.`, ...(f.output || []).slice(-4)].filter(Boolean)
    : [f.action || f.reason || `${who} reported the fix as done.`];
  const stale = f.toolAt !== (s.tool?.at || null);
  return el('div', { class: 'failwhy', role: 'note' },
    el('b', { class: 'failwhy-title', text: 'Why it\u2019s still failing' }),
    el('dl', {},
      el('dt', { text: `What the fix did${when ? ` · ${when}` : ''}` }),
      el('dd', {}, ...did.map((d, i) => el(i && f.state === 'failed' ? 'code' : 'span', { text: d }))),
      el('dt', { text: stale ? 'What the latest check finds' : 'What the re-check after the fix still finds' }),
      el('dd', { text: s.tool?.summary || 'The check still fails.' })),
    SNAP ? null : el('p', { class: 'failwhy-next', text: f.state === 'failed'
      ? 'Next: look at the output above, then Retry fix request or fix it by hand.'
      : 'Next: if what\u2019s left is on purpose (something you chose to skip), press Confirm fix. Otherwise retry the fix or fix it by hand.' }));
}

function itemRow(it) {
  const s = tabState(tab).items[it.id] || {}; const status = s.status || 'todo';
  const save = patch => { const wasShown = tileHas(it); return api(`/sites/${current.id}/items/${tab}/${encodeURIComponent(it.id)}`, { method: 'PUT', body: patch }).then(v => { (data.state.tabs[tab] ||= { items: {}, runs: [] }).items[it.id] = v; if (wasShown) kept.add(it.id); render(); }).catch(e => alert(e.message)); };
  // Automatic items: the scan decides the status (read-only). Manual items: a person marks them.
  const auto = !!(it.check || s.tool);
  // Confirmed fixes and declined items show as Passed (they count under Passed); hover shows what the check reported.
  const settled = ['fail', 'warn'].includes(status) && (s.decision === 'decline' || (s.decision === 'approve' && s.confirmed));
  const shown = settled ? 'pass' : status;
  const seg = auto || SNAP || settled
    ? el('span', { class: `spill sp-${shown}`, title: settled ? `${s.decision === 'decline' ? 'Declined' : 'Fix confirmed by you'}: counted as passed. The check reported: ${LABEL[status]}.` : auto ? 'Set by Run Tool' : 'Marked by hand', text: auto && !s.tool && !settled ? 'Not run yet' : LABEL[shown] })
    : el('div', { class: 'seg', role: 'group', 'aria-label': `Status of ${it.title}` }, STATUS.map(([k, label]) => el('button', { type: 'button', 'data-s': k, 'aria-pressed': String(status === k), title: LABEL[k], text: label, onclick: () => save({ status: k }) })));
  const src = auto
    ? el('span', { class: 'src', text: s.tool ? `automatic · ${ago(s.tool.at)}` : 'automatic' })
    : el('span', { class: 'src', text: s.source === 'manual' ? `you · ${s.at ? ago(s.at) : ''}` : 'manual check' });
  const details = s.tool?.details?.length ? el('details', {}, el('summary', { text: `${s.tool.details.length} detail${s.tool.details.length === 1 ? '' : 's'}` }), el('ul', {}, s.tool.details.map(d => el('li', {}, linkify(String(d)))))) : null;
  let t; const note = SNAP ? (s.note ? el('p', { class: 'item-note' }, el('b', { text: 'Note: ' }), s.note) : null) : el('input', { type: 'text', value: s.note || '', placeholder: 'Add a note…', 'aria-label': `Note for ${it.title}`, oninput: e => { clearTimeout(t); t = setTimeout(() => api(`/sites/${current.id}/items/${tab}/${encodeURIComponent(it.id)}`, { method: 'PUT', body: { note: e.target.value } }).catch(() => {}), 600); } });
  // A container: its check reported separate findings, shown as child cards; each child gets the decision, not this card.
  const kids = kidsOf(tab, it), box = kids.length > 0;
  const kidsWaiting = kids.filter(k => { const ks = tabState(tab).items[k.id] || {}; return ['fail', 'warn'].includes(ks.status) && !ks.decision; }).length;
  // Revert fix (Fixed cards whose fix a fix run made, so there's a backup from just before it): undoes it on the site.
  // On any card with a fix to undo (the server looks through the item's whole fix history), whatever tile it's under.
  const rv = data.revertable?.[tab]?.[it.id];
  const revert = !SNAP && !box && rv
    ? el('button', { type: 'button', class: 'btn ghost revert', text: 'Revert fix', title: `Undo on the site what the fix of ${new Date(rv.at).toLocaleString()} changed`, onclick: () => revertFix(it, rv) }) : null;
  const fix = !SNAP && !box && ['fail', 'warn'].includes(status) ? el('div', { class: 'fix', role: 'group', 'aria-label': 'Fix decision' },
    el('button', { type: 'button', 'data-d': 'approve', 'aria-pressed': String(s.decision === 'approve'), text: 'Approve', onclick: () => save({ decision: s.decision === 'approve' ? null : 'approve' }) }),
    el('button', { type: 'button', 'data-d': 'decline', 'aria-pressed': String(s.decision === 'decline'), text: 'Decline', onclick: () => save({ decision: s.decision === 'decline' ? null : 'decline' }) }),
    // Confirm fix: the approved fix is done but the check can't verify it. Moves the item to Done until the finding changes.
    s.decision === 'approve' ? el('button', { type: 'button', 'data-d': 'confirm', 'aria-pressed': String(!!s.confirmed), text: s.confirmed ? 'Confirmed ✓' : 'Confirm fix',
      title: s.confirmed ? 'Undo: move it back to Fix Failed.' : 'The fix is done, but the check can’t verify it. Moves this item to Fixed until a later run finds something different.',
      onclick: () => save({ confirm: !s.confirmed }) }) : null) : null;
  // Flagged: it fails or needs a look and nobody has approved or declined the fix yet. The card stands out until decided.
  const flagged = box ? kidsWaiting > 0 : ['fail', 'warn'].includes(status) && !s.decision;
  const flagText = box ? `${kidsWaiting} finding${kidsWaiting === 1 ? '' : 's'} below need${kidsWaiting === 1 ? 's' : ''} a decision` : 'Approve the fix or Decline it (bottom right).';
  return el('article', { class: 'item' + (flagged ? ' is-flagged' : '') + (box ? ' is-container' : '') + (it.parent ? ' is-child' : ''), 'data-id': it.id, 'data-status': shown, 'data-auto': it.check ? '1' : '0', 'data-bucket': bucketOf(tab, it) || '' },
    kept.has(it.id) && !tileHas(it) ? el('div', { class: 'movedbar', role: 'note' }, el('b', { text: `Moved to ${movedTo(it)}` }), el('span', { text: 'Stays here until you pick another tile or tab.' })) : null,
    flagged ? el('div', { class: 'flagbar', role: 'note' }, el('b', { text: SNAP ? '\u2691 Needs a decision' : '\u2691 Needs your decision' }), SNAP && !box ? null : el('span', { text: flagText })) : null,
    el('div', { class: 'item-main' },
      el('div', { class: 'item-title' }, it.parent ? el('span', { class: 'chip kid', text: 'Finding' }) : null, it.title, !it.parent && it.owner ? el('span', { class: 'chip', text: it.ownerLabel || it.owner }) : null, !it.parent && it.check ? el('span', { class: 'chip auto', text: 'Auto' }) : null),
      it.description ? el('p', { class: 'item-desc', title: it.description, text: it.description }) : null,
      s.tool?.summary ? el('p', { class: 'item-summary' }, linkify(s.tool.summary)) : null,
      failWhy(it, s),
      details,
      s.tool?.shots?.length && ['fail', 'warn'].includes(s.tool.status) ? el('div', { class: 'shots' }, s.tool.shots.map((sh, i) => el('a', { class: 'shot', href: sh.file, title: `${sh.page} · ${sh.label} (click to enlarge)`, onclick: e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); openShots(s.tool.shots, i); } },
        el('img', { src: sh.file, alt: `${sh.label} on ${sh.page}`, loading: 'lazy', 'data-kind': sh.kind || 'crop' }),
        el('span', { text: `${sh.page} · ${sh.label}${sh.found ? '' : ' (not pinpointed; page view)'}` })))) : null,
      s.tool?.suggestion && ['fail', 'warn'].includes(s.tool.status) ? el('p', { class: 'item-suggest' }, el('strong', { text: 'How to fix' }), s.tool.suggestion.text, s.tool.suggestion.auto ? el('span', { class: 'chip auto', text: 'App can fix' }) : null) : null),
    el('div', { class: 'item-side' }, seg, src, box ? null : (p => p ? el('span', { class: `fixstate fs-${p.cls}`, title: p.title, text: p.text }) : null)(fixPill(s))),
    el('div', { class: 'item-extra' }, note, fix, revert),
    box ? el('div', { class: 'kids', role: 'group', 'aria-label': `Findings for ${it.title}` }, kids.map(k => itemRow(k))) : null);
}

// Revert fix: confirm what will happen on the site, then run it (backup, Claude undoes that one fix, re-check).
async function revertFix(it, rv) {
  const when = new Date(rv.at).toLocaleString(); const run = { backup: { path: rv.backup } };
  const did = rv.did || 'the change it made';
  const ok = confirm(`Revert the fix on “${it.title}”?\n\nThis changes ${current.url}${current.install ? ` (WP Engine install ${current.install})` : ''}:\n\n• A fresh backup of the database and theme is taken first.\n• Claude undoes only what the fix of ${when} changed (${did.slice(0, 160)}${did.length > 160 ? '…' : ''}), restoring from the backup taken just before it (${run.backup.path}). Nothing else is touched.\n• Caches are cleared and the item is checked again. Its approval is cleared, so it asks for a decision again.`);
  if (!ok) return;
  try { setRunning(true); const r = await api(`/sites/${current.id}/revert/${tab}`, { method: 'POST', body: { item: it.id, confirm: true } }); follow(r.runId); }
  catch (e) { setRunning(false); alert(e.message); }
}

// Screenshot lightbox: the item's screenshots, one at a time, over the app.
let shotList = [], shotAt = 0;
function showShot() {
  const sh = shotList[shotAt];
  $('shotImg').src = sh.file; $('shotImg').alt = `${sh.label} on ${sh.page}`;
  $('shotCaption').textContent = `${sh.page} · ${sh.label}${sh.found === false ? ' (not pinpointed; page view)' : ''}`;
  $('shotCount').textContent = shotList.length > 1 ? `${shotAt + 1} of ${shotList.length}` : '';
  $('shotOpen').href = sh.file;
  $('shotPrev').hidden = $('shotNext').hidden = shotList.length < 2;
}
function openShots(list, i) { shotList = list; shotAt = i; showShot(); $('shotDialog').showModal(); $('shotClose').focus(); }
const stepShot = d => { if (shotList.length < 2) return; shotAt = (shotAt + d + shotList.length) % shotList.length; showShot(); };
$('shotClose').onclick = () => $('shotDialog').close();
$('shotPrev').onclick = () => stepShot(-1);
$('shotNext').onclick = () => stepShot(1);
$('shotDialog').addEventListener('click', e => { if (e.target === $('shotDialog')) $('shotDialog').close(); });
$('shotDialog').addEventListener('keydown', e => { if (e.key === 'ArrowLeft') stepShot(-1); if (e.key === 'ArrowRight') stepShot(1); });
$('shotDialog').addEventListener('close', () => { $('shotImg').removeAttribute('src'); });

// The Flagged panel's heading: how many wait for a decision, and how many approved fixes haven't run yet.
function flaggedHint(items, needs, failedFix, fixed) {
  const undecided = items.filter(i => tileHas(i, 'decide') && !tabState(tab).items[i.id]?.decision).length;
  const pending = needs - undecided;
  const parts = [undecided ? `${undecided} waiting for Approve / Decline` : '', pending ? `${pending} approved, not fixed yet` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : failedFix ? `${failedFix} fix${failedFix === 1 ? '' : 'es'} failed` : fixed ? 'Nothing needs attention' : 'Nothing flagged';
}

// A labelled panel of count tiles.
function countGroup(title, hint, tiles, cls = '') {
  return el('section', { class: 'countgroup' + (cls ? ' ' + cls : ''), 'aria-label': title }, el('div', { class: 'countgroup-head' }, el('h3', { text: title }), hint ? el('small', { text: hint }) : null), el('div', { class: 'count-row' }, tiles));
}

// A count tile that filters the list. Empty tiles (0) can't be picked; a picked tile is outlined.
function countTile(key, cls, n, label, title, display) {
  return el('button', { type: 'button', class: `count ${cls}`, 'data-filter': key, 'aria-pressed': String(filter === key), disabled: n || key === 'all' ? null : true, title: title || `Show the ${label.toLowerCase()} items`, onclick: () => { filter = filter === key && key !== 'all' ? 'all' : key; kept.clear(); render(); } }, el('b', { text: display ?? String(n) }), el('span', { text: label }));
}

function applyFilter() {
  document.querySelectorAll('#counts [data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  const byId = tab !== 'urls' && templates[tab] ? Object.fromEntries(tplOf(tab).sections.flatMap(s => s.items).map(i => [i.id, i])) : {};
  // A card shows when it matches the tile or was just decided (kept); a container also while one of its children does.
  const showCard = it => tileHas(it) || kept.has(it.id) || kidsOf(tab, it).some(k => kept.has(k.id));
  // Old-site redirects: under All every one, under another tile the ones that belong to it. Their import box only under All.
  document.querySelectorAll('.lrow').forEach(r => r.classList.toggle('hidden-by-filter', filter !== 'all' && r.dataset.tile !== filter));
  document.querySelectorAll('[data-all-only]').forEach(x => { x.hidden = filter !== 'all'; });
  document.querySelectorAll('.utable-wrap.lt').forEach(w => { w.hidden = !w.querySelector('.lrow:not(.hidden-by-filter)'); });
  document.querySelectorAll('.item, .urow').forEach(r => {
    const st = r.dataset.status;
    // URL rows: u:none / u:redirect / u:attention (scan status, still to do), u:failed, u:done. Checklist items: tileHas() decides.
    const hide = r.classList.contains('urow')
      ? (filter === 'all' ? false : filter === 'u:done' ? r.dataset.done !== '1' : filter === 'u:failed' ? r.dataset.failed !== '1' : filter !== 'u:' + st || r.dataset.done === '1' || r.dataset.failed === '1')
      : !(byId[r.dataset.id] && showCard(byId[r.dataset.id]));
    r.classList.toggle('hidden-by-filter', hide);
  });
  // Old → New URLs: a group heading shows while any of its rows does.
  document.querySelectorAll('tr.ugroup').forEach(h => { let n = h.nextElementSibling, any = false; while (n && !n.classList.contains('ugroup')) { if (!n.classList.contains('hidden-by-filter')) any = true; n = n.nextElementSibling; } h.classList.toggle('hidden-by-filter', !any); });
  // Section pills follow the picked tile. A picked section with nothing for this tile falls back to All.
  $('secNav').hidden = tab === 'urls';
  const tpl = tab !== 'urls' && templates[tab] && document.querySelector('#sections .item') ? tplOf(tab) : null;
  if (tpl) {
    const sec = tpl.sections.find(x => x.title === secSel[tab]);
    if (sec && !sec.items.some(itemShown)) secSel[tab] = 'all';
    renderSecNav(tpl);
  }
  const pickSec = tab !== 'urls' ? secSel[tab] || 'all' : 'all';
  let shown = 0;
  document.querySelectorAll('.section').forEach(s => { s.hidden = (pickSec !== 'all' && s.dataset.sec && s.dataset.sec !== pickSec) || (!(s.dataset.keep && filter === 'all') && !s.querySelector('.item:not(.hidden-by-filter), .urow:not(.hidden-by-filter), .lrow:not(.hidden-by-filter)')); if (!s.hidden) shown++; });
  $('secEmpty').hidden = tab === 'urls' || shown > 0;
}

function setRunning(on) {
  if (!on) $('genReport').textContent = 'Generate report'; $('runTool').disabled = on; $('applyFixes').disabled = on; $('askSend').disabled = on; $('genReport').disabled = on; $('runTool').textContent = on ? 'Running…' : 'Run Tool'; }

function follow(runId) {
  if (stream) stream.close();
  $('runPanel').hidden = false; $('runLog').textContent = ''; $('runBar').style.width = '0';
  setRunning(true);
  stream = new EventSource(`/api/runs/${runId}/events`);
  stream.addEventListener('log', e => { const pre = $('runLog'); pre.textContent += JSON.parse(e.data) + '\n'; pre.scrollTop = pre.scrollHeight; });
  stream.addEventListener('progress', e => { $('runBar').style.width = `${Math.round(+e.data * 100)}%`; });
  const finish = async () => { stream.close(); stream = null; setRunning(false); $('runBar').style.width = '100%'; await openSite(current.id); $('runPanel').hidden = false; };
  stream.addEventListener('done', finish);
  stream.addEventListener('failed', finish);
  stream.onerror = () => { if (stream) { stream.close(); stream = null; setRunning(false); } };
}

// Reports menu: open and close the list of published reports.
const setReportList = open => { $('reportList').hidden = !open; $('reportsBtn').setAttribute('aria-expanded', String(open)); };
$('reportsBtn').addEventListener('click', e => { e.stopPropagation(); setReportList($('reportList').hidden); });
document.addEventListener('click', e => { if (!$('reportMenu').contains(e.target)) setReportList(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setReportList(false); });

// Generate report: the read-only copy of this page, published through Claude Code to the site's one link.
$('genReport').addEventListener('click', async () => {
  try { setRunning(true); $('genReport').textContent = 'Generating…'; const r = await api(`/sites/${current.id}/report`, { method: 'POST' }); follow(r.runId); }
  catch (e) { setRunning(false); alert(e.message); }
});

// Runs share what the last 15 minutes of runs loaded (crawl, settings); Shift-click loads everything again.
$('runTool').addEventListener('click', async e => {
  try { setRunning(true); const r = await api(`/sites/${current.id}/run/${tab}`, { method: 'POST', body: { fresh: e.shiftKey } }); follow(r.runId); }
  catch (e) { setRunning(false); alert(e.message); }
});
$('sitePick').addEventListener('change', e => openSite(e.target.value));

// Add / edit site dialog
let editing = null;
function openDialog(site) {
  editing = site;
  $('siteDialogTitle').textContent = site ? 'Site settings' : 'Add site';
  $('fUrl').value = site?.url || ''; $('fInstall').value = site?.install || '';
  $('fName').value = site?.name || ''; $('fEmail').value = site?.adminEmail ?? config.adminEmail ?? '';
  $('fRef').value = site?.referenceUrl || ''; $('fMax').value = site?.maxPages || 80; $('fProd').value = site?.prodUrl || '';
  $('deleteSite').hidden = !site; $('siteErr').hidden = true;
  $('siteDialog').showModal();
}
$('addSite').addEventListener('click', () => openDialog(null));
$('addFirst').addEventListener('click', () => openDialog(null));
$('editSite').addEventListener('click', () => openDialog(current));
$('siteForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  try {
    $('saveSite').disabled = true; $('saveSite').textContent = 'Finding the install…';
    const s = await api('/sites', { method: 'POST', body: { id: editing?.id, url: $('fUrl').value.trim(), install: $('fInstall').value.trim().toLowerCase(), name: $('fName').value.trim(), adminEmail: $('fEmail').value.trim(), referenceUrl: $('fRef').value.trim(), prodUrl: $('fProd').value.trim(), maxPages: $('fMax').value } });
    $('siteDialog').close(); await loadSites(s.id);
  } catch (err) { $('siteErr').textContent = err.message; $('siteErr').hidden = false; }
  finally { $('saveSite').disabled = false; $('saveSite').textContent = 'Save'; }
});
$('deleteSite').addEventListener('click', async () => {
  if (!confirm(`Remove ${current.name} from the checklist app? Its saved checklist state and run history stay in the data folder.`)) return;
  await api('/sites/' + current.id, { method: 'DELETE' }); $('siteDialog').close(); await loadSites();
});

// Claude's questions from the latest fix run that has some and isn't answered yet. The answer continues the same
// Claude Code conversation (the app backs up again first), so the person never leaves the app.
let askRun = null;
function renderAsk() {
  // Only questions still open: the item is still waiting on this run's question for the same finding (a re-check,
  // a newer fix run or a change of decision makes the question out of date).
  const ts = tabState(tab);
  const open = run => (run.questions || []).filter(q => { const s = ts.items[q.id]; return s && s.decision === 'approve' && ['fail', 'warn'].includes(s.status) && !s.confirmed && s.fix?.state === 'question' && s.fix.runId === run.id && s.fix.toolAt === s.tool?.at; });
  const r0 = (ts.fixRuns || []).find(x => !x.answeredBy && open(x).length);
  const r = r0 && { ...r0, questions: open(r0) };
  const fresh = r && r.id !== askRun?.id;
  askRun = r || null;
  $('askPanel').hidden = !r;
  if (!r) return;
  const n = r.questions.length;
  $('askTitle').textContent = n === 1 ? 'Claude needs your answer' : `Claude needs your answers (${n} items)`;
  $('askMeta').textContent = `From the fix run ${new Date(r.finishedAt).toLocaleString()}. Claude is waiting for you before it finishes ${n === 1 ? 'this item' : 'these items'}.`;
  $('askList').replaceChildren(...r.questions.map(q => el('li', {}, el('b', { text: q.title }), el('p', { class: 'askq', text: q.question || '(no question text)' }))));
  $('askNote').textContent = `Sending lets Claude continue ${n === 1 ? 'this item' : 'these items'} on ${current.url}. The app backs up the site first, then re-checks this tab. ${n > 1 ? 'Answer each question in one message (e.g. "Emails: yes, link them. Logos: skip for now.").' : ''}`;
  $('askErr').hidden = true;
  if (fresh) $('askAnswer').value = '';
}
$('askSend').addEventListener('click', async () => {
  const answer = $('askAnswer').value.trim();
  if (!askRun) return;
  if (!answer) { $('askErr').textContent = 'Write your answer first.'; $('askErr').hidden = false; return $('askAnswer').focus(); }
  try {
    $('askSend').disabled = true; $('askErr').hidden = true;
    const r = await api(`/sites/${current.id}/fix/${tab}/reply`, { method: 'POST', body: { runId: askRun.id, answer } });
    $('askPanel').hidden = true; follow(r.runId);
  } catch (e) { $('askErr').textContent = e.message; $('askErr').hidden = false; }
  finally { $('askSend').disabled = false; }
});

// Fix history: each fix run with its backup, restore commands and fix request.
function renderHistory() {
  const runs = tabState(tab).fixRuns || [];
  $('fixHistory').hidden = !runs.length;
  $('fixRuns').replaceChildren(...runs.map(r => {
    const states = Object.entries(r.states || {}).map(([k, v]) => `${v} ${FIXSTATE[k]?.toLowerCase() || k}`).join(' · ');
    const restore = el('button', { class: 'btn ghost', type: 'button', text: 'Copy restore commands', onclick: e => copy(r.backup.restore.join('\n'), e.target) });
    const reqLink = r.request ? el('a', { class: 'btn ghost', href: `/api/sites/${current.id}/fix-request/${r.id}`, target: '_blank', rel: 'noopener', text: 'Open fix request' }) : null;
    const reqCopy = r.request ? el('button', { class: 'btn ghost', type: 'button', text: 'Copy fix request', onclick: async e => { const t = await (await fetch(`/api/sites/${current.id}/fix-request/${r.id}`)).text(); copy(t, e.target); } }) : null;
    return el('div', { class: 'fixrun' },
      el('div', {}, el('b', { text: new Date(r.finishedAt).toLocaleString() }), ` · ${states}`),
      r.replyTo ? el('div', { class: 'muted', text: 'Continued Claude’s conversation with your answer.' }) : null,
      r.kind === 'revert' ? el('div', { class: 'muted', text: `Reverted the fix on “${r.itemTitle || r.items?.[0]}” from the run of ${(tabState(tab).fixRuns || []).find(x => x.id === r.revertOf)?.finishedAt ? new Date(tabState(tab).fixRuns.find(x => x.id === r.revertOf).finishedAt).toLocaleString() : r.revertOf}.` }) : null,
      ...(r.questions || []).map(q => el('div', { class: 'qa-line' }, el('b', { text: `Claude asked (${q.title}): ` }), q.question)),
      r.answer ? el('div', { class: 'qa-line' }, el('b', { text: 'You answered: ' }), r.answer) : null,
      r.backup ? el('div', {}, 'Backup: ', el('code', { text: r.backup.path }), r.backup.size ? ` (${r.backup.size})` : '') : el('div', { class: 'muted', text: 'No backup (no changes were made; fix request only).' }),
      el('div', { class: 'row' }, r.backup ? restore : null, reqLink, reqCopy));
  }));
}

// Apply approved fixes: second approval in a modal, then a backed-up fix run.
$('applyFixes').addEventListener('click', async () => {
  $('fixErr').hidden = true; $('fixConfirm').checked = false; $('fixGo').disabled = true;
  if (tab === 'urls') return openRedirectsDialog();
  $('fixTitle').textContent = fixRetry ? 'Retry the fix request' : 'Apply approved fixes';
  $('fixAfterText').textContent = "Caches are cleared and this tab's checks run again, so each fix shows as verified or still flagged.";
  let plan;
  try { plan = await api(`/sites/${current.id}/fix/${tab}/plan${fixRetry ? '?retry=1' : ''}`); } catch (e) { return alert(e.message); }
  const auto = plan.auto.length, man = plan.manual.length;
  $('fixSite').textContent = `${current.name} · ${plan.url}${plan.install ? ` · WP Engine install ${plan.install}` : ''} · ${templates[tab].title}`;
  $('fixBackupSec').hidden = !auto;
  $('fixBackup').textContent = `The database and active theme${plan.backupPlugins ? ', plus the plugins folder,' : ''} are saved on the server in _wpeprivate/wpeqa-backups/ before anything changes. If the backup fails, nothing is changed.`;
  $('fixAutoSec').hidden = !auto; $('fixAfterSec').hidden = !auto;
  $('fixAutoTitle').textContent = `2. Automatic fixes (${auto})`;
  $('fixAuto').replaceChildren(...plan.auto.map(a => el('li', {}, el('b', { text: a.title }), el('small', { text: a.action }))));
  $('fixManualSec').hidden = !man;
  $('fixManualTitle').textContent = `Fix request for a developer (${man})`;
  $('fixManual').replaceChildren(...plan.manual.map(m => el('li', {}, el('b', { text: m.title }), el('small', { text: m.reason }))));
  $('claudeRow').hidden = !man || !plan.claudeAvailable; $('claudeMissing').hidden = !man || plan.claudeAvailable;
  $('claudeMissing').textContent = `${plan.claudeReason || ''} Until then these go into a fix request.`;
  $('fixClaude').checked = !!(man && plan.claudeAvailable);
  const sync = () => {
    const claude = $('fixClaude').checked && man > 0;
    const changes = auto + (claude ? man : 0);
    $('fixBackupSec').hidden = !changes; $('fixAfterSec').hidden = !changes;
    $('fixConfirmText').textContent = !changes ? 'Create the fix request (nothing on the site changes).'
      : `I approve ${auto ? `${auto} automatic change${auto === 1 ? '' : 's'}` : ''}${auto && claude ? ' and ' : ''}${claude ? `Claude Code fixing ${man} item${man === 1 ? '' : 's'}` : ''} on ${plan.url} now.`;
    $('fixGo').textContent = !changes ? 'Create fix request' : claude ? 'Back up and run fixes' : `Back up and apply ${auto} fix${auto === 1 ? '' : 'es'}`;
    $('fixConfirm').checked = false; $('fixGo').disabled = true;
  };
  $('fixClaude').onchange = sync; sync();
  $('fixDialog').showModal();
});
$('fixConfirm').addEventListener('change', e => { $('fixGo').disabled = !e.target.checked; });
$('fixCancel').addEventListener('click', () => $('fixDialog').close());
$('fixGo').addEventListener('click', async () => {
  try { $('fixGo').disabled = true; const r = await api(`/sites/${current.id}/fix/${tab}`, { method: 'POST', body: { confirm: true, retry: fixRetry, claude: tab !== 'urls' && $('fixClaude').checked && !$('claudeRow').hidden } }); $('fixDialog').close(); follow(r.runId); }
  catch (e) { $('fixErr').textContent = e.message; $('fixErr').hidden = false; $('fixGo').disabled = false; }
});

// ---------- Old → New URLs tab ----------
// Addresses may break after / or - only, never mid-word.
const pathText = t => String(t).split(/(?<=[\/-])/).flatMap((part, i) => i ? [el('wbr'), part] : [part]);
function renderUrls() {
  const u = data.state.urls || {}; const rows = u.rows || []; const last = u.runs?.[0];
  $('lastRun').textContent = last ? `Ran ${ago(last.finishedAt)} · ${Math.round(last.durationMs / 1000)} s` : 'Not run yet';
  $('runTool').title = `Test every page of the old site on ${current.name}`;
  const pend = urlsPending(rows).length + legacyPending(u).length;
  $('applyFixes').hidden = !pend; $('applyFixes').textContent = `Apply URL decisions (${pend})`;
  $('fixHistory').hidden = true;
  if (!current.referenceUrl) {
    $('counts').replaceChildren();
    $('sections').replaceChildren(el('div', { class: 'urls-empty' }, el('h2', { text: "Add the old site's address" }), el('p', { text: 'Run Tool checks every page of the old site on this one and proposes, for each moved page, keeping its old URL or redirecting to the new one.' }), el('button', { class: 'btn primary', type: 'button', text: 'Set the old site', onclick: () => $('editSite').click() })));
    return;
  }
  // A page whose redirect is in place counts under Done, one whose apply failed under Redirect Failed; the status
  // tiles count only what's still to do.
  const c = { none: 0, redirect: 0, attention: 0 }; rows.filter(r => !urlDone(r) && !urlFailed(r)).forEach(r => c[eff(r).status]++);
  let done = rows.filter(urlDone).length, failed = rows.filter(urlFailed).length;
  // The old site's own redirects count the same way (they show under All, and under the tile they belong to).
  const lrows = u.legacy?.rows || []; const lById = new Map(rows.map(m => [m.id, m]));
  for (const r of lrows) { const t = ltile(r, lById); if (t === 'u:done') done++; else if (t === 'u:failed') failed++; else c[t.slice(2)]++; }
  const shownU = { 'u:none': c.none, 'u:redirect': c.redirect, 'u:attention': c.attention, 'u:failed': failed, 'u:done': done };
  if (filter !== 'all' && !shownU[filter]) filter = 'all';
  $('counts').replaceChildren(...(rows.length ? [el('div', { class: 'count-row' }, [countTile('all', 'c-all', rows.length + lrows.length, 'All', 'Every old page and every redirect imported from the old site'), countTile('u:none', 'c-pass', c.none, URLST.none), countTile('u:redirect', 'c-warn', c.redirect, URLST.redirect), countTile('u:attention', 'c-fail', c.attention, URLST.attention), countTile('u:failed', 'c-fail' + (failed ? ' is-flagged' : ''), failed, 'Redirect Failed', 'Approved redirects that could not be added or that don\u2019t land where they should'), countTile('u:done', 'c-done', done, 'Done', 'Redirects in place and verified')])] : []));
  if (!rows.length) {
    $('sections').replaceChildren(el('div', { class: 'urls-empty' }, el('h2', { text: 'Not run yet' }), el('p', {}, 'Run Tool lists every page of ', el('b', { text: current.referenceUrl.replace(/^https?:\/\//, '') }), ' and checks each old URL on this site. Then you can import the old site\'s redirects.')));
    return;
  }
  const origin = new URL(current.url).origin;
  const save = (r, patch) => api(`/sites/${current.id}/urls/${r.id}`, { method: 'PUT', body: patch }).then(v => { Object.assign(r, v); for (const f of ['target', 'keep', 'choice']) if (!(f in v)) delete r[f]; render(); }).catch(e => alert(e.message));
  const result = r => { const a = r.applied; if (!a) return r.decision === 'decline' ? el('span', { class: 'ures', text: 'Declined · no redirect' }) : null; const keep = a.choice === 'keep'; const t = { verified: ['ok', keep ? 'Old URL kept · verified' : 'Redirected · verified'], applied: ['warn', 'Done · check it'], exists: ['warn', 'Already in Redirection'], failed: ['bad', 'Not done'] }[a.state] || ['warn', a.state]; return el('span', { class: `ures ${t[0]}`, title: a.error || (a.landed ? `Lands on ${a.landed}` : ''), text: t[1] }); };
  const list = el('datalist', { id: 'newPages' }, (u.newPages || []).map(p => el('option', { value: p.path, label: p.title || p.path })));
  // One old page: `depth` 1 = a sub-page (indented under its menu parent or section); `label` = its menu label or short name.
  const rowEl = (r, depth = 0, label = r.page) => {
    const e = eff(r);
    const status = el('span', { class: `ustatus us-${e.status}`, text: URLST[e.status] });
    // "Keep old URL" moves the picked page back, so the picker locks while it's chosen; "Use new URL" unlocks it.
    const locked = e.status === 'attention' && e.choice === 'keep';
    const lockTip = 'Switch to Use new URL to pick a different page';
    const target = e.status !== 'attention'
      ? (e.target ? el('a', { class: 'utarget', href: origin + e.target, target: '_blank', rel: 'noopener' }, pathText(e.target)) : el('span', { class: 'muted', text: '—' }))
      : el('input', { class: 'uinput', type: 'text', list: 'newPages', value: e.target, placeholder: 'Pick or type the new page', 'aria-label': `New page for ${r.oldPath}`, disabled: locked ? true : null, title: locked ? lockTip : null, onchange: ev => save(r, { target: ev.target.value }) });
    // Two pages matched equally well: show both, one click picks one.
    const alts = e.status === 'attention' && r.auto?.alt?.length ? el('div', { class: 'ualt', role: 'group', 'aria-label': 'Matching pages' }, r.auto.alt.map(pth => {
      const pg = (u.newPages || []).find(p => p.path === pth);
      return el('button', { type: 'button', 'aria-pressed': String(e.target === pth), disabled: locked ? true : null, title: locked ? lockTip : `Use ${pth}`, onclick: () => save(r, { target: pth }) }, el('b', { text: pg?.title || pth }), el('span', {}, pathText(pth)));
    })) : null;
    // The person's call for a changed URL: keep the old address (move the page back) or use the new one (301).
    const k = keepOf(r); const canKeep = !k || k.ok;
    const choice = e.status === 'none' || !e.target ? null : el('div', { class: 'uchoice', role: 'group', 'aria-label': 'Which URL to use' },
      el('button', { type: 'button', 'aria-pressed': String(e.choice === 'keep'), disabled: canKeep ? null : true, title: canKeep ? `Move ${e.target} back to ${r.oldPath}` : `Can't keep: ${k.why}`, text: 'Keep old URL', onclick: () => save(r, { choice: 'keep' }) }),
      el('button', { type: 'button', 'aria-pressed': String(e.choice === 'new'), title: `301 ${r.oldPath} → ${e.target}`, text: 'Use new URL', onclick: () => save(r, { choice: 'new' }) }));
    const why = !canKeep && e.status !== 'none' ? el('small', { class: 'unokeep', text: `Can't keep the old URL: ${k.why}` }) : null;
    const decide = e.status === 'none' ? null : el('div', { class: 'fix', role: 'group', 'aria-label': 'Decision' },
      el('button', { type: 'button', 'data-d': 'approve', 'aria-pressed': String(r.decision === 'approve'), disabled: e.target ? null : true, title: e.target ? '' : 'Pick the new page first', text: 'Approve', onclick: () => save(r, { decision: r.decision === 'approve' ? null : 'approve' }) }),
      el('button', { type: 'button', 'data-d': 'decline', 'aria-pressed': String(r.decision === 'decline'), text: 'Decline', onclick: () => save(r, { decision: r.decision === 'decline' ? null : 'decline' }) }));
    return el('tr', { class: 'urow' + (depth ? ' is-sub' : ''), 'data-depth': String(Math.min(depth, 4)), 'data-status': e.status, 'data-decision': r.decision || '', 'data-done': urlDone(r) ? '1' : '0', 'data-failed': urlFailed(r) ? '1' : '0' },
      el('td', { class: 'upage' }, el('b', { text: label, title: label !== r.page ? r.page : null }), el('a', { class: 'uold', href: r.oldUrl, target: '_blank', rel: 'noopener' }, pathText(r.oldPath))),
      el('td', { class: 'ustat' }, status, el('small', { text: r.auto?.reason || '' })),
      el('td', { class: 'unew' }, alts, target, choice, why),
      el('td', { class: 'udecide' }, decide, result(r)));
  };
  // A page only the new site has: nothing to redirect, listed where it belongs for comparing.
  const newEl = (it) => el('tr', { class: 'urow is-new' + (it.depth ? ' is-sub' : ''), 'data-depth': String(Math.min(it.depth, 4)), 'data-status': 'new' },
    el('td', { class: 'upage' }, el('b', { text: it.label }), el('span', { class: 'uold muted', text: 'not on the old site' })),
    el('td', { class: 'ustat' }, el('span', { class: 'ustatus us-new', text: 'New Page (New Site Only)' })),
    el('td', { class: 'unew' }, el('a', { class: 'utarget', href: origin + it.path, target: '_blank', rel: 'noopener' }, pathText(it.path))),
    el('td', { class: 'udecide' }));
  // A menu parent shown only so its children read as a tree (its own page is listed in an old-site group, or it has none).
  const ctxEl = (it) => el('tr', { class: 'urow is-context' + (it.depth ? ' is-sub' : ''), 'data-depth': String(Math.min(it.depth, 4)), 'data-status': 'ctx' },
    el('td', { class: 'upage', colspan: '4' }, el('b', { text: it.label }), it.path ? el('a', { class: 'uold', href: origin + it.path, target: '_blank', rel: 'noopener' }, pathText(it.path)) : null));
  // Arranged like the site (old menu groups and order, sections, then new-only pages), when the last run saved a layout.
  const byRow = new Map(rows.map(r => [r.id, r])); const placed = new Set();
  const groupHead = g => el('tr', { class: 'ugroup' + (g.kind === 'new' ? ' is-new' : '') }, el('th', { colspan: '4' }, g.title,
    el('small', { text: g.kind === 'new' ? 'new site only' : g.kind === 'unlisted' ? 'old pages not in the menu' : g.kind === 'menu' && g.key !== 'home' ? 'old site menu' : '' })));
  // A group whose first item is its own page (What We Do, Team, Services) shows that page as the group's row, like a URL
  // sheet's parent row; groups without a page of their own (About, Others) get a heading row.
  const itemEl = (it, parent) => { if (it.context) return ctxEl(it); const tr = it.isNew ? newEl(it) : (r => r && (placed.add(r.id), rowEl(r, it.depth, parent ? parent.title : it.label)))(byRow.get(it.id)); if (tr && parent) tr.classList.add('is-parent'); return tr; };
  const body = u.layout?.length
    ? [...u.layout.flatMap(g => { const own = g.items[0] && !g.items[0].depth && !g.items[0].context && g.key !== 'unlisted' && g.key !== 'others'; const trs = g.items.map((it, i) => itemEl(it, own && i === 0 ? g : null)).filter(Boolean); return trs.length ? (own ? trs : [groupHead(g), ...trs]) : []; }),
      ...(rows.some(r => !placed.has(r.id)) ? [groupHead({ title: 'Other pages', kind: 'unlisted' }), ...rows.filter(r => !placed.has(r.id)).map(r => rowEl(r))] : [])]
    : rows.map(r => rowEl(r));
  $('sections').replaceChildren(legacySection(u, origin), el('section', { class: 'section' },
    el('h2', {}, 'Old URLs', el('small', { text: `${current.referenceUrl.replace(/^https?:\/\//, '')} → ${origin.replace(/^https?:\/\//, '')} · keep the old URL, or 301 it to the new page` })),
    el('div', { class: 'utable-wrap' }, el('table', { class: 'utable' },
      el('thead', {}, el('tr', {}, ['Old page', 'Status', 'New page · which URL to use', ''].map(h => el('th', { text: h })))),
      el('tbody', {}, body))), list,
    !u.layout?.length && (u.newOnly || []).length ? el('details', { class: 'unewonly' }, el('summary', { text: `New on the new site (${u.newOnly.length}) · no old page, nothing to do` }),
      el('ul', {}, u.newOnly.map(p => el('li', {}, el('a', { href: origin + p.path, target: '_blank', rel: 'noopener' }, pathText(p.path)), p.title ? el('span', { text: p.title }) : null)))) : null));
  applyFilter();
}

// The old site's own redirects, imported from an export file and pointed at where each page is now.
function legacySection(u, origin) {
  const L = u.legacy || {}; const files = L.files || []; const lrows = L.rows || [];
  const byId = new Map((u.rows || []).map(m => [m.id, m]));
  const save = (r, patch) => api(`/sites/${current.id}/urls/${r.id}`, { method: 'PUT', body: patch }).then(v => { Object.assign(r, v); if (!('target' in v)) delete r.target; render(); }).catch(e => alert(e.message));
  const importFile = async f => {
    if (!f) return;
    if (f.size > 20e6) return alert('That file is over 20 MB.');
    try { setRunning(true); const r = await api(`/sites/${current.id}/urls/import`, { method: 'POST', body: { name: f.name, text: await f.text() } }); follow(r.runId); } catch (e) { setRunning(false); alert(e.message); }
  };
  const pick = el('input', { type: 'file', accept: '.csv,.json,.txt,.htaccess,.conf', hidden: true, onchange: ev => { const f = ev.target.files[0]; ev.target.value = ''; importFile(f); } });
  const forget = name => { if (!confirm(`Remove the redirects imported from ${name}?`)) return; api(`/sites/${current.id}/urls/import/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(r => follow(r.runId)).catch(e => alert(e.message)); };
  const FORMATS = ['Redirection JSON / CSV', 'Yoast CSV', 'Rank Math CSV', 'Any source, target CSV', '.htaccess', 'nginx'];
  const card = files.length
    ? el('div', { class: 'lcard', 'data-all-only': '1' },
        el('div', { class: 'lhead' },
          el('div', {}, el('h3', { text: 'Imported from the old site' }), el('p', { text: 'Each redirect points at where its page is now. Approve the ones to keep; they go into Redirection\'s "Migrated from old site" group.' })),
          el('button', { class: 'btn', type: 'button', text: 'Import another file', onclick: () => pick.click() })),
        el('div', { class: 'lfiles' }, files.map(f => el('span', { class: 'lfile' }, el('b', { text: f.name }), el('span', { text: `${f.count ?? ''} rule${f.count === 1 ? '' : 's'}` }), el('button', { type: 'button', class: 'lx', title: `Remove ${f.name}`, 'aria-label': `Remove ${f.name}`, text: '×', onclick: () => forget(f.name) })))),
        (L.notes || []).length ? el('ul', { class: 'linfo' }, L.notes.map(n => el('li', { text: n }))) : null, pick)
    : el('div', { class: 'lcard lempty', 'data-all-only': '1' },
        el('div', { class: 'licon', 'aria-hidden': 'true', text: '↪' }),
        el('div', { class: 'lbody' },
          el('h3', { text: "Bring over the old site's redirects" }),
          el('p', { text: "Old campaign links and earlier redirects aren't pages, so the scan can't find them. Import the old site's export and each one is pointed at its new page." }),
          el('div', { class: 'lformats' }, FORMATS.map(f => el('span', { text: f })))),
        el('div', { class: 'lact' }, el('button', { class: 'btn primary', type: 'button', text: 'Import export file', onclick: () => pick.click() }), el('small', { text: 'or drop the file here' }), pick));
  // Drop a file anywhere on the card.
  card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag'); });
  card.addEventListener('dragleave', e => { if (!card.contains(e.relatedTarget)) card.classList.remove('drag'); });
  card.addEventListener('drop', e => { e.preventDefault(); card.classList.remove('drag'); importFile(e.dataTransfer.files[0]); });
  const result = r => { const a = r.applied; if (!a) return r.decision === 'decline' ? el('span', { class: 'ures', text: 'Declined · no redirect' }) : null; const t = { verified: ['ok', 'Copied · verified'], applied: ['warn', a.status ? 'Done · check it' : 'Added'], exists: ['warn', 'Already in Redirection'], failed: ['bad', 'Not done'] }[a.state] || ['warn', a.state]; return el('span', { class: `ures ${t[0]}`, title: a.error || (a.landed ? `Lands on ${a.landed}` : ''), text: t[1] }); };
  const body = lrows.map(r => {
    const e = leff(r, byId);
    const meta = [r.source, r.hits !== null && r.hits !== undefined ? `${r.hits} hit${r.hits === 1 ? '' : 's'}` : '', r.regex ? 'pattern' : '', !r.gone && r.code !== 301 ? String(r.code) : ''].filter(Boolean).join(' · ');
    const target = r.gone ? el('span', { class: 'lgone', text: `${r.code} Gone` })
      : e.status === 'attention' && !e.waiting ? el('input', { class: 'uinput', type: 'text', list: 'newPages', value: e.target, placeholder: 'Pick or type the new page', 'aria-label': `Target for ${r.from}`, onchange: ev => save(r, { target: ev.target.value }) })
      : !e.target ? el('span', { class: 'muted', text: '—' })
      : r.regex ? el('code', { class: 'utarget' }, pathText(e.target))
      : el('a', { class: 'utarget', href: r.external ? e.target : origin + e.target, target: '_blank', rel: 'noopener' }, pathText(e.target));
    const decide = r.auto?.byHand ? el('small', { class: 'lhand', text: 'By hand' }) : el('div', { class: 'fix', role: 'group', 'aria-label': 'Decision' },
      el('button', { type: 'button', 'data-d': 'approve', 'aria-pressed': String(r.decision === 'approve'), disabled: e.target || r.gone ? null : true, title: e.target || r.gone ? '' : 'Pick the target first', text: 'Approve', onclick: () => save(r, { decision: r.decision === 'approve' ? null : 'approve' }) }),
      el('button', { type: 'button', 'data-d': 'decline', 'aria-pressed': String(r.decision === 'decline'), text: 'Decline', onclick: () => save(r, { decision: r.decision === 'decline' ? null : 'decline' }) }));
    return el('tr', { class: 'lrow', 'data-status': e.status, 'data-tile': ltile(r, byId) },
      el('td', { class: 'upage' }, el('code', { class: 'lfrom' }, pathText(r.from)), el('small', { class: 'lmeta', text: meta })),
      el('td', { class: 'ustat' }, el('span', { class: `ustatus us-${LCLS[e.status]}`, text: LST[e.status] }), el('small', { text: e.reason || '' })),
      el('td', { class: 'unew' }, target),
      el('td', { class: 'udecide' }, decide, result(r)));
  });
  // The heading counts them by tile, like the tiles above (an applied one is done, not "ready").
  const TNAME = { 'u:done': 'done', 'u:failed': 'redirect failed', 'u:redirect': 'redirect', 'u:attention': 'need attention', 'u:none': 'not used' };
  const tally = Object.entries(lrows.reduce((c, r) => { const t = ltile(r, byId); c[t] = (c[t] || 0) + 1; return c; }, {})).map(([k, v]) => `${v} ${TNAME[k]}`).join(' · ');
  return el('section', { class: 'section', 'data-keep': '1' },
    el('h2', {}, "Old site's redirects", lrows.length ? el('small', { text: tally }) : null),
    card,
    lrows.length ? el('div', { class: 'utable-wrap lt' }, el('table', { class: 'utable' },
      el('thead', {}, el('tr', {}, ['Old redirect', 'Status', 'Goes to on the new site', ''].map(h => el('th', { text: h })))),
      el('tbody', {}, body))) : null);
}

// QA — After Launch checks the production site, so it unlocks once someone confirms the site is live there.
function renderLiveGate() {
  const p = data.state.prod;
  $('runTool').hidden = true; $('applyFixes').hidden = true; $('fixHistory').hidden = true; $('secNav').hidden = true; $('reportLink').hidden = true;
  $('lastRun').textContent = ''; $('counts').replaceChildren();
  $('sections').replaceChildren(el('div', { class: 'urls-empty' }, el('h2', { text: 'Unlocks once the site is live' }),
    el('p', { text: current.prodUrl ? `QA — After Launch checks the production site, ${current.prodUrl.replace(/^https?:\/\//, '')}. Everything else runs on staging. Confirm it once the new site is published there.` : 'QA — After Launch checks the production site; everything else runs on staging. Add the live domain as the Production site to audit in Site settings, then confirm it here once the new site is published there.' }),
    p && current.prodUrl && p.url !== current.prodUrl ? el('p', { class: 'warnline', text: `The production URL changed since ${p.url} was confirmed live. Confirm again.` }) : null,
    el('div', { class: 'dlg-actions' }, current.prodUrl ? el('button', { class: 'btn primary', type: 'button', text: 'Confirm the live site', onclick: openProdDialog }) : null, el('button', { class: 'btn ghost', type: 'button', text: 'Site settings', onclick: () => $('editSite').click() }))));
}

// The person confirms the app's address is the live domain with the new site on it; the app checks first.
async function openProdDialog() {
  $('prodErr').hidden = true; $('prodConfirm').checked = false; $('prodGo').disabled = true;
  $('prodSite').textContent = `${current.name} · production: ${current.prodUrl}`;
  $('prodChecks').replaceChildren(el('li', { class: 'pc-wait', text: 'Checking the live site…' }));
  $('prodConfirmText').textContent = `${current.prodUrl} is the live production address, and the new site is published on it.`;
  $('prodDialog').showModal();
  let pc;
  try { pc = await api(`/sites/${current.id}/live-check`); } catch (e) { $('prodErr').textContent = e.message; $('prodErr').hidden = false; return; }
  $('prodChecks').replaceChildren(...pc.checks.map(c => el('li', { class: c.ok ? 'pc-ok' : c.hard ? 'pc-bad' : 'pc-warn', text: c.text })));
  $('prodConfirm').disabled = !pc.ready;
  if (!pc.ready) { $('prodErr').textContent = 'Fix the red items first (Site settings → Production site to audit).'; $('prodErr').hidden = false; }
}
$('prodConfirm').addEventListener('change', e => { $('prodGo').disabled = !e.target.checked; });
$('prodCancel').addEventListener('click', () => $('prodDialog').close());
$('prodGo').addEventListener('click', async () => {
  try { $('prodGo').disabled = true; await api(`/sites/${current.id}/confirm-live`, { method: 'POST', body: { confirm: true } }); $('prodDialog').close(); await openSite(current.id); }
  catch (e) { $('prodErr').textContent = e.message; $('prodErr').hidden = false; $('prodGo').disabled = false; }
});

async function openRedirectsDialog() {
  let plan;
  try { plan = await api(`/sites/${current.id}/fix/urls/plan`); } catch (e) { return alert(e.message); }
  const keep = plan.todo.filter(t => t.choice === 'keep'), move = plan.todo.filter(t => t.choice !== 'keep' && !t.legacy), old = plan.todo.filter(t => t.legacy);
  $('fixTitle').textContent = 'Apply URL decisions';
  $('fixSite').textContent = `${current.name} · ${plan.url}${plan.install ? ` · WP Engine install ${plan.install}` : ''} · Old → New URLs`;
  $('fixBackupSec').hidden = false;
  $('fixBackup').textContent = 'The database and active theme are saved on the server in _wpeprivate/wpeqa-backups/ first. Then the Redirection plugin is installed and activated if it isn\'t already. If the backup fails, nothing is changed.';
  $('fixAutoSec').hidden = false; $('fixAfterSec').hidden = false; $('fixManualSec').hidden = !plan.skipped.length;
  $('fixAutoTitle').textContent = `2. Changes (${plan.todo.length})`;
  $('fixAuto').replaceChildren(
    ...keep.map(t => el('li', {}, el('b', { text: `Keep ${t.from}` }), el('small', { text: `${t.page}: the page moves from ${t.to} back to ${t.from}, and ${t.to} gets a 301 to it.` }))),
    ...move.map(t => el('li', {}, el('b', { text: `301 ${t.from} → ${t.to}` }), el('small', { text: `${t.page}: the old URL redirects to the new page.` }))),
    ...old.map(t => el('li', {}, el('b', { text: t.gone ? `${t.code} ${t.from}` : `${t.code} ${t.from} → ${t.to}` }), el('small', { text: `${t.page}: carried over${t.gone ? ' as gone' : ''}${t.regex ? ' (pattern)' : ''}, in the "Migrated from old site" group.` }))));
  $('fixManualTitle').textContent = `Approved but not changed (${plan.skipped.length})`;
  $('fixManual').replaceChildren(...plan.skipped.map(k => el('li', {}, el('b', { text: k.from }), el('small', { text: k.why }))));
  $('claudeRow').hidden = true; $('claudeMissing').hidden = true; $('fixClaude').checked = false;
  $('fixAfterText').textContent = `Caches are cleared, then each old URL is opened: kept ones must show their page, redirected ones must land on the new page${old.some(t => t.gone) ? ', gone ones must answer 410' : ''}.${old.some(t => t.regex) ? ' Pattern rules are added but not opened.' : ''}`;
  const parts = [keep.length ? `moving ${keep.length} page${keep.length === 1 ? '' : 's'} back to ${keep.length === 1 ? 'its' : 'their'} old URL` : '', move.length ? `adding ${move.length} redirect${move.length === 1 ? '' : 's'}` : '', old.length ? `carrying over ${old.length} of the old site's redirect${old.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  $('fixConfirmText').textContent = `I approve ${parts} on ${plan.url} now.`;
  $('fixGo').textContent = `Back up and apply ${plan.todo.length}`;
  $('fixConfirm').checked = false; $('fixGo').disabled = true;
  $('fixDialog').showModal();
}

// The section switcher sticks just under the header, whatever its height.
const setHdr = () => document.documentElement.style.setProperty('--hdr', document.querySelector('.topbar').offsetHeight + 'px');
window.addEventListener('resize', setHdr); setHdr();

boot().catch(e => { document.body.prepend(el('p', { class: 'err', text: 'Could not load: ' + e.message })); });
