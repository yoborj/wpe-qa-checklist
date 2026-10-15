// WPE QA Checklist front end (no build step).
const TAB_ORDER = ['qa-swarm', 'wp-site-audit', 'before-launch', 'after-launch', 'urls'];
const URLST = { none: 'Same URL', redirect: 'URL changed', attention: 'Needs attention' };
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
const TILE = { pass: 'passed', fail: 'failed', warn: 'to look at', na: 'n/a', todo: 'to do' };

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat()) if (c != null) e.append(c); return e; };
const api = async (path, opts = {}) => { const r = await fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
const ago = iso => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString(); };
const linkify = text => { const frag = document.createDocumentFragment(); let last = 0; for (const m of text.matchAll(/(https?:\/\/\S+|\/runs\/\S+)/g)) { frag.append(text.slice(last, m.index)); frag.append(el('a', { href: m[0], target: '_blank', rel: 'noopener', text: m[0].length > 70 ? m[0].slice(0, 67) + '…' : m[0] })); last = m.index + m[0].length; } frag.append(text.slice(last)); return frag; };
const FIXSTATE = { verified: 'Fixed · verified', applied: 'Fix applied · still flagged', failed: 'Fix failed', manual: 'In fix request' };
const fixLabel = f => f.by === 'claude' ? ({ verified: 'Fixed by Claude · verified', applied: 'Fixed by Claude · check it', manual: 'Claude skipped · in fix request' }[f.state] || FIXSTATE[f.state]) : FIXSTATE[f.state] || f.state;
const copy = async (text, btn) => { try { await navigator.clipboard.writeText(text); const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1500); } catch { prompt('Copy this:', text); } };
const pendingFixes = t => templates[t].sections.flatMap(s => s.items).filter(it => { const s = tabState(t).items[it.id]; return s && s.decision === 'approve' && ['fail', 'warn'].includes(s.status) && !(['verified', 'manual'].includes(s.fix?.state) && s.fix.toolAt === s.tool?.at); });
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let config = {}, templates = {}, sites = [], current = null, data = null, tab = store.get('wpeqa.tab') || 'qa-swarm', filter = 'all', stream = null;
// Which section each checklist tab shows ('all' or a section title), remembered per tab.
let secSel = (() => { try { return JSON.parse(store.get('wpeqa.sec') || '{}'); } catch { return {}; } })();

