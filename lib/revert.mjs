// Revert fix: undo, on the site, what one earlier fix changed. Only for a fix the app or Claude made in a fix run, so
// there is a backup from just before it and a record of what it did. Claude does the revert (headless, like a fix run):
// it restores only what that item's fix changed, from that backup, never the whole database or theme, and never other
// items' fixes from the same run. A fresh backup comes first and the item is re-checked after. The revert job itself
// is lib/jobs.mjs revertJob; this file holds what it plans and tells Claude.
import fs from 'node:fs';
import path from 'node:path';
import { withChildren } from './children.mjs';
import { parseVerdicts } from './claude.mjs';
import { FIXERS } from './fixers.mjs';

// Why this item's fix can't be reverted, or null when it can. `tabState`: the tab's saved state (items + fixRuns).
export function revertBlocker(tabState, itemId) {
  const s = tabState?.items?.[itemId];
  if (!s?.fix?.runId || !['verified', 'applied'].includes(s.fix.state)) return 'Only a fix the app or Claude made in a fix run can be reverted, and this item has none on record.';
  const run = (tabState.fixRuns || []).find(r => r.id === s.fix.runId);
  if (!run?.backup?.path) return 'The fix run that made this change has no backup on record, so it can’t be reverted safely.';
  return null;
}

// What the fix run did on the server: the commands Claude ran (from its transcript), longest-first trimmed to fit.
export function fixCommands(runDir, { max = 40, each = 2500, total = 24000 } = {}) {
  const f = path.join(runDir, 'claude.jsonl');
  if (!fs.existsSync(f)) return [];
  const out = []; let size = 0;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content || []) {
      if (c.type !== 'tool_use' || c.name !== 'Bash' || !c.input?.command) continue;
      const cmd = c.input.command.length > each ? c.input.command.slice(0, each) + '\n…(cut)' : c.input.command;
      if (out.length >= max || size + cmd.length > total) return [...out, '…(more commands not shown)'];
      out.push(cmd); size += cmd.length;
    }
  }
  return out;
}

// Everything the revert needs to know. Throws (with the reason) when the item can't be reverted.
export function planRevert({ site, template, tabState, itemId, runDirOf }) {
  const why = revertBlocker(tabState, itemId);
  if (why) throw new Error(why);
  const s = tabState.items[itemId];
  const item = withChildren(template, tabState).sections.flatMap(x => x.items).find(i => i.id === itemId);
  if (!item) throw new Error('Unknown item.');
  const run = tabState.fixRuns.find(r => r.id === s.fix.runId);
  const dir = runDirOf(run.id);
  const byClaude = s.fix.by === 'claude';
  // Claude's own words on this item in that run, if it reported them.
  let report = '';
  try { report = parseVerdicts(fs.readFileSync(path.join(dir, 'claude-summary.md'), 'utf8'), [itemId]).verdicts[itemId]?.summary || ''; } catch { /* no summary */ }
  const fixer = !byClaude && FIXERS[item.check];
  const script = fixer ? fixer.script({ ...item, note: s.note, decisionNote: s.decisionNote, finding: s.tool }, site) : '';
  return {
    item, state: s, fixRun: run, fixRunId: run.id, fixWhen: new Date(run.finishedAt || s.fix.at).toLocaleString(), byClaude,
    did: s.fix.action || report || s.fix.reason || '', report, script,
    commands: byClaude ? fixCommands(dir) : [],
    others: (run.items || []).filter(id => id !== itemId),
  };
}

// The task for Claude (its usual production rules come with it as the system prompt).
export function revertPrompt({ site, plan, backup, brief = '' }) {
  const { item, fixRun, fixWhen, byClaude, did, report, script, commands, others } = plan;
  const lines = [
    `Site: ${site.name} — ${site.url} (WP Engine install ${site.install}).`,
    '',
    'THIS RUN REVERTS AN EARLIER FIX. The site owner asked in the QA checklist app to undo, on the site, what one earlier fix changed, and confirmed it. Undo only that fix. Change nothing else.',
    '',
    `Item: ${item.id} — ${item.title}`,
    item.description ? `Checklist description: ${item.description}` : '',
    `The fix being undone: fix run ${fixRun.id} (${fixWhen}), made by ${byClaude ? 'Claude Code' : 'the app’s automatic fix'}.`,
    did ? `What it did: ${did}` : '',
    report && report !== did ? `Claude's report on it: ${report}` : '',
    others.length ? `That fix run also worked on other items (${others.join(', ')}). Leave their changes in place.` : '',
    '',
    `Backup from just BEFORE that fix (the state to go back to): ${fixRun.backup.path} (db.sql.gz = database, theme.tgz = active theme${fixRun.backup.restore?.some(r => /plugins\.tgz/.test(r)) ? ', plugins.tgz = plugins' : ''}).`,
    `A fresh backup of the site as it is now was just taken: ${backup.path}.`,
    '',
    ...(script ? ['The automatic fix ran this on the server:', '```bash', script, '```', ''] : []),
    ...(commands.length ? ['The commands that fix run sent (in order):', ...commands.map((c, i) => `--- command ${i + 1}\n${c}`), ''] : []),
    ...(brief ? ['Site map, read just before this run:', brief, ''] : []),
    'How to revert:',
    '- First work out exactly what this fix changed: which files, options, posts, post meta or settings. Ignore what it only read.',
    '- Restore just those from the BEFORE backup: single files with tar (e.g. tar xzf <backup>/theme.tgz <theme>/<file> -O), single values by reading them from db.sql.gz (zgrep) and setting them back with WP-CLI or one targeted query. Renamed or moved things go back to their old names; anything the fix added is removed (posts and attachments to the trash).',
    '- Never import the whole database and never unpack the whole theme or plugins archive. Never undo the other items’ changes from that run.',
    '- Before overwriting a file, compare the server copy with what the fix left. If someone changed it since, do not overwrite it: report the item as skipped and say what changed.',
    '- PHP goes through ~/sites/<install>/_wpeprivate/stage/ and php -l first, as usual. Do not wait for PHP or clear caches: the app does both, then re-checks the item.',
    '- When the revert is done, report the item with "result":"fixed" (meaning: the fix is undone) and say in the summary what you restored. If it can’t be undone safely, report "skipped" and why; if you need the owner, "question".',
  ];
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}
