// Screenshots that show where a failed or flagged item's problem is: the page opened in Chrome, the
// offending element (image, phone number, heading, link, form…) outlined in red and cropped around it.
// Targets come from the check's own details ("/about/: photo.jpg"), so the checks themselves don't change.
import path from 'node:path';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true };
const MAX_PER_CHECK = 3;
const wait = ms => new Promise(r => setTimeout(r, ms));
const pathOf = u => { try { return new URL(u).pathname; } catch { return u; } };
// "/about/: something" → ['/about/', 'something']
const split = d => { const m = String(d).match(/^(\/[^\s:]*):\s*(.*)$/); return m ? [m[1], m[2]] : [null, String(d)]; };
const quoted = s => (String(s).match(/“([^”]+)”/) || [])[1];

// What to show for one check's result: [{ url, img | phone | text | linkText | selector | page, device?, scroll?, label }].
export async function targetsFor(check, r, ctx) {
  const home = ctx.home; const at = p => home + (p.startsWith('/') ? p : '/' + p);
  const det = (r.details || []).map(String); const T = [];
  const each = fn => { for (const d of det) { const [p, rest] = split(d); if (!p) continue; const t = fn(p, rest); if (t) T.push({ url: at(p), ...t }); } };
  const findPage = async needle => (await ctx.pages()).find(pg => (pg.text || '').includes(needle));
  switch (check) {
    case 'crawl.imageAlt': case 'audit.alt': each((p, rest) => ({ img: rest.trim(), label: 'Image without alt text' })); break;
    case 'audit.duplicateImages': each((p, rest) => ({ img: rest.replace(/\s*×\d+\s*$/, '').trim(), label: 'Repeated image' })); break;
    case 'crawl.imageWeight': {
      const pages = await ctx.pages();
      for (const d of det) { const f = d.split(':')[0].trim(); const pg = pages.find(x => (x.images || []).some(i => (i.src || '').includes(f))); if (pg) T.push({ url: pg.url, img: f, label: 'Oversized image' }); }
      break;
    }
    case 'crawl.phonesClickable': each((p, rest) => ({ phone: rest.trim(), label: 'Phone number without a tap-to-call link' })); break;
    case 'audit.longH1': each(() => ({ selector: 'h1', label: 'H1' })); break;
    case 'crawl.headings': each((p, rest) => /H\d → H\d/.test(rest) ? { text: quoted(rest), label: 'Heading that skips a level' } : /^0 H1s/.test(rest) ? { page: true, label: 'Page with no H1' } : { selector: 'h1', label: rest }); break;
    case 'audit.placeholders': each((p, rest) => ({ text: quoted(rest), label: 'Placeholder value' })); break;
    case 'crawl.dummyContent': for (const d of det) { const m = d.match(/^Page text: (\/\S*)/); if (m) T.push({ url: at(m[1]), text: 'lorem', label: 'Placeholder text' }); } break;
    case 'tw.purged': case 'tw.acfPurged': each((p, rest) => { const c = rest.split(',')[0].replace(/ …$/, '').trim(); return c ? { selector: `[class~="${c.replace(/"/g, '')}"]`, label: `Unstyled: .${c}` } : null; }); break;
    case 'audit.emptyHref': each(() => ({ selector: 'a[href=""]', label: 'Link with an empty address' })); break;
    case 'audit.assetLinks': each((p, rest) => ({ linkText: quoted(rest), label: 'Link that opens a file' })); break;
    case 'audit.collapse': each(() => ({ page: true, label: 'Cards pointing at one page' })); break;
    case 'audit.emails': for (const d of det) { const e = d.split(':')[0].trim(); const pg = await findPage(e); if (pg) T.push({ url: pg.url, text: e, label: 'Email shown on the site' }); } break;
    case 'audit.phoneFormats': for (const d of det) { const e = (d.match(/\(e\.g\. (.+)\)$/) || [])[1]; const pg = e && await findPage(e); if (pg) T.push({ url: pg.url, text: e, label: `Phone format ${d.split(' (')[0]}` }); } break;
    case 'crawl.deadMenuLinks': for (const d of det) T.push({ url: home + '/', linkText: quoted(d), label: 'Menu link to #' }); break;
    case 'crawl.internalLinks': case 'swarm.links': for (const d of det) { const m = d.match(/^(\/\S*) → .*linked from ([^,)]+)/); if (m) T.push({ url: at(m[2].trim()), selector: `a[href*="${m[1].replace(/"/g, '')}"]`, label: `Broken link to ${m[1]}` }); } break;
    case 'html.noHomeInNav': T.push({ url: home + '/', linkText: 'Home', label: '“Home” menu item' }); break;
    case 'html.logoHomeLink': T.push({ url: home + '/', selector: 'header', label: 'Header' }); break;
    case 'html.recaptcha': for (const d of det) if (/^\/\S*$/.test(d)) T.push({ url: at(d), selector: 'form', label: 'Form without anti-spam' }); break;
    case 'crawl.socialLinks': T.push({ url: home + '/', selector: 'footer', label: 'Footer' }); break;
    case 'wp.privacyPolicy': T.push({ url: home + '/', selector: 'footer', label: 'Footer (privacy link goes here)' }); break;
    case 'browser.mobileFit': case 'swarm.mobile': each(() => ({ device: 'phone', page: true, label: 'Phone, 390px wide' })); break;
    case 'browser.tapTargets': each((p, rest) => ({ device: 'phone', linkText: quoted(rest), label: 'Small tap target' })); break;
    case 'browser.stickyBottomBar': case 'browser.interactive': case 'swarm.interactive': T.push({ url: home + '/', device: 'phone', page: true, label: 'Homepage on a phone' }); break;
    case 'browser.stickyHeader': T.push({ url: home + '/', page: true, scroll: 1200, label: 'Homepage after scrolling' }); break;
    case 'browser.cookieConsent': T.push({ url: home + '/', page: true, label: 'First view, before any click' }); break;
    case 'lighthouse.home': T.push({ url: home + '/', device: 'phone', page: true, label: 'Homepage on a phone' }); break;
    case 'http.custom404': T.push({ url: home + '/wpeqa-missing-page/', page: true, label: 'A missing page' }); break;
  }
  const seen = new Set();
  return T.filter(t => { const k = JSON.stringify([t.url, t.img, t.phone, t.text, t.linkText, t.selector, t.device]); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_PER_CHECK);
}

