// Revert fix: undo on the site what one earlier fix changed. Only for fixes a fix run made (there's a backup from just
// before it and a record of what it did); Claude restores only that item's changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { revertBlocker, fixCommands, planRevert, revertPrompt } from '../lib/revert.mjs';

const site = { name: 'example', url: 'https://example.wpenginepowered.com', install: 'example' };
const template = { title: 'Audit', sections: [{ title: 'S', items: [{ id: 'labels', title: 'Post type labels', check: 'test.manualOnly', description: 'Labels are set.' }, { id: 'comments', title: 'Comments off', check: 'wp.comments' }] }] };
const backup = { path: '~/sites/example/_wpeprivate/wpeqa-backups/run1', restore: ['…'] };
const tabState = (fix, extra = {}) => ({ items: { labels: { status: 'pass', decision: 'approve', fix, tool: { status: 'pass' } }, comments: { status: 'pass', decision: 'approve', fix: { state: 'verified', runId: 'run1' } } }, fixRuns: [{ id: 'run1', finishedAt: '2026-11-13T08:00:00Z', backup, items: ['labels', 'comments'] }], ...extra });

test('only a fix a fix run made, with its backup on record, can be reverted', () => {
  assert.equal(revertBlocker(tabState({ state: 'verified', runId: 'run1', by: 'claude' }), 'labels'), null);
  assert.match(revertBlocker(tabState(undefined), 'labels'), /none on record/); // passed by itself or fixed by hand
  assert.match(revertBlocker(tabState({ state: 'manual', runId: 'run1' }), 'labels'), /none on record/); // only in a fix request
  assert.match(revertBlocker({ ...tabState({ state: 'verified', runId: 'run1' }), fixRuns: [{ id: 'run1', items: ['labels'] }] }, 'labels'), /no backup on record/);
});

test('what Claude ran in that fix run comes from its transcript; the plan names the backup and the other items', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpeqa-revert-'));
  const ev = cmd => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }, { type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } });
  fs.writeFileSync(path.join(dir, 'claude.jsonl'), [ev('rsync -az host:cpt.php .'), 'not json', ev('ssh host bash -s <<EOF\ncp stage/cpt.php inc/cpt.php\nEOF')].join('\n'));
  fs.writeFileSync(path.join(dir, 'claude-summary.md'), 'Done.\n```json\n{"items":[{"id":"labels","result":"fixed","summary":"Added the full labels set in inc/cpt.php."}]}\n```');
  assert.deepEqual(fixCommands(dir).length, 2);
  const plan = planRevert({ site, template, tabState: tabState({ state: 'verified', runId: 'run1', by: 'claude' }), itemId: 'labels', runDirOf: () => dir });
  assert.equal(plan.report, 'Added the full labels set in inc/cpt.php.');
  assert.deepEqual(plan.others, ['comments']);
  const p = revertPrompt({ site, plan, backup: { path: '~/sites/example/_wpeprivate/wpeqa-backups/now' } });
  assert.match(p, /THIS RUN REVERTS AN EARLIER FIX/);
  assert.match(p, /Backup from just BEFORE that fix .*wpeqa-backups\/run1/);
  assert.match(p, /also worked on other items \(comments\)\. Leave their changes in place/);
  assert.match(p, /Never import the whole database and never unpack the whole theme/);
  assert.match(p, /cp stage\/cpt\.php inc\/cpt\.php/);
  assert.match(p, /"result":"fixed" \(meaning: the fix is undone\)/);
  fs.rmSync(dir, { recursive: true });
});

test("an app fix's own script is what Claude undoes", () => {
  const plan = planRevert({ site, template, tabState: tabState({ state: 'verified', runId: 'run1', by: 'claude' }), itemId: 'comments', runDirOf: () => '/nonexistent' });
  assert.equal(plan.byClaude, false);
  assert.match(revertPrompt({ site, plan, backup }), /The automatic fix ran this on the server:[\s\S]*default_comment_status/);
});

test('an item that cannot be reverted says why', () => {
  assert.throws(() => planRevert({ site, template, tabState: tabState(undefined), itemId: 'labels', runDirOf: () => '/x' }), /none on record/);
});

test('a fix from an earlier run is still revertable after a later run skipped the item; not after it was reverted', () => {
  // What happened for real: run A renamed URLs (Claude reported "fixed"); run B, later, skipped the item ("manual").
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpeqa-revert-'));
  for (const [id, result] of [['runA', 'fixed'], ['runB', 'skipped']]) {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'claude-summary.md'), '```json\n' + JSON.stringify({ items: [{ id: 'labels', result, summary: `${result} in ${id}` }] }) + '\n```');
  }
  const t = { items: { labels: { status: 'warn', decision: 'approve', fix: { state: 'manual', by: 'claude', runId: 'runB' } } },
    fixRuns: [{ id: 'runB', finishedAt: '2026-11-13T11:47:00Z', backup, items: ['labels'] }, { id: 'runA', finishedAt: '2026-11-13T08:36:00Z', backup, items: ['labels', 'other'] }] };
  const runDirOf = id => path.join(dir, id);
  assert.equal(revertBlocker(t, 'labels', runDirOf), null);
  const plan = planRevert({ site, template, tabState: t, itemId: 'labels', runDirOf });
  assert.equal(plan.fixRunId, 'runA'); assert.equal(plan.did, 'fixed in runA'); assert.deepEqual(plan.others, ['other']);
  // Once a revert run undid run A, there's nothing left to revert.
  t.fixRuns.unshift({ id: 'rev1', kind: 'revert', revertOf: 'runA', items: ['labels'], states: { reverted: 1 }, backup });
  assert.match(revertBlocker(t, 'labels', runDirOf), /already reverted/);
  fs.rmSync(dir, { recursive: true });
});
