// Markdown report of one tab for one site (for pasting into a sheet, ticket or message).
import { greenlightLine } from './greenlight.mjs';
import { withChildren } from './children.mjs';

const LABEL = { pass: 'Passed', fail: 'Failed', warn: 'Needs a look', na: 'N/A', todo: 'To do' };

export function report(site, tab, template, state) {
  const t = state.tabs[tab] || { items: {}, runs: [] };
  template = withChildren(template, t); // child findings are listed (indented) under their item
  const last = t.runs?.[0];
  const lines = [`# ${template.title}: ${site.name}`, '', `${site.url}${site.install ? ` · WP Engine install \`${site.install}\`` : ''}${last ? ` · last run ${new Date(last.finishedAt).toLocaleString()}` : ' · not run yet'}`, ''];
  const all = template.sections.flatMap(s => s.items.map(i => t.items[i.id]?.status || 'todo'));
  lines.push(Object.entries(LABEL).map(([k, v]) => `${v}: ${all.filter(s => s === k).length}`).join(' · '), '');
  const gl = tabGreenlight(template, t);
  if (gl) lines.push(`**Security:** ${greenlightLine(gl)}`, '');
  for (const sec of template.sections) {
    lines.push(`## ${sec.title}`, '');
    for (const it of sec.items) {
      const s = t.items[it.id] || {};
      const status = LABEL[s.status || 'todo'];
      const ind = it.parent ? '  ' : '';
      lines.push(`${ind}- **${it.title}** — ${status}${s.source === 'manual' ? ' (set by hand)' : ''}${s.decision ? ` · fix ${s.decision === 'approve' ? 'approved' : 'declined'}` : ''}`);
      if (s.tool?.summary) lines.push(`${ind}  - ${s.tool.summary}`);
      for (const d of (s.tool?.details || []).slice(0, 8)) lines.push(`${ind}    - ${d}`);
      if (s.tool?.suggestion && ['fail', 'warn'].includes(s.status)) lines.push(`${ind}  - Suggested fix: ${s.tool.suggestion.text}`);
      if (s.note) lines.push(`${ind}  - Note: ${s.note}`);
      if (s.decisionNote) lines.push(`${ind}  - Fix note: ${s.decisionNote}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// The Greenlight status this tab's last run saw (from its Greenlight items), or null.
export function tabGreenlight(template, t) {
  for (const sec of template.sections) for (const it of sec.items) { const g = t.items?.[it.id]?.tool?.greenlight; if (g) return g; }
  return null;
}
