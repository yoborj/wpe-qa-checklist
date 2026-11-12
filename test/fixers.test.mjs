// Which approved items a fix run plans: new ones, and (Retry fix request) ones an earlier run left in a fix request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFixes, retryIds } from '../lib/fixers.mjs';

const site = { name: 'example', url: 'https://example.wpenginepowered.com', install: 'example' };
const template = { sections: [{ items: ['new', 'inrequest', 'asked', 'fixed', 'declined', 'rechecked'].map(id => ({ id, title: id, check: 'test.manualOnly' })) }] };
const at = '2026-11-12T08:00:00Z';
const item = (fix, extra = {}) => ({ decision: 'approve', status: 'fail', tool: { at }, ...(fix ? { fix: { toolAt: at, ...fix } } : {}), ...extra });
const tabState = { items: {
  new: item(null),
  inrequest: item({ state: 'manual' }),
  asked: item({ state: 'question' }),
  fixed: item({ state: 'verified' }),
  declined: item(null, { decision: 'decline' }),
  rechecked: { ...item({ state: 'manual' }), tool: { at: '2026-11-12T09:00:00Z' } }, // checks ran again since
} };
const ids = plan => plan.manual.map(m => m.id).sort();

test('Apply fixes plans new items and re-checked ones, not items already in a fix request or waiting for an answer', () => {
  assert.deepEqual(ids(planFixes(template, tabState, site)), ['new', 'rechecked']);
});

test('retryIds: only approved items left in a fix request for the same finding', () => {
  assert.deepEqual(retryIds(template, tabState), ['inrequest']);
});

test('Retry fix request plans those items again, alongside anything new', () => {
  assert.deepEqual(ids(planFixes(template, tabState, site, { include: retryIds(template, tabState) })), ['inrequest', 'new', 'rechecked']);
});

test('answering Claude plans the asked items again', () => {
  assert.ok(ids(planFixes(template, tabState, site, { include: ['asked'] })).includes('asked'));
});
