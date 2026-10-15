// Checks for items that used to be manual: navigation, forms, accessibility, migration, hosting, Elementor and
// YOOtheme settings. Same contract as checks.mjs: each returns { status, summary, details? }. All read-only.
import dns from 'node:dns/promises';
import { fetchText, pool, snapshot, mobileSnapshot, focusWalk } from './crawl.mjs';
import { getState } from './store.mjs';

const pass = (summary, details) => ({ status: 'pass', summary, details });
const fail = (summary, details) => ({ status: 'fail', summary, details });
const warn = (summary, details) => ({ status: 'warn', summary, details });
const na = summary => ({ status: 'na', summary });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const path = u => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const cap = (list, n = 25) => list.length > n ? [...list.slice(0, n), `…and ${list.length - n} more`] : list;
const norm = p => { try { p = new URL(p, 'https://x.invalid').pathname; } catch { /* keep */ } return (p.replace(/\/+$/, '') || '/').toLowerCase(); };
const isLaunchDomain = home => !/\.(wpenginepowered|wpengine)\.com$/.test(new URL(home).hostname);
const digits = s => String(s).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const facts = async ctx => { try { return await ctx.facts(); } catch { return null; } };
// Cloudflare/WP Engine answer 429 to bursts: wait and retry.
async function patient(url, opts) {
  let r; for (const w of [0, 2000, 6000]) { if (w) await new Promise(res => setTimeout(res, w)); r = await fetchText(url, opts); if (r.status !== 429 && r.status !== 0) break; } return r;
}
const sameHost = (u, home) => { try { return new URL(u).host === new URL(home).host; } catch { return false; } };
// Primary navigation of a page: links in header/nav, not the footer.
const navSet = p => new Set((p.links || []).filter(l => l.nav && !l.footer && l.abs && /^https?:/.test(l.abs)).map(l => { try { const u = new URL(l.abs); return u.host + norm(u.pathname); } catch { return l.abs; } }));

