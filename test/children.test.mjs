// Child findings: a check reports separate problems as child cards under one item. Each child is its own item in the
// state (`<parent>::<key>`), planned for fixes one by one; the parent is a container nobody decides on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandResult, withChildren, childItems, isContainer, settleMissingChildren, parentOf } from '../lib/children.mjs';
import { planFixes, retryIds } from '../lib/fixers.mjs';

const site = { name: 'example', url: 'https://example.wpenginepowered.com', install: 'example' };
const template = { title: 'Audit', sections: [{ title: 'Polish', items: [{ id: 'polish--editable', title: 'Everything rendered is editable', check: 'audit.editable', owner: 'Tech Lead' }, { id: 'other', title: 'Other', check: 'test.manualOnly' }] }] };
const result = { status: 'fail', summary: '2 findings', children: [
  { key: 'cpt-labels', title: 'Post type labels', status: 'fail', summary: 'Labels fall back to Posts.' },
  { key: 'title-length', title: 'Title length', status: 'warn', summary: 'Long titles.' },
  { key: 'Bad Key!', title: 'ignored', status: 'warn' },
] };

test('a result with children becomes the parent plus one item per child, in order; bad keys are dropped', () => {
  const r = expandResult('polish--editable', result);
  assert.deepEqual(Object.keys(r).sort(), ['polish--editable', 'polish--editable::cpt-labels', 'polish--editable::title-length']);
  assert.deepEqual(r['polish--editable'].children, ['cpt-labels', 'title-length']);
  assert.equal(r['polish--editable::title-length'].order, 1);
  assert.equal(r['polish--editable::cpt-labels'].parent, 'polish--editable');
  assert.equal(parentOf('polish--editable::cpt-labels'), 'polish--editable');
  assert.equal(parentOf('polish--editable'), null);
});

const at = '2026-11-13T08:00:00Z';
const stateFrom = res => ({ items: Object.fromEntries(Object.entries(res).map(([id, r]) => [id, { tool: { ...r, at }, status: r.status, source: 'tool' }])) });

test('children are listed right after their item, once, even when expanded twice', () => {
  const ts = stateFrom(expandResult('polish--editable', result));
  const once = withChildren(template, ts), twice = withChildren(once, ts);
  assert.deepEqual(twice.sections[0].items.map(i => i.id), ['polish--editable', 'polish--editable::cpt-labels', 'polish--editable::title-length', 'other']);
  const kid = childItems(template.sections[0].items[0], ts.items)[0];
  assert.equal(kid.title, 'Post type labels'); assert.equal(kid.check, 'audit.editable'); assert.equal(kid.owner, 'Tech Lead');
  assert.ok(isContainer(template.sections[0].items[0], ts.items));
  assert.ok(!isContainer(template.sections[0].items[1], ts.items));
});

test('fixes are planned per approved child; the container is never planned', () => {
  const ts = stateFrom(expandResult('polish--editable', result));
  ts.items['polish--editable'].decision = 'approve'; // even if someone approved the container
  ts.items['polish--editable::cpt-labels'].decision = 'approve';
  ts.items['polish--editable::cpt-labels'].note = 'Add the full labels set';
  const plan = planFixes(template, ts, site);
  assert.deepEqual(plan.manual.map(m => m.id), ['polish--editable::cpt-labels']);
  assert.equal(plan.manual[0].title, 'Post type labels');
  assert.equal(plan.manual[0].item.note, 'Add the full labels set');
  assert.equal(plan.manual[0].item.finding.summary, 'Labels fall back to Posts.');
  ts.items['polish--editable::cpt-labels'].fix = { state: 'manual', toolAt: at };
  assert.deepEqual(retryIds(template, ts), ['polish--editable::cpt-labels']);
});

test('a child the next run no longer finds passes and keeps its decision (an approved one counts as fixed)', () => {
  const ts = stateFrom(expandResult('polish--editable', result));
  ts.items['polish--editable::cpt-labels'].decision = 'approve';
  const next = expandResult('polish--editable', { status: 'warn', summary: '1 finding', children: [result.children[1]] });
  settleMissingChildren(ts.items, next, '2026-11-13T09:00:00Z', 'run2');
  const gone = ts.items['polish--editable::cpt-labels'];
  assert.equal(gone.status, 'pass'); assert.equal(gone.decision, 'approve');
  assert.equal(gone.tool.title, 'Post type labels'); assert.match(gone.tool.summary, /Not found in the latest run/);
  assert.equal(ts.items['polish--editable::title-length'].status, 'warn'); // still reported: untouched here (applyRun sets it)
});

test('a run that could not report children (an error) leaves the existing children alone', () => {
  const ts = stateFrom(expandResult('polish--editable', result));
  settleMissingChildren(ts.items, { 'polish--editable': { status: 'warn', summary: 'The check could not run: SSH timed out' } }, at, 'run3');
  assert.equal(ts.items['polish--editable::cpt-labels'].status, 'fail');
});

test('a partial re-check settles only the findings it judged; the parent is worked out from all children', () => {
  const ts = stateFrom(expandResult('polish--editable', result)); // cpt-labels (fail), title-length (warn)
  // A fix run fixed cpt-labels; its re-check judged only the WP-CLI findings (title-length needs the pages).
  const next = expandResult('polish--editable', { status: 'pass', summary: '0 findings', children: [], evaluated: ['cpt-labels', 'empty-fields'] });
  settleMissingChildren(ts.items, next, '2026-11-13T10:00:00Z', 'verify');
  assert.equal(ts.items['polish--editable::cpt-labels'].status, 'pass');
  assert.equal(ts.items['polish--editable::title-length'].status, 'warn'); // not judged: keeps its last result
  assert.equal(ts.items['polish--editable'].status, 'warn'); // the open child keeps the parent flagged
  assert.match(ts.items['polish--editable'].tool.summary, /1 finding open \(this re-check covered 2 of the checks/);
});