// Runs in the page: find the target, outline it, return a crop box in document coordinates (or null).
async function locate(t) {
  if (t.page) return null;
  const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let el = null; let rangeRect = null;
  if (t.selector) el = [...document.querySelectorAll(t.selector)].find(vis) || null;
  if (!el && t.img) { const f = t.img.toLowerCase(); el = [...document.images].find(i => vis(i) && [i.currentSrc, i.getAttribute('src'), i.getAttribute('srcset'), i.getAttribute('data-src')].some(v => (v || '').toLowerCase().includes(f))) || null; }
  if (!el && t.linkText) { const q = norm(t.linkText); const c = [...document.querySelectorAll('a, button')].filter(vis); el = c.find(a => norm(a.textContent) === q) || c.find(a => norm(a.textContent).includes(q)) || null; }
  if (!el && (t.text || t.phone)) {
    const want = t.phone ? t.phone.replace(/\D/g, '') : norm(t.text);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) {
      const p = n.parentElement; if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName) || !vis(p)) continue;
      const v = t.phone ? n.textContent.replace(/\D/g, '') : norm(n.textContent);
      if (!v.includes(want)) continue;
      if (t.phone && p.closest('a[href^="tel:"]')) continue; // the copy that is already a link isn't the problem
      el = p;
      // Frame just the matching words, not the whole paragraph they sit in.
      const raw = n.textContent; let a = -1, b = -1;
      if (t.phone) { let k = 0; for (let i = 0; i < raw.length && b < 0; i++) { if (!/\d/.test(raw[i])) continue; if (raw[i] === want[k]) { if (k === 0) a = i; k++; if (k === want.length) b = i + 1; } else { k = raw[i] === want[0] ? 1 : 0; a = k ? i : -1; } } if (a > 0 && raw[a - 1] === '(') a--; }
      else { a = raw.toLowerCase().indexOf(String(t.text).toLowerCase()); if (a >= 0) b = a + String(t.text).length; }
      if (a >= 0 && b > a) { const rg = document.createRange(); rg.setStart(n, a); rg.setEnd(n, b); el.scrollIntoView({ block: 'center', inline: 'center' }); await new Promise(r => setTimeout(r, 400)); rangeRect = rg.getBoundingClientRect(); }
      break;
    }
  }
  if (!el) return null;
  if (!rangeRect) { el.scrollIntoView({ block: 'center', inline: 'center' }); await new Promise(r => setTimeout(r, 400)); }
  const r = rangeRect || el.getBoundingClientRect(); const pad = 72;
  // A frame drawn on top of the page: an outline on the element itself gets clipped by rounded cards.
  const frame = document.createElement('div');
  frame.style.cssText = `position:absolute;left:${r.left + scrollX - 5}px;top:${r.top + scrollY - 5}px;width:${r.width + 10}px;height:${r.height + 10}px;border:3px solid #e5484d;border-radius:8px;box-shadow:0 0 0 3px rgba(255,255,255,.75);pointer-events:none;z-index:2147483647;box-sizing:border-box`;
  document.body.appendChild(frame);
  const W = Math.min(innerWidth, Math.max(r.width + pad * 2, Math.min(innerWidth, 760)));
  const H = Math.min(innerHeight, Math.max(r.height + pad * 2, 380));
  const x = Math.max(0, Math.min(r.left + r.width / 2 - W / 2, innerWidth - W));
  const y = Math.max(0, Math.min(r.top + r.height / 2 - H / 2, innerHeight - H));
  return { x: Math.round(x + scrollX), y: Math.round(y + scrollY), width: Math.round(W), height: Math.round(H) };
}

