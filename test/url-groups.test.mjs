// Old → New URLs, arranged like the site: old menu groups (in order, sub-pages under their parent), pages outside the
// menu, sections A–Z under their hub, utility pages, blog posts, then new-only pages in the new menu's order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMenu, arrangeUrls, shortLabels } from '../lib/url-groups.mjs';

const OLD = 'https://old.example.com';
const oldHtml = `<header><nav class="elementor-nav-menu--main"><ul id="menu-1-abc" class="elementor-nav-menu">
  <li class="menu-item"><a href="#" class="elementor-item">About</a><ul class="sub-menu">
    <li><a href="${OLD}/about-us">Our Team</a></li><li><a href="${OLD}/faqs/">FAQ&#8217;s</a></li></ul></li>
  <li><a href="${OLD}/what-we-do/">What We Do</a><ul class="sub-menu"><li><a href="${OLD}/detox/">Detox</a></li></ul></li>
  <li><a href="${OLD}/contact/">Contact</a></li>
  <li><a href="https://elsewhere.example.org/">Partner</a></li>
</ul></nav>
<nav class="elementor-nav-menu--dropdown"><ul id="menu-2-abc" class="elementor-nav-menu"><li><a href="${OLD}/x/">Dup</a></li></ul></nav></header>`;
const newHtml = `<nav class="nav" aria-label="Main"><ul><li><a href="/programs/">Programs </a><button>open</button><ul>
  <li><a href="/programs/detox/">Detox</a></li><li><a href="/programs/new-thing/">New Thing</a></li></ul></li>
  <li><a href="/services/">Services</a></li><li><a href="/blog/">Blog</a></li></ul></nav>`;

test('reads the main menu: groups, sub-pages, labels; "#" and other sites keep a label without a path', () => {
  const m = parseMenu(oldHtml, OLD);
  assert.deepEqual(m.map(i => i.label), ['About', 'What We Do', 'Contact', 'Partner']);
  assert.equal(m[0].path, null);
  assert.deepEqual(m[0].children.map(c => [c.label, c.path]), [['Our Team', '/about-us'], ['FAQ’s', '/faqs/']]);
  assert.equal(m[3].path, null);
});

test('a plain <nav> list (no "menu" class) is read too', () => {
  const m = parseMenu(newHtml, 'https://new.example.com');
  assert.deepEqual(m.map(i => i.label), ['Programs', 'Services', 'Blog']);
  assert.deepEqual(m[0].children.map(c => c.path), ['/programs/detox/', '/programs/new-thing/']);
});

const row = (p, page) => ({ id: p, oldPath: p, page });
const rows = [
  row('/', 'Home'), row('/about-us/', 'About Us'), row('/faqs/', 'FAQs'), row('/what-we-do/', 'What We Do'), row('/detox/', 'Detox'),
  row('/contact/', 'Contact Us'), row('/cocaine/', 'Cocaine Addiction'), row('/privacy-policy/', 'Privacy Policy'), row('/thank-you/', 'Thank You'),
  row('/team/', 'Team Archive'), row('/team/zoe/', 'Zoe Adams'), row('/team/al/', 'Al Brown'),
  row('/insurance/', 'Insurance Archive'), row('/insurance/b/', 'Treatment That Accepts Blue Plan'), row('/insurance/a/', 'Treatment That Accepts Acme'), row('/insurance/c/', 'Treatment That Accepts Cove'),
  row('/2026/01/02/a-post/', 'A Post'),
];
const newOnly = [{ path: '/programs/new-thing/', title: 'New Thing' }, { path: '/services/', title: 'Services' }, { path: '/services/x/', title: 'X Therapy' }, { path: '/blog/', title: 'Blog' }];

