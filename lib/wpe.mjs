// WP Engine access over SSH. Read-only: every call here only reads.
// The SSH gateway strips quotes from the command line, so scripts go in on stdin ('bash -s').
import { spawn } from 'node:child_process';

const INSTALL_RE = /^[a-z0-9]{3,30}$/;

export function assertInstall(install) {
  if (!INSTALL_RE.test(install || '')) throw new Error(`"${install}" is not a WP Engine install name (lowercase letters and digits).`);
  return install;
}

export const sshHost = install => `${assertInstall(install)}@${install}.ssh.wpengine.net`;
export const installUrl = install => `https://${assertInstall(install)}.wpenginepowered.com`;

export function ssh(install, script, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', sshHost(install), 'bash -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('SSH timed out')); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      clearTimeout(t);
      if (code !== 0 && !out) return reject(new Error(`SSH failed (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`));
      resolve(out);
    });
    p.stdin.end(script);
  });
}

// Runs PHP inside WordPress with `wp eval-file` and returns the JSON it prints between markers.
export async function wpEvalJson(install, php) {
  const script = `cd ~/sites/${assertInstall(install)} || exit 3
f=$(mktemp /tmp/wpeqa.XXXXXX.php)
cat > "$f" <<'WPEQA_PHP'
${php}
WPEQA_PHP
wp eval-file "$f" 2>/dev/null
rm -f "$f"
`;
  const out = await ssh(install, script);
  const m = out.match(/<<<WPEQA>>>([\s\S]*?)<<<\/WPEQA>>>/);
  if (!m) throw new Error('WordPress did not return data. Check the install name and that WP-CLI works over SSH.');
  return JSON.parse(m[1]);
}

// Everything the WordPress-side checks need, in one call.
export function siteFacts(install) {
  return wpEvalJson(install, FACTS_PHP);
}

