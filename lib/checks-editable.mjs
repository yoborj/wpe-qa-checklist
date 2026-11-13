// "Everything rendered is editable" (audit.editable): an automatic review of the site's custom post types and ACF
// fields. Each problem it finds is a child finding (see lib/children.mjs) with its own Approve / Decline; the item
// itself shows the worst of them. Read-only: one WP-CLI call for post types and fields, then a fetch of each custom
// post type page (title, meta description) and of each post type's hub URL.
import { wpEvalJson } from './wpe.mjs';
import { fetchText, pool } from './crawl.mjs';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const cap = (list, n = 25) => (list.length > n ? [...list.slice(0, n), `…and ${list.length - n} more`] : list);
const pathOf = u => { try { return new URL(u).pathname; } catch { return u; } };
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&#8217;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// Field types whose value an editor fills in (and that show on the page). Layout, choice and container fields are left out.
const VALUE_TYPES = ['text', 'textarea', 'wysiwyg', 'number', 'email', 'url', 'image', 'file', 'gallery', 'oembed', 'link', 'post_object', 'relationship', 'page_link', 'date_picker', 'select'];
const LINK_TYPES = ['relationship', 'post_object', 'page_link', 'link'];
const SEO_FIELD = /^(seo_?title|meta_?title|meta_?description|seo_?description)$/i;