async function boot() {
  [templates, config] = await Promise.all([api('/checklists'), api('/config')]);
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
  store.set('wpeqa.site', id);
  data = await api('/sites/' + id); current = data.site;
  $('siteName').textContent = current.name;
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

function render() {
  // Tabs with a badge for items that need attention.
  $('tabs').replaceChildren(...TAB_ORDER.map(t => {
    if (t === 'urls') {
      const u = data.state.urls || {}; const byId = new Map((u.rows || []).map(m => [m.id, m]));
      const open = (u.rows || []).filter(r => eff(r).status !== 'none' && !r.decision).length + (u.legacy?.rows || []).filter(r => leff(r, byId).status === 'attention' && !r.decision).length;
      return el('button', { role: 'tab', 'aria-selected': String(t === tab), onclick: () => { tab = t; store.set('wpeqa.tab', t); render(); } }, 'Old → New URLs', u.runs?.length ? el('span', { class: 'badge' + (open ? '' : ' ok'), text: open ? String(open) : '✓' }) : null);
    }
    if (t === 'after-launch' && !(data.state.prod && current.prodUrl && data.state.prod.url === current.prodUrl)) return el('button', { role: 'tab', 'aria-selected': String(t === tab), title: 'Unlocks once the production site is confirmed live', onclick: () => { tab = t; store.set('wpeqa.tab', t); render(); } }, templates[t].title, el('span', { class: 'badge lock', text: '🔒' }));
    const tpl = templates[t]; const items = tpl.sections.flatMap(s => s.items);
    const bad = items.filter(i => ['fail', 'warn'].includes(statusOf(t, i))).length;
    const ran = tabState(t).runs?.length;
    return el('button', { role: 'tab', 'aria-selected': String(t === tab), onclick: () => { tab = t; store.set('wpeqa.tab', t); render(); } }, tpl.title, ran ? el('span', { class: 'badge' + (bad ? '' : ' ok'), text: bad ? String(bad) : '✓' }) : null);
  }));
  $('reportLink').hidden = tab === 'urls'; $('runTool').hidden = false; document.querySelector('.filters').hidden = false;
  document.querySelector('.filters [data-filter="attention"]').textContent = tab === 'urls' ? 'Changed' : 'Needs attention';
  document.querySelector('.filters [data-filter="manual"]').textContent = tab === 'urls' ? 'Same URL' : 'Manual';
  $('secNav').hidden = tab === 'urls';
  if (tab === 'urls') return renderUrls();
  if (tab === 'after-launch' && !(data.state.prod && current.prodUrl && data.state.prod.url === current.prodUrl)) return renderLiveGate();
  const tpl = templates[tab]; const ts = tabState(tab);
  const last = ts.runs?.[0];
  $('lastRun').textContent = last ? `Ran ${ago(last.finishedAt)} · ${Math.round(last.durationMs / 1000)} s` : 'Not run yet';
  $('reportLink').href = `/api/sites/${current.id}/report/${tab}`;
  $('runTool').textContent = `Run Tool`;
  const pend = pendingFixes(tab).length;
  $('applyFixes').hidden = !pend; $('applyFixes').textContent = `Apply fixes (${pend})`;
  renderHistory();
  $('runTool').title = `Run the automatic ${tpl.title} checks on ${current.name}`;

  const items = tpl.sections.flatMap(s => s.items);
  const counts = Object.fromEntries(Object.keys(LABEL).map(k => [k, items.filter(i => statusOf(tab, i) === k).length]));
  $('counts').replaceChildren(...Object.keys(TILE).map(k => el('div', { class: `count c-${k}` }, el('b', { text: String(counts[k]) }), el('span', { text: TILE[k] }))), el('div', { class: 'count c-auto' }, el('b', { text: `${items.filter(i => i.check).length}/${items.length}` }), el('span', { text: 'automatic' })));

  renderSecNav(tpl);
  $('sections').replaceChildren(...tpl.sections.map(sec => {
    const rows = sec.items.map(it => itemRow(it));
    return el('section', { class: 'section', 'data-sec': sec.title }, el('h2', {}, sec.title, sec.appliesIf ? el('small', { text: { elementor: '· only when Elementor is active', yootheme: '· only for YOOtheme sites', tailwind: '· only for Tailwind builds', reference: '· needs a reference site' }[sec.appliesIf] }) : null), el('div', { class: 'items' }, rows));
  }));
  applyFilter();
}

// Section switcher: one pill per section, badge = failed/flagged items in it.
function renderSecNav(tpl) {
  const secs = tpl.sections;
  if (secSel[tab] && secSel[tab] !== 'all' && !secs.some(s => s.title === secSel[tab])) secSel[tab] = 'all';
  if (!secSel[tab]) secSel[tab] = secs[0]?.title || 'all';
  const pick = t => { secSel[tab] = t; store.set('wpeqa.sec', JSON.stringify(secSel)); renderSecNav(tpl); applyFilter(); window.scrollTo({ top: $('secNav').offsetTop - 90, behavior: 'smooth' }); };
  const badge = items => {
    const st = items.map(i => statusOf(tab, i));
    const bad = st.filter(x => x === 'fail' || x === 'warn').length;
    if (bad) return el('span', { class: 'sbadge bad', text: String(bad) });
    if (st.every(x => x === 'na')) return el('span', { class: 'sbadge na', text: 'n/a' });
    if (st.some(x => x === 'pass') && st.every(x => ['pass', 'na'].includes(x))) return el('span', { class: 'sbadge ok', text: '✓' });
    return el('span', { class: 'sbadge', text: String(items.length) });
  };
  const all = secs.flatMap(s => s.items);
  $('secNav').replaceChildren(
    el('button', { type: 'button', 'aria-pressed': String(secSel[tab] === 'all'), onclick: () => pick('all') }, 'All', badge(all)),
    ...secs.map(sec => el('button', { type: 'button', 'aria-pressed': String(secSel[tab] === sec.title), class: sec.items.every(i => statusOf(tab, i) === 'na') ? 'is-na' : null, onclick: () => pick(sec.title) }, sec.title, badge(sec.items))));
}

function itemRow(it) {
  const s = tabState(tab).items[it.id] || {}; const status = s.status || 'todo';
  const save = patch => api(`/sites/${current.id}/items/${tab}/${encodeURIComponent(it.id)}`, { method: 'PUT', body: patch }).then(v => { (data.state.tabs[tab] ||= { items: {}, runs: [] }).items[it.id] = v; render(); }).catch(e => alert(e.message));
  // Automatic items: the scan decides the status (read-only). Manual items: a person marks them.
  const auto = !!(it.check || s.tool);
  const seg = auto
    ? el('span', { class: `spill sp-${status}`, title: 'Set by Run Tool', text: s.tool ? LABEL[status] : 'Not run yet' })
    : el('div', { class: 'seg', role: 'group', 'aria-label': `Status of ${it.title}` }, STATUS.map(([k, label]) => el('button', { type: 'button', 'data-s': k, 'aria-pressed': String(status === k), title: LABEL[k], text: label, onclick: () => save({ status: k }) })));
  const src = auto
    ? el('span', { class: 'src', text: s.tool ? `automatic · ${ago(s.tool.at)}` : 'automatic' })
    : el('span', { class: 'src', text: s.source === 'manual' ? `you · ${s.at ? ago(s.at) : ''}` : 'manual check' });
  const details = s.tool?.details?.length ? el('details', {}, el('summary', { text: `${s.tool.details.length} detail${s.tool.details.length === 1 ? '' : 's'}` }), el('ul', {}, s.tool.details.map(d => el('li', {}, linkify(String(d)))))) : null;
  let t; const note = el('input', { type: 'text', value: s.note || '', placeholder: 'Add a note…', 'aria-label': `Note for ${it.title}`, oninput: e => { clearTimeout(t); t = setTimeout(() => api(`/sites/${current.id}/items/${tab}/${encodeURIComponent(it.id)}`, { method: 'PUT', body: { note: e.target.value } }).catch(() => {}), 600); } });
  const fix = ['fail', 'warn'].includes(status) ? el('div', { class: 'fix', role: 'group', 'aria-label': 'Fix decision' },
    el('button', { type: 'button', 'data-d': 'approve', 'aria-pressed': String(s.decision === 'approve'), text: 'Approve', onclick: () => save({ decision: s.decision === 'approve' ? null : 'approve' }) }),
    el('button', { type: 'button', 'data-d': 'decline', 'aria-pressed': String(s.decision === 'decline'), text: 'Decline', onclick: () => save({ decision: s.decision === 'decline' ? null : 'decline' }) })) : null;
  return el('article', { class: 'item', 'data-status': status, 'data-auto': it.check ? '1' : '0' },
    el('div', { class: 'item-main' },
      el('div', { class: 'item-title' }, it.title, it.owner ? el('span', { class: 'chip', text: it.ownerLabel || it.owner }) : null, it.check ? el('span', { class: 'chip auto', text: 'Auto' }) : null),
      el('p', { class: 'item-desc', title: it.description, text: it.description }),
      s.tool?.summary ? el('p', { class: 'item-summary' }, linkify(s.tool.summary)) : null,
      details,
      s.tool?.shots?.length && ['fail', 'warn'].includes(s.tool.status) ? el('div', { class: 'shots' }, s.tool.shots.map((sh, i) => el('a', { class: 'shot', href: sh.file, title: `${sh.page} · ${sh.label} (click to enlarge)`, onclick: e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); openShots(s.tool.shots, i); } },
        el('img', { src: sh.file, alt: `${sh.label} on ${sh.page}`, loading: 'lazy', 'data-kind': sh.kind || 'crop' }),
        el('span', { text: `${sh.page} · ${sh.label}${sh.found ? '' : ' (not pinpointed; page view)'}` })))) : null,
      s.tool?.suggestion && ['fail', 'warn'].includes(s.tool.status) ? el('p', { class: 'item-suggest' }, el('strong', { text: 'How to fix' }), s.tool.suggestion.text, s.tool.suggestion.auto ? el('span', { class: 'chip auto', text: 'App can fix' }) : null) : null),
    el('div', { class: 'item-side' }, seg, src, s.fix ? el('span', { class: `fixstate fs-${s.fix.state}`, title: s.fix.reason || s.fix.action || '', text: fixLabel(s.fix) }) : null),
    el('div', { class: 'item-extra' }, note, fix));
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

