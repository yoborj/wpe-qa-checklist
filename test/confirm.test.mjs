// "Confirm fix" (an approved fix the check can't verify) and the search check that verifies itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The store reads WPEQA_DATA when it loads: point it at a throwaway folder first.
process.env.WPEQA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wpeqa-test-'));
const { setItem, applyRun, getState } = await import('../lib/store.mjs');
const { planFixes } = await import('../lib/fixers.mjs');
const { MORE } = await import('../lib/checks-more.mjs');

const SITE = 'example-com', TAB = 'wp-site-audit', ID = 'item-a';
const run = (n, result) => applyRun(SITE, TAB, { id: `r${n}`, finishedAt: new Date(Date.UTC(2026, 10, 12, 10, n)).toISOString() }, { [ID]: result });
const item = () => getState(SITE).tabs[TAB].items[ID];
const finding = { status: 'warn', summary: 'Needs a judgment call.', details: ['row 1'] };

test('confirming needs an approved, still-flagged item', () => {
  run(1, finding);
  assert.throws(() => setItem(SITE, TAB, ID, { confirm: true }), /Approve the fix first/);
  setItem(SITE, TAB, ID, { decision: 'approve' });
  setItem(SITE, TAB, ID, { confirm: true });
  assert.ok(item().confirmed?.sig);
});

test('a later run with the same finding keeps the confirmation; a different finding drops it', () => {
  run(2, { ...finding });
  assert.ok(item().confirmed, 'same finding: still confirmed');
  run(3, { ...finding, details: ['row 1', 'row 2 (new)'] });
  assert.equal(item().confirmed, undefined, 'new finding: back to Approved, not done');
});

test('undo, and changing the decision, drop the confirmation', () => {
  setItem(SITE, TAB, ID, { confirm: true });
  setItem(SITE, TAB, ID, { confirm: false });
  assert.equal(item().confirmed, undefined);
  setItem(SITE, TAB, ID, { confirm: true });
  setItem(SITE, TAB, ID, { decision: 'decline' });
  assert.equal(item().confirmed, undefined);
});

test('a confirmed item is not planned for Apply fixes', () => {
  setItem(SITE, TAB, ID, { decision: 'approve' });
  const template = { sections: [{ items: [{ id: ID, title: ID, check: 'test.manualOnly' }] }] };
  const site = { name: 'x', url: 'https://example.com', install: 'example' };
  assert.equal(planFixes(template, getState(SITE).tabs[TAB], site).manual.length, 1);
  setItem(SITE, TAB, ID, { confirm: true });
  assert.equal(planFixes(template, getState(SITE).tabs[TAB], site).manual.length, 0);
});

// Search page: settled when there's a form, or when there's none and /?s= is turned off.
const searchCheck = async (searchForm, status, location) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(status === 200 ? 'results' : null, { status, headers: location ? { location } : {} });
  try { return await MORE['http.searchPage']({ home: 'https://example.com', pages: async () => [{ url: 'https://example.com/', searchForm }] }); }
  finally { globalThis.fetch = realFetch; }
};

test('search: no form and /?s= redirects home → pass', async () => {
  const r = await searchCheck(false, 301, 'https://example.com/');
  assert.equal(r.status, 'pass');
  assert.match(r.summary, /search is turned off: \/\?s=… redirects \(301\) to \//);
});

test('search: no form and /?s= answers 404 → pass', async () => {
  assert.equal((await searchCheck(false, 404)).status, 'pass');
});

test('search: no form but the results page works → needs a look', async () => {
  const r = await searchCheck(false, 200);
  assert.equal(r.status, 'warn');
  assert.match(r.summary, /results page still works/);
});

test('search: a search form → pass', async () => {
  assert.equal((await searchCheck(true, 200)).status, 'pass');
});
