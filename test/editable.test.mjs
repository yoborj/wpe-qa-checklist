// WP Site Audit → "Everything rendered is editable" (audit.editable): the CPT & ACF review. analyzeEditable turns the
// facts WP-CLI returns (post types, field groups, field use, REST) and the fetched pages into one child per problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEditable, slugMatchesTitle } from '../lib/checks-editable.mjs';

const H = 'https://example.com';
const entry = (type, slug, title) => ({ id: Math.floor(Math.random() * 1e6), slug, title, url: `${H}/${type}/${slug}/` });
const labels = (name, ok = true) => ok
  ? { search_items: `Search ${name}`, not_found: `No ${name.toLowerCase()} found.`, not_found_in_trash: `No ${name.toLowerCase()} in Trash.`, view_item: `View ${name}`, item_published: `${name} published.`, item_updated: `${name} updated.` }
  : { search_items: 'Search Posts', not_found: 'No posts found.', not_found_in_trash: 'No posts found in Trash.', view_item: 'View Post', item_published: 'Post published.', item_updated: 'Post updated.' };

function site({ badLabels = false, emptyLogo = false, help = true, seoField = false, dbGroup = false, restCpt = true, linkFields = true } = {}) {
  const team = [entry('team', 'jane-doe', 'Jane Doe'), entry('team', 'gie-smith', 'Maria Lopez'), entry('team', 'sam-lee', 'Sam Lee')];
  const insurance = [entry('insurance', 'bcbs', 'Blue Cross Blue Shield'), entry('insurance', 'united-health-care', 'UnitedHealthcare'), entry('insurance', 'aetna', 'Aetna')];
  const fields = [
    { name: 'h1', label: 'H1', type: 'text', nested: false, help, cond: false },
    ...Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, label: `Field ${i}`, type: 'text', nested: false, help, cond: false })),
    ...(seoField ? [{ name: 'seoTitle', label: 'SEO title', type: 'text', nested: false, help: false, cond: false }] : []),
    ...(linkFields ? [{ name: 'related', label: 'Related', type: 'relationship', nested: false, help: true, cond: false }] : []),
  ];
  const filled = n => Object.fromEntries(fields.map(f => [f.name, n]));
  return {
    blogname: 'Example Health', seo: ['Yoast SEO'],
    types: [
      { name: 'team', label: 'Team', rewrite: 'team', rest_base: 'team', labels: labels('Team', !badLabels), entries: team },
      { name: 'insurance', label: 'Insurance', rewrite: 'insurance', rest_base: 'insurance', labels: labels('Insurance'), entries: insurance },
    ],
    groups: [
      { key: 'group_page', title: 'Page Base', id: dbGroup ? 12 : 0, local: dbGroup ? '' : 'php', types: ['team', 'insurance'], fields, filled: { team: filled(3), insurance: filled(3) } },
      { key: 'group_ins', title: 'Insurer details', id: 0, local: 'php', types: ['insurance'], fields: [{ name: 'logo_src', label: 'Src', type: 'image', nested: false, help: true, cond: false }], filled: { insurance: { logo_src: emptyLogo ? 0 : 3 } } },
    ],
    rest: { page: true, post: true, team: restCpt, insurance: restCpt },
    refs: linkFields ? {} : { related_N_slug: 12 },
  };
}
const pagesFor = (facts, { noTeamDesc = false, brandless = [], longTitle = false, mixedCase = false } = {}) => facts.types.flatMap(t => t.entries.map((e, i) => ({
  url: e.url, status: 200,
  title: brandless.includes(e.slug) ? e.title : longTitle && i === 0 ? `${e.title} — a very long page title that keeps going and going | Example Health` : `${e.title}${mixedCase && i === 1 ? ', Co' : t.name === 'team' ? ', CO' : ''} | Example Health`,
  description: noTeamDesc && t.name === 'team' ? '' : 'A description.',
})));
const hubsOk = [{ type: 'team', path: '/team/', plural: false, status: 200, final: '/team/', title: 'Our Team | Example Health' }, { type: 'insurance', path: '/insurance/', plural: false, status: 200, final: '/insurance/', title: 'Insurance | Example Health' }];

const keys = r => r.children.map(c => c.key);

test('a clean site: pass, no children, every check listed as passed', () => {
  const f = site(); const facts = { ...f, types: f.types.map(t => t.name === 'team' ? { ...t, entries: t.entries.filter(e => e.slug !== 'gie-smith') } : t) };
  const r = analyzeEditable(facts, pagesFor(facts), hubsOk);
  assert.equal(r.status, 'pass', JSON.stringify(r.children));
  assert.deepEqual(r.children, []);
  assert.equal(r.details.length, 14);
});

