// WPE QA Checklist front end (no build step).
const TAB_ORDER = ['qa-swarm', 'wp-site-audit', 'before-launch', 'after-launch'];
const STATUS = [['pass', 'Pass'], ['fail', 'Fail'], ['warn', 'Look'], ['na', 'N/A'], ['todo', 'To do']];
const LABEL = { pass: 'Passed', fail: 'Failed', warn: 'Needs a look', na: 'N/A', todo: 'To do' };

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

let templates = {}, sites = [], current = null, data = null, tab = store.get('wpeqa.tab') || 'qa-swarm', filter = 'all', stream = null;

async function boot() {
  templates = await api('/checklists');
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
    const tpl = templates[t]; const items = tpl.sections.flatMap(s => s.items);
    const bad = items.filter(i => ['fail', 'warn'].includes(statusOf(t, i))).length;
    const ran = tabState(t).runs?.length;
    return el('button', { role: 'tab', 'aria-selected': String(t === tab), onclick: () => { tab = t; store.set('wpeqa.tab', t); render(); } }, tpl.title, ran ? el('span', { class: 'badge' + (bad ? '' : ' ok'), text: bad ? String(bad) : '✓' }) : null);
  }));
  const tpl = templates[tab]; const ts = tabState(tab);
  const last = ts.runs?.[0];
  $('lastRun').textContent = last ? `Last run ${ago(last.finishedAt)} · ${Math.round(last.durationMs / 1000)} s` : 'Not run yet';
  $('reportLink').href = `/api/sites/${current.id}/report/${tab}`;
  $('runTool').textContent = `Run Tool`;
  const pend = pendingFixes(tab).length;
  $('applyFixes').hidden = !pend; $('applyFixes').textContent = `Apply approved fixes (${pend})`;
  renderHistory();
  $('runTool').title = `Run the automatic ${tpl.title} checks on ${current.name}`;

  const items = tpl.sections.flatMap(s => s.items);
  const counts = Object.fromEntries(Object.keys(LABEL).map(k => [k, items.filter(i => statusOf(tab, i) === k).length]));
  $('counts').replaceChildren(...Object.entries(LABEL).map(([k, v]) => el('span', { class: `count c-${k}`, text: `${counts[k]} ${v.toLowerCase()}` })), el('span', { class: 'count c-todo', text: `${items.filter(i => i.check).length} of ${items.length} automatic` }));

  $('sections').replaceChildren(...tpl.sections.map(sec => {
    const rows = sec.items.map(it => itemRow(it));
    return el('section', { class: 'section' }, el('h2', {}, sec.title, sec.appliesIf ? el('small', { text: { elementor: '· only when Elementor is active', yootheme: '· only for YOOtheme sites', reference: '· needs a reference site' }[sec.appliesIf] }) : null), el('div', { class: 'items' }, rows));
  }));
  applyFilter();
}

function itemRow(it) {
  const s = tabState(tab).items[it.id] || {}; const status = s.status || 'todo';
  const save = patch => api(`/sites/${current.id}/items/${tab}/${encodeURIComponent(it.id)}`, { method: 'PUT', body: patch }).then(v => { (data.state.tabs[tab] ||= { items: {}, runs: [] }).items[it.id] = v; render(); }).catch(e => alert(e.message));
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': `Status of ${it.title}` }, STATUS.map(([k, label]) => el('button', { type: 'button', 'data-s': k, 'aria-pressed': String(status === k), title: LABEL[k], text: label, onclick: () => save({ status: k }) })));
  const src = s.source === 'manual'
    ? el('span', { class: 'src' }, `set by you ${s.at ? ago(s.at) : ''}`, s.tool ? [' · ', el('button', { type: 'button', text: 'use tool result', onclick: () => save({ status: 'tool' }) })] : null)
    : s.tool ? el('span', { class: 'src', text: `by tool ${ago(s.tool.at)}` }) : el('span', { class: 'src', text: it.check ? 'automatic, not run yet' : 'manual check' });
  const details = s.tool?.details?.length ? el('details', {}, el('summary', { text: `${s.tool.details.length} detail${s.tool.details.length === 1 ? '' : 's'}` }), el('ul', {}, s.tool.details.map(d => el('li', {}, linkify(String(d)))))) : null;
  let t; const note = el('input', { type: 'text', value: s.note || '', placeholder: 'Note', 'aria-label': `Note for ${it.title}`, oninput: e => { clearTimeout(t); t = setTimeout(() => api(`/sites/${current.id}/items/${tab}/${encodeURIComponent(it.id)}`, { method: 'PUT', body: { note: e.target.value } }).catch(() => {}), 600); } });
  const fix = ['fail', 'warn'].includes(status) ? el('div', { class: 'fix', role: 'group', 'aria-label': 'Fix decision' }, el('span', { text: 'Fix:' }),
    el('button', { type: 'button', 'data-d': 'approve', 'aria-pressed': String(s.decision === 'approve'), text: 'Approve', onclick: () => save({ decision: s.decision === 'approve' ? null : 'approve' }) }),
    el('button', { type: 'button', 'data-d': 'decline', 'aria-pressed': String(s.decision === 'decline'), text: 'Decline', onclick: () => save({ decision: s.decision === 'decline' ? null : 'decline' }) })) : null;
  return el('article', { class: 'item', 'data-status': status, 'data-auto': it.check ? '1' : '0' },
    el('div', { class: 'item-main' },
      el('div', { class: 'item-title' }, it.title, it.owner ? el('span', { class: 'chip', text: it.owner }) : null, it.check ? el('span', { class: 'chip auto', text: 'Auto' }) : null),
      el('p', { class: 'item-desc', text: it.description }),
      s.tool?.summary ? el('p', { class: 'item-summary' }, linkify(s.tool.summary)) : null,
      details),
    el('div', { class: 'item-side' }, seg, src, s.fix ? el('span', { class: `fixstate fs-${s.fix.state}`, title: s.fix.reason || s.fix.action || '', text: fixLabel(s.fix) }) : null),
    el('div', { class: 'item-extra' }, note, fix));
}

function applyFilter() {
  document.querySelectorAll('.filters button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  document.querySelectorAll('.item').forEach(r => {
    const st = r.dataset.status; const hide = filter === 'attention' ? !['fail', 'warn'].includes(st) : filter === 'manual' ? r.dataset.auto === '1' : false;
    r.classList.toggle('hidden-by-filter', hide);
  });
  document.querySelectorAll('.section').forEach(s => { s.hidden = !s.querySelector('.item:not(.hidden-by-filter)'); });
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
  $('fName').value = site?.name || ''; $('fEmail').value = site?.adminEmail ?? 'developer@example.com';
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
  try { $('fixGo').disabled = true; const r = await api(`/sites/${current.id}/fix/${tab}`, { method: 'POST', body: { confirm: true, claude: $('fixClaude').checked && !$('claudeRow').hidden } }); $('fixDialog').close(); follow(r.runId); }
  catch (e) { $('fixErr').textContent = e.message; $('fixErr').hidden = false; $('fixGo').disabled = false; }
});

boot().catch(e => { document.body.prepend(el('p', { class: 'err', text: 'Could not load: ' + e.message })); });