function applyFilter() {
  document.querySelectorAll('.filters button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  document.querySelectorAll('.item, .urow').forEach(r => {
    const st = r.dataset.status; const hide = r.classList.contains('urow') ? (filter === 'attention' ? st === 'none' : filter === 'manual' ? st !== 'none' : false) : filter === 'attention' ? !['fail', 'warn'].includes(st) : filter === 'manual' ? r.dataset.auto === '1' : false;
    r.classList.toggle('hidden-by-filter', hide);
  });
  const pickSec = tab !== 'urls' ? secSel[tab] || 'all' : 'all';
  let shown = 0;
  document.querySelectorAll('.section').forEach(s => { s.hidden = (pickSec !== 'all' && s.dataset.sec && s.dataset.sec !== pickSec) || (!s.dataset.keep && !s.querySelector('.item:not(.hidden-by-filter), .urow:not(.hidden-by-filter)')); if (!s.hidden) shown++; });
  $('secEmpty').hidden = tab === 'urls' || shown > 0;
}

function setRunning(on) { $('runTool').disabled = on; $('applyFixes').disabled = on; $('runTool').textContent = on ? 'Running…' : 'Run Tool'; }

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

$('runTool').addEventListener('click', async () => {
  try { setRunning(true); const r = await api(`/sites/${current.id}/run/${tab}`, { method: 'POST' }); follow(r.runId); }
  catch (e) { setRunning(false); alert(e.message); }
});
$('sitePick').addEventListener('change', e => openSite(e.target.value));
document.querySelectorAll('.filters button').forEach(b => b.addEventListener('click', () => { filter = b.dataset.filter; applyFilter(); }));

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
      r.backup ? el('div', {}, 'Backup: ', el('code', { text: r.backup.path }), r.backup.size ? ` (${r.backup.size})` : '') : el('div', { class: 'muted', text: 'No backup (no changes were made; fix request only).' }),
      el('div', { class: 'row' }, r.backup ? restore : null, reqLink, reqCopy));
  }));
}

