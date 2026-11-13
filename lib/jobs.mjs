// The two jobs the app runs, shared by the web app (server.mjs) and the command line (bin/wpeqa.mjs):
//   checkJob: Run Tool for one tab (read-only)
//   fixJob:   apply approved fixes for one tab (backup, automatic fixes, optional Claude Code, verify)
// A lock file per site stops two jobs on the same site at once, across processes.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, templates, getState, applyRun, recordFix, markAnswered, runDir } from './store.mjs';
import { runTab } from './run.mjs';
import { fixTab } from './fixrun.mjs';
import { retryIds } from './fixers.mjs';
import { URLS_TAB, buildUrlMap, applyRedirects } from './redirects.mjs';
import { buildLegacy } from './legacy.mjs';
import { LIVE_TAB, requireLive } from './live.mjs';
import { clearRunCache } from './runcache.mjs';

export const newRunId = (tab, kind) => new Date().toISOString().replace(/[:.]/g, '-') + (kind === 'fix' ? '-fix-' : '-') + tab;

const lockFile = siteId => path.join(DATA, 'locks', `${siteId}.lock`);
function lock(siteId, what) {
  const f = lockFile(siteId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (fs.existsSync(f)) {
    const held = JSON.parse(fs.readFileSync(f, 'utf8'));
    let alive = false; try { process.kill(held.pid, 0); alive = true; } catch { /* stale lock */ }
    if (alive) throw new Error(`A ${held.what} run is already going for this site (since ${new Date(held.at).toLocaleTimeString()}). Wait for it to finish.`);
  }
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, what, at: new Date().toISOString() }));
  return () => { try { fs.unlinkSync(f); } catch { /* already gone */ } };
}

// A logger that writes the run's log.txt and passes each line on (to the browser stream or the terminal).
export function runLogger(dir, onLine = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  return line => { const l = `${new Date().toLocaleTimeString()}  ${line}`; fs.appendFileSync(path.join(dir, 'log.txt'), l + '\n'); onLine(l); };
}

