// Runs one tab's automatic checks for one site and returns { itemId: result }.
// Data sources (WordPress facts, sitemap crawl, phone crawl, link check, Lighthouse) are loaded
// at most once per run and shared by every check that needs them.
import fs from 'node:fs';
import path from 'node:path';
import { siteFacts } from './wpe.mjs';
import { readGreenlight, greenlightLine, glSummary } from './greenlight.mjs';
import { discoverUrls, launchBrowser, snapshot, mobileSnapshot, pool, fetchText } from './crawl.mjs';
import { runLighthouse } from './lighthouse.mjs';
import { ALL_CHECKS } from './checks.mjs';
import { suggestionFor, GREENLIGHT_LINKED } from './suggest.mjs';
import { targetsFor, capture } from './evidence.mjs';

const memo = fn => { let p; return (...a) => (p ||= fn(...a)); };
const memoBy = fn => { const m = new Map(); return (arg = {}) => { const k = JSON.stringify(arg); if (!m.has(k)) m.set(k, fn(arg)); return m.get(k); }; };
const words = t => new Set((t || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(w => w.length > 3));

export async function runTab({ site, template, runId, dir, log, progress }) {
  fs.mkdirSync(dir, { recursive: true });
  let browser = null;
  const ctx = { site, home: site.url.replace(/\/$/, ''), runUrl: f => `/runs/${site.id}/${runId}/${f}` };

  ctx.facts = memo(async () => { if (!site.install) throw new Error('No WP Engine install name for this site, so WordPress settings can\'t be read. Add it in Site settings.'); log(`Reading WordPress settings over SSH (${site.install})…`); const f = await siteFacts(site.install); log(`WordPress ${f.wp_version}, PHP ${f.php_version}, theme ${f.theme.name}, ${f.plugins.length} plugins.`); return f; });
  ctx.greenlight = memo(async () => { if (!site.install) throw new Error('No WP Engine install name for this site, so Greenlight can\'t be read. Add it in Site settings.'); log(`Reading Greenlight's security status over SSH (${site.install})…`); const g = await readGreenlight(site.install); log(greenlightLine(glSummary(g))); return g; });
  ctx.browser = memo(async () => (browser = await launchBrowser()));
  ctx.discovery = memo(async () => { const d = await discoverUrls(ctx.home, site.maxPages); log(`Found ${d.total} URLs${d.fromSitemap ? ' in the sitemap' : d.fromLinks ? ' by following the site\'s links (no sitemap)' : ''}; checking ${d.urls.length}.`); return d; });
  ctx.pages = memo(async () => {
    const { urls } = await ctx.discovery(); const b = await ctx.browser(); let n = 0;
    return pool(urls, 4, async u => { const s = await snapshot(b, u); n++; if (n % 5 === 0 || n === urls.length) { log(`Desktop pass: ${n}/${urls.length} pages`); progress(0.15 + 0.4 * n / urls.length); } return s; });
  });
  ctx.homeSnap = memo(async () => { const pages = await ctx.pages(); return pages.find(p => p.url.replace(/\/$/, '') === ctx.home) || pages[0]; });
  ctx.mobilePages = memo(async () => {
    const { urls } = await ctx.discovery(); const b = await ctx.browser(); let n = 0;
    return pool(urls, 4, async u => { const s = await mobileSnapshot(b, u); n++; if (n % 5 === 0 || n === urls.length) { log(`Phone pass: ${n}/${urls.length} pages`); progress(0.55 + 0.25 * n / urls.length); } return s; });
  });
  ctx.homeMobile = memoBy(async opts => mobileSnapshot(await ctx.browser(), ctx.home + '/', opts));
  ctx.linkCheck = memo(async () => {
    const pages = await ctx.pages(); const targets = new Map();
    for (const p of pages) for (const l of p.links || []) {
      if (!l.abs || !/^https?:/.test(l.abs)) continue;
      let u; try { u = new URL(l.abs); } catch { continue; }
      if (u.origin !== new URL(ctx.home).origin || /\.(jpe?g|png|gif|webp|svg|pdf|zip)$/i.test(u.pathname)) continue;
      u.hash = ''; const k = u.href; if (!targets.has(k)) targets.set(k, new Set()); targets.get(k).add(new URL(p.url).pathname);
    }
    // Pages the crawl already loaded keep that status; the rest are fetched gently, because
    // Cloudflare answers 429 (too many requests) to bursts, which is not a broken link.
    const known = new Map(pages.map(p => [p.url.split('#')[0], p.status]));
    const list = [...targets.keys()].slice(0, 500);
    const todo = list.filter(u => !known.has(u) || !known.get(u));
    log(`Checking ${list.length} internal link targets (${list.length - todo.length} already loaded in the crawl)…`);
    const status = new Map(known);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await pool(todo, 2, async u => {
      let r;
      for (const wait of [0, 2000, 6000, 12000]) { if (wait) await sleep(wait); r = await fetchText(u, { method: 'GET' }); if (r.status !== 429) break; }
      status.set(u, r.status || r.error);
    });
    const from = u => `linked from ${[...targets.get(u)].slice(0, 3).join(', ')}`;
    const broken = list.filter(u => { const s = status.get(u); return s !== 429 && (typeof s !== 'number' || s >= 400 || s === 0); }).map(u => `${new URL(u).pathname} → ${status.get(u)} (${from(u)})`);
    const throttled = list.filter(u => status.get(u) === 429).map(u => `${new URL(u).pathname} → 429, could not verify (${from(u)})`);
    return { checked: list.length, broken, throttled };
  });
  ctx.swarmScores = memo(async () => {
    const [pages, mobile, links] = [await ctx.pages(), await ctx.mobilePages(), await ctx.linkCheck()];
    const brokenPaths = links.broken.map(b => b.split(' → ')[0]);
    const homeM = mobile.find(m => m.url.replace(/\/$/, '') === ctx.home) || mobile[0];
    const rows = pages.map((p, i) => {
      const m = mobile[i] || {}; const issues = [];
      if (!p.title) issues.push('no title');
      const h1 = (p.headings || []).filter(h => h.level === 1).length; if (h1 !== 1) issues.push(`${h1} H1s`);
      if (!p.lang) issues.push('no lang');
      if ((p.images || []).some(im => im.inMain && !im.decorative && !im.alt)) issues.push('image without alt');
      if (!p.metaDescription) issues.push('no meta description');
      if ((p.consoleErrors || []).length) issues.push('console errors');
      const own = (p.links || []).filter(l => l.abs && l.abs.startsWith(ctx.home));
      const bad = own.filter(l => brokenPaths.includes(new URL(l.abs).pathname)).length;
      const hb = homeM?.menuButton; const hbScore = !hb ? 0 : hb.w >= 44 && hb.h >= 44 ? 100 : 50;
      const dims = [p.status === 200 ? 100 : 0, own.length ? 100 * (1 - bad / own.length) : 100, ((m.overflow ? 0 : 100) + hbScore) / 2, 100 * (1 - issues.length / 6)];
      return { path: new URL(p.url).pathname, score: dims.reduce((a, b) => a + b, 0) / dims.length, a11yIssues: issues, overflow: !!m.overflow };
    });
    return { pages: rows, site: rows.reduce((a, r) => a + r.score, 0) / (rows.length || 1), menuButton: homeM?.menuButton };
  });
  ctx.screenshots = memo(async () => {
    const { urls } = await ctx.discovery(); const b = await ctx.browser(); const shotDir = path.join(dir, 'shots'); fs.mkdirSync(shotDir, { recursive: true });
    const out = []; let n = 0; const list = urls.slice(0, 40);
    await pool(list, 3, async (u, i) => {
      for (const [kind, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
        const c = await b.createBrowserContext(); const pg = await c.newPage(); await pg.setViewport(vp);
        try { await pg.goto(u, { waitUntil: 'networkidle2', timeout: 45000 }); await pg.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 700) { scrollTo(0, y); await new Promise(r => setTimeout(r, 80)); } scrollTo(0, 0); }); const f = `${String(i).padStart(3, '0')}-${kind}.jpg`; await pg.screenshot({ path: path.join(shotDir, f), type: 'jpeg', quality: 60, fullPage: kind === 'phone' ? false : false }); out.push({ url: u, kind, file: 'shots/' + f }); } catch { /* page failed; reported by swarm.http */ } finally { await c.close(); }
      }
      n++; if (n % 5 === 0 || n === list.length) log(`Screenshots: ${n}/${list.length} pages`);
    });
    out.sort((a, b) => a.file.localeCompare(b.file));
    const html = `<!doctype html><meta charset="utf-8"><title>Screenshots</title><style>body{font:14px system-ui;margin:24px;background:#f4f5f7}figure{display:inline-block;margin:0 16px 24px 0;vertical-align:top;background:#fff;padding:8px;border-radius:8px}img{display:block;max-height:420px;border:1px solid #ddd}figcaption{margin-top:6px;color:#555}</style>${out.map(s => `<figure><a href="${s.file}"><img src="${s.file}" loading="lazy" alt=""></a><figcaption>${new URL(s.url).pathname} · ${s.kind}</figcaption></figure>`).join('')}`;
    fs.writeFileSync(path.join(dir, 'shots.html'), html);
    return out;
  });
  ctx.referencePairs = memo(async () => {
    if (!site.referenceUrl) return [];
    const pages = await ctx.pages(); const out = [];
    await pool(pages.slice(0, 60), 4, async p => {
      const pth = new URL(p.url).pathname; const r = await fetchText(site.referenceUrl + pth);
      if (r.status !== 200 || !r.text) return;
      const oldWords = words(r.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')); const now = words(p.text);
      if (oldWords.size < 30) return;
      let hit = 0; for (const w of oldWords) if (now.has(w)) hit++;
      out.push({ path: pth, text: hit / oldWords.size });
    });
    log(`Compared ${out.length} pages with ${site.referenceUrl}.`);
    return out;
  });
  ctx.lighthouse = memo(async () => { log('Running Lighthouse on the homepage (phone, then desktop)…'); const r = await runLighthouse(ctx.home + '/', dir); log(`Lighthouse phone ${r.mobile.score ?? '—'}, desktop ${r.desktop.score ?? '—'}.`); return r; });

  const t0 = Date.now(); const results = {}; let facts = null;
  try {
    progress(0.02);
    const landing = await fetchText(ctx.home + '/');
    if (landing.ok && new URL(landing.url).origin !== new URL(ctx.home).origin) { log(`${ctx.home} redirects to ${new URL(landing.url).origin}; auditing that.`); ctx.home = new URL(landing.url).origin; }
    else if (!landing.ok || landing.status >= 400) log(`Warning: ${ctx.home} answered ${landing.status || landing.error}.`);
    log(`Auditing ${ctx.home}`);
    try {
      facts = await ctx.facts();
      if (new URL(facts.home).hostname !== new URL(ctx.home).hostname) log(`Note: WordPress's own address is ${facts.home}; pages are checked at ${ctx.home} as entered.`);
    } catch (e) { log(`WordPress checks skipped: ${e.message}`); }
    progress(0.12);
    const tailwind = () => !facts || !!(facts.theme_build && (facts.theme_build.tailwind_version || facts.theme_build.css || facts.theme_build.configs?.some(c => /tailwind/.test(c))));
    const applies = sec => !sec.appliesIf || (sec.appliesIf === 'elementor' ? !!facts?.elementor : sec.appliesIf === 'yootheme' ? !!facts?.yootheme : sec.appliesIf === 'tailwind' ? tailwind() : sec.appliesIf === 'reference' ? !!site.referenceUrl : true);
    const cache = {};
    const items = template.sections.flatMap(s => s.items.map(it => ({ ...it, section: s })));
    const auto = items.filter(it => it.check || !applies(it.section));
    let done = 0;
    for (const it of auto) {
      if (!applies(it.section)) { const why = { elementor: 'Elementor is not active on this site.', yootheme: 'The site does not use YOOtheme.', tailwind: 'The theme is not a Tailwind build.', reference: 'No reference (old) site URL is set.' }[it.section.appliesIf]; results[it.id] = { status: 'na', summary: why }; continue; }
      const fn = ALL_CHECKS[it.check];
      if (!fn) { results[it.id] = { status: 'warn', summary: `No automatic check named ${it.check}.` }; continue; }
      try {
        cache[it.check] ||= fn(ctx); results[it.id] = { ...(await cache[it.check]) };
        // Checks a Greenlight feature can fix: name that feature (and whether it's on) in the suggestion.
        const gl = GREENLIGHT_LINKED.includes(it.check) && ['fail', 'warn'].includes(results[it.id].status) && site.install ? await ctx.greenlight().catch(() => null) : null;
        const sg = suggestionFor(it.check, results[it.id], gl); if (sg) results[it.id].suggestion = sg;
      }
      catch (e) { results[it.id] = { status: 'warn', summary: `The check could not run: ${e.message}` }; }
      done++; progress(0.8 + 0.18 * done / auto.length);
      log(`${it.title}: ${results[it.id].status.toUpperCase()}`);
    }
    // Screenshots of where each failed or flagged item's problem is on the page.
    const flagged = [...new Set(auto.filter(it => it.check && ['fail', 'warn'].includes(results[it.id]?.status)).map(it => it.check))];
    if (flagged.length) {
      const evDir = path.join(dir, 'evidence'); fs.mkdirSync(evDir, { recursive: true });
      let shots = 0;
      for (const check of flagged) {
        const first = auto.find(it => it.check === check && results[it.id]);
        let targets = []; try { targets = await targetsFor(check, results[first.id], ctx); } catch { /* no evidence for this one */ }
        if (!targets.length) continue;
        const list = await capture(await ctx.browser(), targets, evDir, check.replace(/[^a-z0-9]+/gi, '-'), ctx.runUrl);
        if (!list.length) continue;
        shots += list.length;
        for (const it of auto) if (it.check === check && results[it.id]) results[it.id].shots = list;
      }
      if (shots) log(`Saved ${shots} screenshots of flagged items.`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  const counts = Object.values(results).reduce((c, r) => (c[r.status] = (c[r.status] || 0) + 1, c), {});
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ site, home: ctx.home, results }, null, 1));
  return { results, home: ctx.home, durationMs: Date.now() - t0, counts };
}
