// Page discovery and one browser snapshot per page, shared by every check in a run.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0 Safari/537.36 wpe-qa-checklist';
const ASSET_RE = /\.(jpe?g|png|gif|webp|avif|svg|pdf|zip|docx?|xlsx?|mp4|mov|mp3|woff2?)(\?|#|$)/i;
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

export const chromePath = () => CHROME_PATHS.find(p => fs.existsSync(p));
export const isAsset = u => ASSET_RE.test(u);

export async function fetchText(url, { method = 'GET', redirect = 'follow', timeoutMs = 25000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, redirect, signal: ctl.signal, headers: { 'user-agent': UA } });
    const text = method === 'HEAD' || redirect === 'manual' ? '' : await r.text();
    return { ok: true, status: r.status, url: r.url, headers: Object.fromEntries(r.headers), text };
  } catch (e) {
    return { ok: false, status: 0, url, headers: {}, text: '', error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(t); }
}

export async function discoverUrls(base, max = 80) {
  const origin = new URL(base).origin;
  const locs = async u => [...(await fetchText(u)).text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1].replace(/&amp;/g, '&'));
  let found = [];
  for (const path of ['/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap.xml']) {
    const top = await locs(origin + path);
    if (!top.length) continue;
    for (const l of top) {
      // Attachment/image sitemaps list one page per media file: not pages anyone links to or needs checked.
      if (/\.xml(\?|$)/.test(l)) { if (!/attachment|image-sitemap|media-sitemap/i.test(l)) found.push(...(await locs(l))); }
      else found.push(l);
    }
    if (found.length) break;
  }
  found = [...new Set(found.filter(u => u.startsWith(origin) && !isAsset(u)))];
  const home = origin + '/';
  if (!found.includes(home)) found.unshift(home);
  if (found.length >= 5) return { urls: found.slice(0, max), total: found.length, fromSitemap: true };
  // No sitemap (normal before launch, when "Discourage search engines" turns WordPress's sitemaps off), or one that
  // lists almost nothing (e.g. pages set to noindex): follow the site's own links two levels deep as well.
  const pages = [...new Set([...found, ...(await followLinks(home, max))])];
  return { urls: pages.slice(0, max), total: pages.length, fromSitemap: found.length > 1, fromLinks: pages.length > found.length };
}

const SKIP_PATH = /\/(wp-admin|wp-login\.php|wp-json|xmlrpc\.php|feed|wp-content|wp-includes)(\/|$)|\/(page|author|tag)\/|[?&](replytocom|s|p|page_id|attachment_id)=/i;
export async function followLinks(home, max) {
  const origin = new URL(home).origin;
  const seen = new Set([home]);
  let level = [home];
  for (let depth = 0; depth < 2 && level.length && seen.size < max; depth++) {
    const next = [];
    for (const url of level) {
      let html = '';
      try { html = (await fetchText(url)).text || ''; } catch { continue; }
      for (const m of html.matchAll(/<a\b[^>]*\shref=["']([^"'#]+)/gi)) {
        let u;
        try { u = new URL(m[1].replace(/&amp;/g, '&'), url); } catch { continue; }
        if (u.origin !== origin || isAsset(u.href) || SKIP_PATH.test(u.pathname + u.search)) continue;
        u.hash = '';
        if (!seen.has(u.href) && seen.size < max) { seen.add(u.href); next.push(u.href); }
      }
    }
    level = next;
  }
  return [...seen];
}

export async function launchBrowser() {
  const executablePath = chromePath();
  if (!executablePath) throw new Error('Google Chrome was not found. Install Chrome or set CHROME_PATH.');
  return puppeteer.launch({ executablePath, headless: 'new', args: ['--no-first-run', '--disable-extensions'] });
}

// Runs fn over items with a small worker pool.
export async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Scroll through the page like a reader, then back to the top, so lazy-loaded images download and
// scripts that speed plugins (Greenlight, WP Rocket…) hold back until the first scroll run too.
async function readThrough(page) {
  await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const step = Math.max(400, innerHeight * 0.9);
    const end = Math.min(document.documentElement.scrollHeight, 30000);
    for (let y = step; y < end; y += step) { scrollTo(0, y); await wait(120); }
    scrollTo(0, 0);
    const pending = [...document.images].filter(i => !i.complete);
    await Promise.race([
      Promise.all(pending.map(i => new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
      wait(4000),
    ]);
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
}

// Desktop snapshot of one page: everything the content/link/SEO checks read.
export async function snapshot(browser, url) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => consoleErrors.push(String(e.message).slice(0, 200)));
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1440, height: 900 });
  let status = 0;
  const failed = []; // assets that answered 4xx/5xx (build tool asset paths)
  page.on('response', r => { if (r.status() >= 400 && r.url() !== url) failed.push({ url: r.url(), status: r.status(), type: r.request().resourceType() }); });
  try {
    const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    status = res ? res.status() : 0;
    await readThrough(page);
    const data = await page.evaluate(SNAPSHOT_JS);
    return { url, status, consoleErrors, failed, ...data };
  } catch (e) {
    return { url, status, consoleErrors, error: e.message.slice(0, 200) };
  } finally {
    await ctx.close();
  }
}

