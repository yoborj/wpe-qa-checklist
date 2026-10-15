// The two jobs the app runs, shared by the web app (server.mjs) and the command line (bin/wpeqa.mjs):
//   checkJob: Run Tool for one tab (read-only)
//   fixJob:   apply approved fixes for one tab (backup, automatic fixes, optional Claude Code, verify)
// A lock file per site stops two jobs on the same site at once, across processes.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, templates, getState, applyRun, recordFix, runDir } from './store.mjs';
import { runTab } from './run.mjs';
import { fixTab } from './fixrun.mjs';
import { URLS_TAB, buildUrlMap, applyRedirects } from './redirects.mjs';
import { LIVE_TAB, requireLive } from './live.mjs';

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

export async function checkJob({ site, tab, id = newRunId(tab, 'check'), log, progress = () => {} }) {
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
    const r = await runTab({ site, template, runId: id, dir, log, progress });
    const meta = { id, startedAt, finishedAt: new Date().toISOString(), durationMs: r.durationMs, counts: r.counts, home: r.home };
    applyRun(site.id, tab, meta, r.results);
    log(`Done in ${Math.round(r.durationMs / 1000)} s: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
    return meta;
  } finally { unlock(); }
}

export async function fixJob({ site, tab, id = newRunId(tab, 'fix'), log, progress = () => {}, claude = false }) {
  if (!site.install) throw new Error('This site has no WP Engine install, so fixes cannot be applied. Add it in Site settings.');
  if (tab === LIVE_TAB) site = requireLive(site);
  if (tab === URLS_TAB) {
    log ||= runLogger(runDir(site.id, id), l => console.log(l));
    const unlock = lock(site.id, 'Old → New URLs redirects');
    try { log(`Apply approved redirects for ${site.name} (${site.url}, WP Engine install ${site.install})`); const meta = await applyRedirects({ site, runId: id, log, progress }); return { meta }; } finally { unlock(); }
  }
  const template = templates()[tab];
  const dir = runDir(site.id, id);
  log ||= runLogger(dir, l => console.log(l));
  const unlock = lock(site.id, `${template.title} fix`);
  const startedAt = new Date().toISOString();
  try {
    log(`Apply approved fixes: ${template.title} for ${site.name} (${site.url}, WP Engine install ${site.install})${claude ? ', with Claude Code for the rest' : ''}`);
    const fx = await fixTab({ site, template, tabState: getState(site.id).tabs[tab] || { items: {} }, runId: id, dir, log, progress: p => progress(p * 0.7), claude });
    const changed = Object.values(fx.outcomes).some(o => o.state === 'applied');
    if (changed) {
      log('Re-running the checks to verify the fixes…');
      const verify = await runTab({ site, template, runId: id, dir: path.join(dir, 'verify'), log, progress: p => progress(0.7 + p * 0.3) });
      applyRun(site.id, tab, { id: id + '-verify', startedAt, finishedAt: new Date().toISOString(), durationMs: verify.durationMs, counts: verify.counts, home: verify.home, after: 'fix' }, verify.results);
      for (const [itemId, o] of Object.entries(fx.outcomes)) if (o.state === 'applied' && verify.results[itemId]?.status === 'pass') o.state = 'verified';
    }
    const states = Object.values(fx.outcomes).reduce((c, o) => (c[o.state] = (c[o.state] || 0) + 1, c), {});
    const meta = { id, startedAt, finishedAt: new Date().toISOString(), backup: fx.backup, request: !!fx.request, claude: !!fx.claude, states, items: Object.keys(fx.outcomes) };
    recordFix(site.id, tab, meta, fx.outcomes);
    log(`Done: ${Object.entries(states).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
    return { meta, outcomes: fx.outcomes, request: fx.request, claudeSummary: fx.claude?.summary };
  } finally { unlock(); }
}