// One screenshot per target, saved as evidence/<prefix>-N.jpg. Returns [{ file, label, page, found }].
export async function capture(browser, targets, dir, prefix, runUrl) {
  const out = [];
  for (const [i, t] of targets.entries()) {
    const c = await browser.createBrowserContext(); const pg = await c.newPage();
    try {
      await pg.setViewport(t.device === 'phone' ? PHONE : DESKTOP);
      await pg.goto(t.url, { waitUntil: 'networkidle2', timeout: 45000 });
      await pg.evaluate(async () => { const end = Math.min(document.body.scrollHeight, 20000); for (let y = 0; y < end; y += 700) { scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); } scrollTo(0, 0); });
      await wait(300);
      // Cookie banners cover the bottom of the screen; hide them unless the consent check is the subject.
      if (!/first view/i.test(t.label)) await pg.evaluate(() => { for (const e of document.querySelectorAll('body *')) { const st = getComputedStyle(e); if ((st.position === 'fixed' || st.position === 'sticky') && /cookie|consent/i.test(e.textContent || '') && e.getBoundingClientRect().height < innerHeight * 0.8 && !e.querySelector('header, nav')) e.style.setProperty('display', 'none', 'important'); } });
      const box = await pg.evaluate(locate, t);
      if (!box && t.scroll) { await pg.evaluate(y => scrollTo(0, y), t.scroll); await wait(500); }
      const file = `${prefix}-${i + 1}.jpg`;
      await pg.screenshot({ path: path.join(dir, file), type: 'jpeg', quality: 72, ...(box ? { clip: box } : {}) });
      out.push({ file: runUrl('evidence/' + file), label: t.label, page: pathOf(t.url), found: !!box || !!t.page, kind: box ? 'crop' : t.device === 'phone' ? 'phone' : 'page' });
    } catch { /* page failed to load; the item's details still say what's wrong */ } finally { await c.close(); }
  }
  return out;
}