const FACTS_PHP = String.raw`<?php
global $wpdb;
if ( ! function_exists( 'get_plugins' ) ) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
wp_update_plugins();
wp_version_check();
$upd = get_site_transient( 'update_plugins' );
$plugins = array();
foreach ( get_plugins() as $file => $p ) {
	$plugins[] = array(
		'file'    => $file,
		'name'    => $p['Name'],
		'version' => $p['Version'],
		'active'  => is_plugin_active( $file ),
		'update'  => isset( $upd->response[ $file ] ) ? $upd->response[ $file ]->new_version : null,
	);
}
$core_new = null;
$core = get_site_transient( 'update_core' );
if ( $core && ! empty( $core->updates ) ) {
	foreach ( $core->updates as $u ) { if ( 'upgrade' === $u->response ) { $core_new = $u->current; break; } }
}
$mu = array();
foreach ( get_mu_plugins() as $file => $p ) { $mu[] = array( 'file' => $file, 'name' => $p['Name'] ); }
$theme = wp_get_theme();
$authors = $wpdb->get_results( "SELECT u.user_login AS login, u.display_name AS name, COUNT(*) AS posts FROM {$wpdb->posts} p JOIN {$wpdb->users} u ON u.ID = p.post_author WHERE p.post_type = 'post' AND p.post_status = 'publish' GROUP BY u.ID", ARRAY_A );
$default_cat = get_term( (int) get_option( 'default_category' ), 'category' );
$public_types = array_values( array_diff( get_post_types( array( 'public' => true, '_builtin' => false ) ), array( 'attachment' ) ) );
$no_thumb = function ( $type ) use ( $wpdb ) {
	return $wpdb->get_results( $wpdb->prepare( "SELECT p.ID AS id, p.post_title AS title, p.post_name AS slug FROM {$wpdb->posts} p LEFT JOIN {$wpdb->postmeta} m ON m.post_id = p.ID AND m.meta_key = '_thumbnail_id' WHERE p.post_type = %s AND p.post_status = 'publish' AND ( m.meta_value IS NULL OR m.meta_value = '' OR m.meta_value = '0' ) LIMIT 200", $type ), ARRAY_A );
};
$cpt_missing = array();
foreach ( $public_types as $t ) { $cpt_missing[ $t ] = $no_thumb( $t ); }
$page_slugs = $wpdb->get_col( "SELECT post_name FROM {$wpdb->posts} WHERE post_type = 'page' AND post_status = 'publish'" );
$collisions = $page_slugs ? $wpdb->get_results( "SELECT ID AS id, post_title AS title, post_name AS slug FROM {$wpdb->posts} WHERE post_type = 'post' AND post_status = 'publish' AND post_name IN ('" . implode( "','", array_map( 'esc_sql', $page_slugs ) ) . "')", ARRAY_A ) : array();
$junk = $wpdb->get_results( "SELECT ID AS id, post_type AS type, post_status AS status, post_title AS title, post_name AS slug FROM {$wpdb->posts} WHERE post_status IN ('publish','draft','private') AND ( post_name IN ('hello-world','sample-page') OR post_title IN ('Hello world!','Sample Page') OR post_content LIKE '%lorem ipsum%' ) AND post_type IN ('post','page')", ARRAY_A );
$home_host = wp_parse_url( home_url(), PHP_URL_HOST );
$old_hosts = array_values( array_unique( array_filter( array( basename( ABSPATH ) . '.wpenginepowered.com', basename( ABSPATH ) . '.wpengine.com', '.local/', 'localhost:' ) ) ) );
$old_url_hits = array();
foreach ( $old_hosts as $h ) {
	if ( $home_host && false !== strpos( $h, $home_host ) ) { continue; }
	$like = '%' . $wpdb->esc_like( $h ) . '%';
	$old_url_hits[ $h ] = array(
		'posts'   => (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_status IN ('publish','draft','private') AND post_content LIKE %s", $like ) ),
		'meta'    => (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_value LIKE %s", $like ) ),
		'options' => (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_value LIKE %s AND option_name NOT LIKE '%%transient%%'", $like ) ),
	);
}
$yoast_titles = get_option( 'wpseo_titles' );
$yoast_meta = $wpdb->get_results( "SELECT p.post_title AS title, m.meta_value AS seo_title FROM {$wpdb->postmeta} m JOIN {$wpdb->posts} p ON p.ID = m.post_id WHERE m.meta_key = '_yoast_wpseo_title' AND p.post_status = 'publish' AND m.meta_value <> '' LIMIT 500", ARRAY_A );
$pages_no_thumb = $no_thumb( 'page' );
$privacy_id = (int) get_option( 'wp_page_for_privacy_policy' );
// Theme build files (Tailwind/custom builds): package.json, configs, README, compiled CSS and template ages.
$theme_build = ( function () use ( $theme ) {
	$dir = get_stylesheet_directory();
	$out = array( 'package' => null, 'tailwind_version' => null, 'configs' => array(), 'readme' => null, 'tested_up_to' => $theme->get( 'Tested up to' ) ? $theme->get( 'Tested up to' ) : null, 'css' => null, 'newest_template' => null );
	if ( is_readable( $dir . '/package.json' ) ) {
		$j = json_decode( (string) file_get_contents( $dir . '/package.json' ), true );
		$deps = array_merge( (array) ( $j['dependencies'] ?? array() ), (array) ( $j['devDependencies'] ?? array() ) );
		$out['package'] = array( 'scripts' => is_array( $j['scripts'] ?? null ) ? $j['scripts'] : array() );
		foreach ( array( 'tailwindcss', '@tailwindcss/cli', '@tailwindcss/postcss', '@tailwindcss/vite' ) as $d ) { if ( isset( $deps[ $d ] ) ) { $out['tailwind_version'] = $deps[ $d ]; break; } }
	}
	foreach ( array( 'tailwind.config', 'postcss.config', 'vite.config', 'webpack.config' ) as $c ) { foreach ( array( 'js', 'cjs', 'mjs', 'ts' ) as $e ) { if ( file_exists( "$dir/$c.$e" ) ) { $out['configs'][] = "$c.$e"; } } }
	foreach ( array( 'README.md', 'readme.md', 'README.txt', 'README', 'BUILD.md', 'docs/README.md' ) as $r ) {
		if ( is_readable( "$dir/$r" ) ) { $t = (string) file_get_contents( "$dir/$r" ); $out['readme'] = array( 'file' => $r, 'build' => (bool) preg_match( '/npm\s+(run|install|ci)|npx\s|yarn\s|pnpm\s|tailwindcss\s+-i|\bbuild\b/i', $t ) ); break; }
	}
	$best = null;
	foreach ( array( '', 'dist/', 'build/', 'assets/', 'css/', 'public/', 'assets/css/', 'dist/css/', 'build/css/', 'assets/dist/', 'public/css/' ) as $sub ) {
		foreach ( (array) glob( "$dir/$sub*.css" ) as $c ) {
			$h = @file_get_contents( $c, false, null, 0, 600000 );
			if ( false !== $h && false !== strpos( $h, '--tw-' ) && ( ! $best || filesize( $c ) > filesize( $best ) ) ) { $best = $c; }
		}
	}
	if ( $best ) { $out['css'] = array( 'file' => substr( $best, strlen( $dir ) + 1 ), 'mtime' => filemtime( $best ) ); }
	$newest = 0; $nf = null;
	$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ) );
	foreach ( $it as $f ) {
		$pth = $f->getPathname();
		if ( preg_match( '#/(node_modules|vendor|dist|build)/#', $pth ) || ! preg_match( '/\.(php|twig|html)$/', $pth ) ) { continue; }
		if ( $f->getMTime() > $newest ) { $newest = $f->getMTime(); $nf = substr( $pth, strlen( $dir ) + 1 ); }
	}
	if ( $nf ) { $out['newest_template'] = array( 'file' => $nf, 'mtime' => $newest ); }
	return $out;
} )();
// Pages whose own content has a phone number or a street address typed in (not from a theme option).
$typed = array( 'phones' => array(), 'addresses' => array() );
foreach ( $wpdb->get_results( "SELECT ID, post_title, post_content FROM {$wpdb->posts} WHERE post_status = 'publish' AND post_type NOT IN ('revision','nav_menu_item','attachment','wpcf7_contact_form','acf-field','acf-field-group') LIMIT 2000" ) as $row ) {
	$txt = wp_strip_all_tags( $row->post_content );
	if ( preg_match_all( '/(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/', $txt, $m ) ) {
		foreach ( array_unique( $m[0] ) as $ph ) { $d = substr( preg_replace( '/\D/', '', $ph ), -10 ); $typed['phones'][ $d ][] = $row->post_title; }
	}
	if ( preg_match( '/\b\d{2,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pkwy|Parkway|Pl|Place|Hwy|Highway)\b\.?/', $txt, $am ) ) { $typed['addresses'][] = array( 'title' => $row->post_title, 'match' => $am[0] ); }
}
$latest = get_posts( array( 'numberposts' => 1, 'post_status' => 'publish' ) );
$cats = get_categories( array( 'hide_empty' => true, 'number' => 1 ) );
$wpseo = get_option( 'wpseo_titles' );
$types = array();
foreach ( get_post_types( array( 'public' => true, '_builtin' => false ), 'objects' ) as $pt ) {
	$types[] = array( 'name' => $pt->name, 'label' => $pt->label, 'count' => (int) ( wp_count_posts( $pt->name )->publish ?? 0 ), 'yoast_noindex' => is_array( $wpseo ) ? ! empty( $wpseo[ 'noindex-' . $pt->name ] ) : null );
}
$cf7 = array();
if ( class_exists( 'WPCF7_ContactForm' ) ) {
	foreach ( get_posts( array( 'post_type' => 'wpcf7_contact_form', 'numberposts' => 50 ) ) as $f ) { $mail = get_post_meta( $f->ID, '_mail', true ); $cf7[] = array( 'title' => $f->post_title, 'sender' => is_array( $mail ) ? ( $mail['sender'] ?? '' ) : '' ); }
}
$elementor_opts = null;
if ( defined( 'ELEMENTOR_VERSION' ) ) {
	$elementor_opts = array(
		'pro'          => defined( 'ELEMENTOR_PRO_VERSION' ) ? ELEMENTOR_PRO_VERSION : null,
		'license_key'  => (bool) get_option( 'elementor_pro_license_key' ),
		'google_fonts' => get_option( 'elementor_google_font', '1' ),
		'sections'     => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->postmeta} m JOIN {$wpdb->posts} p ON p.ID = m.post_id WHERE m.meta_key = '_elementor_data' AND p.post_status = 'publish' AND m.meta_value LIKE '%\"elType\":\"section\"%'" ),
		'containers'   => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->postmeta} m JOIN {$wpdb->posts} p ON p.ID = m.post_id WHERE m.meta_key = '_elementor_data' AND p.post_status = 'publish' AND m.meta_value LIKE '%\"elType\":\"container\"%'" ),
	);
}
$yoo_dir = wp_get_upload_dir()['basedir'] . '/yootheme';
$facts = array(
	'install'        => basename( ABSPATH ),
	'home'           => home_url(),
	'siteurl'        => site_url(),
	'blogname'       => get_option( 'blogname' ),
	'blogdescription'=> get_option( 'blogdescription' ),
	'admin_email'    => get_option( 'admin_email' ),
	'blog_public'    => (int) get_option( 'blog_public' ),
	'show_on_front'  => get_option( 'show_on_front' ),
	'page_on_front'  => (int) get_option( 'page_on_front' ),
	'front_title'    => get_the_title( (int) get_option( 'page_on_front' ) ),
	'page_for_posts' => (int) get_option( 'page_for_posts' ),
	'post_count'     => (int) wp_count_posts( 'post' )->publish,
	'site_icon'      => (int) get_option( 'site_icon' ),
	'permalink'      => get_option( 'permalink_structure' ),
	'default_comment_status' => get_option( 'default_comment_status' ),
	'open_comment_posts'     => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE comment_status = 'open' AND post_status = 'publish' AND post_type IN ('post','page')" ),
	'approved_comments'      => (int) wp_count_comments()->approved,
	'wp_version'     => get_bloginfo( 'version' ),
	'wp_update'      => $core_new,
	'php_version'    => PHP_VERSION,
	'memory_limit'   => WP_MEMORY_LIMIT,
	'php_memory_limit' => ini_get( 'memory_limit' ),
	'plugins'        => $plugins,
	'mu_plugins'     => $mu,
	'theme'          => array( 'name' => $theme->get( 'Name' ), 'stylesheet' => $theme->get_stylesheet(), 'template' => $theme->get_template() ),
	'elementor'      => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : null,
	'yootheme'       => ( false !== stripos( $theme->get_template(), 'yootheme' ) ),
	'acf'            => class_exists( 'ACF' ) ? ( defined( 'ACF_VERSION' ) ? ACF_VERSION : 'active' ) : null,
	'theme_build'    => $theme_build,
	'typed'          => $typed,
	'posts_url'      => get_option( 'page_for_posts' ) ? get_permalink( (int) get_option( 'page_for_posts' ) ) : null,
	'latest_post_url'=> $latest ? get_permalink( $latest[0] ) : null,
	'category_url'   => $cats ? get_category_link( $cats[0] ) : null,
	'post_types'     => $types,
	'cf7'            => class_exists( 'WPCF7_ContactForm' ) ? $cf7 : null,
	'elementor_opts' => $elementor_opts,
	'yootheme_dir'   => is_dir( $yoo_dir ) ? array( 'writable' => is_writable( $yoo_dir ), 'perms' => substr( sprintf( '%o', fileperms( $yoo_dir ) ), -3 ), 'css' => count( (array) glob( $yoo_dir . '/*.css' ) ) ) : null,
	'whl_page'       => get_option( 'whl_page' ),
	'authors'        => $authors,
	'default_category' => $default_cat && ! is_wp_error( $default_cat ) ? array( 'name' => $default_cat->name, 'slug' => $default_cat->slug, 'count' => (int) $default_cat->count ) : null,
	'privacy'        => $privacy_id ? array( 'id' => $privacy_id, 'status' => get_post_status( $privacy_id ), 'url' => get_permalink( $privacy_id ) ) : null,
	'pages_no_thumb' => $pages_no_thumb,
	'cpt_no_thumb'   => $cpt_missing,
	'slug_collisions'=> $collisions,
	'junk_posts'     => $junk,
	'old_url_hits'   => $old_url_hits,
	'yoast'          => array( 'separator' => is_array( $yoast_titles ) ? ( $yoast_titles['separator'] ?? null ) : null, 'titles' => $yoast_meta ),
	'counts'         => array( 'pages' => (int) wp_count_posts( 'page' )->publish, 'users' => (int) count_users()['total_users'] ),
);
echo '<<<WPEQA>>>' . wp_json_encode( $facts ) . '<<</WPEQA>>>';
`;

