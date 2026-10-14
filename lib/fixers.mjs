// Automatic fixes for approved items, keyed by the item's check key.
// Only settings-level changes with a clear, reversible fix live here; everything else becomes a
// fix request for a developer. Each fixer returns a bash snippet that runs inside ~/sites/<install>
// (where `php_eval` runs PHP from stdin inside WordPress), or null when it can't run (with why).

const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// PHP single-quoted string literal (values placed inside PHP code).
const phpq = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const php = code => `php_eval <<'WPEQA_PHP'\n<?php\n${code}\nWPEQA_PHP`;
const SLUG = /^[a-z0-9][a-z0-9-]{2,40}$/;
const EMAIL = /^[^\s@'"]+@[^\s@'"]+\.[a-z]{2,}$/i;

export const FIXERS = {
  'wp.comments': {
    action: 'Close comments and pingbacks for new posts, and on every published page and post.',
    script: () => php(`update_option( 'default_comment_status', 'closed' );
update_option( 'default_ping_status', 'closed' );
global $wpdb;
$n = $wpdb->query( "UPDATE {$wpdb->posts} SET comment_status = 'closed', ping_status = 'closed' WHERE post_status = 'publish' AND post_type IN ('post','page') AND ( comment_status = 'open' OR ping_status = 'open' )" );
echo "Comments closed by default; closed on $n published items.\\n";`),
  },
  'wp.stagingNoindex': {
    action: 'Turn on “Discourage search engines” (blog_public = 0).',
    script: () => 'wp option update blog_public 0',
  },
  'wp.indexable': {
    action: 'Allow search engines to index the site (blog_public = 1).',
    script: () => 'wp option update blog_public 1',
  },
  'wp.uncategorized': {
    action: item => `Rename the default “Uncategorized” category to “${categoryName(item)}” (type a different name in the note to change it).`,
    script: item => php(`$id = (int) get_option( 'default_category' );
$t = get_term( $id, 'category' );
if ( ! $t || is_wp_error( $t ) ) { echo "No default category.\\n"; return; }
if ( 'uncategorized' !== $t->slug ) { echo "Already renamed to {$t->name}.\\n"; return; }
$name = ${phpq(categoryName(item))};
$r = wp_update_term( $id, 'category', array( 'name' => $name, 'slug' => sanitize_title( $name ) ) );
echo is_wp_error( $r ) ? 'Failed: ' . $r->get_error_message() . "\\n" : "Renamed Uncategorized to $name.\\n";`),
  },
  'wp.placeholderPosts': {
    action: 'Move the Hello World post and Sample Page to the trash (restorable from Trash for 30 days).',
    script: () => trashPlaceholders,
  },
  'audit.junkPosts': {
    action: 'Move the Hello World post and Sample Page to the trash. Slug collisions are left for a developer.',
    script: () => trashPlaceholders,
  },
  'wp.permalinks': {
    action: 'Set permalinks to “Post name” (/%postname%/) and flush rewrite rules.',
    script: () => "wp rewrite structure '/%postname%/' && wp rewrite flush && echo 'Permalinks set to /%postname%/.'",
  },
  'wp.activityLog': {
    action: 'Install and activate WP Activity Log from wordpress.org.',
    script: () => 'wp plugin install wp-security-audit-log --activate',
  },
  'wp.hideLogin': {
    action: item => SLUG.test(slugFrom(item)) ? `Install and activate WPS Hide Login and move the login page to /${slugFrom(item)}/.` : null,
    why: 'Type the new login slug (e.g. team-login) in the note, then approve again.',
    script: item => `wp plugin install wps-hide-login --activate && wp option update whl_page ${sq(slugFrom(item))} && echo 'Login page is now /${slugFrom(item)}/'`,
  },
  'wp.plugins': {
    action: 'Update every plugin that has an update (the plugins folder is backed up first).',
    backupPlugins: true,
    script: () => 'wp plugin update --all',
  },
  'wp.coreUpdate': {
    action: 'Update WordPress core and run the database update.',
    script: () => 'wp core update && wp core update-db',
  },
  'wp.adminEmail': {
    action: (item, site) => EMAIL.test(site.adminEmail || '') ? `Set the admin email to ${site.adminEmail}.` : null,
    why: 'Set the expected admin email in Site settings first.',
    script: (item, site) => php(`update_option( 'admin_email', ${phpq(site.adminEmail)} );
delete_option( 'new_admin_email' ); delete_option( 'adminhash' );
echo "Admin email set to " . get_option( 'admin_email' ) . "\\n";`),
  },
  'wp.oldUrls': {
    action: (item, site) => site.install ? `Replace https://${site.install}.wpenginepowered.com with the site address in content, custom fields and options (dry run first; GUIDs untouched). Local (.local) URLs are left for a developer.` : null,
    why: 'Needs the WP Engine install name.',
    script: (item, site) => `home=$(wp option get home)
old=${sq(`https://${site.install}.wpenginepowered.com`)}
if [ "$home" = "$old" ]; then echo "The site address is still the staging domain; nothing to replace."; exit 0; fi
echo "Dry run:"; wp search-replace "$old" "$home" --skip-columns=guid --precise --dry-run --report-changed-only
wp search-replace "$old" "$home" --skip-columns=guid --precise --report-changed-only`,
  },
};

const trashPlaceholders = php(`global $wpdb;
$ids = $wpdb->get_col( "SELECT ID FROM {$wpdb->posts} WHERE post_type IN ('post','page') AND post_status IN ('publish','draft','private') AND ( post_name IN ('hello-world','sample-page') OR post_title IN ('Hello world!','Sample Page') )" );
foreach ( $ids as $id ) { $t = get_the_title( $id ); wp_trash_post( (int) $id ); echo "Trashed: $t ($id)\\n"; }
if ( ! $ids ) { echo "No Hello World or Sample Page found.\\n"; }`);

function categoryName(item) {
  const n = String(item.note || '').trim();
  return n && n.length <= 40 && /^[\p{L}\p{N} &'-]+$/u.test(n) ? n : 'General';
}
function slugFrom(item) {
  return String(item.note || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

// What would happen for each approved item: { auto: [...], manual: [...] }.
export function planFixes(template, tabState, site) {
  const auto = [], manual = [];
  for (const sec of template.sections) for (const it of sec.items) {
    const s = tabState.items?.[it.id];
    if (!s || s.decision !== 'approve' || !['fail', 'warn'].includes(s.status)) continue;
    // Already fixed, or already in a fix request, for this same finding: skip until the checks run again.
    if (['verified', 'manual'].includes(s.fix?.state) && s.fix.toolAt === s.tool?.at) continue;
    const f = FIXERS[it.check];
    const item = { ...it, note: s.note, decisionNote: s.decisionNote, finding: s.tool };
    const action = f && (typeof f.action === 'function' ? f.action(item, site) : f.action);
    if (f && action && site.install) auto.push({ id: it.id, title: it.title, check: it.check, action, item });
    else manual.push({ id: it.id, title: it.title, check: it.check, reason: !site.install ? 'No WP Engine install for this site.' : f ? f.why : 'Needs a developer (theme, content or judgment).', item });
  }
  return { auto, manual };
}

export function fixRequest(site, template, plan, backup) {
  const lines = [
    `Fix the approved QA items for ${site.name} (${site.url}${site.install ? `, WP Engine install ${site.install}` : ''}).`,
    `Checklist: ${template.title}.${backup ? ` A backup was taken before this run: ${backup}` : ' Take a backup (database + theme) before changing anything.'}`,
    'Follow the usual production process: check the server copy for edits by others before uploading, change only what is approved, clear caches, then verify on the site.',
    '',
  ];
  for (const m of plan.manual) {
    lines.push(`- ${m.title}`);
    if (m.item.finding?.summary) lines.push(`  Finding: ${m.item.finding.summary}`);
    for (const d of (m.item.finding?.details || []).slice(0, 10)) lines.push(`    - ${d}`);
    if (m.item.finding?.suggestion) lines.push(`  Suggested fix: ${m.item.finding.suggestion.text}`);
    if (m.item.note) lines.push(`  Note: ${m.item.note}`);
    if (m.item.decisionNote) lines.push(`  Fix note: ${m.item.decisionNote}`);
  }
  return lines.join('\n');
}