// Post types, ACF field groups (with how many published entries fill each field), SEO plugin, REST exposure.
const PHP = String.raw`<?php
global $wpdb;
$out = [ 'blogname' => html_entity_decode( get_bloginfo( 'name' ), ENT_QUOTES ), 'acf' => function_exists( 'acf_get_field_groups' ), 'seo' => [], 'types' => [], 'groups' => [], 'rest' => [], 'refs' => [] ];
if ( defined( 'WPSEO_VERSION' ) ) { $out['seo'][] = 'Yoast SEO'; }
if ( class_exists( 'RankMath' ) ) { $out['seo'][] = 'Rank Math'; }
if ( defined( 'AIOSEO_VERSION' ) ) { $out['seo'][] = 'All in One SEO'; }
$skip = [ 'attachment', 'elementor_library', 'e-landing-page', 'e-floating-buttons', 'jet-engine', 'jet-menu', 'wp_block', 'acf-field-group', 'acf-field', 'acf-post-type', 'acf-taxonomy' ];
$types = [];
foreach ( get_post_types( [ 'public' => true, '_builtin' => false ], 'objects' ) as $t ) {
	if ( in_array( $t->name, $skip, true ) ) { continue; }
	$entries = [];
	foreach ( get_posts( [ 'post_type' => $t->name, 'post_status' => 'publish', 'numberposts' => 300, 'orderby' => 'menu_order title', 'order' => 'ASC' ] ) as $p ) {
		$entries[] = [ 'id' => $p->ID, 'slug' => $p->post_name, 'title' => html_entity_decode( get_the_title( $p ), ENT_QUOTES ), 'url' => get_permalink( $p ) ];
	}
	$l = $t->labels;
	$types[ $t->name ] = true;
	$out['types'][] = [ 'name' => $t->name, 'label' => $l->name, 'hierarchical' => (bool) $t->hierarchical,
		'rewrite' => is_array( $t->rewrite ) ? ( $t->rewrite['slug'] ?? $t->name ) : null, 'has_archive' => (bool) $t->has_archive,
		'rest_base' => $t->show_in_rest ? ( $t->rest_base ? $t->rest_base : $t->name ) : null,
		'labels' => [ 'search_items' => $l->search_items, 'not_found' => $l->not_found, 'not_found_in_trash' => $l->not_found_in_trash, 'view_item' => $l->view_item, 'item_published' => $l->item_published ?? '', 'item_updated' => $l->item_updated ?? '' ],
		'entries' => $entries ];
}
if ( $out['acf'] ) {
	foreach ( acf_get_field_groups() as $g ) {
		$fields = [];
		$walk = function ( $fs, $prefix, $nested ) use ( &$walk, &$fields ) {
			foreach ( (array) $fs as $f ) {
				$fields[] = [ 'name' => $prefix . $f['name'], 'label' => $f['label'], 'type' => $f['type'], 'nested' => $nested, 'help' => '' !== trim( (string) ( $f['instructions'] ?? '' ) ), 'cond' => ! empty( $f['conditional_logic'] ) ];
				if ( 'group' === $f['type'] && ! empty( $f['sub_fields'] ) ) { $walk( $f['sub_fields'], $prefix . $f['name'] . '_', $nested ); }
				if ( in_array( $f['type'], [ 'repeater', 'flexible_content' ], true ) ) {
					$walk( $f['sub_fields'] ?? [], $prefix . $f['name'] . '_N_', true );
					foreach ( (array) ( $f['layouts'] ?? [] ) as $lay ) { $walk( $lay['sub_fields'] ?? [], $prefix . $f['name'] . '_N_', true ); }
				}
			}
		};
		$walk( acf_get_fields( $g ) ?: [], '', false );
		$on = [];
		foreach ( (array) ( $g['location'] ?? [] ) as $or ) { foreach ( (array) $or as $rule ) { if ( 'post_type' === ( $rule['param'] ?? '' ) && '==' === ( $rule['operator'] ?? '' ) && isset( $types[ $rule['value'] ] ) ) { $on[] = $rule['value']; } } }
		$on = array_values( array_unique( $on ) );
		// How many published entries of each post type fill each top-level field.
		$filled = [];
		foreach ( $on as $type ) {
			foreach ( $fields as $f ) {
				if ( $f['nested'] ) { continue; }
				$filled[ $type ][ $f['name'] ] = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(DISTINCT pm.post_id) FROM {$wpdb->postmeta} pm JOIN {$wpdb->posts} p ON p.ID = pm.post_id WHERE p.post_type = %s AND p.post_status = 'publish' AND pm.meta_key = %s AND pm.meta_value NOT IN ( '', '0', 'a:0:{}' )", $type, $f['name'] ) );
			}
		}
		$out['groups'][] = [ 'key' => $g['key'], 'title' => $g['title'], 'id' => (int) ( $g['ID'] ?? 0 ), 'local' => (string) ( $g['local'] ?? '' ), 'types' => $on, 'fields' => $fields, 'filled' => $filled ];
	}
	// Links stored as typed text: custom fields ending in slug / href that hold an internal path or a slug.
	foreach ( $wpdb->get_results( "SELECT meta_key, meta_value FROM {$wpdb->postmeta} pm JOIN {$wpdb->posts} p ON p.ID = pm.post_id WHERE p.post_status = 'publish' AND pm.meta_key NOT LIKE '\_%' AND ( pm.meta_key LIKE '%slug' OR pm.meta_key LIKE '%href' ) AND pm.meta_value <> '' LIMIT 5000" ) as $r ) {
		if ( ! preg_match( '#^(/[a-z0-9/_-]*|[a-z0-9][a-z0-9-]*)$#', $r->meta_value ) ) { continue; }
		$k = preg_replace( '/_\d+_/', '_N_', $r->meta_key );
		$out['refs'][ $k ] = ( $out['refs'][ $k ] ?? 0 ) + 1;
	}
}
// REST: does each post type return ACF values (as pages and posts may)?
foreach ( array_merge( [ [ 'name' => 'page', 'rest_base' => 'pages' ], [ 'name' => 'post', 'rest_base' => 'posts' ] ], $out['types'] ) as $t ) {
	if ( empty( $t['rest_base'] ) ) { continue; }
	$req = new WP_REST_Request( 'GET', '/wp/v2/' . $t['rest_base'] );
	$req->set_param( 'per_page', 1 );
	$data = rest_do_request( $req )->get_data();
	$first = is_array( $data ) && isset( $data[0] ) && is_array( $data[0] ) ? $data[0] : null;
	if ( $first ) { $out['rest'][ $t['name'] ] = ! empty( $first['acf'] ); }
}
echo '<<<WPEQA>>>' . wp_json_encode( $out ) . '<<</WPEQA>>>';
`;

export const editableFacts = install => wpEvalJson(install, PHP);

// Each custom post type page as visitors get it: title, meta description, H1. Gentle (Cloudflare answers 429 to bursts).
export async function fetchEntryPages(urls, { concurrency = 3 } = {}) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  return pool(urls, concurrency, async url => {
    let r;
    for (const wait of [0, 2000, 6000, 12000]) { if (wait) await sleep(wait); r = await fetchText(url); if (r.status !== 429 && r.status !== 0) break; }
    const html = r.text || '';
    return {
      url, status: r.status,
      title: decode((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]),
      description: decode((html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) || html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i) || [])[1]),
    };
  });
}