test('arranged like the site: menu groups first, then off-menu pages, sections, others, blog, new-only pages', () => {
  const g = arrangeUrls({ rows, newOnly, oldNav: parseMenu(oldHtml, OLD), newNav: parseMenu(newHtml, 'https://new.example.com'), oldOrder: ['/', '/team/zoe/', '/insurance/a/'] });
  assert.deepEqual(g.map(x => x.title), ['Home', 'About', 'What We Do', 'Contact', 'Not in the menu', 'Team', 'Insurance', 'Others', 'Programs', 'Services', 'Blog']);
  // The site's post type order (wp-admin's) beats sitemap order for the sections.
  const byType = arrangeUrls({ rows, newOnly, oldOrder: ['/team/zoe/', '/insurance/a/'], typeOrder: [{ slug: 'post', rest_base: 'posts' }, { slug: 'insurance', rest_base: 'insurance' }, { slug: 'team', rest_base: 'team' }] });
  assert.deepEqual(byType.filter(x => x.kind === 'section').map(x => x.title), ['Insurance', 'Team']);
  const at = t => g.find(x => x.title === t).items.map(i => `${'-'.repeat(i.depth)}${i.label}`);
  assert.deepEqual(at('About'), ['-Our Team', '-FAQ’s']); // no page of its own: only its sub-pages
  assert.deepEqual(at('What We Do'), ['What We Do', '-Detox']);
  assert.deepEqual(at('Not in the menu'), ['Cocaine Addiction']);
  assert.deepEqual(at('Team'), ['Team', '-Al Brown', '-Zoe Adams']); // hub first, then A–Z; sitemap order puts Team first
  assert.deepEqual(at('Insurance'), ['Insurance', '-Acme', '-Blue Plan', '-Cove']); // the shared "Treatment That Accepts" dropped
  assert.deepEqual(at('Others'), ['Privacy Policy', 'Thank You']);
  assert.deepEqual(at('Blog'), ['Blog', '-A Post']); // the new blog page heads the old posts
  assert.deepEqual(at('Services'), ['Services', '-X Therapy']);
  assert.ok(g.find(x => x.title === 'Programs').items.every(i => i.isNew));
  assert.equal(new Set(g.flatMap(x => x.items).filter(i => !i.isNew).map(i => i.id)).size, rows.length); // every old row once
});

test('new pages keep their menu depth; a parent that is not new shows as a context row', () => {
  const nav = parseMenu(`<nav aria-label="Main"><ul><li><a href="/programs/">Programs</a><ul><li><a href="/programs/detox/">Detox</a><ul>
    <li><a href="/programs/benzo-detox/">Benzo Detox</a></li><li><a href="/programs/meth-detox/">Meth Detox</a></li></ul></li></ul></li>
    <li><a href="/a/">A</a></li><li><a href="/b/">B</a></li></ul></nav>`, 'https://new.example.com');
  const g = arrangeUrls({ rows: [row('/', 'Home')], newOnly: [{ path: '/programs/benzo-detox/', title: 'Benzo' }, { path: '/programs/meth-detox/', title: 'Meth' }, { path: '/programs/zeta/', title: 'Zeta' }], newNav: nav });
  const p = g.find(x => x.title === 'Programs');
  assert.deepEqual(p.items.map(i => [i.label, i.depth, i.context ? 'ctx' : i.isNew ? 'new' : 'old']),
    [['Detox', 1, 'ctx'], ['Benzo Detox', 2, 'new'], ['Meth Detox', 2, 'new'], ['Zeta', 1, 'new']]); // Zeta: not in the menu, joins its section
});

test('no menu found: pages are still grouped by address, nothing is lost', () => {
  const g = arrangeUrls({ rows, newOnly: [] });
  assert.equal(g.flatMap(x => x.items).length, rows.length);
  assert.equal(g[0].title, 'Home');
});

test('short labels drop a prefix most titles share, and a trailing state code', () => {
  assert.deepEqual(shortLabels(['Treatment in Aspen', 'Treatment in Vail, CO', 'Treatment in Erie', 'Something Else']), ['Aspen', 'Vail', 'Erie', 'Something Else']);
  assert.deepEqual(shortLabels(['Ann Lee', 'Bo Kim', 'Cy Fox']), ['Ann Lee', 'Bo Kim', 'Cy Fox']);
});