// Works out the WP Engine install name for a site URL:
// 1. the URL itself (<install>.wpenginepowered.com), 2. DNS CNAME, 3. install domains referenced in
// the page or guessed from the domain, confirmed by <install>.wpenginepowered.com redirecting to this host.
export async function detectInstall(url) {
  const { hostname: host, origin } = new URL(url);
  const WPE = /^([a-z0-9]{3,30})\.(wpenginepowered|wpengine)\.com$/;
  const direct = host.match(WPE);
  if (direct && direct[1] !== 'wp') return { install: direct[1], how: 'from the URL' };
  const dns = await import('node:dns/promises');
  for (const name of [host, host.replace(/^www\./, '')]) {
    try { for (const c of await dns.resolveCname(name)) { const m = c.match(WPE); if (m && m[1] !== 'wp') return { install: m[1], how: 'from DNS' }; } } catch { /* no CNAME */ }
  }
  const candidates = new Set();
  try {
    const html = await (await fetch(origin + '/', { headers: { 'user-agent': 'wpe-qa-checklist' } })).text();
    for (const m of html.matchAll(/\b([a-z0-9]{3,30})\.(?:wpenginepowered|wpengine)\.com/g)) if (!['wp', 'www', 'my', 'cdn'].includes(m[1])) candidates.add(m[1]);
  } catch { /* site unreachable */ }
  // Installs this Mac has connected to over SSH before.
  try {
    const fs = await import('node:fs'); const os = await import('node:os');
    const kh = fs.readFileSync(os.homedir() + '/.ssh/known_hosts', 'utf8');
    for (const m of kh.matchAll(/(?:^|[,\s\[])([a-z0-9]{3,30})\.ssh\.wpengine\.net/gm)) candidates.add(m[1]);
  } catch { /* no known_hosts */ }
  const label = host.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '');
  if (label.length >= 3) candidates.add(label.slice(0, 30));
  const bare = h => h.replace(/^www\./, '');
  const probe = async c => {
    try {
      const r = await fetch(`https://${c}.wpenginepowered.com/`, { redirect: 'manual', headers: { 'user-agent': 'wpe-qa-checklist' }, signal: AbortSignal.timeout(8000) });
      const loc = r.headers.get('location');
      return loc && bare(new URL(loc, `https://${c}.wpenginepowered.com/`).hostname) === bare(host) ? c : null;
    } catch { return null; }
  };
  const list = [...candidates];
  for (let i = 0; i < list.length; i += 8) {
    const hit = (await Promise.all(list.slice(i, i + 8).map(probe))).find(Boolean);
    if (hit) return { install: hit, how: `${hit}.wpenginepowered.com redirects to ${host}` };
  }
  return null;
}

// Like ssh(), but resolves with the exit code instead of failing, for scripts that change things.
export function sshRun(install, script, { timeoutMs = 600000 } = {}) {
  return new Promise(resolve => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', sshHost(install), 'bash -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); err += '\nTimed out.'; }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
    p.stdin.end(script);
  });
}

// Shell preamble for fix scripts: cd into the install and a php_eval helper that runs PHP (stdin) in WordPress.
export const fixPreamble = install => `cd ~/sites/${assertInstall(install)} || exit 3
php_eval() { f=$(mktemp /tmp/wpeqa.XXXXXX.php); cat > "$f"; wp eval-file "$f"; rc=$?; rm -f "$f"; return $rc; }
`;