// Hub URLs per post type: /<rewrite slug>/ and its plural, with where each ends up and its title.
export async function fetchHubs(home, types) {
  const out = [];
  for (const t of types) {
    if (!t.rewrite || t.rewrite.includes('/') || t.rewrite.includes('%')) continue;
    const forms = [t.rewrite, /s$/.test(t.rewrite) ? null : `${t.rewrite}s`].filter(Boolean);
    for (const f of forms) {
      const r = await fetchText(`${home}/${f}/`);
      out.push({ type: t.name, path: `/${f}/`, plural: f !== t.rewrite, status: r.status, final: pathOf(r.url), title: decode((r.text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]) });
    }
  }
  return out;
}

// Does a slug still name its entry? True when a slug word is a title word, the slug is the title run together
// (unitedhealthcare), or the slug is the title's initials (bcbs, ccha).
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'our', 'into', 'in', 'of', 'to', 'a', 'an', 'at', 'on', 'by']);
const words = s => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w));
export function slugMatchesTitle(slug, title) {
  const sw = words(slug.replace(/-/g, ' ')), tw = words(title);
  if (!sw.length || !tw.length) return true;
  if (sw.some(w => tw.includes(w))) return true;
  const joined = slug.replace(/-/g, '');
  if (tw.includes(joined)) return true;
  const initials = String(title).toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w)).map(w => w[0]).join('');
  return joined.length >= 2 && initials === joined;
}

// The labels WordPress falls back to (from Posts or Pages) when a post type does not set its own.
const FALLBACK = /\b(posts?|pages?)\b/i;

// The findings that need the pages themselves (fetched); every other finding comes from the one WP-CLI call.
export const PAGE_KEYS = ['meta-descriptions', 'plural-hub', 'hub-titles', 'brand-in-titles', 'title-length', 'title-case'];

