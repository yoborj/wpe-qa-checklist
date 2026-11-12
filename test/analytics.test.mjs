// QA — Before Launch → "Google Analytics 4 (GA4) tag" (html.analyticsTags): passes only for a GA4 measurement ID (G-…),
// on the page or inside the site's Tag Manager container. A GTM container alone is the GTM card's job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CHECKS } from '../lib/checks.mjs';

const check = ALL_CHECKS['html.analyticsTags'];
const run = async ({ scripts = [], inline = [], containers = {} }) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => { const id = new URL(url).searchParams.get('id'); return new Response(containers[id] ?? '', { status: containers[id] ? 200 : 404 }); };
  try { return await check({ homeSnap: async () => ({ scripts, inlineScripts: inline }) }); }
  finally { globalThis.fetch = realFetch; }
};

test('GA4 inside the Tag Manager container → pass, says where it is', async () => {
  const r = await run({ inline: ["(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABC1234');"], containers: { 'GTM-ABC1234': '{"vtp_tagId":"G-TEST12345"}' } });
  assert.equal(r.status, 'pass');
  assert.equal(r.summary, 'GA4 G-TEST12345 in Tag Manager GTM-ABC1234.');
});

test('GA4 installed directly with gtag.js → pass', async () => {
  const r = await run({ scripts: ['https://www.googletagmanager.com/gtag/js?id=G-TEST12345'], inline: ["gtag('config', 'G-TEST12345');"] });
  assert.equal(r.status, 'pass');
  assert.match(r.summary, /G-TEST12345 on the page \(gtag\.js\)/);
});

test('a GTM container without a GA4 tag → fail (the GTM card is the one that passes)', async () => {
  const r = await run({ inline: ["'dataLayer','GTM-ABC1234'"], containers: { 'GTM-ABC1234': '{"vtp_html":"<script>/* no GA4 */</script>"}' } });
  assert.equal(r.status, 'fail');
  assert.match(r.summary, /Tag Manager GTM-ABC1234 is on the site, but it has no GA4 tag/);
});

test('nothing at all → fail, asks to escalate', async () => {
  const r = await run({});
  assert.equal(r.status, 'fail');
  assert.equal(r.summary, 'No GA4 measurement ID (G-…) on the homepage. Escalate if the client has one.');
});

test('an old Universal Analytics ID is pointed out', async () => {
  const r = await run({ inline: ["gtag('config', 'G-TEST12345'); ga('create', 'UA-1234567-1');"] });
  assert.equal(r.status, 'pass');
  assert.match(r.details[0], /Universal Analytics/);
});