// Tracking codes and integrations in a page's HTML (raw, so scripts held back by speed plugins count too).
const CODES = [
  ['Google Tag Manager', /\bGTM-[A-Z0-9]{4,10}\b/g], ['Google Analytics 4', /\bG-[A-Z0-9]{6,12}\b/g], ['Universal Analytics', /\bUA-\d{4,10}-\d+\b/g], ['Google Ads', /\bAW-\d{6,12}\b/g],
  ['Meta Pixel', /fbq\(\s*['"]init['"]\s*,\s*['"](\d{8,20})/g], ['Hotjar', /hjid\s*:\s*(\d{5,10})/g], ['Microsoft Clarity', /clarity\.ms\/tag\/([a-z0-9]{6,14})/gi],
  ['LinkedIn Insight', /_linkedin_partner_id\s*=\s*["']?(\d{4,12})/g], ['HubSpot', /js\.hs-scripts\.com\/(\d+)\.js/g], ['TikTok Pixel', /ttq\.load\(\s*['"]([A-Z0-9]{10,30})/g],
  ['Bing UET', /\bti\s*:\s*["'](\d{6,12})/g], ['CallTrackingMetrics', /tctm\.co\/t\.js|calltrackingmetrics/gi], ['CallRail', /cdn\.callrail\.com\/companies\/(\d+)/g],
  ['Google site verification', /google-site-verification["']\s+content=["']([^"']+)/g], ['Facebook domain verification', /facebook-domain-verification["']\s+content=["']([^"']+)/g],
];
const codesIn = html => { const out = new Map(); for (const [name, re] of CODES) for (const m of String(html).matchAll(re)) out.set(`${name}${m[1] ? ' ' + m[1] : ''}`, name); return out; };

const urlsState = ctx => getState(ctx.site.id).urls;
const urlsNeeded = ctx => !ctx.site.referenceUrl ? na('No old site is set for this site (Site settings → Old site URL).') : !(urlsState(ctx)?.rows || []).length ? warn('Run Tool on the Old → New URLs tab first; this item is read from it.') : null;
const effStatus = r => r.auto?.status || 'attention';
const effTarget = r => (effStatus(r) === 'attention' ? r.target : undefined) ?? r.auto?.target ?? '';

async function templatePage(ctx, url, label) {
  const b = await ctx.browser(); const home = await ctx.homeSnap();
  const [d, m] = [await snapshot(b, url), await mobileSnapshot(b, url)];
  if (d.error || d.status >= 400) return fail(`The ${label} (${path(url)}) did not load: ${d.status || d.error}.`);
  const homeNav = navSet(home), nav = navSet(d); const shared = [...homeNav].filter(x => nav.has(x)).length;
  const problems = [];
  if (homeNav.size && shared / homeNav.size < 0.8) problems.push(`its menu has ${shared} of the homepage's ${homeNav.size} menu links`);
  if (!(d.links || []).some(l => l.footer)) problems.push('no footer links (the site footer may be missing)');
  if (m.overflow) problems.push(`scrolls sideways on a phone (${m.scrollWidth}px wide)`);
  if ((d.consoleErrors || []).length) problems.push(`${plural(d.consoleErrors.length, 'script error')}`);
  if (!(d.headings || []).some(h => h.level === 1)) problems.push('no H1');
  return problems.length ? fail(`The ${label} (${path(url)}) doesn't match the rest of the site: ${problems.join('; ')}.`) : pass(`The ${label} (${path(url)}) uses the site's header, menu and footer, fits a phone and has no script errors.`);
}

export const MORE = {
  // ---------- Navigation ----------
  'crawl.navLinks': async ctx => {
    const pages = await ctx.pages(); const home = await ctx.homeSnap();
    const links = [...new Map([...(home.links || []), ...pages.flatMap(p => (p.links || []).filter(l => l.footer))].filter(l => (l.nav || l.footer) && l.abs && sameHost(l.abs, ctx.home)).map(l => [l.abs.split('#')[0], l])).values()];
    const bad = [];
    await pool(links, 2, async l => { const r = await patient(l.abs.split('#')[0]); if (r.status >= 400 || r.status === 0) bad.push(`“${l.text || '(no text)'}” → ${path(l.abs)}: ${r.status || r.error || 'no answer'}`); });
    return bad.length ? fail(`${plural(bad.length, 'menu or footer link')} do not open a page.`, cap(bad)) : pass(`All ${links.length} menu and footer links to this site (dropdown items included) open a page.`);
  },
  'crawl.navConsistent': async ctx => {
    const pages = (await ctx.pages()).filter(p => !p.error && p.status < 400); const home = await ctx.homeSnap(); const ref = navSet(home);
    if (!ref.size) return warn('No header menu found on the homepage to compare.');
    const diff = []; for (const p of pages) { const s = navSet(p); const missing = [...ref].filter(x => !s.has(x)).length, extra = [...s].filter(x => !ref.has(x)).length; if (missing || extra) diff.push(`${path(p.url)}: ${missing ? missing + ' menu links missing' : ''}${missing && extra ? ', ' : ''}${extra ? extra + ' extra' : ''}`); }
    return diff.length ? warn(`${plural(diff.length, 'page')} show a different menu from the homepage.`, cap(diff)) : pass(`The same ${ref.size}-link menu appears on all ${pages.length} pages.`);
  },
  'crawl.navCoverage': async ctx => {
    const pages = await ctx.pages(); const home = await ctx.homeSnap();
    const linked = new Set((home.links || []).filter(l => (l.nav || l.footer) && l.abs && sameHost(l.abs, ctx.home)).map(l => norm(l.abs)));
    const key = pages.filter(p => !p.error && p.status === 200).map(p => norm(p.url)).filter(x => x !== '/' && x.split('/').filter(Boolean).length === 1 && !/privacy|terms|thank|cookie|accessibility|sitemap|cart|checkout|account|login|404|test|sample/i.test(x));
    const missing = key.filter(k => !linked.has(k));
    return missing.length ? warn(`${plural(missing.length, 'top-level page')} not linked from the menu or footer.`, missing) : pass(`All ${key.length} top-level pages are linked from the menu or footer.`);
  },
  'browser.mobileMenu': async ctx => {
    const m = await ctx.homeMobile({ tryMenu: true });
    if (!m.menuButton) return fail('No menu button on the phone layout.');
    const notes = []; if (!m.menuButton.icon) notes.push(`The menu button (“${m.menuButton.label}”) has no icon.`); if (!m.menuOpened) notes.push('Tapping it did not show menu links.');
    return notes.length ? fail('The phone menu needs a look.', notes) : pass(`The phone menu button shows its icon (${m.menuButton.w}×${m.menuButton.h}px) and opens ${m.menuOpened} links.`);
  },
  'browser.mobileNavHeight': async ctx => { const m = await ctx.homeMobile(); if (m.navHeight == null) return warn('No header found on the phone layout.'); return m.navHeight <= 82 ? pass(`The phone header is ${m.navHeight}px tall (82px or less).`) : fail(`The phone header is ${m.navHeight}px tall; the limit is 82px.`); },
  'browser.mobileParents': async ctx => {
    const m = await ctx.homeMobile({ tryMenu: true }); const parents = m.menuParents || [];
    if (!m.menuButton) return warn('No phone menu found.'); if (!parents.length) return na('The phone menu has no dropdowns.');
    const toggles = parents.filter(x => !x.link).map(x => x.text);
    return toggles.length ? fail(`${plural(toggles.length, 'menu parent')} in the phone menu only open a dropdown and can't be visited.`, toggles) : pass(`All ${parents.length} menu parents in the phone menu are links to their page.`);
  },
  'browser.mobileFriendly': async ctx => {
    const home = await ctx.homeSnap(); const ms = await ctx.mobilePages(); const notes = [];
    if (!/width\s*=\s*device-width/i.test(home.viewport || '')) notes.push(`Viewport meta tag is ${home.viewport ? `“${home.viewport}”` : 'missing'}.`);
    const over = ms.filter(m => m.overflow); if (over.length) notes.push(`${plural(over.length, 'page')} scroll sideways at 375px.`);
    const small = ms.reduce((n, m) => n + (m.smallTargets || []).length, 0); if (small) notes.push(`${plural(small, 'tap target')} under 24×24px.`);
    return notes.length ? fail('Not fully mobile-friendly.', notes) : pass(`Mobile-friendly: a device-width viewport, ${ms.length} pages fit 375px, tap targets 24px or larger.`);
  },

  // ---------- Content ----------
  'wp.phoneHardcoded': async ctx => {
    const f = await facts(ctx); if (!f) return warn('WordPress could not be read over SSH.');
    const pages = await ctx.pages(); const count = {};
    for (const p of pages) for (const n of new Set([...(p.text?.match(PHONE_RE) || []).map(digits), ...(p.links || []).filter(l => /^tel:/i.test(l.href || '')).map(l => digits(l.href))])) count[n] = (count[n] || 0) + 1;
    const main = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0]; if (!main) return na('No phone number on the site.');
    const typed = f.typed?.phones?.[main] || [];
    return typed.length ? warn(`The main number (${main.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')}) is typed into ${plural(typed.length, 'page')}' content, so changing it means editing each one.`, cap(typed)) : pass('The main phone number is not typed into any page content; it comes from the theme (one place to change it).');
  },
  'wp.addressHardcoded': async ctx => {
    const f = await facts(ctx); if (!f) return warn('WordPress could not be read over SSH.');
    const a = f.typed?.addresses || [];
    return a.length ? warn(`A street address is typed into ${plural(a.length, 'page')}' content.`, cap(a.map(x => `${x.title}: “${x.match}”`))) : pass('No street address is typed into page content; addresses come from the theme.');
  },
  'http.searchPage': async ctx => {
    const pages = await ctx.pages(); const withForm = pages.filter(p => p.searchForm).map(p => path(p.url));
    const r = await patient(ctx.home + '/?s=wpeqa');
    const works = r.status === 200;
    if (withForm.length) return pass(`The site has a search form (${plural(withForm.length, 'page')}) and the results page answers ${r.status}.`);
    return warn(`No search form on the site.${works ? ' WordPress\'s results page still works at /?s=…' : ''} Confirm whether the site needs one.`);
  },
  'browser.linkColors': async ctx => {
    const pages = await ctx.pages(); const rows = pages.filter(p => p.linkColors?.plain?.length).map(p => `${path(p.url)}: ${p.linkColors.plain.map(t => `“${t}”`).join(', ')}`);
    const total = pages.reduce((n, p) => n + (p.linkColors?.total || 0), 0);
    if (!total) return na('No links inside body text on the pages checked.');
    return rows.length ? fail(`Links in body text on ${plural(rows.length, 'page')} look like plain text (same color, no underline).`, cap(rows)) : pass(`All ${total} links in body text stand out from the text around them.`);
  },
  'browser.blogTemplates': async ctx => { const f = await facts(ctx); if (!f) return warn('WordPress could not be read over SSH.'); if (!f.post_count) return na('The site has no published blog posts.'); const a = f.posts_url ? await templatePage(ctx, f.posts_url, 'blog page') : null; const b = f.latest_post_url ? await templatePage(ctx, f.latest_post_url, 'latest post') : null; const res = [a, b].filter(Boolean); if (!res.length) return warn('No blog page or post URL found.'); const bad = res.filter(r => r.status === 'fail'); return bad.length ? fail(bad.map(r => r.summary).join(' ')) : pass(res.map(r => r.summary).join(' ')); },
  'browser.categoryTemplate': async ctx => { const f = await facts(ctx); if (!f) return warn('WordPress could not be read over SSH.'); if (!f.category_url || !f.post_count) return na('No category archive (no published posts).'); return templatePage(ctx, f.category_url, 'category page'); },

  // ---------- Forms (never submitted) ----------
  'crawl.formsConfigured': async ctx => {
    const pages = await ctx.pages(); const seen = new Map();
    for (const p of pages) for (const fm of p.forms2 || []) { if (fm.fields.length < 2) continue; const k = fm.plugin + fm.fields.map(x => x.name).join(','); if (!seen.has(k)) seen.set(k, { page: path(p.url), ...fm }); }
    if (!seen.size) return na('No forms on the site.');
    const issues = [];
    for (const fm of seen.values()) {
      if (!fm.submit) issues.push(`${fm.page}: form has no submit button`);
      for (const x of fm.fields) {
        if (!x.name) issues.push(`${fm.page}: a ${x.type} field has no name (its value is not sent)`);
        if (!x.label) issues.push(`${fm.page}: “${x.placeholder || x.name || x.type}” has no label${x.placeholder ? ' (placeholder only)' : ''}`);
        if (/email/i.test(x.name + x.placeholder + x.auto) && x.type !== 'email' && x.type !== 'select') issues.push(`${fm.page}: “${x.name}” takes an email but is type=${x.type}`);
        if (/phone|tel/i.test(x.name + x.placeholder) && x.type === 'text') issues.push(`${fm.page}: “${x.name}” takes a phone number but is type=text (phones get no number keypad)`);
      }
    }
    return issues.length ? warn(`${plural(seen.size, 'form')} checked; ${plural(issues.length, 'field issue')}.`, cap(issues)) : pass(`${plural(seen.size, 'form')}: every field has a name and a label, emails use type=email, and each form has a submit button.`);
  },
  'crawl.formValidation': async ctx => {
    const pages = await ctx.pages(); const forms = pages.flatMap(p => (p.forms2 || []).filter(fm => fm.fields.length >= 2).map(fm => ({ page: path(p.url), ...fm })));
    if (!forms.length) return na('No forms on the site.');
    const none = forms.filter(fm => !fm.fields.some(x => x.required)).map(fm => `${fm.page}: ${fm.plugin || 'form'} marks no field as required`);
    return none.length ? warn('Some forms have no validation on any field.', cap([...new Set(none)])) : pass(`Every form marks its required fields (browser and form-plugin validation).`, ['Error messages themselves are only seen when a person submits a form.']);
  },

  // ---------- Accessibility ----------
  'browser.contrast': async ctx => {
    const pages = await ctx.pages(); const seen = new Set(); const rows = [];
    for (const p of pages) for (const c of p.contrast?.fails || []) { const k = c.text + c.fg + c.bg; if (seen.has(k)) continue; seen.add(k); rows.push(`${path(p.url)}: “${c.text}” ${c.ratio}:1 (needs ${c.need}:1)`); }
    const checked = pages.reduce((n, p) => n + (p.contrast?.checked || 0), 0);
    return rows.length ? fail(`${plural(rows.length, 'text style')} below WCAG AA contrast.`, cap(rows)) : pass(`${checked} text elements on ${pages.length} pages meet WCAG AA contrast (text over images is checked by eye).`);
  },
  'browser.keyboard': async ctx => {
    const r = await (ctx._focus ||= focusWalk(await ctx.browser(), ctx.home + '/'));
    if (r.error) return warn(`The keyboard test could not run: ${r.error}`);
    if (r.stuck) return fail('Pressing Tab on the homepage does not move focus: the page cannot be used with a keyboard.');
    return r.reached >= Math.min(10, r.interactive) ? pass(`Tab moves through ${r.reached} links and controls on the homepage in order${r.reached < r.interactive ? ` (first ${r.reached} of ${r.interactive} checked)` : ''}.`) : fail(`Tab reaches only ${r.reached} of ${r.interactive} links and controls on the homepage.`);
  },
  'browser.focusVisible': async ctx => {
    const r = await (ctx._focus ||= focusWalk(await ctx.browser(), ctx.home + '/'));
    if (r.error) return warn(`The keyboard test could not run: ${r.error}`);
    return r.noRing.length ? fail(`${plural(r.noRing.length, 'link or control', 'links and controls')} show no focus ring when reached with Tab.`, cap([...new Set(r.noRing)])) : pass(`All ${r.reached} links and controls reached with Tab show a visible focus style.`);
  },

  // ---------- Migration (from the Old → New URLs tab) ----------
  'urls.compare': async ctx => { const n = urlsNeeded(ctx); if (n) return n; const rows = urlsState(ctx).rows; const att = rows.filter(r => effStatus(r) === 'attention'); return att.length ? fail(`${plural(att.length, 'old page')} still need a decision on the Old → New URLs tab.`, cap(att.map(r => `${r.oldPath}: ${r.auto?.reason || ''}`))) : pass(`All ${rows.length} old pages are on the new site or matched to a new page.`); },
  'urls.sameStructure': async ctx => { const n = urlsNeeded(ctx); if (n) return n; const rows = urlsState(ctx).rows; const changed = rows.filter(r => effStatus(r) !== 'none' || norm(r.auto?.target || r.oldPath) !== norm(r.oldPath)); return changed.length ? warn(`${plural(changed.length, 'old address', 'old addresses')} changed (of ${rows.length}). Confirm each change was meant.`, cap(changed.map(r => `${r.oldPath} → ${effTarget(r) || '?'}`))) : pass(`All ${rows.length} old addresses are unchanged on the new site.`); },
  'urls.redirectsDone': async ctx => {
    const n = urlsNeeded(ctx); if (n) return n;
    const rows = urlsState(ctx).rows.filter(r => effStatus(r) !== 'none'); if (!rows.length) return pass('No old address changed, so no redirects are needed.');
    const origin = new URL(ctx.home).origin; const bad = [];
    await pool(rows, 2, async r => {
      if ((r.choice || (r.auto?.keep?.ok ? 'keep' : 'new')) === 'keep') { const res = await patient(origin + r.oldPath); const at = res.url ? new URL(res.url).pathname : ''; if (!(res.status === 200 && norm(at) === norm(r.oldPath))) bad.push(`${r.oldPath}: meant to keep its URL, but answers ${res.status}${at && norm(at) !== norm(r.oldPath) ? ' at ' + at : ''}`); return; }
      const res = await patient(origin + r.oldPath, { redirect: 'manual' }); let to = res.headers?.location || ''; try { to = new URL(to, origin).pathname; } catch { /* raw */ } if (![301, 308].includes(res.status)) bad.push(`${r.oldPath}: answers ${res.status}${to ? ' → ' + to : ''}${res.status === 302 || res.status === 307 ? ' (temporary; use 301)' : ''}`);
    });
    return bad.length ? fail(`${plural(bad.length, 'changed URL')} not handled yet (kept or 301).`, cap(bad)) : pass(`All ${rows.length} changed URLs are handled: kept where chosen, 301 to the new page otherwise.`);
  },
  'urls.seoCarried': async ctx => {
    const n = urlsNeeded(ctx); if (n) return n;
    const origin = new URL(ctx.home).origin; const rows = urlsState(ctx).rows.filter(r => effTarget(r)).slice(0, 40); const diffs = [];
    const info = async u => { const r = await patient(u); const t = (r.text || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i); const d = (r.text || '').match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i) || (r.text || '').match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i); const dec = x => x.replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)); return { title: t ? dec(t[1].trim().replace(/\s+/g, ' ')) : '', desc: d ? dec(d[1].trim()) : '' }; };
    await pool(rows, 2, async r => { const [o, nw] = [await info(r.oldUrl), await info(origin + effTarget(r))]; if (o.desc && !nw.desc) diffs.push(`${r.oldPath}: meta description missing on ${effTarget(r)}`); else if (o.title && nw.title && o.title.toLowerCase() !== nw.title.toLowerCase()) diffs.push(`${r.oldPath}: title “${o.title.slice(0, 60)}” → “${nw.title.slice(0, 60)}”`); });
    return diffs.length ? warn(`${plural(diffs.length, 'page')} changed title or lost its meta description. Confirm each change was meant.`, cap(diffs)) : pass(`Titles and meta descriptions carried over for ${rows.length} pages.`);
  },
  'urls.codesCarried': async ctx => {
    if (!ctx.site.referenceUrl) return na('No old site is set for this site (Site settings → Old site URL).');
    const [o, nw] = [await patient(ctx.site.referenceUrl + '/'), await patient(ctx.home + '/')];
    if (o.status >= 400 || !o.text) return warn(`The old site answered ${o.status || 'nothing'}, so its codes can't be compared.`);
    const oldC = codesIn(o.text), newC = codesIn(nw.text);
    // Universal Analytics stopped collecting data in July 2024: nothing to carry over.
    const retired = [...oldC.keys()].filter(k => oldC.get(k) === 'Universal Analytics'); retired.forEach(k => oldC.delete(k));
    const missing = [...oldC.keys()].filter(k => !newC.has(k));
    const note = retired.length ? [`Not carried over on purpose: ${retired.join(', ')} (Universal Analytics stopped collecting data in July 2024).`] : undefined;
    return missing.length ? fail(`${plural(missing.length, 'tracking code or integration', 'tracking codes and integrations')} from the old homepage are not on the new one.`, [...missing, ...(note || [])]) : pass(oldC.size ? `All ${oldC.size} codes from the old homepage are on the new one: ${[...new Set(oldC.values())].join(', ')}.` : 'The old homepage has no current tracking codes or integrations to carry over.', note);
  },

  // ---------- Hosting and setup ----------
  'html.gtmPresent': async ctx => { const h = await patient(ctx.home + '/'); const m = (h.text || '').match(/\bGTM-[A-Z0-9]{4,10}\b/); return m ? pass(`Tag Manager container ${m[0]} is in the page source.`) : fail('No Google Tag Manager container in the page source.'); },
  'html.callTracking': async ctx => { const pages = await ctx.pages(); const all = pages.flatMap(p => [...(p.scripts || []), ...(p.inlineScripts || [])]).join('\n'); const found = [['CallTrackingMetrics', /tctm\.co|calltrackingmetrics/i], ['CallRail', /callrail/i], ['WhatConverts', /whatconverts/i], ['Invoca', /invoca/i]].filter(([, re]) => re.test(all)).map(([n]) => n); return found.length ? pass(`Call-tracking code is installed: ${found.join(', ')}.`) : warn('No call-tracking script on the site. Fine if this site has no call tracking.'); },
  'http.advancedNetwork': async ctx => {
    if (!isLaunchDomain(ctx.home)) return warn('The site is still on its WP Engine address; check Advanced Network once the real domain points to WP Engine.');
    const r = await patient(ctx.home + '/'); const h = r.headers || {};
    return h['cf-ray'] ? pass(`The domain is served through WP Engine's edge network (Cloudflare, ray ${String(h['cf-ray']).split('-').pop()}).`) : fail('Responses do not come through WP Engine\'s Advanced Network (no edge headers). Turn it on in the User Portal → Domains.');
  },
  'dns.pointsToWpe': async ctx => {
    const host = new URL(ctx.home).hostname; if (!isLaunchDomain(ctx.home)) return warn('The site is still on its WP Engine address; check DNS at launch.');
    const apex = host.replace(/^www\./, ''); const rows = [];
    const a = await dns.resolve4(apex).catch(() => []); const cname = await dns.resolveCname('www.' + apex).catch(() => []);
    rows.push(`${apex} A: ${a.join(', ') || 'none'}`, `www.${apex} CNAME: ${cname.join(', ') || 'none'}`);
    const viaWpe = async h => { const r = await patient(`https://${h}/`, { redirect: 'manual' }); const x = r.headers || {}; return !!(x['x-powered-by'] && /wp engine/i.test(x['x-powered-by'])) || Object.keys(x).some(k => /^(x-wpe|wpe-)/i.test(k)) || !!x['cf-ray']; };
    const [okA, okW] = [await viaWpe(apex), await viaWpe('www.' + apex)];
    const cnameOk = cname.some(c => /wpeproxy\.com|wpenginepowered\.com|wpengine\.com/.test(c));
    return okA && okW ? pass(`Both ${apex} and www.${apex} are served by WP Engine${cnameOk ? ' (www is a CNAME to WP Engine)' : ''}.`, rows) : fail(`${!okA ? apex : 'www.' + apex} is not served by WP Engine.`, rows);
  },
  'wp.onWpEngine': async ctx => { const f = await facts(ctx); return f ? pass(`The site runs on WP Engine install ${ctx.site.install} (WordPress answers over its SSH gateway).`, ['Confirm in the User Portal that the install is under the right account.']) : fail('WordPress could not be reached over WP Engine SSH for this install.'); },
  'wp.cptIndexed': async ctx => {
    const f = await facts(ctx); if (!f) return warn('WordPress could not be read over SSH.');
    const types = (f.post_types || []).filter(t => t.count > 0); if (!types.length) return pass('The site has no custom post types with published entries.');
    const indexed = types.filter(t => t.yoast_noindex === false || t.yoast_noindex === null).map(t => `${t.label} (${t.name}): ${t.count} indexable`); const hidden = types.filter(t => t.yoast_noindex).map(t => `${t.label} (${t.name}): ${t.count}, noindex`);
    return warn(`${plural(indexed.length, 'custom post type')} indexable, ${hidden.length} set to noindex. Confirm each one is meant to be in search.`, [...indexed, ...hidden]);
  },
  'wp.cf7From': async ctx => {
    const f = await facts(ctx); if (!f) return warn('WordPress could not be read over SSH.'); if (f.cf7 === null) return na('Contact Form 7 is not active.'); if (!f.cf7.length) return na('No Contact Form 7 forms.');
    const site = new URL(ctx.home).hostname.replace(/^www\./, '');
    const bad = f.cf7.filter(x => { const m = String(x.sender).match(/@([a-z0-9.-]+)/i); return !m || m[1].toLowerCase().replace(/^www\./, '') !== site; }).map(x => `“${x.title}”: From ${x.sender || '(empty)'}`);
    return bad.length ? fail(`${plural(bad.length, 'form')} send from an address that is not on ${site}.`, bad) : pass(`All ${f.cf7.length} Contact Form 7 forms send from an address on ${site}.`);
  },

  // ---------- Elementor ----------
  'wp.elementorContainers': async ctx => { const f = await facts(ctx); const e = f?.elementor_opts; if (!e) return na('Elementor is not active on this site.'); return e.sections ? fail(`${plural(e.sections, 'published page')} still use legacy sections/columns (${e.containers} use containers).`) : pass(`All Elementor pages use Flexbox containers (${e.containers}).`); },
  'wp.elementorFonts': async ctx => { const f = await facts(ctx); const e = f?.elementor_opts; if (!e) return na('Elementor is not active on this site.'); const pages = await ctx.pages(); const google = pages.some(p => (p.styles || []).some(s => /fonts\.googleapis\.com/.test(s))); return String(e.google_fonts) === '0' ? pass('Elementor\'s Google Fonts loading is turned off.') : google ? warn('Elementor loads Google Fonts. If the site uses custom or system fonts, turn it off (Elementor → Settings → Advanced).') : pass('Elementor\'s Google Fonts setting is on, but no Google Fonts load on the pages.'); },
  'wp.elementorLicense': async ctx => { const f = await facts(ctx); const e = f?.elementor_opts; if (!e) return na('Elementor is not active on this site.'); if (!e.pro) return na('Elementor Pro is not installed.'); return e.license_key ? pass(`Elementor Pro ${e.pro} has a license key saved.`, ['Confirm in Elementor → License that it is active for this domain.']) : fail(`Elementor Pro ${e.pro} has no license key saved.`); },

  // ---------- YOOtheme ----------
  'wp.yooPerms': async ctx => { const f = await facts(ctx); if (!f?.yootheme) return na('The site does not use YOOtheme.'); const d = f.yootheme_dir; if (!d) return fail('wp-content/uploads/yootheme does not exist, so YOOtheme cannot write its CSS.'); return d.writable ? pass(`wp-content/uploads/yootheme is writable (${d.perms}) and holds ${plural(d.css, 'CSS file')}.`) : fail(`wp-content/uploads/yootheme is not writable (${d.perms}); YOOtheme can't regenerate its CSS.`); },
  'crawl.yooAssets': async ctx => { const f = await facts(ctx); if (f && !f.yootheme) return na('The site does not use YOOtheme.'); const pages = await ctx.pages(); const bad = new Set(); for (const p of pages) for (const x of p.failed || []) if (/yootheme|uikit/i.test(x.url)) bad.add(`${path(x.url)} → ${x.status}`); return bad.size ? fail(`${plural(bad.size, 'YOOtheme file')} do not load (often a 403 after a deploy).`, [...bad]) : pass(`YOOtheme's CSS, scripts and icons load on all ${pages.length} pages.`); },
};