// Facts → the item's result, with one child per problem found. `pages`: fetched entry pages; `hubs`: fetchHubs().
// `skipPages`: a fix run's re-check of findings that don't need the pages: those findings are left out (not judged),
// and `evaluated` lists the ones this result covers, so the others keep their last result.
export function analyzeEditable(facts, pages = [], hubs = [], { skipPages = false } = {}) {
  const types = facts.types || [];
  if (!types.length && !(facts.groups || []).length) return { status: 'pass', summary: 'No custom post types or ACF field groups: nothing to review here.', children: [] };
  const typeOf = Object.fromEntries(types.map(t => [t.name, t]));
  const pageBy = new Map(pages.map(p => [p.url, p]));
  const entryPages = t => t.entries.map(e => ({ ...e, page: pageBy.get(e.url) })).filter(e => e.page && e.page.status === 200);
  const checks = [];
  const add = (key, title, description, problems, { status = 'warn', summary, ok }) => (skipPages && PAGE_KEYS.includes(key)) || checks.push(problems.length
    ? { key, title, description, status, summary: summary(problems), details: cap(problems.map(p => p.line)) }
    : { key, title, description, status: 'pass', summary: ok });

  // 1. Admin screens say "Posts" because the post type leaves labels to WordPress's defaults.
  add('cpt-labels', 'Post type labels in wp-admin', 'Each custom post type sets its own admin labels, so editors never see “Search Posts” or “No posts found” on its screens.',
    types.flatMap(t => { const bad = Object.entries(t.labels || {}).filter(([, v]) => v && FALLBACK.test(v)); return bad.length ? [{ line: `${t.label}: ${bad.map(([k, v]) => `${k} = “${v}”`).join(', ')}` }] : []; }),
    { status: 'fail', summary: p => `${plural(p.length, 'post type')} still show WordPress’s default “Posts” labels in wp-admin.`, ok: `All ${plural(types.length, 'custom post type')} set their own admin labels.` });

  // 2. Fields no entry fills in: missing content (an empty logo or photo field) or a field nobody uses. Only groups made
  // for one post type: a shared group (hero, FAQ, SEO on every type) has optional fields by design (see field-help).
  const empty = [];
  for (const g of (facts.groups || []).filter(x => x.types.length === 1)) for (const [type, counts] of Object.entries(g.filled || {})) {
    const n = typeOf[type]?.entries.length || 0; if (n < 2) continue;
    for (const f of g.fields) if (!f.nested && VALUE_TYPES.includes(f.type) && counts[f.name] === 0) empty.push({ type, n, f, line: `${typeOf[type].label} (${plural(n, 'entry', 'entries')}): ${f.label || f.name} (${f.name}, ${f.type}) is empty on all ${n}` });
  }
  const media = empty.some(e => ['image', 'file', 'gallery'].includes(e.f.type));
  add('empty-fields', 'Fields no entry fills in', 'Every field in a post type’s own field group is filled in on its entries, or removed when it isn’t used.',
    empty, { status: media ? 'fail' : 'warn', summary: p => `${plural(p.length, 'field')} ${p.length === 1 ? 'is' : 'are'} empty on every published entry${media ? ', including image fields' : ''}. Fill them in, or remove fields nobody uses.`, ok: 'Every field is filled in on at least one entry of its post type.' });

  // 3. Post types whose pages print no meta description.
  const noDesc = types.map(t => { const e = entryPages(t); const missing = e.filter(x => !x.page.description); return { t, e, missing }; }).filter(x => x.e.length && x.missing.length);
  add('meta-descriptions', 'Meta descriptions on post type pages', 'Every custom post type page prints a meta description (written in the SEO plugin, or set by its template).',
    noDesc.map(x => ({ line: `${x.t.label}: ${x.missing.length} of ${x.e.length} pages have none (e.g. ${cap(x.missing.map(m => pathOf(m.url)), 3).join(', ')})` })),
    { status: 'fail', summary: p => `${plural(noDesc.reduce((a, x) => a + x.missing.length, 0), 'page')} in ${plural(p.length, 'post type')} print no meta description.`, ok: 'Every custom post type page checked prints a meta description.' });

  // 4. Big field groups with no help for editors.
  const noHelp = (facts.groups || []).map(g => { const top = g.fields.filter(f => VALUE_TYPES.includes(f.type)); return { g, top, help: top.filter(f => f.help).length, cond: g.fields.filter(f => f.cond).length }; }).filter(x => x.top.length >= 8 && x.help === 0);
  add('field-help', 'Help text for editors', 'Field groups with many fields give editors short instructions, and hide fields that don’t apply.',
    noHelp.map(x => ({ line: `${x.g.title}: 0 of ${x.top.length} fields have instructions${x.cond ? '' : '; no conditional logic'}${x.g.types.length ? ` (on ${x.g.types.map(t => typeOf[t]?.label || t).join(', ')})` : ''}` })),
    { summary: p => `${plural(p.length, 'field group')} with 8 or more fields give${p.length === 1 ? 's' : ''} editors no instructions.`, ok: 'Field groups with many fields have instructions for editors.' });

  // 5. SEO title / description stored twice: an ACF copy next to the SEO plugin's.
  const seoDup = (facts.seo || []).length ? (facts.groups || []).flatMap(g => g.fields.filter(f => !f.nested && SEO_FIELD.test(f.name)).map(f => ({ line: `${g.title}: ${f.label || f.name} (${f.name}) next to ${facts.seo.join(' / ')}` }))) : [];
  add('seo-duplicates', 'SEO fields stored once', 'SEO titles and descriptions are edited in one place. An ACF copy next to the SEO plugin’s is easy to edit by mistake and does nothing.',
    seoDup, { summary: p => `${plural(p.length, 'ACF field')} duplicate${p.length === 1 ? 's' : ''} what ${facts.seo.join(' / ')} already stores.`, ok: (facts.seo || []).length ? `No ACF copies of ${facts.seo.join(' / ')}’s SEO fields.` : 'No SEO plugin, so no duplicate SEO fields.' });

  // 6. Field groups that exist only in the database (not in the theme's code or JSON): lost on the next deploy or restore.
  const dbOnly = (facts.groups || []).filter(g => g.id > 0 && !g.local);
  add('db-only-groups', 'Field groups kept in code', 'Field groups are saved with the theme (PHP or acf-json), not only in the database, so they deploy and restore with it.',
    dbOnly.map(g => ({ line: `${g.title} (${g.key}): only in the database` })),
    { summary: p => `${plural(p.length, 'field group')} exist${p.length === 1 ? 's' : ''} only in the database.`, ok: 'Every field group is saved with the theme.' });

  // 7. REST: some types return ACF values and custom post types don't (inconsistent for imports and integrations).
  const rest = facts.rest || {}; const withAcf = Object.keys(rest).filter(k => rest[k]);
  const restMissing = withAcf.length ? types.filter(t => rest[t.name] === false && (facts.groups || []).some(g => g.types.includes(t.name))) : [];
  add('rest-acf', 'Custom fields in the REST API', 'Post types with custom fields return them in the REST API the same way (when any type does), so imports and integrations can read them.',
    restMissing.map(t => ({ line: `${t.label} (/wp-json/wp/v2/${t.rest_base}): no ACF values, while ${withAcf.join(', ')} return them` })),
    { summary: p => `${plural(p.length, 'post type')} with custom fields return no ACF values in the REST API.`, ok: withAcf.length ? 'Every post type with custom fields returns them in the REST API.' : 'No post type returns ACF values in the REST API (consistent).' });

  // 8. Slugs that no longer name their entry (renamed person, program or page).
  const slugOff = types.flatMap(t => t.entries.filter(e => !slugMatchesTitle(e.slug, e.title)).map(e => ({ line: `${pathOf(e.url)} is “${e.title}”` })));
  add('slug-title', 'URLs match their entries', 'Each entry’s URL names it. When a title changes for good, the slug changes too, with a redirect from the old one.',
    slugOff, { summary: p => `${plural(p.length, 'entry', 'entries')} ha${p.length === 1 ? 's' : 've'} a URL that doesn’t match the title.`, ok: 'Every entry’s URL matches its title.' });

  // 9 + 10. Hub URLs: the plural form people guess, and hub pages still titled "… Archive".
  const plural404 = hubs.filter(h => h.plural && h.status === 404 && hubs.some(s => s.type === h.type && !s.plural && s.status === 200));
  add('plural-hub', 'Plural hub URLs', 'If a post type lives at /location/…, then /locations/ also reaches its hub (people guess the plural).',
    plural404.map(h => ({ line: `${h.path} → 404, while /${typeOf[h.type]?.rewrite}/ works` })),
    { summary: p => `${plural(p.length, 'plural hub URL')} return 404.`, ok: 'Plural hub URLs work, or no post type needs one.' });
  const seenHub = new Set();
  const archiveTitle = hubs.filter(h => h.status === 200 && /\barchive\b/i.test(h.title) && !seenHub.has(h.final) && seenHub.add(h.final));
  add('hub-titles', 'Hub page titles', 'Hub pages have a real title, not a leftover “… Archive”.',
    archiveTitle.map(h => ({ line: `${h.final}: “${h.title}”` })),
    { summary: p => `${plural(p.length, 'hub page')} still titled “Archive”.`, ok: 'No hub page is titled “Archive”.' });

  // 11 + 12 + 13. Titles of post type pages: brand, length, consistent state code.
  const all = types.flatMap(t => entryPages(t).map(e => ({ ...e, type: t })));
  const brand = facts.blogname || '';
  const branded = brand ? all.filter(e => e.page.title.toLowerCase().includes(brand.toLowerCase())) : [];
  const unbranded = brand && branded.length >= all.length / 2 ? all.filter(e => !e.page.title.toLowerCase().includes(brand.toLowerCase())) : [];
  add('brand-in-titles', 'Brand name in titles', `Post type page titles end with the brand name (${brand || 'the site name'}), like most of the site’s titles.`,
    unbranded.map(e => ({ line: `${pathOf(e.url)}: “${e.page.title}”` })),
    { summary: p => `${plural(p.length, 'page')} leave${p.length === 1 ? 's' : ''} “${brand}” out of the title, unlike the other ${branded.length}.`, ok: brand ? `Post type page titles include “${brand}” consistently.` : 'No site name to compare titles with.' });
  const long = all.filter(e => e.page.title.length > 65);
  add('title-length', 'Title length', 'Post type page titles stay within about 65 characters, so search results show them whole.',
    long.map(e => ({ line: `${pathOf(e.url)} (${e.page.title.length}): “${e.page.title}”` })),
    { summary: p => `${plural(p.length, 'title')} run past 65 characters (longest ${Math.max(...p.map(x => x.line.match(/\((\d+)\)/)[1]))}).`, ok: 'Post type page titles are 65 characters or shorter.' });
  const codes = new Map();
  for (const e of all) for (const s of [e.title, e.page.title]) for (const m of String(s).matchAll(/,\s*([A-Za-z]{2})\b/g)) { const k = m[1].toUpperCase(); if (!codes.has(k)) codes.set(k, new Map()); const v = codes.get(k); if (!v.has(m[1])) v.set(m[1], new Set()); v.get(m[1]).add(pathOf(e.url)); }
  const mixed = [...codes.entries()].filter(([, v]) => v.size > 1);
  add('title-case', 'Consistent wording in titles', 'Abbreviations in titles and H1s are written one way (for example always “CO”, never “Co”).',
    mixed.flatMap(([, v]) => [...v.entries()].map(([form, paths]) => ({ line: `“, ${form}” on ${paths.size}: ${cap([...paths], 4).join(', ')}` }))),
    { summary: p => `${plural(mixed.length, 'abbreviation')} written more than one way: ${mixed.map(([, v]) => [...v.keys()].join(' / ')).join('; ')}.`, ok: 'Abbreviations are written the same way in every title.' });

  // 14. Related items and buttons linked by typed slugs or paths instead of relationship or link fields.
  const linkFields = (facts.groups || []).some(g => g.fields.some(f => LINK_TYPES.includes(f.type)));
  const refs = Object.entries(facts.refs || {}).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  add('slug-references', 'Links between entries', 'Related items and buttons point to entries with Relationship or Link fields, so renaming a slug can’t silently break them.',
    refs.map(([k, n]) => ({ line: `${k.replace(/_N_/g, '[n].')}: ${n} values typed as a slug or path` })),
    { summary: p => `${plural(p.length, 'field')} store links to other entries as typed slugs or paths${linkFields ? '' : ', and the site has no Relationship or Link fields'}. Renaming a slug breaks them without warning.`, ok: 'No links between entries are stored as typed slugs or paths.' });

  const found = checks.filter(c => c.status !== 'pass');
  const worst = found.some(c => c.status === 'fail') ? 'fail' : found.length ? 'warn' : 'pass';
  const scope = `${plural(types.length, 'post type')}, ${plural(types.reduce((a, t) => a + t.entries.length, 0), 'entry', 'entries')} and ${plural((facts.groups || []).length, 'ACF field group')}`;
  // Pages that didn't load (rate limits, timeouts): the page checks above skipped them, so say so.
  const unchecked = types.flatMap(t => t.entries).filter(e => !(pageBy.get(e.url)?.status === 200));
  const skipped = pages.length && unchecked.length ? [`Not loaded, so the page checks skipped them: ${plural(unchecked.length, 'page')} (${cap(unchecked.map(e => `${pathOf(e.url)} → ${pageBy.get(e.url)?.status || 'not fetched'}`), 8).join(', ')}). Run Tool again to include them.`] : [];
  return {
    status: worst,
    summary: found.length ? `${plural(found.length, 'finding')} across ${scope} (each below, with its own Approve / Decline).` : `Checked ${scope}: nothing to fix.`,
    details: [...skipped, ...checks.filter(c => c.status === 'pass').map(c => `${c.title}: ${c.summary}`)],
    children: found,
    ...(skipPages ? { evaluated: checks.map(c => c.key) } : {}),
  };
}

