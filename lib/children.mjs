// Child findings. One check can report several separate problems under one checklist item: each becomes a child
// card under that item, with its own status, note and Approve / Decline. A child is a normal item in the site's
// state, keyed `<parent id>::<key>`, so fix runs, fix requests, Fix Failed and Fixed work for it like for any item.
// The parent becomes a container: the check sets its status (the worst of its children) and nobody decides on it.
// A child the latest run no longer finds stays (with its decision) and passes, so an approved one moves to Fixed.
// public/app.js repeats childItems / withChildren (no build step); keep the two in step.

export const SEP = '::';
const KEY = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const childId = (parent, key) => `${parent}${SEP}${key}`;
export const parentOf = id => (String(id).includes(SEP) ? String(id).slice(0, String(id).indexOf(SEP)) : null);

// A check result with `children: [{ key, title, description, status, summary, details }]` →
// { [parent id]: parent result (children = their keys, in order), [child id]: child result, … }.
export function expandResult(itemId, r) {
  if (!Array.isArray(r?.children)) return { [itemId]: r };
  const out = {}; const keys = [];
  r.children.forEach(c => {
    if (!KEY.test(c?.key || '') || keys.includes(c.key)) return;
    const { key, ...rest } = c;
    keys.push(key);
    out[childId(itemId, key)] = { ...rest, parent: itemId, key, order: keys.length - 1 };
  });
  out[itemId] = { ...r, children: keys };
  return out;
}

// The child items the state holds for a checklist item, in the order the last run listed them.
export function childItems(it, items = {}) {
  const pre = it.id + SEP;
  return Object.keys(items)
    .filter(id => id.startsWith(pre) && items[id]?.tool)
    .sort((a, b) => (items[a].tool.order ?? 1e3) - (items[b].tool.order ?? 1e3) || a.localeCompare(b))
    .map(id => ({ id, title: items[id].tool.title || id.slice(pre.length), description: items[id].tool.description || '', owner: it.owner, ownerLabel: it.ownerLabel, check: it.check, parent: it.id }));
}

// A container: an item whose check reports its findings as children (and has reported some).
export const isContainer = (it, items = {}) => childItems(it, items).length > 0;

// The checklist with each container's children listed right after it (the children carry `parent`). Safe to call on
// a checklist that already has its children: they are listed again from the state, once.
export function withChildren(template, tabState) {
  if (!template) return template;
  const items = tabState?.items || {};
  return { ...template, sections: template.sections.map(sec => ({ ...sec, items: sec.items.filter(it => !it.parent).flatMap(it => [it, ...childItems(it, items)]) })) };
}

// After a run: children of a parent this run checked that it no longer reports now pass (their decisions stay).
// A partial re-check (`evaluated`: the child keys it judged, e.g. a fix run's re-check of two findings) settles only
// those; the others keep their last result, and the parent's status is worked out again from all its children.
export function settleMissingChildren(items, results, at, runId) {
  for (const [pid, r] of Object.entries(results)) {
    if (!Array.isArray(r?.children)) continue;
    const pre = pid + SEP;
    const judged = Array.isArray(r.evaluated) ? new Set(r.evaluated) : null;
    for (const [id, it] of Object.entries(items)) {
      if (!id.startsWith(pre) || id in results || !it.tool || it.tool.status === 'pass') continue;
      if (judged && !judged.has(id.slice(pre.length))) continue;
      const { title, description, order, key } = it.tool;
      it.tool = { title, description, order, key, parent: pid, status: 'pass', summary: 'Not found in the latest run.', at, runId };
      it.status = 'pass'; it.source = 'tool';
    }
    if (judged && items[pid]) {
      const kids = Object.entries(items).filter(([id, it]) => id.startsWith(pre) && it.tool);
      const open = kids.filter(([, it]) => ['fail', 'warn'].includes(it.status));
      const status = open.some(([, it]) => it.status === 'fail') ? 'fail' : open.length ? 'warn' : 'pass';
      items[pid].status = status;
      items[pid].tool = { ...items[pid].tool, status, summary: `${open.length} finding${open.length === 1 ? '' : 's'} open (this re-check covered ${judged.size} of the checks; the rest are from the last full run).` };
    }
  }
}
