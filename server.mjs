#!/usr/bin/env node
// WPE QA Checklist: a local web app. Listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, TABS, templates, listSites, getSite, saveSite, deleteSite, getState, setItem, runDir } from './lib/store.mjs';
import { checkJob, fixJob, newRunId, runLogger } from './lib/jobs.mjs';
import { claudeStatus } from './lib/claude.mjs';
import { agency } from './lib/config.mjs';
import { planFixes } from './lib/fixers.mjs';
import { report } from './lib/report.mjs';
import { URLS_TAB, setUrlRow, planRedirects, effective } from './lib/redirects.mjs';
import { liveChecks, confirmLive } from './lib/live.mjs';
const JOB_TABS = [...TABS, URLS_TAB];

const PORT = +process.env.PORT || 4646;
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

const runs = new Map(); // runId -> { siteId, tab, log[], listeners:Set, done, progress }

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const body = req => new Promise((resolve, reject) => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('Invalid JSON.')); } }); });

function serveFile(res, base, rel) {
  const f = path.resolve(base, '.' + path.sep + rel);
  if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}

function emit(run, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const l of run.listeners) l.write(msg);
}

// Wraps a job so the browser can follow it live (server-sent events).
function startJob(site, tab, kind, opts = {}) {
  for (const r of runs.values()) if (r.siteId === site.id && !r.done) throw new Error(`A ${r.tab} ${r.kind} run is already going for this site. Wait for it to finish.`);
  const id = newRunId(tab, kind);
  const run = { id, siteId: site.id, tab, kind, log: [], listeners: new Set(), done: false, progress: 0, startedAt: new Date().toISOString() };
  runs.set(id, run);
  const log = runLogger(runDir(site.id, id), l => { run.log.push(l); emit(run, 'log', l); });
  const progress = p => { run.progress = Math.max(run.progress, Math.min(1, p)); emit(run, 'progress', run.progress); };
  const job = kind === 'fix' ? fixJob({ site, tab, id, log, progress, claude: !!opts.claude }).then(r => r.meta) : checkJob({ site, tab, id, log, progress });
  job.then(meta => { run.result = meta; emit(run, 'done', meta); })
    .catch(e => { log(`Stopped: ${e.message}`); run.error = e.message; emit(run, 'failed', { error: e.message }); })
    .finally(() => { run.done = true; for (const l of run.listeners) l.end(); run.listeners.clear(); setTimeout(() => runs.delete(id), 30 * 60 * 1000); });
  return run;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (req.method === 'GET' && !url.pathname.startsWith('/api') && !url.pathname.startsWith('/runs/')) return serveFile(res, PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (req.method === 'GET' && p[0] === 'runs') return serveFile(res, path.join(DATA, 'runs'), p.slice(1).join('/'));
    if (p[0] !== 'api') return send(res, 404, { error: 'Not found' });

    if (req.method === 'GET' && p[1] === 'checklists') return send(res, 200, templates());
    if (req.method === 'GET' && p[1] === 'config') { const a = agency(); return send(res, 200, { adminEmail: a.adminEmail || '', configured: a._source === 'agency.json' }); }
    if (req.method === 'GET' && p[1] === 'sites' && !p[2]) return send(res, 200, listSites());
    if (req.method === 'POST' && p[1] === 'sites' && !p[2]) return send(res, 200, await saveSite(await body(req)));

    const site = p[2] && getSite(p[2]);
    if (p[1] === 'sites' && p[2] && !site) return send(res, 404, { error: 'Unknown site.' });
    if (req.method === 'GET' && p[1] === 'sites' && !p[3]) {
      const active = [...runs.values()].filter(r => r.siteId === site.id && !r.done).map(r => ({ id: r.id, tab: r.tab, kind: r.kind, progress: r.progress }));
      return send(res, 200, { site, state: getState(site.id), active });
    }
    if (req.method === 'DELETE' && p[1] === 'sites' && !p[3]) { deleteSite(site.id); return send(res, 200, { ok: true }); }
    if (req.method === 'PUT' && p[3] === 'items' && TABS.includes(p[4]) && p[5]) return send(res, 200, setItem(site.id, p[4], p[5], await body(req)).tabs[p[4]].items[p[5]]);
    if (req.method === 'POST' && p[3] === 'run' && JOB_TABS.includes(p[4])) { const r = startJob(site, p[4], 'check'); return send(res, 200, { runId: r.id }); }
    if (req.method === 'GET' && p[3] === 'live-check') return send(res, 200, await liveChecks(site));
    if (req.method === 'POST' && p[3] === 'confirm-live') { const b = await body(req); if (b.confirm !== true) return send(res, 400, { error: 'Confirm the live site first.' }); return send(res, 200, await confirmLive(site)); }
    if (req.method === 'PUT' && p[3] === 'urls' && p[4]) return send(res, 200, setUrlRow(site.id, p[4], await body(req)));
    if (req.method === 'GET' && p[3] === 'fix' && p[4] === URLS_TAB && p[5] === 'plan') { const pl = planRedirects(site.id); return send(res, 200, { install: site.install, url: site.url, todo: pl.todo, skipped: pl.skipped.map(r => ({ page: r.page, from: r.oldPath, why: r.why })) }); }
    if (req.method === 'POST' && p[3] === 'fix' && p[4] === URLS_TAB) { const b = await body(req); if (b.confirm !== true) return send(res, 400, { error: 'Confirm the redirects first.' }); const r = startJob(site, URLS_TAB, 'fix'); return send(res, 200, { runId: r.id }); }
    if (req.method === 'GET' && p[3] === 'fix' && TABS.includes(p[4]) && p[5] === 'plan') {
      const plan = planFixes(templates()[p[4]], getState(site.id).tabs[p[4]] || { items: {} }, site);
      const strip = x => ({ id: x.id, title: x.title, action: x.action, reason: x.reason, note: x.item.note || '' });
      return send(res, 200, { install: site.install, url: site.url, auto: plan.auto.map(strip), manual: plan.manual.map(strip), backupPlugins: plan.auto.some(a => a.check === 'wp.plugins'), ...(st => ({ claudeAvailable: st.ok, claudeReason: st.reason || null }))(plan.manual.length ? claudeStatus() : { ok: false }) });
    }
    if (req.method === 'POST' && p[3] === 'fix' && TABS.includes(p[4])) { const b = await body(req); if (b.confirm !== true) return send(res, 400, { error: 'Confirm the fix run first.' }); const r = startJob(site, p[4], 'fix', { claude: b.claude === true }); return send(res, 200, { runId: r.id }); }
    if (req.method === 'GET' && p[3] === 'fix-request' && p[4]) { const f = path.join(runDir(site.id, p[4]), 'fix-request.md'); return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f, 'utf8'), TYPES['.md']) : send(res, 404, { error: 'No fix request for that run.' }); }
    if (req.method === 'GET' && p[3] === 'report' && TABS.includes(p[4])) return send(res, 200, report(site, p[4], templates()[p[4]], getState(site.id)), TYPES['.md']);

    if (req.method === 'GET' && p[1] === 'runs' && p[3] === 'events') {
      const run = runs.get(p[2]);
      if (!run) return send(res, 404, { error: 'Run not found (it may have finished a while ago).' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      for (const l of run.log) res.write(`event: log\ndata: ${JSON.stringify(l)}\n\n`);
      res.write(`event: progress\ndata: ${run.progress}\n\n`);
      if (run.done) { res.write(run.error ? `event: failed\ndata: ${JSON.stringify({ error: run.error })}\n\n` : `event: done\ndata: ${JSON.stringify(run.result)}\n\n`); return res.end(); }
      run.listeners.add(res); req.on('close', () => run.listeners.delete(res));
      return;
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`WPE QA Checklist → http://localhost:${PORT}`));
