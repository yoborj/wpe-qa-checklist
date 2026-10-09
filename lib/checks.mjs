// Every automatic check, keyed by the `check` value in checklists/*.json.
// Each returns { status: 'pass' | 'fail' | 'warn' | 'na', summary, details?: string[] }.
// 'warn' means "needs a person to look": the tool found something it can't judge alone.
import { fetchText, isAsset, stickyHeader, cookiesBeforeConsent, pool } from './crawl.mjs';

const pass = (summary, details) => ({ status: 'pass', summary, details });
const fail = (summary, details) => ({ status: 'fail', summary, details });
const warn = (summary, details) => ({ status: 'warn', summary, details });
const na = summary => ({ status: 'na', summary });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const path = u => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const cap = (list, n = 25) => list.length > n ? [...list.slice(0, n), `…and ${list.length - n} more`] : list;

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const digits = s => s.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const phoneShape = s => s.replace(/\d/g, '9');
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TRACKING_COOKIE = /^(_ga|_gid|_gat|_gcl|_fbp|_fbc|_hj|_clck|_clsk|_uet|__hs|hubspotutk|_tt_|_pin_)/;

const sameOrigin = (u, base) => { try { return new URL(u).origin === new URL(base).origin; } catch { return false; } };
const plugin = (facts, slugPrefix) => facts.plugins.find(p => p.file.startsWith(slugPrefix + '/'));
const isLaunchDomain = home => !/\.(wpenginepowered|wpengine)\.com$/.test(new URL(home).hostname);