test('each problem from the CPT & ACF review becomes its own child', () => {
  const facts = site({ badLabels: true, emptyLogo: true, help: false, seoField: true, dbGroup: true, restCpt: false, linkFields: false });
  const pages = pagesFor(facts, { noTeamDesc: true, brandless: ['aetna'], longTitle: true, mixedCase: true });
  const hubs = [...hubsOk.map(h => h.type === 'insurance' ? { ...h, title: 'Insurance Archive - Example Health' } : h), { type: 'team', path: '/teams/', plural: true, status: 404, final: '/teams/', title: 'Not found' }];
  const r = analyzeEditable(facts, pages, hubs);
  assert.equal(r.status, 'fail');
  assert.deepEqual(keys(r).sort(), ['brand-in-titles', 'cpt-labels', 'db-only-groups', 'empty-fields', 'field-help', 'hub-titles', 'meta-descriptions', 'plural-hub', 'rest-acf', 'seo-duplicates', 'slug-references', 'slug-title', 'title-case', 'title-length'].sort());
  const c = Object.fromEntries(r.children.map(x => [x.key, x]));
  assert.equal(c['cpt-labels'].status, 'fail'); assert.match(c['cpt-labels'].details[0], /^Team: search_items = “Search Posts”/);
  assert.equal(c['empty-fields'].status, 'fail'); assert.match(c['empty-fields'].details[0], /Insurance \(3 entries\): Src \(logo_src, image\) is empty on all 3/);
  assert.match(c['meta-descriptions'].summary, /3 pages in 1 post type print no meta description/);
  assert.match(c['slug-title'].details[0], /\/team\/gie-smith\/ is “Maria Lopez”/);
  assert.equal(c['slug-title'].details.length, 1); // bcbs (initials) and united-health-care (run together) still match
  assert.match(c['plural-hub'].details[0], /\/teams\/ → 404/);
  assert.match(c['hub-titles'].details[0], /Insurance Archive/);
  assert.match(c['title-case'].summary, /CO \/ Co|Co \/ CO/);
  assert.match(c['rest-acf'].details[0], /no ACF values, while page, post return them/);
  assert.match(c['slug-references'].details[0], /related\[n\]\.slug: 12 values/);
  assert.match(r.summary, /14 findings across 2 post types, 6 entries and 2 ACF field groups/);
});

test('an empty text field alone is a look, an empty image field is a fail', () => {
  const facts = site();
  facts.groups[1].fields.push({ name: 'region', label: 'Region', type: 'text', nested: false, help: true, cond: false }); facts.groups[1].filled.insurance.region = 0;
  const kid = analyzeEditable(facts, pagesFor(facts), hubsOk).children.find(c => c.key === 'empty-fields');
  assert.equal(kid.status, 'warn'); assert.match(kid.details[0], /Region \(region, text\) is empty on all 3/);
});

test('optional fields of a group shared by several post types are not "unused" (field-help covers those)', () => {
  const facts = site(); facts.groups[0].filled.team.f3 = 0;
  assert.ok(!analyzeEditable(facts, pagesFor(facts), hubsOk).children.some(c => c.key === 'empty-fields'));
});

test('pages that did not load are named in the details, not counted as missing a description', () => {
  const facts = site(); const pages = pagesFor(facts).map((p, i) => i === 0 ? { ...p, status: 429 } : p);
  const r = analyzeEditable(facts, pages, hubsOk);
  assert.match(r.details[0], /Not loaded, so the page checks skipped them: 1 page \(\/team\/jane-doe\/ → 429\)/);
});

test('no custom post types and no ACF: pass with nothing to review', () => {
  const r = analyzeEditable({ types: [], groups: [] });
  assert.equal(r.status, 'pass'); assert.deepEqual(r.children, []);
});

test('slugs: a renamed entry is caught; initials, run-together names and shared words are fine', () => {
  assert.equal(slugMatchesTitle('kim-oduya', 'Marisol Brandt'), false);
  assert.equal(slugMatchesTitle('ccha', 'Colorado Community Health Alliance'), true);
  assert.equal(slugMatchesTitle('united-health-care', 'UnitedHealthcare'), true);
  assert.equal(slugMatchesTitle('arvada', 'Addiction and Mental Health Treatment in Arvada, CO'), true);
  assert.equal(slugMatchesTitle('high-intensity-outpatient', 'Partial Hospitalization Program (PHP)'), false);
});

test('a re-check without the pages judges only the WP-CLI findings and says which', () => {
  const facts = site({ badLabels: true });
  const r = analyzeEditable(facts, [], [], { skipPages: true });
  assert.deepEqual(r.children.map(c => c.key), ['cpt-labels', 'slug-title']);
  assert.ok(r.evaluated.includes('cpt-labels') && !r.evaluated.includes('meta-descriptions') && !r.evaluated.includes('title-length'));
});
