// QA — After Launch runs on the live site only: someone confirms the app's site address is the production domain and
// the new site is published there. The app checks what it can first; changing the site's address resets it.
import { fetchText } from './crawl.mjs';
import { wpEvalJson } from './wpe.mjs';
import { getState, updateState } from './store.mjs';

export const LIVE_TAB = 'after-launch';
const STAGING_HOST = /\.(wpenginepowered|wpengine)\.com$|\.local$|^localhost$|^127\.|(^|[.-])(staging|stage|dev)([.-]|$)/i;
async function patient(url) { let r; for (const w of [0, 2000, 6000]) { if (w) await new Promise(res => setTimeout(res, w)); r = await fetchText(url); if (r.status !== 429 && r.status !== 0) break; } return r; }

export const liveConfirmed = site => { const p = getState(site.id).prod; return p && site.prodUrl && p.url === site.prodUrl ? p : null; };
// The site as QA — After Launch sees it: the production URL and the install that serves it.
export const liveSite = site => ({ ...site, url: site.prodUrl, install: site.prodInstall || site.install });
export const requireLive = site => { if (!liveConfirmed(site)) throw new Error('QA — After Launch runs on the production site. Set it in Site settings and confirm it is live on that tab first (or: node bin/wpeqa.mjs confirm-live <site> --yes).'); return liveSite(site); };

export async function liveChecks(site) {
  if (!site.prodUrl) return { url: null, checks: [{ hard: true, ok: false, text: 'No production site is set. Add it in Site settings → Production site to audit.' }], ready: false, confirmed: null };
  const live = liveSite(site); const host = new URL(live.url).hostname; const checks = [];
  const staging = STAGING_HOST.test(host);
  checks.push({ hard: true, ok: !staging, text: staging ? `${host} is a staging/development address. Set the live domain as the production site in Site settings.` : `${host} is not a staging address.` });
  const r = await patient(live.url + '/');
  const finalHost = r.url ? new URL(r.url).hostname : '';
  const answers = r.status === 200 && finalHost === host;
  checks.push({ hard: true, ok: answers, text: answers ? `${host} answers 200.` : `${host} answered ${r.status || 'nothing'}${finalHost && finalHost !== host ? ` and sends visitors to ${finalHost}` : ''}.` });
  if (live.install) {
    try {
      const f = await wpEvalJson(live.install, "<?php echo '<<<WPEQA>>>' . wp_json_encode( array( 'home' => home_url(), 'public' => (int) get_option( 'blog_public' ) ) ) . '<<</WPEQA>>>';");
      const wpHost = new URL(f.home).hostname;
      checks.push({ hard: true, ok: wpHost === host, text: wpHost === host ? `The new WordPress (install ${live.install}) uses ${host} as its address.` : `The new WordPress (install ${live.install}) still uses ${wpHost}, not ${host}: it isn't launched on this domain yet.` });
      checks.push({ hard: false, ok: f.public === 1, text: f.public === 1 ? 'Search engines are allowed to index it.' : '“Discourage search engines” is still on (After Launch will flag it).' });
    } catch (e) { checks.push({ hard: true, ok: false, text: `Could not reach WordPress on install ${live.install} over SSH: ${e.message}` }); }
  } else checks.push({ hard: true, ok: false, text: 'No WP Engine install is set for this site (Site settings).' });
  const h = r.headers || {};
  const wpe = !!(h['x-powered-by'] && /wp engine/i.test(h['x-powered-by'])) || Object.keys(h).some(k => /^(x-wpe|wpe-)/i.test(k)) || !!h['cf-ray'];
  checks.push({ hard: false, ok: wpe, text: wpe ? 'Served by WP Engine.' : 'No WP Engine headers seen (fine if a proxy hides them).' });
  return { url: live.url, install: live.install, checks, ready: checks.filter(c => c.hard).every(c => c.ok), confirmed: liveConfirmed(site) };
}

export async function confirmLive(site) {
  const lc = await liveChecks(site);
  if (!lc.ready) throw new Error('The live-site checks did not pass: ' + lc.checks.filter(c => c.hard && !c.ok).map(c => c.text).join(' '));
  updateState(site.id, s => { s.prod = { url: site.prodUrl, at: new Date().toISOString() }; });
  return { ...lc, confirmed: liveConfirmed(site) };
}
