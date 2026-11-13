// Data embedded in PHP run with `wp eval-file`: WP Engine's WP-CLI silently runs nothing when a file has one very long
// line (a 30-redirect apply failed that way), so data goes in short lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phpData, phpNoise } from '../lib/wpe.mjs';
import { ADD_PHP, KEEP_PHP } from '../lib/redirects.mjs';

const pairs = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, page: `Page ${i} — “quoted” & café`, from: `/old-${i}/long-path-segment-for-testing/`, to: `/new/${i}/`, code: 301 }));

test('no line of the PHP is longer than a few hundred characters, however much data it carries', () => {
  for (const php of [ADD_PHP(pairs), KEEP_PHP(pairs, false), `<?php $x = ${phpData({ big: 'x'.repeat(50000) })};`]) {
    assert.ok(Math.max(...php.split('\n').map(l => l.length)) < 1000, 'a line is too long');
  }
});

test('the chunks put back together decode to the same data', () => {
  const expr = phpData(pairs);
  const b64 = [...expr.matchAll(/'([A-Za-z0-9+/=]*)'/g)].map(m => m[1]).join('');
  assert.deepEqual(JSON.parse(Buffer.from(b64, 'base64').toString()), pairs);
});

test('PHP warnings are noise in error messages; real errors are not', () => {
  assert.ok(phpNoise('PHP Warning:  Attempt to read property "use_trailing_slashes" on null in /x.php on line 49'));
  assert.ok(phpNoise('Deprecated: Creation of dynamic property'));
  assert.ok(!phpNoise('PHP Fatal error:  Uncaught Error: Call to undefined method'));
  assert.ok(!phpNoise('Error: This does not seem to be a WordPress installation.'));
});

import { BOT_CHECK, nameFromPath, redirectTitle } from '../lib/redirects.mjs';

test("a bot check's page title is never a page name; names come from the menu, else the address", () => {
  for (const t of ['Just a moment...', 'Attention Required! | Cloudflare', 'Access denied', 'Checking your browser before accessing']) assert.ok(BOT_CHECK.test(t), t);
  assert.ok(!BOT_CHECK.test('Alcohol Detox Grand Junction CO'));
  assert.equal(nameFromPath('/alcohol-detox/'), 'Alcohol Detox');
  assert.equal(nameFromPath('/'), 'Home');
  const layout = [{ key: 'menu-1', title: 'What We Do', kind: 'menu', items: [{ id: 'a', depth: 0, label: 'What We Do' }, { id: 'b', depth: 1, label: 'Alcohol Detox' }] }, { key: 'unlisted', title: 'Not in the menu', kind: 'unlisted', items: [{ id: 'c', depth: 0, label: 'Alcohol Detox Grand Junction CO, Drug Detox Center' }] }];
  assert.equal(redirectTitle({ id: 'b', oldPath: '/alcohol-detox/' }, layout), 'Old site: Alcohol Detox');
  assert.equal(redirectTitle({ id: 'a', oldPath: '/what-we-do/' }, layout), 'Old site: What We Do');
  assert.equal(redirectTitle({ id: 'c', oldPath: '/detox/' }, layout), 'Old site: Detox'); // not in the menu: from the address, not an SEO title
});
