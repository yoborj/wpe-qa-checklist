#!/usr/bin/env node
// WPE QA Checklist: a local web app. Listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, TABS, templates, listSites, getSite, saveSite, deleteSite, getState, setItem, applyRun, runDir } from './lib/store.mjs';
import { runTab } from './lib/run.mjs';
import { report } from './lib/report.mjs';

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

function startRun(site, tab) {
  for (const r of runs.values()) if (r.siteId === site.id && !r.done) throw new Error(`A ${r.tab} run is already going for this site. Wait for it to finish.`);
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + tab;
  const run = { id, siteId: site.id, tab, log: [], listeners: new Set(), done: false, progress: 0, startedAt: new Date().toISOString() };
  runs.set(id, run);
  const dir = runDir(site.id, id);
  fs.mkdirSync(dir, { recursive: true });
  const log = line => { const l = `${new Date().toLocaleTimeString()}  ${line}`; run.log.push(l); fs.appendFileSync(path.join(dir, 'log.txt'), l + '\n'); emit(run, 'log', l); };
  const progress = p => { run.progress = Math.max(run.progress, Math.min(1, p)); emit(run, 'progress', run.progress); };
  log(`Run Tool: ${templates()[tab].title} for ${site.name} (${site.url}${site.install ? `, WP Engine install ${site.install}` : ', no WP Engine install'})`);
  runTab({ site, template: templates()[tab], runId: id, dir, log, progress })
    .then(r => {
      const meta = { id, startedAt: run.startedAt, finishedAt: new Date().toISOString(), durationMs: r.durationMs, counts: r.counts, home: r.home };
      applyRun(site.id, tab, meta, r.results);
      log(`Done in ${Math.round(r.durationMs / 1000)} s: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
      run.done = true; run.result = meta; emit(run, 'done', meta);
    })
    .catch(e => { log(`Run failed: ${e.message}`); run.done = true; run.error = e.message; emit(run, 'failed', { error: e.message }); })
    .finally(() => { for (const l of run.listeners) l.end(); run.listeners.clear(); setTimeout(() => runs.delete(id), 30 * 60 * 1000); });
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
    if (req.method === 'GET' && p[1] === 'sites' && !p[2]) return send(res, 200, listSites());
    if (req.method === 'POST' && p[1] === 'sites' && !p[2]) return send(res, 200, await saveSite(await body(req)));

    const site = p[2] && getSite(p[2]);
    if (p[1] === 'sites' && p[2] && !site) return send(res, 404, { error: 'Unknown site.' });
    if (req.method === 'GET' && p[1] === 'sites' && !p[3]) {
      const active = [...runs.values()].filter(r => r.siteId === site.id && !r.done).map(r => ({ id: r.id, tab: r.tab, progress: r.progress }));
      return send(res, 200, { site, state: getState(site.id), active });
    }
    if (req.method === 'DELETE' && p[1] === 'sites' && !p[3]) { deleteSite(site.id); return send(res, 200, { ok: true }); }
    if (req.method === 'PUT' && p[3] === 'items' && TABS.includes(p[4]) && p[5]) return send(res, 200, setItem(site.id, p[4], p[5], await body(req)).tabs[p[4]].items[p[5]]);
    if (req.method === 'POST' && p[3] === 'run' && TABS.includes(p[4])) { const r = startRun(site, p[4]); return send(res, 200, { runId: r.id }); }
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