// Apply approved fixes: second approval in a modal, then a backed-up fix run.
$('applyFixes').addEventListener('click', async () => {
  $('fixErr').hidden = true; $('fixConfirm').checked = false; $('fixGo').disabled = true;
  if (tab === 'urls') return openRedirectsDialog();
  $('fixTitle').textContent = 'Apply approved fixes';
  $('fixAfterText').textContent = "Caches are cleared and this tab's checks run again, so each fix shows as verified or still flagged.";
  let plan;
  try { plan = await api(`/sites/${current.id}/fix/${tab}/plan`); } catch (e) { return alert(e.message); }
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
  try { $('fixGo').disabled = true; const r = await api(`/sites/${current.id}/fix/${tab}`, { method: 'POST', body: { confirm: true, claude: tab !== 'urls' && $('fixClaude').checked && !$('claudeRow').hidden } }); $('fixDialog').close(); follow(r.runId); }
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
  const c = { none: 0, redirect: 0, attention: 0 }; rows.forEach(r => c[eff(r).status]++);
  const done = rows.filter(r => ['verified', 'applied', 'exists'].includes(r.applied?.state)).length;
  const tile = (cls, n, label) => el('div', { class: `count ${cls}` }, el('b', { text: String(n) }), el('span', { text: label }));
  $('counts').replaceChildren(...(rows.length ? [tile('c-pass', c.none, 'same URL'), tile('c-warn', c.redirect, 'URL changed'), tile('c-fail', c.attention, 'need attention'), tile('c-auto', rows.filter(r => r.decision === 'approve').length, 'approved'), tile('c-na', done, 'done')] : []));
  if (!rows.length) {
    $('sections').replaceChildren(el('div', { class: 'urls-empty' }, el('h2', { text: 'Not run yet' }), el('p', {}, 'Run Tool lists every page of ', el('b', { text: current.referenceUrl.replace(/^https?:\/\//, '') }), ' and checks each old URL on this site. Then you can import the old site\'s redirects.')));
    return;
  }
  const origin = new URL(current.url).origin;
  const save = (r, patch) => api(`/sites/${current.id}/urls/${r.id}`, { method: 'PUT', body: patch }).then(v => { Object.assign(r, v); for (const f of ['target', 'keep', 'choice']) if (!(f in v)) delete r[f]; render(); }).catch(e => alert(e.message));
  const result = r => { const a = r.applied; if (!a) return null; const keep = a.choice === 'keep'; const t = { verified: ['ok', keep ? 'Old URL kept · verified' : 'Redirected · verified'], applied: ['warn', 'Done · check it'], exists: ['warn', 'Already in Redirection'], failed: ['bad', 'Not done'] }[a.state] || ['warn', a.state]; return el('span', { class: `ures ${t[0]}`, title: a.error || (a.landed ? `Lands on ${a.landed}` : ''), text: t[1] }); };
  const list = el('datalist', { id: 'newPages' }, (u.newPages || []).map(p => el('option', { value: p.path, label: p.title || p.path })));
  const body = rows.map(r => {
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
    return el('tr', { class: 'urow', 'data-status': e.status },
      el('td', { class: 'upage' }, el('b', { text: r.page }), el('a', { class: 'uold', href: r.oldUrl, target: '_blank', rel: 'noopener' }, pathText(r.oldPath))),
      el('td', { class: 'ustat' }, status, el('small', { text: r.auto?.reason || '' })),
      el('td', { class: 'unew' }, alts, target, choice, why),
      el('td', { class: 'udecide' }, decide, result(r)));
  });
  $('sections').replaceChildren(legacySection(u, origin), el('section', { class: 'section' },
    el('h2', {}, 'Old URLs', el('small', { text: `${current.referenceUrl.replace(/^https?:\/\//, '')} → ${origin.replace(/^https?:\/\//, '')} · keep the old URL, or 301 it to the new page` })),
    el('div', { class: 'utable-wrap' }, el('table', { class: 'utable' },
      el('thead', {}, el('tr', {}, ['Old page', 'Status', 'New page · which URL to use', ''].map(h => el('th', { text: h })))),
      el('tbody', {}, body))), list,
    (u.newOnly || []).length ? el('details', { class: 'unewonly' }, el('summary', { text: `New on the new site (${u.newOnly.length}) · no old page, nothing to do` }),
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
    ? el('div', { class: 'lcard' },
        el('div', { class: 'lhead' },
          el('div', {}, el('h3', { text: 'Imported from the old site' }), el('p', { text: 'Each redirect points at where its page is now. Approve the ones to keep; they go into Redirection\'s "Migrated from old site" group.' })),
          el('button', { class: 'btn', type: 'button', text: 'Import another file', onclick: () => pick.click() })),
        el('div', { class: 'lfiles' }, files.map(f => el('span', { class: 'lfile' }, el('b', { text: f.name }), el('span', { text: `${f.count ?? ''} rule${f.count === 1 ? '' : 's'}` }), el('button', { type: 'button', class: 'lx', title: `Remove ${f.name}`, 'aria-label': `Remove ${f.name}`, text: '×', onclick: () => forget(f.name) })))),
        (L.notes || []).length ? el('ul', { class: 'linfo' }, L.notes.map(n => el('li', { text: n }))) : null, pick)
    : el('div', { class: 'lcard lempty' },
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
  const result = r => { const a = r.applied; if (!a) return null; const t = { verified: ['ok', 'Copied · verified'], applied: ['warn', a.status ? 'Done · check it' : 'Added'], exists: ['warn', 'Already in Redirection'], failed: ['bad', 'Not done'] }[a.state] || ['warn', a.state]; return el('span', { class: `ures ${t[0]}`, title: a.error || (a.landed ? `Lands on ${a.landed}` : ''), text: t[1] }); };
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
    return el('tr', { class: 'lrow', 'data-status': e.status },
      el('td', { class: 'upage' }, el('code', { class: 'lfrom' }, pathText(r.from)), el('small', { class: 'lmeta', text: meta })),
      el('td', { class: 'ustat' }, el('span', { class: `ustatus us-${LCLS[e.status]}`, text: LST[e.status] }), el('small', { text: e.reason || '' })),
      el('td', { class: 'unew' }, target),
      el('td', { class: 'udecide' }, decide, result(r)));
  });
  const tally = Object.entries(lrows.reduce((c, r) => (c[leff(r, byId).status] = (c[leff(r, byId).status] || 0) + 1, c), {})).map(([k, v]) => `${v} ${LST[k].toLowerCase()}`).join(' · ');
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
  $('runTool').hidden = true; $('applyFixes').hidden = true; $('fixHistory').hidden = true; $('secNav').hidden = true; $('reportLink').hidden = true; document.querySelector('.filters').hidden = true;
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
