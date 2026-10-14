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
      if (/\.xml(\?|$)/.test(l)) found.push(...(await locs(l)));
      else found.push(l);
    }
    if (found.length) break;
  }
  found = [...new Set(found.filter(u => u.startsWith(origin) && !isAsset(u)))];
  const home = origin + '/';
  if (!found.includes(home)) found.unshift(home);
  return { urls: found.slice(0, max), total: found.length, fromSitemap: found.length > 1 };
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
  try {
    const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    status = res ? res.status() : 0;
    await readThrough(page);
    const data = await page.evaluate(SNAPSHOT_JS);
    return { url, status, consoleErrors, ...data };
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
    menuButton = { selector: '[data-wpeqa-menu="1"]', w: Math.round(r.width), h: Math.round(r.height), label: (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 40) };
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
