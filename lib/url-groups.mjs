// Old → New URLs, arranged the way a person reads the site (and the way a hand-made URL sheet usually is): the old
// site's main menu first, in menu order, with sub-pages under their parent; then pages not in the menu; then sections
// such as /team/ or /location/ (hub page first, entries A–Z); then legal and utility pages; then blog posts; and
// last, pages that only exist on the new site, grouped the same way in the new site's menu order.
import { normPath } from './redirects.mjs';

const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&rsquo;|&#8217;/g, '’').replace(/&quot;/g, '"').replace(/&nbsp;|&#160;/g, ' ').replace(/&ndash;|&#8211;/g, '–').replace(/&mdash;|&#8212;/g, '—').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
const segs = p => normPath(p).split('/').filter(Boolean);
const titleCase = s => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const UTILITY = /(^|-)(privacy|terms|cookies?|disclaimer|accessibility|thank|thanks|thank-you|newsletter|sitemap|legal|unsubscribe|login|account|cart|checkout|404|search)(-|$)/;
const BLOG = /^\/(\d{4}\/\d{2}\/|blog\/|category\/|tag\/|author\/)/;

// The main menu in a page's HTML: [{ label, path, children: [...] }]. Takes the first menu list (a <ul> whose id or
// class says menu, inside a <nav> or header) with at least 3 top-level items; menus rendered twice (desktop and phone)
// are read once. Links to other sites and "#" items keep their label with no path.
export function parseMenu(html, origin) {
  const host = new URL(origin).hostname.replace(/^www\./, '');
  const toPath = href => {
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return null;
    try { const u = new URL(decode(href), origin); return u.hostname.replace(/^www\./, '') === host ? u.pathname : null; } catch { return null; }
  };
  html = String(html);
  // A WordPress menu list (id="menu-…" / class="menu"), else the first list inside the main <nav>.
  const starts = [...html.matchAll(/<ul\b[^>]*(?:id|class)=["'][^"']*menu[^"']*["'][^>]*>/gi)].map(m => m.index);
  for (const m of html.matchAll(/<nav\b[^>]*>/gi)) { const ul = html.indexOf('<ul', m.index); if (ul > 0 && ul - m.index < 2000) starts.push(ul); }
  for (const at of starts) {
    const tree = readList(html, at, toPath);
    if (tree && tree.length >= 3) return tree;
  }
  return [];
}

// Reads one <ul> (starting at `at`) into a tree of { label, path, children }.
function readList(html, at, toPath) {
  const re = /<(\/?)(ul|li|a)\b([^>]*)>/gi; re.lastIndex = at;
  const root = { children: [] }; const stack = [root]; let li = null; let depth = 0; let m;
  while ((m = re.exec(html))) {
    const [, close, tag, attrs] = m; const t = tag.toLowerCase();
    if (t === 'ul') { if (close) { depth--; stack.pop(); if (!depth) break; } else { depth++; if (depth > 1) stack.push(li || stack[stack.length - 1]); } continue; }
    if (t === 'li' && !close) { li = { label: '', path: null, children: [] }; stack[stack.length - 1].children.push(li); continue; }
    if (t === 'a' && !close && li && !li.label) {
      const end = html.indexOf('</a>', re.lastIndex); if (end < 0) continue;
      li.label = decode(html.slice(re.lastIndex, end).replace(/<[^>]+>/g, ' '));
      li.path = toPath((attrs.match(/href=["']([^"']*)["']/i) || [])[1]);
    }
  }
  const clean = list => list.filter(i => i.label).map(i => ({ label: i.label, path: i.path, children: clean(i.children) }));
  return clean(root.children);
}

const flat = (items, depth = 0) => items.flatMap(i => [{ ...i, depth }, ...flat(i.children || [], depth + 1)]);

// Labels without the words at the start that most of them repeat (3+ titles, 60%+ share it, whole words kept), and
// without a trailing ", XX" state code they all carry. Titles that don't share the prefix stay as they are.
export function shortLabels(titles) {
  if (titles.length < 3) return titles;
  const w = titles.map(t => String(t).split(/\s+/));
  let best = 0, pre = '';
  for (let n = 1; n < Math.max(...w.map(x => x.length)); n++) {
    // The most common n-word start among titles long enough to keep a word after it.
    const counts = new Map();
    for (const x of w) if (x.length > n) { const k = x.slice(0, n).join(' ').toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1); }
    const [k, c] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
    if (c / w.length >= 0.6) { best = n; pre = k; } else break;
  }
  if (best < 2) return titles;
  return w.map((x, i) => (x.length > best && x.slice(0, best).join(' ').toLowerCase() === pre ? x.slice(best).join(' ').replace(/,\s*[A-Z]{2}$/, '') : titles[i]));
}

// rows: the URL map's rows (oldPath, page); newOnly: [{ path, title }]; oldNav / newNav: parseMenu(); oldOrder: old
// paths in sitemap order. Returns groups: [{ key, title, kind, items: [{ id | null, path, label, depth, isNew }] }].
// typeOrder: the sites' post types in the order WordPress registers them ([{ slug, rest_base }], from /wp-json/wp/v2/types),
// which orders the sections (/team/, /insurance/ …) the way the site itself lists them; sitemap order otherwise.
export function arrangeUrls({ rows = [], newOnly = [], oldNav = [], newNav = [], oldOrder = [], typeOrder = [] }) {
  const byPath = new Map(rows.map(r => [normPath(r.oldPath), r]));
  const used = new Set(); const groups = [];
  const take = (path, label, depth) => { const r = byPath.get(normPath(path)); if (!r || used.has(r.id)) return null; used.add(r.id); return { id: r.id, path: r.oldPath, label: label || r.page, depth, isNew: false }; };
  const home = rows.find(r => normPath(r.oldPath) === '/');
  if (home) groups.push({ key: 'home', title: 'Home', kind: 'menu', items: [take(home.oldPath, 'Home', 0)] });

  // 1. The old site's main menu, in order: each top item is a group; its own page first, then everything under it.
  // Every level keeps its depth (a sub-menu's own sub-pages sit one level deeper); a sub-menu heading with no page of
  // its own is a context row, so its pages still read as its children.
  for (const top of oldNav) {
    if (top.path && normPath(top.path) === '/') continue;
    const items = [top.path ? take(top.path, top.label, 0) : null, ...flat(top.children).map(c => (c.path ? take(c.path, c.label, c.depth + 1) : c.children?.length ? { id: null, path: null, label: c.label, depth: c.depth + 1, context: true } : null))].filter(Boolean);
    if (items.some(i => !i.context)) groups.push({ key: `menu-${groups.length}`, title: top.label, kind: 'menu', items });
  }

  // 2. Everything else: sections (/team/x, /location/y), single pages, utility pages, blog posts.
  const order = new Map(oldOrder.map((p, i) => [normPath(p), i]));
  const rest = rows.filter(r => !used.has(r.id));
  const blog = rest.filter(r => BLOG.test(normPath(r.oldPath) + '/'));
  const util = rest.filter(r => !blog.includes(r) && UTILITY.test(segs(r.oldPath).pop() || ''));
  const bySection = new Map();
  for (const r of rest) { if (blog.includes(r) || util.includes(r)) continue; const s = segs(r.oldPath); if (s.length >= 2) (bySection.get(s[0]) || bySection.set(s[0], []).get(s[0])).push(r); }
  const sections = [...bySection.entries()].filter(([, list]) => list.length >= 2);
  const inSection = new Set(sections.flatMap(([, l]) => l.map(r => r.id)));
  const hubs = new Set(sections.map(([s]) => `/${s}`));
  const singles = rest.filter(r => !blog.includes(r) && !util.includes(r) && !inSection.has(r.id) && !hubs.has(normPath(r.oldPath)));
  const az = (a, b) => a.page.localeCompare(b.page, undefined, { sensitivity: 'base' });
  if (singles.length) groups.push({ key: 'unlisted', title: 'Not in the menu', kind: 'unlisted', items: singles.sort(az).map(r => take(r.oldPath, r.page, 0)) });
  const first = list => Math.min(...list.map(r => order.get(normPath(r.oldPath)) ?? 1e6));
  const typeIdx = s => { const i = typeOrder.findIndex(t => [t.slug, t.rest_base].some(x => x && (x === s || `${x}s` === s || x === `${s}s`))); return i < 0 ? 1e6 : i; };
  for (const [s, list] of sections.sort((a, b) => typeIdx(a[0]) - typeIdx(b[0]) || first(a[1]) - first(b[1]) || a[0].localeCompare(b[0]))) {
    const hub = byPath.get(`/${s}`);
    // "Insurance Archive" → "Insurance"; entries lose the words every title in the section repeats
    // ("Addiction Treatment … That Accepts Aetna" → "Aetna"), then sort A–Z by what's left.
    const title = (hub?.page || '').replace(/\s+archives?$/i, '').trim() || titleCase(s);
    const short = shortLabels(list.map(r => r.page));
    const entries = list.map((r, i) => ({ r, label: short[i] })).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    const items = [hub ? take(hub.oldPath, title, 0) : null, ...entries.map(e => take(e.r.oldPath, e.label, 1))].filter(Boolean);
    groups.push({ key: `section-${s}`, title, kind: 'section', items });
  }
  if (util.length) groups.push({ key: 'others', title: 'Others', kind: 'others', items: util.sort(az).map(r => take(r.oldPath, r.page, 0)) });
  const blogGroup = blog.length ? { key: 'blog', title: 'Blog', kind: 'blog', items: blog.sort((a, b) => normPath(a.oldPath).localeCompare(normPath(b.oldPath))).map(r => take(r.oldPath, r.page, 1)) } : null;

  // 3. Pages only on the new site, as the new site's menu tree: each top menu item is a group; a new page sits at its
  // menu depth, under its parents. A parent that isn't new (it has an old page, listed above) is a context row, so the
  // tree still reads Programs › Medical Detox › Benzodiazepine Detox. New pages outside the menu join their section's
  // group (or one of their own); the new blog and its archives head the old blog posts.
  const isBlog = p => BLOG.test(normPath(p) + '/') || normPath(p) === '/blog';
  const newBy = new Map(newOnly.filter(p => !isBlog(p.path)).map(p => [normPath(p.path), p]));
  const placedNew = new Set();
  const treeRows = (node, depth) => {
    const np = node.path ? normPath(node.path) : null;
    const isNew = !!np && newBy.has(np) && !placedNew.has(np);
    if (isNew) placedNew.add(np);
    const kids = (node.children || []).flatMap(c => treeRows(c, depth + 1));
    if (!isNew && !kids.length) return [];
    return [{ id: null, path: node.path, label: node.label, depth, ...(isNew ? { isNew: true } : { context: true }) }, ...kids];
  };
  const newGroups = [];
  for (const top of newNav) {
    let items = treeRows(top, 0);
    if (!items.length) continue;
    if (items[0].context) items = items.slice(1); // the group heading already names the top item
    newGroups.push({ key: `new-${newGroups.length}`, title: top.label, kind: 'new', items, seg: segs(top.path || '')[0] || null });
  }
  const leftNew = [...newBy.values()].filter(p => !placedNew.has(normPath(p.path)));
  const bySeg = new Map();
  for (const p of leftNew) { const s = segs(p.path)[0] || ''; (bySeg.get(s) || bySeg.set(s, []).get(s)).push(p); }
  for (const [s, list] of bySeg) {
    const rowsOf = l => l.sort((a, b) => (a.title || a.path).localeCompare(b.title || b.path)).map(p => ({ id: null, path: p.path, label: p.title || p.path, depth: s && normPath(p.path) !== `/${s}` ? 1 : 0, isNew: true }));
    const home = s && newGroups.find(g => g.seg === s);
    if (home) home.items.push(...rowsOf(list));
    else newGroups.push({ key: `new-${s || 'pages'}`, title: s ? titleCase(s) : 'Other new pages', kind: 'new', items: rowsOf(list) });
  }
  const newBlog = newOnly.filter(p => isBlog(p.path)).sort((a, b) => (normPath(a.path) === '/blog' ? -1 : normPath(b.path) === '/blog' ? 1 : a.path.localeCompare(b.path)))
    .map(p => ({ id: null, path: p.path, label: p.title || p.path, depth: normPath(p.path) === '/blog' ? 0 : 1, isNew: true }));
  if (blogGroup) blogGroup.items.unshift(...newBlog);
  else if (newBlog.length) newGroups.push({ key: 'new-blog', title: 'Blog', kind: 'new', items: newBlog });
  groups.push(...newGroups.map(({ seg, ...g }) => g));
  if (blogGroup) groups.push(blogGroup); // last: the new blog page with the old posts that moved into it

  // Anything left (should be nothing): its own group, so no row is ever lost.
  const left = rows.filter(r => !used.has(r.id));
  if (left.length) groups.push({ key: 'rest', title: 'Other pages', kind: 'unlisted', items: left.map(r => take(r.oldPath, r.page, 0)) });
  return groups;
}
