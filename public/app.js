// WPE QA Checklist front end (no build step).
const TAB_ORDER = ['qa-swarm', 'wp-site-audit', 'before-launch', 'after-launch', 'urls'];
const URLST = { none: 'No redirect needed', redirect: 'Redirect', attention: 'Needs attention' };
const eff = r => { const status = r.auto?.status || 'attention'; return { status, target: (status === 'attention' ? r.target : undefined) ?? r.auto?.target ?? '' }; };
const urlsPending = rows => rows.filter(r => r.decision === 'approve' && eff(r).status !== 'none' && eff(r).target && !(r.applied?.state === 'verified' && r.applied.target === eff(r).target));
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
  $('siteHome').href = current.url; $('siteHome').textContent = current.url.replace(/^https?:\/\//, '');
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
      const u = data.state.urls || {}; const open = (u.rows || []).filter(r => eff(r).status !== 'none' && !r.decision).length;
      return el('button', { role: 'tab', 'aria-selected': String(t === tab), onclick: () => { tab = t; store.set('wpeqa.tab', t); render(); } }, 'Old → New URLs', u.runs?.length ? el('span', { class: 'badge' + (open ? '' : ' ok'), text: open ? String(open) : '✓' }) : null);
    }
    const tpl = templates[t]; const items = tpl.sections.flatMap(s => s.items);
    const bad = items.filter(i => ['fail', 'warn'].includes(statusOf(t, i))).length;
    const ran = tabState(t).runs?.length;
    return el('button', { role: 'tab', 'aria-selected': String(t === tab), onclick: () => { tab = t; store.set('wpeqa.tab', t); render(); } }, tpl.title, ran ? el('span', { class: 'badge' + (bad ? '' : ' ok'), text: bad ? String(bad) : '✓' }) : null);
  }));
  $('reportLink').hidden = tab === 'urls';
  document.querySelector('.filters [data-filter="attention"]').textContent = tab === 'urls' ? 'Needs redirect' : 'Needs attention';
  document.querySelector('.filters [data-filter="manual"]').textContent = tab === 'urls' ? 'No redirect' : 'Manual';
  $('secNav').hidden = tab === 'urls';
  if (tab === 'urls') return renderUrls();
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
  document.querySelectorAll('.item').forEach(r => {
    const st = r.dataset.status; const hide = r.classList.contains('urow') ? (filter === 'attention' ? st === 'none' : filter === 'manual' ? st !== 'none' : false) : filter === 'attention' ? !['fail', 'warn'].includes(st) : filter === 'manual' ? r.dataset.auto === '1' : false;
    r.classList.toggle('hidden-by-filter', hide);
  });
  const pickSec = tab !== 'urls' ? secSel[tab] || 'all' : 'all';
  let shown = 0;
  document.querySelectorAll('.section').forEach(s => { s.hidden = (pickSec !== 'all' && s.dataset.sec && s.dataset.sec !== pickSec) || !s.querySelector('.item:not(.hidden-by-filter), .urow:not(.hidden-by-filter)'); if (!s.hidden) shown++; });
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
  $('fRef').value = site?.referenceUrl || ''; $('fMax').value = site?.maxPages || 80;
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
    const s = await api('/sites', { method: 'POST', body: { id: editing?.id, url: $('fUrl').value.trim(), install: $('fInstall').value.trim().toLowerCase(), name: $('fName').value.trim(), adminEmail: $('fEmail').value.trim(), referenceUrl: $('fRef').value.trim(), maxPages: $('fMax').value } });
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
  const pend = urlsPending(rows).length;
  $('applyFixes').hidden = !pend; $('applyFixes').textContent = `Add redirects (${pend})`;
  $('fixHistory').hidden = true;
  const c = { none: 0, redirect: 0, attention: 0 }; rows.forEach(r => c[eff(r).status]++);
  const added = rows.filter(r => ['verified', 'applied', 'exists'].includes(r.applied?.state)).length;
  const tile = (cls, n, label) => el('div', { class: `count ${cls}` }, el('b', { text: String(n) }), el('span', { text: label }));
  $('counts').replaceChildren(...(rows.length ? [tile('c-pass', c.none, 'no redirect needed'), tile('c-warn', c.redirect, 'to redirect'), tile('c-fail', c.attention, 'need attention'), tile('c-auto', rows.filter(r => r.decision === 'approve').length, 'approved'), tile('c-na', added, 'added in Redirection')] : []));
  if (!current.referenceUrl) {
    $('sections').replaceChildren(el('div', { class: 'urls-empty' }, el('h2', { text: "Add the old site's address" }), el('p', { text: 'Run Tool compares every page of the old site with this one and proposes the redirects.' }), el('button', { class: 'btn primary', type: 'button', text: 'Set the old site', onclick: () => $('editSite').click() })));
    return;
  }
  if (!rows.length) {
    $('sections').replaceChildren(el('div', { class: 'urls-empty' }, el('h2', { text: 'Not run yet' }), el('p', {}, 'Run Tool lists every page of ', el('b', { text: current.referenceUrl.replace(/^https?:\/\//, '') }), ' and tests it on this site.')));
    return;
  }
  const origin = new URL(current.url).origin;
  const save = (r, patch) => api(`/sites/${current.id}/urls/${r.id}`, { method: 'PUT', body: patch }).then(v => { Object.assign(r, v); if (!('target' in v)) delete r.target; render(); }).catch(e => alert(e.message));
  const result = r => { const a = r.applied; if (!a) return null; const t = { verified: ['ok', 'Added · verified'], applied: ['warn', 'Added · check it'], exists: ['warn', 'Already in Redirection'], failed: ['bad', 'Not added'] }[a.state] || ['warn', a.state]; return el('span', { class: `ures ${t[0]}`, title: a.error || (a.landed ? `Lands on ${a.landed}` : ''), text: t[1] }); };
  const list = el('datalist', { id: 'newPages' }, (u.newPages || []).map(p => el('option', { value: p.path, label: p.title || p.path })));
  const body = rows.map(r => {
    const e = eff(r);
    const status = el('span', { class: `ustatus us-${e.status}`, text: URLST[e.status] });
    // Only rows that need attention take a new URL from a person; the scan set the others.
    const target = e.status !== 'attention'
      ? (e.target ? el('a', { class: 'utarget', href: origin + e.target, target: '_blank', rel: 'noopener' }, pathText(e.target)) : el('span', { class: 'muted', text: '—' }))
      : el('input', { class: 'uinput', type: 'text', list: 'newPages', value: e.target, placeholder: 'Pick or type the new URL', 'aria-label': `New URL for ${r.oldPath}`, onchange: ev => save(r, { target: ev.target.value }) });
    const decide = e.status === 'none' ? null : el('div', { class: 'fix', role: 'group', 'aria-label': 'Decision' },
      el('button', { type: 'button', 'data-d': 'approve', 'aria-pressed': String(r.decision === 'approve'), disabled: e.target ? null : true, title: e.target ? '' : 'Pick the new URL first', text: 'Approve', onclick: () => save(r, { decision: r.decision === 'approve' ? null : 'approve' }) }),
      el('button', { type: 'button', 'data-d': 'decline', 'aria-pressed': String(r.decision === 'decline'), text: 'Decline', onclick: () => save(r, { decision: r.decision === 'decline' ? null : 'decline' }) }));
    return el('tr', { class: 'urow', 'data-status': e.status },
      el('td', { class: 'upage' }, el('b', { text: r.page }), el('a', { class: 'uold', href: r.oldUrl, target: '_blank', rel: 'noopener' }, pathText(r.oldPath))),
      el('td', { class: 'ustat' }, status, el('small', { text: r.auto?.reason || '' })),
      el('td', { class: 'unew' }, target),
      el('td', { class: 'udecide' }, decide, result(r)));
  });
  $('sections').replaceChildren(el('section', { class: 'section' },
    el('h2', {}, 'Old site', el('small', { text: `${current.referenceUrl.replace(/^https?:\/\//, '')} → ${origin.replace(/^https?:\/\//, '')} · redirects go into the Redirection plugin` })),
    el('div', { class: 'utable-wrap' }, el('table', { class: 'utable' },
      el('thead', {}, el('tr', {}, ['Old page', 'Status', 'New URL', ''].map(h => el('th', { text: h })))),
      el('tbody', {}, body))), list,
    (u.newOnly || []).length ? el('details', { class: 'unewonly' }, el('summary', { text: `New on the new site (${u.newOnly.length}) · no old page, nothing to redirect` }),
      el('ul', {}, u.newOnly.map(p => el('li', {}, el('a', { href: origin + p.path, target: '_blank', rel: 'noopener' }, pathText(p.path)), p.title ? el('span', { text: p.title }) : null)))) : null));
  applyFilter();
}

async function openRedirectsDialog() {
  let plan;
  try { plan = await api(`/sites/${current.id}/fix/urls/plan`); } catch (e) { return alert(e.message); }
  const n = plan.todo.length;
  $('fixTitle').textContent = 'Add redirects';
  $('fixSite').textContent = `${current.name} · ${plan.url}${plan.install ? ` · WP Engine install ${plan.install}` : ''} · Old → New URLs`;
  $('fixBackupSec').hidden = false;
  $('fixBackup').textContent = 'The database and active theme are saved on the server in _wpeprivate/wpeqa-backups/ first. Then the Redirection plugin is installed and activated if it isn\'t already. If the backup fails, nothing is changed.';
  $('fixAutoSec').hidden = false; $('fixAfterSec').hidden = false; $('fixManualSec').hidden = !plan.skipped.length;
  $('fixAutoTitle').textContent = `2. Redirects to add (${n}, 301 permanent)`;
  $('fixAuto').replaceChildren(...plan.todo.map(t => el('li', {}, el('b', { text: `${t.from} → ${t.to}` }), el('small', { text: t.page }))));
  $('fixManualTitle').textContent = `Approved but not added (${plan.skipped.length})`;
  $('fixManual').replaceChildren(...plan.skipped.map(k => el('li', {}, el('b', { text: k.from }), el('small', { text: k.why }))));
  $('claudeRow').hidden = true; $('claudeMissing').hidden = true; $('fixClaude').checked = false;
  $('fixAfterText').textContent = 'Caches are cleared, then each old address is opened to check it now redirects to its new page.';
  $('fixConfirmText').textContent = `I approve adding ${n} redirect${n === 1 ? '' : 's'} to the Redirection plugin on ${plan.url} now.`;
  $('fixGo').textContent = `Back up and add ${n} redirect${n === 1 ? '' : 's'}`;
  $('fixConfirm').checked = false; $('fixGo').disabled = true;
  $('fixDialog').showModal();
}

// The section switcher sticks just under the header, whatever its height.
const setHdr = () => document.documentElement.style.setProperty('--hdr', document.querySelector('.topbar').offsetHeight + 'px');
window.addEventListener('resize', setHdr); setHdr();

boot().catch(e => { document.body.prepend(el('p', { class: 'err', text: 'Could not load: ' + e.message })); });