export async function checkJob({ site, tab, id = newRunId(tab, 'check'), log, progress = () => {}, fresh = false }) {
  if (tab === URLS_TAB) {
    log ||= runLogger(runDir(site.id, id), l => console.log(l));
    const unlock = lock(site.id, 'Old → New URLs check');
    try { log(`Run Tool: Old → New URLs for ${site.name} (old ${site.referenceUrl || 'not set'}, new ${site.url})`); const meta = await buildUrlMap({ site, log, progress }); return { ...meta, id, newPages: undefined }; } finally { unlock(); }
  }
  if (tab === LIVE_TAB) site = requireLive(site); // After Launch audits the production URL and install
  const template = templates()[tab];
  const dir = runDir(site.id, id);
  log ||= runLogger(dir, l => console.log(l));
  const unlock = lock(site.id, `${template.title} check`);
  const startedAt = new Date().toISOString();
  try {
    log(`Run Tool: ${template.title} for ${site.name} (${site.url}${site.install ? `, WP Engine install ${site.install}` : ', no WP Engine install'})`);
    const r = await runTab({ site, template, runId: id, dir, log, progress, fresh });
    const meta = { id, startedAt, finishedAt: new Date().toISOString(), durationMs: r.durationMs, counts: r.counts, home: r.home };
    applyRun(site.id, tab, meta, r.results);
    log(`Done in ${Math.round(r.durationMs / 1000)} s: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
    return meta;
  } finally { unlock(); }
}

// Import an export file of the old site's redirects (or drop one) and map them onto the new site. Read-only.
export async function legacyJob({ site, file, remove, id = newRunId(URLS_TAB, 'check'), log }) {
  log ||= runLogger(runDir(site.id, id), l => console.log(l));
  const unlock = lock(site.id, "Old site's redirects");
  try {
    log(file ? `Importing the old site's redirects from ${file.name} for ${site.name}` : remove ? `Removing ${remove} from the old site's redirects` : `Mapping the old site's redirects for ${site.name}`);
    const r = await buildLegacy({ site, log, file, remove });
    return { id, finishedAt: new Date().toISOString(), ...(r || {}) };
  } finally { unlock(); }
}

// Claude's open questions from an earlier fix run, and what's needed to continue that conversation.
export function openQuestions(site, tab, runId) {
  const prev = (getState(site.id).tabs[tab]?.fixRuns || []).find(r => r.id === runId);
  if (!prev) throw new Error('Unknown fix run.');
  if (!prev.questions?.length) throw new Error('That fix run has no questions from Claude.');
  if (prev.answeredBy) throw new Error('Those questions were already answered.');
  // Still open: the item is waiting on this run's question for the same finding (not re-checked or re-run since).
  const items = getState(site.id).tabs[tab]?.items || {};
  const open = prev.questions.filter(q => { const s = items[q.id]; return s && s.decision === 'approve' && ['fail', 'warn'].includes(s.status) && !s.confirmed && s.fix?.state === 'question' && s.fix.runId === prev.id && s.fix.toolAt === s.tool?.at; });
  if (!open.length) throw new Error('Those questions are out of date: the checks ran again or the items changed since. Use Apply fixes instead.');
  const f = path.join(runDir(site.id, prev.id), 'claude-session.json');
  if (!fs.existsSync(f)) throw new Error("That run's Claude conversation wasn't saved, so it can't continue. Run Apply fixes again.");
  const sess = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { prev, sessionId: sess.sessionId, work: sess.work, items: open.map(q => q.id) };
}

// `reply: { to: <fix run id>, answer }` continues that run's Claude conversation with the owner's answer.
// `retry: true` also plans the approved items an earlier run left in a fix request (Retry fix request).
export async function fixJob({ site, tab, id = newRunId(tab, 'fix'), log, progress = () => {}, claude = false, reply = null, retry = false }) {
  if (!site.install) throw new Error('This site has no WP Engine install, so fixes cannot be applied. Add it in Site settings.');
  if (tab === LIVE_TAB) site = requireLive(site);
  // A fix changes the site: what earlier runs loaded (crawls, settings) is out of date for every module.
  clearRunCache(site.id);
  if (tab === URLS_TAB) {
    log ||= runLogger(runDir(site.id, id), l => console.log(l));
    const unlock = lock(site.id, 'Old → New URLs redirects');
    try { log(`Apply approved redirects for ${site.name} (${site.url}, WP Engine install ${site.install})`); const meta = await applyRedirects({ site, runId: id, log, progress }); return { meta }; } finally { unlock(); }
  }
  const template = templates()[tab];
  const dir = runDir(site.id, id);
  log ||= runLogger(dir, l => console.log(l));
  let cont = null;
  if (reply) {
    const answer = String(reply.answer || '').trim().slice(0, 8000);
    if (!answer) throw new Error('Write your answer to Claude first.');
    const q = openQuestions(site, tab, reply.to);
    cont = { items: q.items, answer, sessionId: q.sessionId, work: q.work };
  }
  const unlock = lock(site.id, `${template.title} fix`);
  const startedAt = new Date().toISOString();
  try {
    log(cont
      ? `Your answer to Claude: ${template.title} for ${site.name} (${site.url}, WP Engine install ${site.install}), continuing fix run ${reply.to}`
      : `Apply approved fixes: ${template.title} for ${site.name} (${site.url}, WP Engine install ${site.install})${claude ? ', with Claude Code for the rest' : ''}`);
    if (cont) cont.answer.split('\n').slice(0, 8).forEach(l => log('You: ' + l.slice(0, 220)));
    const tabState = getState(site.id).tabs[tab] || { items: {} };
    const include = retry && !cont ? retryIds(template, tabState) : [];
    if (include.length) log(`Retrying the fix request: ${include.length} approved item${include.length === 1 ? '' : 's'} from an earlier run.`);
    const fx = await fixTab({ site, template, tabState, runId: id, dir, log, progress: p => progress(p * 0.7), claude, reply: cont, include });
    const changed = Object.values(fx.outcomes).some(o => o.state === 'applied' || o.unreported);
    if (changed) {
      // Re-check only the items this run worked on (not the whole tab): much faster, same verdict for those items.
      const only = Object.keys(fx.outcomes);
      log(`Re-checking the ${only.length} item${only.length === 1 ? '' : 's'} this run worked on…`);
      const verify = await runTab({ site, template, runId: `${id}/verify`, dir: path.join(dir, 'verify'), log, progress: p => progress(0.7 + p * 0.3), only });
      applyRun(site.id, tab, { id: id + '-verify', startedAt, finishedAt: new Date().toISOString(), durationMs: verify.durationMs, counts: verify.counts, home: verify.home, after: 'fix', partial: true, items: only }, verify.results);
      for (const [itemId, o] of Object.entries(fx.outcomes)) if (o.state === 'applied' && verify.results[itemId]?.status === 'pass') o.state = 'verified';
    }
    const states = Object.values(fx.outcomes).reduce((c, o) => (c[o.state] = (c[o.state] || 0) + 1, c), {});
    const questions = fx.plan.manual.filter(m => fx.outcomes[m.id]?.state === 'question').map(m => ({ id: m.id, title: m.title, question: fx.outcomes[m.id].question }));
    const meta = { id, startedAt, finishedAt: new Date().toISOString(), backup: fx.backup, request: !!fx.request, claude: !!fx.claude, states, items: Object.keys(fx.outcomes),
      ...(questions.length ? { questions } : {}), ...(cont ? { replyTo: reply.to } : {}) };
    recordFix(site.id, tab, meta, fx.outcomes);
    if (cont) markAnswered(site.id, tab, reply.to, id, cont.answer);
    log(`Done: ${Object.entries(states).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
    return { meta, outcomes: fx.outcomes, request: fx.request, claudeSummary: fx.claude?.summary, questions };
  } finally { unlock(); }
}