export const EDITABLE = {
  'audit.editable': async ctx => {
    if (!ctx.site.install) return { status: 'warn', summary: 'Needs the WP Engine install name to read the post types and fields over SSH.' };
    const facts = await editableFacts(ctx.site.install);
    // A fix run's re-check of findings that don't need the pages: skip fetching them (minutes on a big site).
    // (Only children were asked for, never the whole item, and none of them is a page finding.)
    const kids = (ctx.only || []).filter(o => o.includes('::')), parents = new Set(kids.map(o => o.split('::')[0]));
    if (kids.length && !ctx.only.some(o => parents.has(o)) && kids.every(o => !PAGE_KEYS.includes(o.split('::').pop()))) return analyzeEditable(facts, [], [], { skipPages: true });
    // Pages are fetched at the address being audited (the WordPress home may still be another domain).
    const home = new URL(ctx.home).origin;
    const at = u => { try { const x = new URL(u); return home + x.pathname + x.search; } catch { return u; } };
    for (const t of facts.types || []) for (const e of t.entries) e.url = at(e.url);
    const urls = (facts.types || []).flatMap(t => t.entries.map(e => e.url)).slice(0, 400);
    // Pages the run's crawl already loaded (title and meta description as the browser saw them) aren't fetched again.
    const key = u => { try { const x = new URL(u); return (x.pathname.replace(/\/+$/, '') || '/').toLowerCase(); } catch { return u; } };
    const crawled = new Map();
    for (const p of (ctx.pages ? await ctx.pages().catch(() => []) : [])) if (p?.status === 200) crawled.set(key(p.url), { status: 200, title: p.title || '', description: p.metaDescription || '' });
    const fetched = await fetchEntryPages(urls.filter(u => !crawled.has(key(u))));
    const pages = [...urls.filter(u => crawled.has(key(u))).map(u => ({ url: u, ...crawled.get(key(u)) })), ...fetched];
    const hubs = await fetchHubs(home, facts.types || []);
    return analyzeEditable(facts, pages, hubs);
  },
};
