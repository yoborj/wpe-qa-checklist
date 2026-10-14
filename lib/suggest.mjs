// Suggested fix for each automatic check, shown under failed and flagged items.
// Plain WordPress steps; `r` is the check's result, for checks whose advice depends on the finding.
import { FIXERS } from './fixers.mjs';

const S = {
  'wp.homepage': 'Settings → Reading → “Your homepage displays”: choose “A static page” and pick the Home page.',
  'wp.postsPage': 'Create an empty “Blog” (or “News”) page, then choose it as the Posts page under Settings → Reading.',
  'wp.adminEmail': 'Settings → General → Administration Email Address, then confirm the change from the email WordPress sends.',
  'wp.stagingNoindex': 'Settings → Reading → tick “Discourage search engines from indexing this site” while the site is in development.',
  'wp.indexable': 'At launch only: Settings → Reading → untick “Discourage search engines”. Leave it on before launch.',
  'wp.plugins': 'Dashboard → Updates: update the listed plugins (backup first). Delete inactive plugins you no longer need.',
  'wp.comments': 'Settings → Discussion → untick “Allow people to submit comments on new posts”, then close comments on existing pages (Quick Edit).',
  'wp.coreUpdate': 'Dashboard → Updates → update WordPress (WP Engine takes a backup point first; check the site after).',
  'wp.hideLogin': 'Install WPS Hide Login and set the login URL under Settings → General (e.g. /backend-login/). Share the new URL with the team.',
  'wp.activityLog': 'Plugins → Add New → install and activate “WP Activity Log”.',
  'wp.permalinks': 'Settings → Permalinks → choose “Post name”, then save.',
  'wp.yoast': 'Install Yoast SEO; under Yoast SEO → Settings → Site basics set the site title and the “|” title separator.',
  'wp.titleTagline': 'Settings → General: set the business name as Site Title and a short real tagline.',
  'wp.uncategorized': 'Posts → Categories → edit “Uncategorized”: rename it (e.g. “News”) and change its slug.',
  'wp.postAuthors': 'Edit each post and set a real author, or reassign the posts when deleting the developer user.',
  'wp.placeholderPosts': 'Trash “Hello world!”, “Sample Page” and any lorem ipsum drafts, then empty the trash.',
  'wp.privacyPolicy': 'Settings → Privacy: create or choose the privacy policy page, publish it, and add it to the footer menu.',
  'wp.memoryLimit': 'Ask WP Engine support to raise the PHP memory limit, or set WP_MEMORY_LIMIT to 256M in wp-config.php.',
  'wp.phpVersion': 'WP Engine User Portal → the environment → PHP version: switch to 8.1+ after checking the site on staging.',
  'wp.oldUrls': 'Run a search-replace from the old domain to the new one (WP-CLI `wp search-replace`, dry run first; skip GUIDs).',
  'wp.featuredImages': 'Edit each listed page and set a Featured Image (used for social sharing previews).',
  'html.favicon': 'Appearance → Customize → Site Identity → Site Icon: upload a square 512×512 image.',
  'html.noHomeInNav': 'Appearance → Menus: remove the “Home” item; the logo already links home.',
  'html.openGraph': 'Yoast SEO → each page → Social: set a title and image, or set a default image in Yoast SEO → Settings → Site representation.',
  'html.logoHomeLink': 'Make the header logo a link to “/” in the theme header (Customizer or header template).',
  'html.analyticsTags': 'Add the Google Tag Manager container (head and body snippets) through the theme or a header/footer plugin, then confirm in Tag Assistant.',
  'html.ga4ViaGtm': 'Create a GA4 tag inside Google Tag Manager and remove the direct gtag.js snippet, so all tracking runs through GTM.',
  'html.searchConsole': 'Verify the property in Google Search Console (DNS record or the HTML tag in Yoast SEO → Settings → Site connections).',
  'html.schema': 'Add JSON-LD (LocalBusiness or Organization with name, phone, address) via Yoast or the theme, then test in Rich Results Test.',
  'html.schemaDrift': 'Update the phone/address in the structured data so it matches what the pages show.',
  'html.recaptcha': 'Add reCAPTCHA v3 (or Cloudflare Turnstile) to the listed forms in the form plugin’s settings.',
  'html.noTailwindCdn': 'Remove the cdn.tailwindcss.com script and load the compiled CSS file from the build instead.',
  'http.custom404': 'Add a 404.php template (or the theme’s 404 setting) with the site header, a short message and links back in.',
  'http.wwwRedirect': 'In the WP Engine User Portal → Domains, set the primary domain and redirect the other one to it (301).',
  'http.securityHeaders': 'Ask WP Engine support (or use the Cloudflare/Advanced Network rules) to add the missing headers listed.',
  'http.sourceMaps': 'Build without source maps for production, or delete the .map files from the theme.',
  'http.ssl': 'Replace the listed http:// URLs with https:// (search-replace in the database) and force HTTPS in WP Engine Domains.',
  'http.sitemap': 'Make sure Yoast SEO’s XML sitemaps are on (Yoast SEO → Settings → Site features). Before launch, no sitemap is expected.',
  'http.robots': 'Before launch this is expected. At launch, untick “Discourage search engines” and check robots.txt no longer says “Disallow: /”.',
  'crawl.imageAlt': 'Media Library → open each listed image → fill in Alternative Text (describe the image; leave it empty only for decoration).',
  'crawl.dummyContent': 'Replace the lorem ipsum / sample text on the listed pages and trash the placeholder posts.',
  'crawl.socialLinks': 'Add the business’s social profile links to the footer (or mark N/A if it has none).',
  'crawl.phonesClickable': 'Wrap each listed number in a link: <a href="tel:+1XXXXXXXXXX">(XXX) XXX-XXXX</a>, ideally from one theme option.',
  'crawl.deadMenuLinks': 'Appearance → Menus: give the listed items a real page, or make the parent a non-link label.',
  'crawl.internalLinks': 'Fix or remove the listed broken links on the pages they come from, or add a 301 redirect for the old address.',
  'crawl.phoneConsistency': 'Use one phone number from a single theme option everywhere, unless each number is intended (e.g. per location).',
  'crawl.headings': 'Give each page exactly one H1 and don’t skip levels (H2 → H3); change the heading level in the editor, keep the styling with a class.',
  'crawl.imageWeight': 'Re-upload the listed images at most 2× their shown width (usually ≤2000px), compressed to WebP.',
  'crawl.stagingLinks': 'Search-replace the staging/local domain with the real domain and re-check the listed links.',
  'crawl.noindex': 'Before launch this is expected. At launch, untick “Discourage search engines” and check Yoast “Allow search engines” on each page.',
  'browser.stickyHeader': 'Make the header sticky (position: sticky; top: 0) on desktop and phone.',
  'browser.stickyBottomBar': 'Add a phone-only bottom bar with a tel: Call button (and Book/Contact).',
  'browser.mobileFit': 'Find the element wider than the screen on the listed pages (often a table, iframe or fixed width) and give it max-width: 100%.',
  'browser.fontFamilies': 'Trim to two font families in the theme settings, or confirm the third is an intended design choice.',
  'browser.tapTargets': 'Make the listed links/buttons at least 24×24px on phones (padding, not just a bigger font).',
  'browser.cookieConsent': 'Load analytics and pixels only after consent: set the consent tool to block them, or use Google Consent Mode in GTM.',
  'browser.domSize': 'Simplify the homepage markup: remove nested wrapper containers and hidden duplicate desktop/phone sections.',
  'browser.consoleErrors': 'Open the listed pages with DevTools → Console and fix the script errors (often a plugin conflict or a missing file).',
  'browser.interactive': 'Check the phone menu button opens the menu; fix the theme’s menu script or the console errors listed.',
  'lighthouse.home': r => {
    const lcp = (r.details || []).find(d => /^Phone/.test(d)) || '';
    return `Run PageSpeed Insights again to confirm (lab results vary). If LCP stays over 2.5 s: install Greenlight (hero first, fonts self-hosted, scripts delayed) and compress the hero image.${lcp ? ' Measured: ' + lcp + '.' : ''}`;
  },
  'swarm.http': 'Fix or redirect the listed pages so each one answers 200.',
  'swarm.a11y': 'Add the missing pieces listed per page: title and meta description in Yoast, one H1, alt text in the Media Library.',
  'swarm.mobile': 'Fix the pages that scroll sideways (max-width: 100% on the wide element) and make the menu button at least 44×44px.',
  'swarm.content': 'Copy the missing text from the old pages into the new ones, or confirm it was removed on purpose.',
  'swarm.visual': 'Open the screenshots and look for broken layouts, missing images or text overlaps.',
  'swarm.composite': 'Fix the lowest-scoring pages listed first; each item above shows what pulls them down.',
  'audit.collapse': 'Point each card at its own page instead of one shared index page.',
  'audit.emptyHref': 'Give the listed links a real URL, or turn them into plain text.',
  'audit.assetLinks': 'Link navigation to pages, not files; keep file links only for real downloads.',
  'audit.duplicateImages': 'If it isn’t a looping carousel, replace the repeated image with a different one.',
  'audit.junkPosts': 'Trash the placeholder posts, and rename post slugs that collide with page slugs.',
  'audit.emails': 'Confirm each email is meant to be public; replace personal addresses with a shared one, or use a contact form.',
  'audit.muPlugins': 'Read each listed mu-plugin in wp-content/mu-plugins and remove overrides that hide or change the theme.',
  'audit.longH1': 'Shorten the H1 to a display heading; keep the long SEO wording in the Yoast SEO title instead.',
  'audit.phoneFormats': 'Pick one format, e.g. (720) 966-8892, and use it sitewide (ideally from one theme option).',
  'audit.cptFeatured': 'Edit each listed post and set a Featured Image.',
  'audit.yoastTitles': 'Yoast SEO → Settings → Content types: use “%%title%% %%sep%% %%sitename%%”, and set the separator to “|”.',
  'audit.placeholders': 'Replace the placeholder values listed (fake phones, example emails, 000+ counters, TBD/TODO, unrendered {{tokens}}).',
  'audit.localStyles': 'Move shared rules from the page’s <style> block into the theme stylesheet.',
};
S['audit.alt'] = S['crawl.imageAlt'];
S['swarm.links'] = S['crawl.internalLinks'];
S['swarm.interactive'] = S['browser.interactive'];

export function suggestionFor(check, result) {
  if (!result || !['fail', 'warn'].includes(result.status)) return null;
  const s = S[check];
  const text = typeof s === 'function' ? s(result) : s;
  if (!text) return null;
  return { text, auto: !!FIXERS[check] };
}
