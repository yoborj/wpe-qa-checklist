// WP Site Audit → "Exposed email addresses reviewed" (audit.emails): passes when every email shown on the site is a
// working mailto: link, flags addresses shown as plain text. Page data is shaped like the crawler's (lib/crawl.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailFindings, AUDIT } from '../lib/checks.mjs';

const page = (url, text, mailtos = []) => ({ url: `https://example.com${url}`, text, links: mailtos.map(m => ({ href: m, abs: m, text: m.replace(/^mailto:/, '') })) });
const run = pages => AUDIT['audit.emails']({ pages: async () => pages });

test('every email is a mailto link: pass, still listing each address and its pages', async () => {
  const r = await run([
    page('/privacy-policy/', 'Contact privacy@example.com | (970) 555-0100', ['mailto:privacy@example.com']),
    page('/terms/', 'By email: hello@example.com', ['mailto:Hello@Example.com?subject=Terms']), // case and query don't matter
  ]);
  assert.equal(r.status, 'pass');
  assert.match(r.summary, /2 email addresses shown, each as a mailto link/);
  assert.deepEqual(r.details, ['privacy@example.com: 1 page (/privacy-policy/)', 'hello@example.com: 1 page (/terms/)']);
});

test('an email shown as plain text: needs a look, plain ones first, linked ones labelled', async () => {
  const r = await run([
    page('/privacy-policy/', 'Contact privacy@example.com', []),
    page('/terms/', 'By email: hello@example.com', ['mailto:hello@example.com']),
  ]);
  assert.equal(r.status, 'warn');
  assert.match(r.summary, /1 email address shown as plain text, not as a mailto link/);
  assert.equal(r.details[0], 'privacy@example.com: 1 page (/privacy-policy/)');
  assert.match(r.details[1], /^Already a mailto link — hello@example\.com/);
});

test('linked on one page but plain on another still counts as plain there', () => {
  const r = emailFindings([
    page('/contact/', 'hello@example.com', ['mailto:hello@example.com']),
    page('/footer-page/', 'Write to hello@example.com', []),
  ]);
  assert.deepEqual(r.plain, ['hello@example.com: 1 page (/footer-page/)']);
  assert.deepEqual(r.linked, []);
});

test('Greenlight-encoded mailto links count (the crawler reads the decoded address)', () => {
  // In the HTML the address is entity-encoded (mailto:&#104;ello@…); the browser hands the crawler the decoded href.
  assert.deepEqual(emailFindings([page('/terms/', 'hello@example.com', ['mailto:hello@example.com'])]).plain, []);
});

test('percent-encoded mailto links and retina file names', () => {
  const r = emailFindings([page('/a/', 'logo@2x.png info@example.com', ['mailto:info%40example.com'])]);
  assert.deepEqual(r.plain, []);
  assert.deepEqual(r.linked, ['info@example.com: 1 page (/a/)']);
});

test('no emails at all: pass', async () => {
  const r = await run([page('/', 'Call us', [])]);
  assert.equal(r.status, 'pass');
  assert.equal(r.summary, 'No email addresses are shown on the site.');
});
