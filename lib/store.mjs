// Sites, checklist state and run history, stored as JSON under data/ (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstall, detectInstall } from './wpe.mjs';
import { agency, fill, ownerLabel } from './config.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.WPEQA_DATA || path.join(ROOT, 'data');
const SITES = path.join(DATA, 'sites.json');

export const TABS = ['qa-swarm', 'wp-site-audit', 'before-launch', 'after-launch'];
export const STATUSES = ['todo', 'pass', 'fail', 'warn', 'na'];

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, f); };

// Checklists with the agency's details filled in from config/agency.json.
export function templates() {
  const a = agency();
  return Object.fromEntries(TABS.map(t => {
    const tpl = readJson(path.join(ROOT, 'checklists', `${t}.json`), null);
    for (const s of tpl?.sections || []) for (const it of s.items) { it.title = fill(it.title, a); it.description = fill(it.description, a); it.ownerLabel = ownerLabel(it.owner, a); }
    return [t, tpl];
  }));
}

const ID_RE = /^[a-z0-9-]{2,60}$/;
const assertId = id => { if (!ID_RE.test(id || '')) throw new Error('Unknown site.'); return id; };
// Older entries were keyed by install name only.
const normalize = s => ({ ...s, id: s.id || s.install, url: s.url || `https://${s.install}.wpenginepowered.com`, install: s.install || null });
export const listSites = () => readJson(SITES, []).map(normalize);
export const getSite = id => listSites().find(s => s.id === id) || null;

// The site URL is what gets audited; the WP Engine install (for SSH/WP-CLI checks) is detected from it
// unless typed in.
export async function saveSite(input) {
  const url = cleanUrl(input.url);
  if (!url) throw new Error('Enter the site URL to audit.');
  const sites = listSites();
  const prev = input.id ? sites.find(s => s.id === input.id) : null;
  const host = new URL(url).hostname.replace(/^www\./, '');
  let id = prev?.id || host.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  if (!prev) { const base = id; let n = 2; while (sites.some(s => s.id === id)) id = `${base}-${n++}`; }
  let install = String(input.install || '').trim().toLowerCase(), installHow = install ? 'entered by hand' : null;
  if (install) assertInstall(install);
  else { const d = await detectInstall(url); if (d) { install = d.install; installHow = d.how; } }
  const site = {
    id, url, install: install || null, installHow,
    name: String(input.name || prev?.name || host).slice(0, 80),
    adminEmail: String(input.adminEmail ?? prev?.adminEmail ?? agency().adminEmail ?? '').trim().slice(0, 120),
    referenceUrl: cleanUrl(input.referenceUrl ?? prev?.referenceUrl ?? ''),
    maxPages: Math.max(5, Math.min(300, parseInt(input.maxPages ?? prev?.maxPages ?? 80, 10) || 80)),
    createdAt: prev?.createdAt || new Date().toISOString(),
  };
  writeJson(SITES, [...sites.filter(s => s.id !== id), site].sort((a, b) => a.name.localeCompare(b.name)));
  return site;
}

export function deleteSite(id) {
  writeJson(SITES, listSites().filter(s => s.id !== id));
}

function cleanUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); return x.origin; } catch { throw new Error(`"${u}" is not a valid URL.`); }
}

const statePath = id => path.join(DATA, 'state', `${assertId(id)}.json`);
export const getState = id => readJson(statePath(id), { tabs: {} });

export function updateState(id, fn) {
  const s = getState(id);
  fn(s);
  writeJson(statePath(id), s);
  return s;
}

const tabState = (s, tab) => (s.tabs[tab] ||= { items: {}, runs: [] });

// A person sets status / note / fix decision on one item.
export function setItem(id, tab, itemId, patch) {
  if (!TABS.includes(tab)) throw new Error('Unknown tab.');
  return updateState(id, s => {
    const it = (tabState(s, tab).items[itemId] ||= {});
    if ('status' in patch) {
      // Items with a tool result are checked automatically: Run Tool decides their status, not a person.
      if (it.tool) throw new Error('This item is checked automatically; its status comes from Run Tool.');
      if (STATUSES.includes(patch.status)) { it.status = patch.status; it.source = 'manual'; }
    }
    if ('note' in patch) it.note = String(patch.note).slice(0, 4000);
    if ('decision' in patch) it.decision = ['approve', 'decline'].includes(patch.decision) ? patch.decision : null;
    if ('decisionNote' in patch) it.decisionNote = String(patch.decisionNote).slice(0, 2000);
    it.at = new Date().toISOString();
  });
}

// A tool run writes its findings and sets the status of every automatic item.
export function applyRun(id, tab, run, results) {
  return updateState(id, s => {
    const t = tabState(s, tab);
    for (const [id, r] of Object.entries(results)) {
      const it = (t.items[id] ||= {});
      it.tool = { ...r, at: run.finishedAt, runId: run.id };
      it.status = r.status; it.source = 'tool'; // the scan decides automatic items
    }
    t.runs = [run, ...(t.runs || [])].slice(0, 20);
  });
}

export const runDir = (id, runId) => path.join(DATA, 'runs', assertId(id), runId);

// Records a fix run: each item's fix state, and the run (with its backup) in the tab's history.
// After verification: 'verified' (check passes now), 'applied' (ran, still flagged), 'failed', 'manual'.
export function recordFix(id, tab, fixRun, outcomes) {
  return updateState(id, s => {
    const t = tabState(s, tab);
    for (const [itemId, o] of Object.entries(outcomes)) {
      const it = (t.items[itemId] ||= {});
      it.fix = { ...o, runId: fixRun.id, at: fixRun.finishedAt, toolAt: it.tool?.at || null };
    }
    t.fixRuns = [fixRun, ...(t.fixRuns || [])].slice(0, 30);
  });
}
