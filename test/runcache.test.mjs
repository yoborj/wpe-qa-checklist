// Runs share what they load (crawl, settings) for 15 minutes per site; a fix clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheFor, clearRunCache, RUN_CACHE_MS } from '../lib/runcache.mjs';

test('a value is reused within 15 minutes, then forgotten', () => {
  let t = 1000; const c = cacheFor('site-a', () => t);
  c.set('pages|https://x|80', ['p1'], 'QA Swarm');
  t += RUN_CACHE_MS - 1; assert.deepEqual(c.get('pages|https://x|80').value, ['p1']); assert.equal(c.get('pages|https://x|80').from, 'QA Swarm');
  t += 2; assert.equal(c.get('pages|https://x|80'), null);
});

test('sites are kept apart, and clearing one site (a fix ran) drops only its data', () => {
  cacheFor('site-a').set('facts|https://a|80', { a: 1 }, 'WP Site Audit');
  cacheFor('site-b').set('facts|https://b|80', { b: 1 }, 'WP Site Audit');
  clearRunCache('site-a');
  assert.equal(cacheFor('site-a').get('facts|https://a|80'), null);
  assert.deepEqual(cacheFor('site-b').get('facts|https://b|80').value, { b: 1 });
});