export const CHECKS = {
  // ---------- WordPress settings (one SSH call: ctx.facts) ----------
  'wp.homepage': async ctx => { const f = await ctx.facts(); return f.show_on_front === 'page' && f.page_on_front ? pass(`A static page is the homepage: “${f.front_title}”.`) : fail('The homepage shows latest posts. Set a static page under Settings → Reading.'); },
  'wp.postsPage': async ctx => { const f = await ctx.facts(); if (!f.post_count && !f.page_for_posts) return na('The site has no published blog posts, so no posts page is needed.'); return f.page_for_posts ? pass('A page is assigned to list blog posts.') : fail(`${plural(f.post_count, 'post')} published but no posts page is set under Settings → Reading.`); },
  'wp.adminEmail': async ctx => { const f = await ctx.facts(); const want = (ctx.site.adminEmail || '').toLowerCase(); if (!want) return warn(`Admin email is ${f.admin_email}. Set the expected address in the site settings to check it.`); return f.admin_email.toLowerCase() === want ? pass(`Admin email is ${f.admin_email}.`) : fail(`Admin email is ${f.admin_email}, expected ${want}.`); },
  'wp.stagingNoindex': async ctx => { const f = await ctx.facts(); if (isLaunchDomain(f.home)) return na(`The site already runs on ${new URL(f.home).hostname}; this applies before launch.`); return f.blog_public === 0 ? pass('“Discourage search engines” is on while in development.') : fail('Search engines can index the staging site. Turn on “Discourage search engines” under Settings → Reading.'); },
  'wp.indexable': async ctx => { const f = await ctx.facts(); return f.blog_public === 1 ? pass('Search engines are allowed to index the site.') : fail('“Discourage search engines” is still on under Settings → Reading.'); },
  'wp.plugins': async ctx => {
    const f = await ctx.facts();
    const upd = f.plugins.filter(p => p.update), off = f.plugins.filter(p => !p.active);
    const details = [...upd.map(p => `Update: ${p.name} ${p.version} → ${p.update}`), ...off.map(p => `Inactive: ${p.name} ${p.version}`)];
    if (upd.length) return fail(`${plural(upd.length, 'plugin')} need an update${off.length ? `, ${off.length} inactive` : ''}.`, details);
    if (off.length) return warn(`All plugins are up to date; ${plural(off.length, 'inactive plugin')} could be deleted.`, details);
    return pass(`All ${f.plugins.length} plugins are active and up to date.`);
  },
  'wp.comments': async ctx => { const f = await ctx.facts(); const ok = f.default_comment_status === 'closed' && !f.open_comment_posts; return ok ? pass('Comments are off for new posts and no published page or post has them open.') : fail(`New posts: comments ${f.default_comment_status}; ${plural(f.open_comment_posts, 'published page/post')} with comments open.`); },
  'wp.coreUpdate': async ctx => { const f = await ctx.facts(); return f.wp_update ? fail(`WordPress ${f.wp_version} can be updated to ${f.wp_update}.`) : pass(`WordPress ${f.wp_version} is the latest version.`); },
  'wp.hideLogin': async ctx => {
    const f = await ctx.facts(); const p = plugin(f, 'wps-hide-login');
    if (!p || !p.active) return fail('WPS Hide Login is not active.');
    const r = await fetchText(ctx.home + '/wp-login.php', { redirect: 'manual' });
    return r.status === 404 || r.status === 403 ? pass(`WPS Hide Login is active; the login page moved to /${f.whl_page}/ and /wp-login.php returns ${r.status}.`) : warn(`WPS Hide Login is active (login at /${f.whl_page}/), but /wp-login.php returned ${r.status}.`);
  },
  'wp.activityLog': async ctx => { const f = await ctx.facts(); const p = plugin(f, 'wp-security-audit-log'); return p && p.active ? pass(`WP Activity Log ${p.version} is active.`) : fail('WP Activity Log is not installed or not active.'); },
  'wp.permalinks': async ctx => { const f = await ctx.facts(); if (!f.permalink) return fail('Permalinks are “Plain” (?p=123). Use “Post name”.'); return /%postname%/.test(f.permalink) ? pass(`Permalink structure is ${f.permalink}.`) : warn(`Permalink structure is ${f.permalink}. “Post name” (/%postname%/) is the usual choice.`); },
  'wp.yoast': async ctx => { const f = await ctx.facts(); const p = plugin(f, 'wordpress-seo'); if (!p || !p.active) return fail('Yoast SEO is not active.'); return f.yoast.separator ? pass(`Yoast SEO ${p.version} is active; title separator is “${f.yoast.separator}” and the site title is “${f.blogname}”.`) : warn('Yoast SEO is active but no title separator is saved.'); },
  'wp.titleTagline': async ctx => { const f = await ctx.facts(); const bad = !f.blogname || !f.blogdescription || /just another wordpress site/i.test(f.blogdescription); return bad ? fail(`Site title “${f.blogname}”, tagline “${f.blogdescription || '(empty)'}”.`) : pass(`Site title “${f.blogname}”, tagline “${f.blogdescription}”.`); },
  'wp.uncategorized': async ctx => { const f = await ctx.facts(); const c = f.default_category; return c && c.slug !== 'uncategorized' ? pass(`The default category is “${c.name}”.`) : fail('The default category is still “Uncategorized”.'); },
  'wp.postAuthors': async ctx => { const f = await ctx.facts(); if (!f.authors.length) return na('No published blog posts.'); const bad = f.authors.filter(a => /^(dev|developer|admin|wpengine|test)$/i.test(a.login)); const details = f.authors.map(a => `${a.name} (${a.login}): ${plural(+a.posts, 'post')}`); return bad.length ? fail(`Posts are credited to ${bad.map(a => a.login).join(', ')}.`, details) : pass('Posts are credited to real authors.', details); },
  'wp.placeholderPosts': async ctx => { const f = await ctx.facts(); const j = f.junk_posts; return j.length ? fail(`${plural(j.length, 'placeholder post/page')} still exist (any status).`, j.map(p => `${p.type} “${p.title}” /${p.slug}/ (${p.status})`)) : pass('No Hello World, Sample Page or lorem ipsum posts or pages.'); },
  'wp.privacyPolicy': async ctx => {
    const f = await ctx.facts(); if (!f.privacy || f.privacy.status !== 'publish') return fail('No published privacy policy page is set under Settings → Privacy.');
    const home = await ctx.homeSnap(); const linked = home.links?.some(l => l.footer && (l.abs === f.privacy.url || /privacy/i.test(l.text)));
    const r = await fetchText(f.privacy.url);
    if (r.status !== 200) return fail(`The privacy page returns ${r.status}.`);
    return linked ? pass(`Privacy policy published at ${path(f.privacy.url)} and linked in the footer.`) : warn(`Privacy policy published at ${path(f.privacy.url)} but no footer link to it was found on the homepage.`);
  },
  'wp.memoryLimit': async ctx => { const f = await ctx.facts(); const mb = s => { const m = String(s).match(/^(-?\d+)([MG]?)/i); return !m ? 0 : +m[1] < 0 ? Infinity : +m[1] * (/g/i.test(m[2]) ? 1024 : 1); }; const v = Math.max(mb(f.memory_limit), mb(f.php_memory_limit)); return v >= 256 ? pass(`PHP memory limit is ${f.php_memory_limit} (WP_MEMORY_LIMIT ${f.memory_limit}).`) : fail(`Memory limit is ${f.php_memory_limit}; Elementor needs 256M or more.`); },
  'wp.phpVersion': async ctx => { const f = await ctx.facts(); const [a, b] = f.php_version.split('.').map(Number); return a > 8 || (a === 8 && b >= 1) ? pass(`PHP ${f.php_version}.`) : a === 8 || (a === 7 && b >= 4) ? warn(`PHP ${f.php_version}; 8.1 or newer is recommended.`) : fail(`PHP ${f.php_version} is too old.`); },
  'wp.oldUrls': async ctx => {
    const f = await ctx.facts(); const rows = Object.entries(f.old_url_hits).filter(([, v]) => v.posts + v.meta + v.options);
    return rows.length ? fail(`Old or staging URLs are still stored in the database.`, rows.map(([h, v]) => `${h}: ${v.posts} posts/pages, ${v.meta} custom fields, ${v.options} options`)) : pass('No staging (wpenginepowered.com) or Local (.local) URLs left in content, custom fields or options.');
  },
  'wp.featuredImages': async ctx => { const f = await ctx.facts(); const m = f.pages_no_thumb; return m.length ? warn(`${plural(m.length, 'published page')} without a featured image (used for social sharing previews).`, m.map(p => `${p.title} /${p.slug}/`)) : pass('Every published page has a featured image.'); },

  // ---------- Homepage HTML (ctx.homeSnap) ----------
  'html.favicon': async ctx => { const f = await ctx.facts(); const h = await ctx.homeSnap(); return f.site_icon || h.icon ? pass('A site icon is set and the homepage links a favicon.') : fail('No site icon (Appearance → Customize → Site Identity).'); },
  'html.noHomeInNav': async ctx => { const h = await ctx.homeSnap(); const hits = h.links.filter(l => l.nav && /^home$/i.test(l.text)); return hits.length ? fail('The navigation has a “Home” item.') : pass('No “Home” item in the navigation.'); },
  'html.openGraph': async ctx => { const pages = await ctx.pages(); const miss = pages.filter(p => !p.error && (!p.og?.title || !p.og?.image)); return miss.length ? fail(`${plural(miss.length, 'page')} missing og:title or og:image.`, cap(miss.map(p => path(p.url)))) : pass(`Open Graph title and image on all ${pages.length} pages${(await ctx.homeSnap()).og.twitter ? ', plus a Twitter card' : ''}.`); },
  'html.logoHomeLink': async ctx => { const h = await ctx.homeSnap(); const ok = h.logoHref && new URL(h.logoHref).pathname === '/'; return ok ? pass('The header logo links to the homepage.') : fail(h.logoHref ? `The header logo links to ${h.logoHref}.` : 'No linked logo found in the header.'); },
  'html.analyticsTags': async ctx => {
    const h = await ctx.homeSnap(); const all = [...h.scripts, ...h.inlineScripts].join('\n');
    const ga = [...new Set(all.match(/\bG-[A-Z0-9]{6,12}\b/g) || [])], gtm = [...new Set(all.match(/\bGTM-[A-Z0-9]{4,10}\b/g) || [])], ua = [...new Set(all.match(/\bUA-\d{4,10}-\d+\b/g) || [])];
    if (!ga.length && !gtm.length) return fail('No Google Analytics or Tag Manager ID found on the homepage. Escalate.');
    const gated = !h.scripts.some(s => /googletagmanager|google-analytics/.test(s));
    return pass(`Found ${[...gtm, ...ga, ...ua].join(', ')}${gated ? ' (loaded by script, likely after cookie consent)' : ''}.`, ua.length ? ['Universal Analytics (UA-) stopped collecting data in July 2024 and can be removed.'] : undefined);
  },
  'html.ga4ViaGtm': async ctx => { const h = await ctx.homeSnap(); const all = [...h.scripts, ...h.inlineScripts].join('\n'); const gtm = all.match(/\bGTM-[A-Z0-9]{4,10}\b/); const ga = [...new Set(all.match(/\bG-[A-Z0-9]{6,12}\b/g) || [])]; if (gtm) return pass(`Tag Manager container ${gtm[0]} is on the site.`); return ga.length ? warn(`GA4 (${ga.join(', ')}) is installed directly with gtag.js, not through Tag Manager.`) : fail('No Tag Manager container and no GA4 tag found.'); },
  'html.searchConsole': async ctx => { const h = await ctx.homeSnap(); return h.siteVerification ? pass('A google-site-verification meta tag is present.') : warn('No google-site-verification tag; the property may be verified by DNS. Confirm in Search Console.'); },
  'html.schema': async ctx => {
    const pages = await ctx.pages(); const types = new Set(); const errors = [];
    const walk = n => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (n['@type']) [].concat(n['@type']).forEach(t => types.add(t)); if (n['@graph']) walk(n['@graph']); };
    for (const p of pages) for (const j of p.jsonld || []) { if (j.__error) errors.push(`${path(p.url)}: ${j.__error}`); else walk(j); }
    if (errors.length) return fail(`${plural(errors.length, 'JSON-LD block')} do not parse.`, errors);
    if (!types.size) return fail('No JSON-LD structured data found.');
    const biz = [...types].some(t => /LocalBusiness|Organization|MedicalBusiness|Physician|Dentist|Store|Restaurant|ProfessionalService/.test(t));
    return (biz ? pass : warn)(`Structured data types: ${[...types].sort().join(', ')}.${biz ? '' : ' No LocalBusiness/Organization type.'}`, ['Confirm in Google\'s Rich Results Test: https://search.google.com/test/rich-results?url=' + encodeURIComponent(ctx.home + '/')]);
  },
  'html.schemaDrift': async ctx => {
    const pages = await ctx.pages(); const phones = new Set(); const drift = [];
    const walk = (n, page) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(x => walk(x, page)); if (n['@graph']) walk(n['@graph'], page); for (const k of ['telephone']) if (typeof n[k] === 'string') { phones.add(digits(n[k])); if (!digits(page.text || '').includes(digits(n[k])) && !(page.text || '').replace(/\D/g, '').includes(digits(n[k]))) drift.push(`${path(page.url)}: schema phone ${n[k]} is not shown on the page`); } };
    for (const p of pages) for (const j of p.jsonld || []) if (!j.__error) walk(j, p);
    if (!phones.size) return warn('No telephone in the structured data to compare.');
    return drift.length ? fail('Structured data phone numbers do not match the page.', cap(drift)) : pass(`Schema phone numbers (${[...phones].join(', ')}) match what the pages show.`);
  },
  'html.recaptcha': async ctx => { const pages = await ctx.pages(); const withForms = pages.filter(p => p.forms); if (!withForms.length) return na('No forms on the site (booking may use an embedded scheduler).'); const rc = withForms.filter(p => p.scripts.some(s => /recaptcha|hcaptcha|turnstile/.test(s)) || p.inlineScripts.some(s => /grecaptcha|turnstile/.test(s))); return rc.length === withForms.length ? pass(`Anti-spam (reCAPTCHA/Turnstile) loads on all ${withForms.length} pages with forms.`) : fail(`${plural(withForms.length - rc.length, 'page')} with a form but no reCAPTCHA.`, withForms.filter(p => !rc.includes(p)).map(p => path(p.url))); },
  'html.noTailwindCdn': async ctx => { const pages = await ctx.pages(); const hits = pages.filter(p => p.scripts?.some(s => /cdn\.tailwindcss\.com/.test(s))); return hits.length ? fail('The Tailwind CDN script is loaded in production.', hits.map(p => path(p.url))) : pass('No Tailwind CDN script on any page.'); },

  // ---------- HTTP ----------
  'http.custom404': async ctx => { const r = await fetchText(`${ctx.home}/wpeqa-missing-${Date.now()}/`); const links = (r.text.match(/<a\s/gi) || []).length; return r.status === 404 && links > 5 ? pass(`Missing pages return 404 with the site's own layout (${links} links on the page).`) : r.status === 404 ? warn('Missing pages return 404, but the page looks bare. Check it has navigation back into the site.') : fail(`A missing page returned ${r.status} instead of 404.`); },
  'http.wwwRedirect': async ctx => {
    const host = new URL(ctx.home).hostname; if (!isLaunchDomain(ctx.home)) return na('The site is still on its WP Engine domain.');
    const other = host.startsWith('www.') ? host.slice(4) : 'www.' + host;
    const r = await fetchText(`https://${other}/`, { redirect: 'manual' });
    const loc = r.headers.location || '';
    return [301, 308].includes(r.status) && loc.includes(host) ? pass(`${other} redirects (${r.status}) to ${host}.`) : r.status === 0 ? warn(`${other} did not answer (${r.error}). Check DNS.`) : fail(`${other} returned ${r.status}${loc ? ' → ' + loc : ''} instead of a permanent redirect to ${host}.`);
  },
  'http.securityHeaders': async ctx => {
    const h = (await fetchText(ctx.home + '/')).headers; const miss = [];
    const hsts = h['strict-transport-security'] || ''; const age = +(hsts.match(/max-age=(\d+)/) || [])[1] || 0;
    if (age < 31536000) miss.push(hsts ? `Strict-Transport-Security max-age is ${age} (want 31536000+)` : 'Strict-Transport-Security missing');
    if (!/nosniff/i.test(h['x-content-type-options'] || '')) miss.push('X-Content-Type-Options: nosniff missing');
    if (!h['x-frame-options'] && !/frame-ancestors/i.test(h['content-security-policy'] || '')) miss.push('X-Frame-Options (or CSP frame-ancestors) missing');
    if (!h['referrer-policy']) miss.push('Referrer-Policy missing');
    return miss.length ? fail(`${plural(miss.length, 'security header')} missing or weak.`, miss) : pass('HSTS, X-Content-Type-Options, X-Frame-Options and Referrer-Policy are all set.');
  },
  'http.sourceMaps': async ctx => {
    const h = await ctx.homeSnap(); const files = [...h.scripts, ...(h.styles || [])].filter(u => sameOrigin(u, ctx.home)).slice(0, 30); const exposed = [];
    await pool(files, 4, async u => { const r = await fetchText(u); const m = r.text.match(/sourceMappingURL=([^\s*]+)/); if (m) { const mapUrl = new URL(m[1], u).href; const mr = await fetchText(mapUrl, { method: 'HEAD' }); if (mr.status === 200) exposed.push(path(mapUrl)); } });
    return exposed.length ? fail('Source map files are publicly reachable.', exposed) : pass(`No reachable source maps in the ${files.length} site CSS/JS files.`);
  },
  'http.ssl': async ctx => {
    if (!ctx.home.startsWith('https://')) return fail('The site URL is not HTTPS.');
    const r = await fetchText(ctx.home.replace('https://', 'http://') + '/', { redirect: 'manual' });
    const pages = await ctx.pages(); const mixed = pages.flatMap(p => [...(p.images || []).map(i => i.src), ...(p.scripts || []), ...(p.styles || [])].filter(u => u.startsWith('http://')).map(u => `${path(p.url)}: ${u}`));
    if (mixed.length) return fail(`${plural(mixed.length, 'insecure (http://) resource')} on HTTPS pages.`, cap(mixed));
    return [301, 308].includes(r.status) ? pass(`HTTPS works, http:// redirects (${r.status}) to https://, and no mixed content on ${pages.length} pages.`) : warn(`HTTPS works, but http:// returned ${r.status} instead of a redirect.`);
  },
  'http.sitemap': async ctx => { const d = await ctx.discovery(); return d.fromSitemap ? pass(`An XML sitemap lists ${d.total} URLs. Submit ${ctx.home}/sitemap_index.xml in Search Console if not done.`) : fail('No XML sitemap found at /sitemap_index.xml, /wp-sitemap.xml or /sitemap.xml.'); },
  'http.robots': async ctx => { const r = await fetchText(ctx.home + '/robots.txt'); if (r.status !== 200) return fail(`robots.txt returned ${r.status}.`); const blocksAll = /User-agent:\s*\*[^]*?Disallow:\s*\/\s*$/im.test(r.text) && !/Disallow:\s*\/\S/.test(r.text.split(/User-agent:\s*\*/i)[1] || ''); const sm = /^Sitemap:/im.test(r.text); return blocksAll ? fail('robots.txt blocks the whole site (Disallow: /).') : sm ? pass('robots.txt allows crawling and lists the sitemap.') : warn('robots.txt allows crawling but has no Sitemap: line.', [r.text.slice(0, 300)]); },

  // ---------- Crawl of every sitemap page (ctx.pages) ----------
  'crawl.imageAlt': async ctx => { const pages = await ctx.pages(); const miss = pages.flatMap(p => (p.images || []).filter(i => i.inMain && !i.decorative && (i.alt === null || !i.alt.trim())).map(i => `${path(p.url)}: ${i.src.split('/').pop().slice(0, 60)}`)); const deco = pages.reduce((n, p) => n + (p.images || []).filter(i => i.decorative).length, 0); return miss.length ? fail(`${plural(miss.length, 'content image')} without alt text.`, cap(miss)) : pass(`Every content image has alt text (${deco} decorative images correctly use empty alt).`); },
  'crawl.dummyContent': async ctx => { const pages = await ctx.pages(); const re = /lorem ipsum|dolor sit amet|consectetur adipiscing|\bplaceholder text\b|sample page/i; const hits = pages.filter(p => re.test(p.text || '')).map(p => path(p.url)); const f = await ctx.facts(); const j = f.junk_posts.map(p => `${p.type} “${p.title}” (${p.status})`); return hits.length || j.length ? fail('Placeholder content found.', [...hits.map(h => 'Page text: ' + h), ...j]) : pass(`No lorem ipsum or sample content on ${pages.length} pages or in drafts.`); },
  'crawl.socialLinks': async ctx => { const h = await ctx.homeSnap(); const re = /(facebook|instagram|linkedin|twitter|x|youtube|tiktok|pinterest|yelp)\.com\//i; const s = [...new Set(h.links.filter(l => re.test(l.abs || '')).map(l => l.abs.replace(/\?.*$/, '')))]; return s.length ? pass(`${plural(s.length, 'social profile')} linked from the homepage.`, s) : warn('No social media links found on the homepage.'); },
  'crawl.phonesClickable': async ctx => {
    const pages = await ctx.pages(); const bad = [];
    for (const p of pages) { if (p.error) continue; const tels = new Set((p.links || []).filter(l => /^tel:/i.test(l.href || '')).map(l => digits(l.href))); const shown = [...new Set((p.text.match(PHONE_RE) || []).map(digits))]; for (const n of shown) if (!tels.has(n)) bad.push(`${path(p.url)}: ${n}`); }
    return bad.length ? fail(`${plural(bad.length, 'phone number')} shown without a tap-to-call link on the same page.`, cap(bad)) : pass(`Every phone number shown on ${pages.length} pages has a tel: link.`);
  },
  'crawl.deadMenuLinks': async ctx => { const pages = await ctx.pages(); const bad = new Set(); for (const p of pages) for (const l of p.links || []) if (l.nav && /^(#!?|javascript:.*)$/i.test((l.href || '').trim())) bad.add(`“${l.text || '(no text)'}” → ${l.href}`); return bad.size ? fail(`${plural(bad.size, 'menu link')} point at # or #!.`, [...bad]) : pass('No menu link points at # or #!.'); },
  'crawl.internalLinks': async ctx => { const r = await ctx.linkCheck(); if (r.broken.length) return fail(`${plural(r.broken.length, 'broken internal link')} out of ${r.checked} checked.`, cap([...r.broken, ...r.throttled])); return r.throttled.length ? warn(`No broken links; ${plural(r.throttled.length, 'link')} could not be verified because the server rate-limited the checker (429).`, cap(r.throttled)) : pass(`All ${r.checked} internal link targets answer.`); },
  'crawl.phoneConsistency': async ctx => {
    const pages = await ctx.pages(); const count = {};
    for (const p of pages) for (const n of new Set([...(p.text?.match(PHONE_RE) || []).map(digits), ...(p.links || []).filter(l => /^tel:/i.test(l.href || '')).map(l => digits(l.href))])) count[n] = (count[n] || 0) + 1;
    const list = Object.entries(count).sort((a, b) => b[1] - a[1]).map(([n, c]) => `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)} on ${plural(c, 'page')}`);
    if (!list.length) return warn('No phone numbers found on the site.');
    return list.length === 1 ? pass(`One phone number used sitewide: ${list[0]}.`) : warn(`${list.length} different phone numbers on the site. Confirm each one is intended (e.g. one per location).`, list);
  },
  'crawl.headings': async ctx => { const pages = await ctx.pages(); const bad = []; for (const p of pages) { if (p.error) continue; const h1 = p.headings.filter(h => h.level === 1).length; if (h1 !== 1) bad.push(`${path(p.url)}: ${h1} H1s`); let prev = 0; for (const h of p.headings) { if (prev && h.level > prev + 1) { bad.push(`${path(p.url)}: H${prev} → H${h.level} (“${h.text.slice(0, 40)}”)`); break; } prev = h.level; } } return bad.length ? fail(`${plural(bad.length, 'heading problem')} found.`, cap(bad)) : pass(`All ${pages.length} pages have one H1 and no skipped heading levels.`); },
  'crawl.imageWeight': async ctx => { const pages = await ctx.pages(); const big = new Set(); for (const p of pages) for (const i of p.images || []) if (i.w > 2200 && i.shownW && i.w > i.shownW * 2.2) big.add(`${i.src.split('/').pop().slice(0, 60)}: ${i.w}px wide, shown at ${i.shownW}px`); return big.size ? warn(`${plural(big.size, 'image')} much larger than displayed.`, cap([...big])) : pass(`Images on ${pages.length} pages are sized close to how they are displayed.`); },
  'crawl.stagingLinks': async ctx => { const pages = await ctx.pages(); const re = new RegExp(`${ctx.site.install ? ctx.site.install + '\\.(wpenginepowered|wpengine)\\.com|' : '[a-z0-9]+\\.wpenginepowered\\.com|'}\\.local/|localhost:`, 'i'); if (!isLaunchDomain(ctx.home)) return na('The site is still on its WP Engine domain.'); const hits = pages.flatMap(p => [...(p.links || []).map(l => l.abs), ...(p.images || []).map(i => i.src)].filter(u => re.test(u || '')).map(u => `${path(p.url)}: ${u}`)); return hits.length ? fail(`${plural(hits.length, 'link or image')} still point at the staging or Local site.`, cap(hits)) : pass(`No links or images point at staging on ${pages.length} pages.`); },
  'crawl.noindex': async ctx => { const pages = await ctx.pages(); const hits = pages.filter(p => /noindex/i.test(p.robots || '')).map(p => path(p.url)); return hits.length ? fail(`${plural(hits.length, 'page')} in the sitemap carry noindex.`, cap(hits)) : pass(`No noindex tag on the ${pages.length} sitemap pages.`); },

  // ---------- Browser layout ----------
  'browser.stickyHeader': async ctx => { const b = await ctx.browser(); const [d, m] = [await stickyHeader(b, ctx.home + '/'), await stickyHeader(b, ctx.home + '/', true)]; return d && m ? pass('The header stays on screen when scrolling, on desktop and phone.') : fail(`Sticky header: desktop ${d ? 'yes' : 'no'}, phone ${m ? 'yes' : 'no'}.`); },
  'browser.stickyBottomBar': async ctx => { const m = await ctx.homeMobile(); return m.bottomBar ? (m.bottomBar.tel ? pass(`Phone bottom bar present: “${m.bottomBar.text}”.`) : warn(`A bottom bar is present (“${m.bottomBar.text}”) but has no phone link.`)) : fail('No sticky bottom bar on the phone layout.'); },
  'browser.mobileFit': async ctx => { const ms = await ctx.mobilePages(); const bad = ms.filter(m => m.overflow).map(m => `${path(m.url)}: ${m.scrollWidth}px wide on a 375px screen`); return bad.length ? fail(`${plural(bad.length, 'page')} scroll sideways on a phone.`, cap(bad)) : pass(`All ${ms.length} pages fit a 375px screen.`); },
  'browser.fontFamilies': async ctx => { const pages = await ctx.pages(); const total = {}; for (const p of pages) for (const [f, n] of Object.entries(p.fonts || {})) total[f] = (total[f] || 0) + n; const fams = Object.entries(total).filter(([f]) => !/fallback|icon|awesome|dashicons|symbol|emoji/i.test(f)).sort((a, b) => b[1] - a[1]); const list = fams.map(([f, n]) => `${f}: ${n} text elements`); return fams.length <= 2 ? pass(`${plural(fams.length, 'font family', 'font families')}: ${fams.map(f => f[0]).join(', ')}.`) : warn(`${fams.length} font families in use.`, list); },
  'browser.tapTargets': async ctx => { const ms = await ctx.mobilePages(); const bad = ms.flatMap(m => (m.smallTargets || []).map(t => `${path(m.url)}: “${t.text}” ${t.w}×${t.h}px`)); return bad.length ? fail(`${plural(bad.length, 'tap target')} under 24×24px.`, cap(bad)) : pass(`Every button and link on ${ms.length} pages is at least 24×24px on a phone.`); },
  'browser.cookieConsent': async ctx => { const r = await cookiesBeforeConsent(await ctx.browser(), ctx.home + '/'); const track = r.cookies.filter(c => TRACKING_COOKIE.test(c)); if (track.length || r.trackers.length) return fail('Tracking runs before the visitor accepts cookies.', [...track.map(c => 'Cookie: ' + c), ...r.trackers.map(t => 'Request: ' + t)]); return pass(`No tracking cookies or tracker requests before consent${r.banner ? '; a consent banner is showing' : ''}.`, r.banner ? undefined : ['No cookie banner was detected. If the site uses any non-essential cookies, it needs one.']); },
  'browser.domSize': async ctx => { const h = await ctx.homeSnap(); return h.domNodes < 1400 ? pass(`Homepage has ${h.domNodes} DOM elements.`) : warn(`Homepage has ${h.domNodes} DOM elements (target under 1,400).`); },
  'browser.consoleErrors': async ctx => { const pages = await ctx.pages(); const bad = pages.flatMap(p => (p.consoleErrors || []).map(e => `${path(p.url)}: ${e}`)); return bad.length ? fail(`${plural(bad.length, 'console error')} on ${new Set(bad.map(b => b.split(':')[0])).size} pages.`, cap(bad)) : pass(`No console errors on ${pages.length} pages.`); },
  'browser.interactive': async ctx => { const m = await ctx.homeMobile({ tryMenu: true }); const h = await ctx.homeSnap(); const notes = []; if (!m.menuButton) notes.push('No phone menu button found.'); else if (!m.menuOpened) notes.push(`The phone menu button (“${m.menuButton.label}”) did not reveal links.`); if (h.consoleErrors.length) notes.push(`${plural(h.consoleErrors.length, 'console error')} on the homepage.`); return notes.length ? fail('Interactive elements need a look.', notes) : pass(`The phone menu opens (${m.menuOpened} links) and the homepage has no script errors. Sliders, accordions and forms still need a manual click-through.`); },

  // ---------- Speed ----------
  'lighthouse.home': async ctx => {
    const r = await ctx.lighthouse();
    const line = (d, x) => `${d}: score ${x.score ?? '—'}, LCP ${x.lcp == null ? 'not measured' : (x.lcp / 1000).toFixed(2) + ' s'}, CLS ${x.cls == null ? '—' : x.cls.toFixed(3)}, blocking ${x.tbt == null ? '—' : Math.round(x.tbt) + ' ms'}`;
    const ok = x => x.lcp != null && x.lcp <= 2500 && x.cls <= 0.1 && x.tbt <= 200;
    const details = [line(`Phone (middle of ${r.mobileRuns} runs)`, r.mobile), line('Desktop', r.desktop), r.mobileLcps ? `Phone LCP per run: ${r.mobileLcps.map(v => v == null ? '—' : (v / 1000).toFixed(2) + ' s').join(', ')}` : null, `Lab results vary; Google's own run: https://pagespeed.web.dev/analysis?url=${encodeURIComponent(ctx.home + '/')}`].filter(Boolean);
    return ok(r.mobile) && ok(r.desktop) ? pass('Homepage passes Core Web Vitals in the lab (LCP < 2.5 s, CLS < 0.1, blocking < 200 ms) on phone and desktop.', details) : fail('Homepage misses a Core Web Vitals mark in the lab.', details);
  },
};

// ---------- QA Swarm (per-page scoring over the whole sitemap) ----------
export const SWARM = {
  'swarm.http': async ctx => { const pages = await ctx.pages(); const bad = pages.filter(p => p.status !== 200).map(p => `${path(p.url)}: ${p.status || p.error}`); return bad.length ? fail(`${pages.length - bad.length}/${pages.length} pages answer 200.`, bad) : pass(`${pages.length}/${pages.length} pages answer 200.`); },
  'swarm.links': CHECKS['crawl.internalLinks'],
  'swarm.a11y': async ctx => { const s = await ctx.swarmScores(); const bad = s.pages.filter(p => p.a11yIssues.length).map(p => `${p.path}: ${p.a11yIssues.join(', ')}`); const hard = s.pages.some(p => p.a11yIssues.some(i => /no title|H1s|no lang/.test(i))); return !bad.length ? pass(`All ${s.pages.length} pages: title, one H1, lang, alt text, meta description, no console errors.`) : (hard ? fail : warn)(`${plural(bad.length, 'page')} with accessibility/SEO basics missing.`, cap(bad)); },
  'swarm.mobile': async ctx => { const s = await ctx.swarmScores(); const over = s.pages.filter(p => p.overflow).map(p => p.path); const hb = s.menuButton; const notes = [...over.map(p => `${p}: scrolls sideways at 375px`)]; if (hb && (hb.w < 44 || hb.h < 44)) notes.push(`Menu button is ${hb.w}×${hb.h}px (44×44 recommended)`); return over.length ? fail(`${plural(over.length, 'page')} do not fit a 375px screen.`, cap(notes)) : notes.length ? warn(`All ${s.pages.length} pages fit 375px; menu button is small.`, notes) : pass(`All ${s.pages.length} pages fit a 375px screen; menu button ${hb ? `${hb.w}×${hb.h}px` : 'not found'}.`); },
  'swarm.interactive': CHECKS['browser.interactive'],
  'swarm.content': async ctx => {
    const pairs = await ctx.referencePairs(); if (!pairs.length) return na('Set a reference (old) site URL to compare content.');
    const rows = pairs.map(p => `${p.path}: ${Math.round(p.text * 100)}% of the old page's words found`);
    const avg = pairs.reduce((n, p) => n + p.text, 0) / pairs.length;
    return (avg >= 0.9 ? pass : avg >= 0.75 ? warn : fail)(`Average text completeness ${Math.round(avg * 100)}% over ${plural(pairs.length, 'page pair')}.`, cap(rows));
  },
  'swarm.visual': async ctx => { const shots = await ctx.screenshots(); return shots.length ? warn(`${plural(shots.length, 'screenshot')} saved (desktop and phone). Look through them in the run report.`, [`Open: ${ctx.runUrl('shots.html')}`]) : fail('No screenshots captured.'); },
  'swarm.composite': async ctx => { const s = await ctx.swarmScores(); const rows = s.pages.slice().sort((a, b) => a.score - b.score).map(p => `${p.path}: ${p.score.toFixed(1)}%`); return (s.site >= 90 ? pass : s.site >= 75 ? warn : fail)(`Site composite ${s.site.toFixed(2)}% (${s.pages.filter(p => p.score >= 95).length} pages ≥ 95%, ${s.pages.filter(p => p.score >= 90).length} ≥ 90%, ${s.pages.filter(p => p.score < 75).length} under 75%).`, cap(rows, 12)); },
};

// ---------- WP Site Audit ----------
export const AUDIT = {
  'audit.collapse': async ctx => {
    const pages = await ctx.pages(); const bad = [];
    for (const p of pages) { const byTarget = {}; for (const l of p.links || []) { if (!l.abs || !sameOrigin(l.abs, ctx.home) || l.nav || l.footer) continue; const t = l.abs.split('#')[0]; if (new URL(t).pathname === '/' || t === p.url) continue; (byTarget[t] ||= new Set()).add(l.text.toLowerCase()); } for (const [t, texts] of Object.entries(byTarget)) if (texts.size > 3) bad.push(`${path(p.url)}: ${texts.size} different links → ${path(t)} (${[...texts].slice(0, 4).join(' · ')})`); }
    return bad.length ? fail(`${plural(bad.length, 'collapsed link group')} (cards pointing at one index page).`, cap(bad)) : pass(`No collapsed links on ${pages.length} pages.`);
  },
  'audit.emptyHref': async ctx => { const pages = await ctx.pages(); const bad = pages.flatMap(p => (p.links || []).filter(l => l.href === '').map(l => `${path(p.url)}: “${l.text || '(no text)'}”`)); return bad.length ? fail(`${plural(bad.length, 'empty link')} (href="").`, cap(bad)) : pass(`No href="" on ${pages.length} pages.`); },
  'audit.assetLinks': async ctx => { const pages = await ctx.pages(); const bad = new Set(); for (const p of pages) for (const l of p.links || []) if (l.abs && isAsset(l.abs) && l.text && (l.nav || l.main)) bad.add(`${path(p.url)}: “${l.text}” → ${l.abs.split('/').pop()}`); return bad.size ? warn(`${plural(bad.size, 'text link')} open a file instead of a page. Fine for downloads; wrong for navigation.`, cap([...bad])) : pass('No navigation or related link points at an image or file.'); },
  'audit.duplicateImages': async ctx => { const pages = await ctx.pages(); const bad = []; for (const p of pages) { const seen = {}; for (const i of p.images || []) if (i.inMain && !i.decorative && i.src && !i.src.startsWith('data:') && i.shownW > 80) seen[i.src] = (seen[i.src] || 0) + 1; for (const [s, n] of Object.entries(seen)) if (n > 1) bad.push(`${path(p.url)}: ${s.split('/').pop()} ×${n}`); } return bad.length ? warn(`${plural(bad.length, 'image')} repeated within one page body (fine for carousels that loop).`, cap(bad)) : pass('No image repeats within a page body.'); },
  'audit.junkPosts': async ctx => { const f = await ctx.facts(); const rows = [...f.junk_posts.map(p => `Placeholder ${p.type}: “${p.title}” /${p.slug}/ (${p.status})`), ...f.slug_collisions.map(p => `Post slug collides with a page: “${p.title}” /${p.slug}/`)]; return rows.length ? fail(`${plural(rows.length, 'junk item')}.`, rows) : pass('No placeholder posts and no post/page slug collisions.'); },
  'audit.emails': async ctx => { const pages = await ctx.pages(); const where = {}; for (const p of pages) for (const e of new Set([...(p.text?.match(EMAIL_RE) || []), ...(p.links || []).filter(l => /^mailto:/i.test(l.href || '')).map(l => l.href.slice(7).split('?')[0])])) (where[e.toLowerCase()] ||= new Set()).add(path(p.url)); const rows = Object.entries(where).map(([e, s]) => `${e}: ${plural(s.size, 'page')}`); return rows.length ? warn(`${plural(rows.length, 'email address', 'email addresses')} shown on the site. Confirm each one is meant to be public.`, rows) : pass('No email addresses are shown on the site.'); },
  'audit.muPlugins': async ctx => { const f = await ctx.facts(); const custom = f.mu_plugins.filter(m => !/^WP Engine|Force Strong Passwords - WPE/i.test(m.name) && !/^(wpe-|wpengine-|mu-plugin\.php$|slt-force-strong)/.test(m.file)); return custom.length ? warn(`${plural(custom.length, 'custom mu-plugin')}. Read each one for overrides that shadow the theme.`, custom.map(m => `${m.file}: ${m.name || '(no name)'}`)) : pass(`Only WP Engine's own mu-plugins (${f.mu_plugins.length}).`); },
  'audit.longH1': async ctx => { const pages = await ctx.pages(); const bad = []; for (const p of pages) for (const h of (p.headings || []).filter(h => h.level === 1)) if (h.text.length > 70 || /\s[|–—]\s/.test(h.text)) bad.push(`${path(p.url)}: “${h.text}”`); return bad.length ? fail(`${plural(bad.length, 'H1')} look like raw SEO titles.`, cap(bad)) : pass('No H1 is a long SEO string.'); },
  'audit.alt': CHECKS['crawl.imageAlt'],
  'audit.phoneFormats': async ctx => { const pages = await ctx.pages(); const shapes = {}; for (const p of pages) for (const m of p.text?.match(PHONE_RE) || []) { const v = m.trim().replace(/\s+/g, ' '); (shapes[phoneShape(v)] ||= new Set()).add(v); } const list = Object.entries(shapes).map(([s, ex]) => `${s} (e.g. ${[...ex][0]})`); return list.length <= 1 ? pass(list.length ? `One phone format: ${list[0]}.` : 'No phone numbers in page text.') : warn(`${list.length} phone formats in use.`, list); },
  'audit.cptFeatured': async ctx => { const f = await ctx.facts(); const rows = Object.entries(f.cpt_no_thumb).flatMap(([t, l]) => l.map(p => `${t}: ${p.title}`)); return rows.length ? fail(`${plural(rows.length, 'custom post')} without a featured image.`, cap(rows)) : pass(`Every published custom post (${Object.keys(f.cpt_no_thumb).join(', ') || 'none'}) has a featured image.`); },
  'audit.yoastTitles': async ctx => { const f = await ctx.facts(); const bad = f.yoast.titles.filter(t => !/%%sitename%%\s*$/.test(t.seo_title)).map(t => `${t.title}: “${t.seo_title}”`); const sep = f.yoast.separator; const notes = sep && sep !== 'sc-pipe' ? [`Separator is ${sep} (house standard is sc-pipe “|”).`] : []; return bad.length ? warn(`${plural(bad.length, 'custom SEO title')} do not end with %%sitename%%.`, cap([...notes, ...bad])) : notes.length ? warn('Titles end with the site name; separator differs from the house standard.', notes) : pass(`All ${f.yoast.titles.length} custom SEO titles end with %%sep%% %%sitename%%.`); },
  'audit.placeholders': async ctx => { const pages = await ctx.pages(); const re = /\(?000\)?[\s.-]?000[\s.-]?0000|\b555[\s.-]?(01\d\d|5555)\b|placeholder@|@example\.com|(?<![\d,.])0{2,3}\+|\b0am\s*-\s*0pm|\blorem\b|\bTBD\b|\bTODO\b|\bXXX\b|\{\{[^}]+\}\}|%%[a-z_]+%%/i; const bad = []; for (const p of pages) { const m = (p.text || '').match(re); if (m) bad.push(`${path(p.url)}: “${m[0]}”`); } return bad.length ? fail(`${plural(bad.length, 'page')} show placeholder values.`, cap(bad)) : pass(`No placeholder phones, emails, counters, lorem/TBD/TODO or unrendered tokens on ${pages.length} pages.`); },
  'audit.localStyles': async ctx => { const pages = await ctx.pages(); const rows = pages.filter(p => p.bodyStyleBlocks).map(p => `${path(p.url)}: ${plural(p.bodyStyleBlocks, '<style> block')}`); return rows.length ? warn(`${plural(rows.length, 'page')} carry page-local <style> blocks. Check shared rules are not trapped in one template.`, cap(rows)) : pass('No page-local <style> blocks in page bodies.'); },
};

export const ALL_CHECKS = { ...CHECKS, ...SWARM, ...AUDIT };
