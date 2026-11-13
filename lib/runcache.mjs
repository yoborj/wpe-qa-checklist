// What one Run Tool loads that the next one needs too: WordPress facts, Greenlight status, the sitemap, the desktop and
// phone crawls, the internal link check and the old-site comparison. Kept in memory per site for 15 minutes, so running
// QA Swarm, WP Site Audit and QA — Before Launch one after another crawls the site once instead of three times.
// Anything that changes the site (a fix run, applied redirects) clears it, a fix run's re-check never uses it, and
// `run --fresh` skips it. The app's own process holds it: the web app shares it between its runs, and so does one
// `run <site> all` on the command line.
export const RUN_CACHE_MS = 15 * 60 * 1000;
const cache = new Map(); // siteId → Map(key → { at, from, value })

export const LABELS = {
  facts: 'the WordPress settings', greenlight: 'Greenlight’s security status', discovery: 'the sitemap',
  pages: 'the page crawl', mobilePages: 'the phone-width crawl', linkCheck: 'the internal link check', referencePairs: 'the old-site comparison',
};

export function cacheFor(siteId, now = () => Date.now()) {
  if (!cache.has(siteId)) cache.set(siteId, new Map());
  const m = cache.get(siteId);
  return {
    get(key) { const e = m.get(key); if (!e) return null; if (now() - e.at > RUN_CACHE_MS) { m.delete(key); return null; } return e; },
    set(key, value, from) { m.set(key, { at: now(), from, value }); },
  };
}

export function clearRunCache(siteId) { cache.delete(siteId); }