// Phone snapshot: layout fit, menu button, tap targets, bottom bar.
export async function mobileSnapshot(browser, url, { tryMenu = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setUserAgent(UA.replace('Macintosh; Intel Mac OS X 10_15_7', 'Linux; Android 14; Pixel 8') + ' Mobile');
  await page.setViewport({ width: 375, height: 667, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    const data = await page.evaluate(MOBILE_JS);
    if (tryMenu && data.menuButton) {
      try {
        await page.click(data.menuButton.selector);
        await new Promise(r => setTimeout(r, 700));
        data.menuOpened = await page.evaluate(() => {
          const links = [...document.querySelectorAll('nav a, [class*="menu"] a')].filter(a => { const r = a.getBoundingClientRect(); const c = getComputedStyle(a); return r.width > 0 && r.height > 0 && r.top < innerHeight && c.visibility !== 'hidden' && +c.opacity > 0.1; });
          return links.length;
        });
        data.menuParents = await page.evaluate(() => [...document.querySelectorAll('nav li, [class*="menu"] li')].filter(li => li.querySelector('ul, [class*="sub-menu"], [class*="submenu"], [class*="dropdown"]') && li.getBoundingClientRect().height > 0).map(li => {
          const a = li.querySelector('a'); const href = a ? (a.getAttribute('href') || '') : '';
          return { text: (a ? a.textContent : li.textContent).trim().split('\n')[0].trim().slice(0, 40), link: !!a && href !== '' && href !== '#' && !/^javascript:/i.test(href) };
        }).filter((x, i, all) => x.text && all.findIndex(y => y.text === x.text) === i));
        await page.click(data.menuButton.selector).catch(() => {});
      } catch (e) { data.menuError = e.message.slice(0, 120); }
    }
    return { url, ...data };
  } catch (e) {
    return { url, error: e.message.slice(0, 200) };
  } finally {
    await ctx.close();
  }
}

const SNAPSHOT_JS = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none'; };
  const inside = (el, sel) => !!el.closest(sel);
  const links = [...document.querySelectorAll('a')].map(a => ({
    href: a.getAttribute('href'), abs: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
    nav: inside(a, 'nav, header, [role=navigation]'), footer: inside(a, 'footer'), main: inside(a, 'main, article, .entry-content'),
  }));
  const main = document.querySelector('main') || document.body;
  const images = [...document.querySelectorAll('img')].map(i => ({
    src: i.currentSrc || i.getAttribute('src') || i.getAttribute('data-lazy-src') || '', alt: i.getAttribute('alt'),
    decorative: i.getAttribute('alt') === '' || !!i.closest('[aria-hidden="true"]') || i.getAttribute('role') === 'presentation',
    inMain: main.contains(i), w: i.naturalWidth, h: i.naturalHeight, shownW: Math.round(i.getBoundingClientRect().width),
  }));
  const text = (document.body.innerText || '').replace(/[ \\t]+/g, ' ');
  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => { try { return JSON.parse(s.textContent); } catch (e) { return { __error: e.message }; } });
  const meta = n => (document.querySelector('meta[name="' + n + '"], meta[property="' + n + '"]') || {}).content || null;
  const fonts = {};
  for (const el of document.querySelectorAll('h1,h2,h3,h4,p,li,a,button,span,label')) {
    if (!vis(el) || !el.textContent.trim()) continue;
    const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();
    fonts[f] = (fonts[f] || 0) + 1;
  }
  const header = document.querySelector('header, .site-header, [class*="header"]');
  const logo = header && [...header.querySelectorAll('a')].find(a => a.querySelector('img, svg') || /logo|brand/i.test(a.className));
  return {
    title: document.title, lang: document.documentElement.getAttribute('lang'),
    metaDescription: meta('description'), robots: meta('robots'), canonical: (document.querySelector('link[rel=canonical]') || {}).href || null,
    og: { title: meta('og:title'), image: meta('og:image'), type: meta('og:type'), twitter: meta('twitter:card') },
    icon: !!document.querySelector('link[rel~="icon"]'),
    headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(vis).map(h => ({ level: +h.tagName[1], text: h.innerText.trim().replace(/\\s+/g, ' ').slice(0, 120) })),
    links, images, jsonld,
    text: text.slice(0, 40000),
    // Includes scripts a speed plugin is still holding back (their address moves to a data- attribute).
    scripts: [...document.querySelectorAll('script[src], script[data-greenlight-src], script[data-rocket-src]')].map(s => s.src || s.getAttribute('data-greenlight-src') || s.getAttribute('data-rocket-src')),
    styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href),
    inlineScripts: [...document.querySelectorAll('script:not([src])')].map(s => s.textContent.slice(0, 400)),
    siteVerification: meta('google-site-verification'),
    bodyStyleBlocks: [...document.querySelectorAll('body style')].length,
    viewport: meta('viewport'),
    searchForm: !!document.querySelector('form[role=search], input[type=search], input[name="s"]'),
    // Forms and their fields (never submitted): names, labels, types, required markers.
    forms2: [...document.querySelectorAll('form')].filter(vis).map(f => {
      const skip = ['hidden', 'submit', 'button', 'image', 'reset'];
      const fields = [...f.querySelectorAll('input, select, textarea')].filter(el => !skip.includes((el.getAttribute('type') || '').toLowerCase()) && vis(el));
      const labelled = el => !!((el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label') || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title'));
      return { plugin: (String(f.className).match(/wpcf7|gform|wpforms|elementor|fluentform|frm_|nf-form/) || [''])[0], submit: !!f.querySelector('button, input[type=submit]'),
        fields: fields.map(el => ({ type: (el.getAttribute('type') || el.tagName).toLowerCase(), name: el.getAttribute('name') || '', label: labelled(el), placeholder: el.getAttribute('placeholder') || '',
          required: el.required || el.getAttribute('aria-required') === 'true' || / wpcf7-validates-as-required| gfield_contains_required/.test(' ' + el.className), auto: el.getAttribute('autocomplete') || '' })) };
    }),
    // Links inside body text that look exactly like the text around them (same color, no underline, same weight).
    linkColors: (() => { const rows = []; for (const a of document.querySelectorAll('p a, li a, td a')) { if (!vis(a) || a.closest('nav, header, footer, [role=navigation], [class*=breadcrumb], [aria-label*=readcrumb]') || !a.textContent.trim()) continue; const p = a.parentElement.closest('p, li, td') || a.parentElement; if (p.textContent.trim().length - a.textContent.trim().length < 4 || p.querySelector('[aria-current=page], .breadcrumb_last, [class*=breadcrumb]')) continue; /* a link that is the whole item (breadcrumbs, link lists) is not a link inside text */ const ca = getComputedStyle(a), cp = getComputedStyle(p); const deco = (ca.textDecorationLine || '').indexOf('underline') !== -1 || (ca.borderBottomStyle !== 'none' && parseFloat(ca.borderBottomWidth) > 0); rows.push({ text: a.textContent.trim().slice(0, 40), plain: ca.color === cp.color && !deco && ca.fontWeight === cp.fontWeight }); } return { total: rows.length, plain: rows.filter(r => r.plain).map(r => r.text).slice(0, 10) }; })(),
    // WCAG contrast of text on a solid background (text over images or translucent layers is skipped, not guessed).
    contrast: (() => {
      const parse = c => { const m = String(c).match(/rgba?[(]([^)]+)[)]/); if (!m) return null; const v = m[1].split(',').map(x => parseFloat(x)); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
      const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const bgOf = el => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const st = getComputedStyle(e); if (st.backgroundImage && st.backgroundImage !== 'none') return null; const c = parse(st.backgroundColor); if (c && c.a > 0) return c.a >= 0.99 ? c : null; } return { r: 255, g: 255, b: 255, a: 1 }; };
      const fails = []; let checked = 0;
      for (const el of document.querySelectorAll('p, li, a, span, h1, h2, h3, h4, h5, h6, button, label, td, small, strong, em, figcaption, blockquote')) {
        if (checked > 600 || fails.length >= 25) break;
        if (!vis(el) || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
        const st = getComputedStyle(el); if (parseFloat(st.opacity) < 1) continue;
        const fg = parse(st.color); if (!fg || fg.a < 0.99) continue;
        const r = el.getBoundingClientRect(); let overImg = false;
        for (let e = el.parentElement, i = 0; e && i < 6 && !overImg; e = e.parentElement, i++) for (const m of e.querySelectorAll('img, video, picture, canvas')) { const q = m.getBoundingClientRect(); if (!el.contains(m) && q.width > 50 && q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top) { overImg = true; break; } }
        if (overImg) continue;
        const bg = bgOf(el); if (!bg) continue; checked++;
        const a = lum(fg), b = lum(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const size = parseFloat(st.fontSize), large = size >= 24 || (parseInt(st.fontWeight, 10) >= 700 && size >= 18.66), symbols = !/[A-Za-z0-9]/.test(el.textContent), need = large || symbols ? 3 : 4.5; /* symbols like ★ are graphics: 3:1 */
        if (ratio < need) fails.push({ text: el.textContent.trim().split(' ').filter(Boolean).join(' ').slice(0, 50), ratio: Math.round(ratio * 100) / 100, need, fg: st.color, bg: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')' });
      }
      return { checked, fails };
    })(),
    // Every class used in the page that no CSS rule mentions (Tailwind classes purged by the build), and which
    // stylesheets carry Tailwind (--tw- custom properties), in load order.
    tw: (() => {
      const known = new Set(); const sheets = []; const blocked = [];
      const walk = (rules, info) => { for (const r of rules) { if (r.cssRules) walk(r.cssRules, info); if (r.selectorText) for (const m of r.selectorText.matchAll(/\\.((?:\\\\.|[\\w-])+)/g)) known.add(m[1].replace(/\\\\(.)/g, '$1')); if (!info.tw && r.cssText && r.cssText.indexOf('--tw-') !== -1) info.tw = true; } };
      for (const sh of document.styleSheets) { const info = { href: sh.href || 'inline', tw: false }; try { walk(sh.cssRules, info); } catch (e) { blocked.push(info.href); } sheets.push(info); }
      const missing = new Set(); for (const el of document.body.querySelectorAll('[class]')) for (const c of el.classList) if (!known.has(c)) missing.add(c);
      return { tw: sheets.some(x => x.tw), sheets, blocked, missing: [...missing].slice(0, 400) };
    })(),
    domNodes: document.getElementsByTagName('*').length,
    fonts,
    logoHref: logo ? logo.href : null,
    forms: document.querySelectorAll('form').length,
  };
})()`;

const MOBILE_JS = `(() => {
  const W = innerWidth;
  const overflow = document.documentElement.scrollWidth > W + 1;
  const cand = [...document.querySelectorAll('button, a, [role=button]')].filter(b => {
    const r = b.getBoundingClientRect(); if (!r.width || r.top > 140) return false;
    const s = (b.className + ' ' + (b.getAttribute('aria-label') || '') + ' ' + b.id).toLowerCase();
    return /burger|menu|nav-toggle|navbar-toggler|toggle/.test(s) || b.hasAttribute('aria-expanded');
  });
  let menuButton = null;
  if (cand.length) {
    const b = cand[0], r = b.getBoundingClientRect();
    b.setAttribute('data-wpeqa-menu', '1');
    menuButton = { selector: '[data-wpeqa-menu="1"]', w: Math.round(r.width), h: Math.round(r.height), label: (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 40), icon: !!b.querySelector('svg, img, i, span') || /☰|≡/.test(b.textContent) };
  }
  const small = [...document.querySelectorAll('a, button, input, select, textarea, [role=button]')].filter(el => {
    const r = el.getBoundingClientRect(); const c = getComputedStyle(el);
    if (!r.width || !r.height || c.visibility === 'hidden' || r.bottom < 0 || r.top > innerHeight * 3) return false;
    if (el.closest('p, li') && c.display === 'inline') return false; // inline text links are exempt in WCAG 2.5.8
    return r.width < 24 || r.height < 24;
  }).slice(0, 12).map(el => ({ text: (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 40), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }));
  const fixedBottom = [...document.querySelectorAll('body *')].filter(el => { const c = getComputedStyle(el); if (c.position !== 'fixed' && c.position !== 'sticky') return false; const r = el.getBoundingClientRect(); return r.height > 30 && r.bottom >= innerHeight - 2 && r.width > W * 0.6; });
  const bottomBar = fixedBottom.length ? { tel: !!fixedBottom.find(el => el.querySelector('a[href^="tel:"], button')), text: fixedBottom[0].innerText.trim().replace(/\\s+/g, ' ').slice(0, 80) } : null;
  const header = document.querySelector('header, .site-header, [class*="header"]');
  const navHeight = header ? Math.round(header.getBoundingClientRect().height) : null;
  return { width: W, overflow, scrollWidth: document.documentElement.scrollWidth, menuButton, smallTargets: small, bottomBar, navHeight };
})()`;

// Keyboard: press Tab through the page, recording what gets focus and whether a focus ring shows.
export async function focusWalk(browser, url, steps = 40) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    const interactive = await page.evaluate(() => [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && !el.disabled; }).length);
    const seen = []; let stuck = 0;
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(i => {
        const el = document.activeElement; if (!el || el === document.body) return null;
        const key = el.getAttribute('data-wpeqa-f') || String(i); el.setAttribute('data-wpeqa-f', key);
        const st = getComputedStyle(el); const r = el.getBoundingClientRect();
        return { key, text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('name') || el.tagName).trim().split('\n')[0].slice(0, 40), visible: r.width > 0 && r.height > 0,
          on: [st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0 ? st.outlineColor + st.outlineWidth : '', st.boxShadow, st.borderColor, st.backgroundColor, st.textDecorationLine, st.color].join('|') };
      }, i);
      if (!f) { stuck++; if (stuck > 2) break; continue; }
      if (seen.length && seen[seen.length - 1].key === f.key) { stuck++; if (stuck > 2) break; continue; }
      stuck = 0;
      // The same element's look when it does not have focus, to see whether focus changes anything.
      f.off = await page.evaluate(k => { const el = document.querySelector('[data-wpeqa-f="' + k + '"]'); const clone = el.cloneNode(true); clone.removeAttribute('data-wpeqa-f'); el.parentNode.insertBefore(clone, el); const st = getComputedStyle(clone); const v = [st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0 ? st.outlineColor + st.outlineWidth : '', st.boxShadow, st.borderColor, st.backgroundColor, st.textDecorationLine, st.color].join('|'); clone.remove(); return v; }, f.key);
      seen.push(f);
      if (seen.filter(x => x.key === f.key).length > 1) break; // came back round
    }
    return { interactive, reached: new Set(seen.map(x => x.key)).size, stuck: stuck > 2 && seen.length < 3, noRing: seen.filter(x => x.visible && x.on === x.off).map(x => x.text) };
  } catch (e) {
    return { error: e.message.slice(0, 200) };
  } finally { await ctx.close(); }
}

// Is the header still on screen after scrolling? (sticky or fixed header)
export async function stickyHeader(browser, url, mobile = false) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(mobile ? { width: 375, height: 667, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.evaluate(() => scrollTo(0, 1200));
    await new Promise(r => setTimeout(r, 600));
    return await page.evaluate(() => {
      const cands = [...document.querySelectorAll('header, .site-header, [class*="header"], nav')];
      return cands.some(el => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return r.height > 20 && r.top <= 2 && r.bottom > 10 && (c.position === 'fixed' || c.position === 'sticky' || el.closest('[style*="fixed"]')); })
        || cands.some(el => { let x = el; while (x && x !== document.body) { const c = getComputedStyle(x); if ((c.position === 'fixed' || c.position === 'sticky') && x.getBoundingClientRect().top <= 2) return true; x = x.parentElement; } return false; });
    });
  } finally { await ctx.close(); }
}

// Cookies and tracker requests before the visitor accepts cookies (consent check). Checked twice:
// on load, and after the visitor scrolls and moves the mouse WITHOUT touching the banner, because
// speed plugins hold trackers back until the first interaction, and that is not consent.
export async function cookiesBeforeConsent(browser, url) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  const trackers = [];
  page.on('request', r => { if (/googletagmanager|google-analytics|analytics\.google|facebook\.net|connect\.facebook|hotjar|clarity\.ms|doubleclick|bat\.bing/.test(r.url())) trackers.push(new URL(r.url()).hostname); });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await wait(3000);
    const onLoad = new Set(trackers);
    // Scroll and move the mouse in the page's upper middle: no clicks, so no banner button is pressed.
    await page.mouse.move(683, 260); await page.mouse.move(720, 300, { steps: 5 });
    await page.mouse.wheel({ deltaY: 700 }); await wait(400); await page.mouse.wheel({ deltaY: -700 });
    await wait(5000);
    const afterScroll = [...new Set(trackers)].filter(t => !onLoad.has(t));
    const cookies = (await page.cookies()).map(c => c.name);
    const banner = await page.evaluate(() => [...document.querySelectorAll('body *')].some(el => { const c = getComputedStyle(el); const r = el.getBoundingClientRect(); return (c.position === 'fixed' || c.position === 'sticky') && r.height > 30 && /cookie|consent|privacy/i.test(el.innerText || '') && c.visibility !== 'hidden' && +c.opacity > 0.1; }));
    return { cookies, trackers: [...new Set(trackers)], afterScroll, banner };
  } finally { await ctx.close(); }
}
