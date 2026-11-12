// Reading Claude Code's final message in a --claude fix run: per-item verdicts, and questions for the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdicts, replyPrompt, RULES } from '../lib/claude.mjs';

const site = { name: 'example', url: 'https://example.wpenginepowered.com', install: 'example' };
const block = items => '```json\n' + JSON.stringify({ items }) + '\n```';

test('fixed, skipped and question verdicts from the JSON block', () => {
  const text = `Done.\n\n${block([
    { id: 'a', result: 'fixed', summary: 'Linked both emails.' },
    { id: 'b', result: 'skipped', summary: 'Needs content.' },
    { id: 'c', result: 'question', summary: 'Logos', question: 'Should I use the insurers’ official logos?' },
  ])}`;
  const { verdicts, summary } = parseVerdicts(text, ['a', 'b', 'c']);
  assert.equal(verdicts.a.result, 'fixed');
  assert.equal(verdicts.b.result, 'skipped');
  assert.equal(verdicts.c.result, 'question');
  assert.equal(verdicts.c.question, 'Should I use the insurers’ official logos?');
  assert.equal(summary, 'Done.');
});

test('a question verdict without question text falls back to its summary', () => {
  const { verdicts } = parseVerdicts(block([{ id: 'x', result: 'question', summary: 'Which email should be public?' }]), ['x']);
  assert.equal(verdicts.x.question, 'Which email should be public?');
});

test('an unknown result counts as skipped, never as fixed', () => {
  const { verdicts } = parseVerdicts(block([{ id: 'x', result: 'done', summary: '?' }]), ['x']);
  assert.equal(verdicts.x.result, 'skipped');
});

test('no JSON block and a closing question: every item waits for the owner', () => {
  // What happened in a real run: Claude stopped to ask for a go-ahead and never printed the JSON block.
  const text = 'Here is what I found.\n\nI’m still waiting on your go-ahead: should I link the two emails and skip the logos?';
  const { verdicts } = parseVerdicts(text, ['nap--emails', 'polish--featured']);
  assert.deepEqual(Object.keys(verdicts), ['nap--emails', 'polish--featured']);
  for (const v of Object.values(verdicts)) {
    assert.equal(v.result, 'question');
    assert.match(v.question, /go-ahead/);
  }
});

test('no JSON block and no question: nothing is reported (items stay in the fix request)', () => {
  assert.deepEqual(parseVerdicts('I could not reach the server.', ['a']).verdicts, {});
});

test('the reply carries the answer and names the items to continue', () => {
  const p = replyPrompt('Yes, link them.', [{ id: 'nap--emails', title: 'Exposed email addresses reviewed' }]);
  assert.match(p, /Yes, link them\./);
  assert.match(p, /nap--emails \(Exposed email addresses reviewed\)/);
  assert.match(p, /JSON block/);
});

test('the rules tell a headless run not to wait for a go-ahead, and how to ask', () => {
  const r = RULES(site);
  assert.match(r, /do not stop to ask for a go-ahead/);
  assert.match(r, /"result":"question"/);
});

test('a headless run must not sleep, background or schedule: the app waits and clears caches', () => {
  // A real run did "sleep 130" in the background, scheduled a wake-up and ended without reporting.
  const r = RULES(site);
  assert.match(r, /never sleep or wait, never start background tasks, and never schedule a wake-up/);
  assert.match(r, /the app waits about 2 minutes/);
  assert.doesNotMatch(r, /After changes, wait about 2 minutes/);
});

test('the interactive rules (wpeqa rules) keep the wait and cache clearing', () => {
  const r = RULES(site, { headless: false });
  assert.match(r, /After changes, wait about 2 minutes/);
  assert.doesNotMatch(r, /headless/);
});

test('a headless run is told to work in few SSH calls and start from the site map', () => {
  assert.match(RULES(site), /Every SSH call to WP Engine takes 10-30 seconds, so work in few calls/);
  assert.doesNotMatch(RULES(site, { headless: false }), /work in few calls/);
});

test('the site map goes into the first prompt, before the items', async () => {
  const { claudePrompt } = await import('../lib/claude.mjs');
  const manual = [{ id: 'a', title: 'A', item: { description: 'd', finding: { summary: 's', details: [] } } }];
  const p = claudePrompt(site, { title: 'QA' }, manual, null, 'WordPress 7.1 · theme demo\nTheme files:\n  ./functions.php');
  assert.ok(p.indexOf('Site map, read just before this run') < p.indexOf('Approved items to fix:'));
  assert.match(p, /\.\/functions\.php/);
  assert.doesNotMatch(claudePrompt(site, { title: 'QA' }, manual, null), /Site map/);
});
