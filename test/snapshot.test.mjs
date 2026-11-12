// Read-only report (`wpeqa snapshot`): the files it builds, its data, and the saved link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = process.env.WPEQA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wpeqa-snap-'));
const ID = 'example-com';
fs.writeFileSync(path.join(DATA, 'sites.json'), JSON.stringify([{ id: ID, name: 'example.com', url: 'https://example.com', install: 'example' }]));
fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'runs', ID, 'run1', 'evidence'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'runs', ID, 'run1', 'evidence', 'shot-1.jpg'), 'jpg');
fs.writeFileSync(path.join(DATA, 'state', `${ID}.json`), JSON.stringify({ tabs: { 'wp-site-audit': { items: {
  'nap--emails': { status: 'warn', note: 'Link them — mailto', tool: { status: 'warn', summary: '2 emails', at: '2026-11-12T10:00:00Z',
    details: ['a@example.com: 1 page', 'Open: /runs/example-com/run1/shots.html'], shots: [{ file: `/runs/${ID}/run1/evidence/shot-1.jpg`, page: '/', label: 'Email' }] } },
} } } }));

const { buildSnapshot, saveReportLink } = await import('../lib/snapshot.mjs');

test('builds the page, styles, script, data and screenshots', () => {
  const r = buildSnapshot(ID);
  for (const f of ['index.html', 'app.css', 'app.js', 'snapshot.js', 'shots/run1-evidence-shot-1.jpg']) assert.ok(fs.existsSync(path.join(r.dir, f)), f);
  assert.deepEqual(r.files.slice(0, 3), ['app.css', 'app.js', 'snapshot.js']);
  assert.equal(r.link, null);
});

test('the page is the app body for the artifact host: a title, no html/head/body tags, data before the app', () => {
  const html = fs.readFileSync(path.join(DATA, 'reports', ID, 'index.html'), 'utf8');
  assert.match(html, /^<title>example\.com QA Report [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M<\/title>/);
  assert.doesNotMatch(html, /<(html|head|body)[\s>]|<!doctype/i); // (<header> is fine)
  assert.ok(html.indexOf('src="snapshot.js"') < html.indexOf('src="app.js"'));
  assert.match(html, /Read-only report/);
});

test('the data is ASCII, points screenshots at the copies, and drops links into the app', () => {
  const js = fs.readFileSync(path.join(DATA, 'reports', ID, 'snapshot.js'), 'utf8');
  assert.ok(/^[\x00-\x7e]*$/.test(js), 'ASCII only');
  const window = {}; new Function('window', js)(window);
  const it = window.WPEQA_SNAPSHOT.site.state.tabs['wp-site-audit'].items['nap--emails'];
  assert.equal(it.tool.shots[0].file, 'shots/run1-evidence-shot-1.jpg');
  assert.deepEqual(it.tool.details, ['a@example.com: 1 page']);
  assert.equal(it.note, 'Link them — mailto');
  assert.deepEqual(window.WPEQA_SNAPSHOT.sites.map(s => s.id), [ID]);
});

test('dark colors also follow an explicit theme choice', () => {
  const css = fs.readFileSync(path.join(DATA, 'reports', ID, 'app.css'), 'utf8');
  assert.match(css, /:root:not\(\[data-theme="light"\]\)/);
  assert.match(css, /:root\[data-theme="dark"\] \{/);
});

test('each published report is added to the list, newest first, and the list survives a rebuild', () => {
  saveReportLink(ID, 'https://claude.ai/artifact/first', '2026-11-12T10:00:00Z');
  const list = saveReportLink(ID, 'https://claude.ai/artifact/second', '2026-11-12T11:00:00Z');
  assert.deepEqual(list.map(r => r.url), ['https://claude.ai/artifact/second', 'https://claude.ai/artifact/first']);
  const r = buildSnapshot(ID);
  assert.equal(r.link, 'https://claude.ai/artifact/second', 'link = the newest report');
  assert.ok(fs.existsSync(path.join(r.dir, 'reports.json')), 'the list is kept when the folder is rebuilt');
});
