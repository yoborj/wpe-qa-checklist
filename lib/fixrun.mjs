// Applies a tab's approved fixes for one site: backup first, then each automatic fix, then caches.
// Approved items without an automatic fix go into a fix request for a developer.
import fs from 'node:fs';
import path from 'node:path';
import { sshRun, fixPreamble } from './wpe.mjs';
import { FIXERS, planFixes, fixRequest } from './fixers.mjs';
import { runClaudeFix, siteBrief, phpChangedSince } from './claude.mjs';

// WordPress object cache, WP Engine's page caches and CDN, and WP Rocket when present.
export async function clearCaches(site, log) {
  log('Clearing caches…');
  await sshRun(site.install, `${fixPreamble(site.install)}wp cache flush >/dev/null 2>&1
wp eval 'if ( class_exists( "WpeCommon" ) ) { WpeCommon::purge_memcached(); WpeCommon::purge_varnish_cache(); } if ( function_exists( "rocket_clean_domain" ) ) { rocket_clean_domain(); }' >/dev/null 2>&1
wp page-cache flush >/dev/null 2>&1; wp cdn-cache flush >/dev/null 2>&1; echo done`);
}

export async function backupSite(site, runId, { plugins = false } = {}, log) {
  const dir = `_wpeprivate/wpeqa-backups/${runId}`;
  log(`Backing up to ${dir} on the server (database + active theme${plugins ? ' + plugins' : ''})…`);
  const r = await sshRun(site.install, `${fixPreamble(site.install)}set -e
B=${dir}
mkdir -p "$B"
wp db export "$B/db.sql" --quiet
gzip -f "$B/db.sql"
S=$(wp option get stylesheet); T=$(wp option get template)
if [ "$S" = "$T" ]; then tar czf "$B/theme.tgz" -C wp-content/themes "$S"; else tar czf "$B/theme.tgz" -C wp-content/themes "$S" "$T"; fi
${plugins ? 'tar czf "$B/plugins.tgz" -C wp-content plugins' : ''}
wp plugin list --format=json > "$B/plugins.json"
wp core version > "$B/wp-version.txt"
ls -la "$B" | awk 'NR>1 && $5>0 {print $5, $9}'
echo "SIZE $(du -sh "$B" | cut -f1)"
echo BACKUP_OK
`);
  if (r.code !== 0 || !r.out.includes('BACKUP_OK')) throw new Error(`Backup failed, so no fixes were applied. ${r.err.split('\n').slice(-2).join(' ')}`);
  const size = (r.out.match(/SIZE (\S+)/) || [])[1];
  log(`Backup saved (${size}): ${r.out.split('\n').filter(l => /\.(gz|tgz|json|txt)$/.test(l)).map(l => l.split(' ')[1]).join(', ')}.`);
  return {
    path: `~/sites/${site.install}/${dir}`, size,
    restore: [
      `ssh ${site.install}@${site.install}.ssh.wpengine.net`,
      `cd ~/sites/${site.install} && gunzip -kf ${dir}/db.sql.gz && wp db import ${dir}/db.sql`,
      `tar xzf ${dir}/theme.tgz -C wp-content/themes`,
      ...(plugins ? [`tar xzf ${dir}/plugins.tgz -C wp-content`] : []),
      `wp cache flush`,
    ],
  };
}

// `reply` continues an earlier run's Claude Code conversation with the owner's answer: only the items Claude
// asked about ({ items, answer, sessionId, work }), no automatic fixes, and a fresh backup first.
// `include`: item ids already in a fix request to plan again (Retry fix request).
export async function fixTab({ site, template, tabState, runId, dir, log, progress, claude = false, reply = null, include = [] }) {
  const plan = planFixes(template, tabState, site, { include: reply ? reply.items : include });
  if (reply) { plan.auto = []; plan.manual = plan.manual.filter(m => reply.items.includes(m.id)); claude = true; }
  if (reply && !plan.manual.length) throw new Error('Those items are no longer approved and flagged, so there is nothing for Claude to continue. Run the checks again or approve them first.');
  if (!plan.auto.length && !plan.manual.length) throw new Error('No approved items to fix in this tab. Approve failed or flagged items first.');
  fs.mkdirSync(dir, { recursive: true });
  const useClaude = claude && plan.manual.length > 0;
  log(`${plan.auto.length} automatic fix${plan.auto.length === 1 ? '' : 'es'}, ${plan.manual.length} ${useClaude ? 'for Claude Code' : 'for the fix request'}.`);
  let backup = null; const outcomes = {}; let claudeRun = null;
  if (plan.auto.length || useClaude) backup = await backupSite(site, runId, { plugins: plan.auto.some(a => FIXERS[a.check].backupPlugins) }, log);
  if (plan.auto.length) {
    progress(0.25);
    let n = 0;
    for (const a of plan.auto) {
      log(`Fixing “${a.title}”: ${a.action}`);
      const r = await sshRun(site.install, fixPreamble(site.install) + FIXERS[a.check].script(a.item, site) + '\n');
      const out = [r.out, r.err].filter(Boolean).join('\n').split('\n').filter(l => l && !/^Deprecated|^PHP Deprecated|^Warning: Undefined/.test(l)).slice(-12);
      out.forEach(l => log('  ' + l));
      outcomes[a.id] = { state: r.code === 0 ? 'applied' : 'failed', output: out, action: a.action };
      if (r.code !== 0) log(`  That fix failed (exit ${r.code}).`);
      progress(0.25 + 0.4 * ++n / plan.auto.length);
    }
    await clearCaches(site, log);
  }
  if (useClaude) {
    try {
      // One SSH call: a site map for Claude (a new run; an answer continues a conversation that has it) and a marker file
      // for spotting PHP changes afterwards.
      log('Reading a site map for Claude…');
      const brief = await siteBrief(site, runId).catch(() => '');
      claudeRun = await runClaudeFix({ site, template, manual: plan.manual, backup, dir, log, brief: reply ? '' : brief, resume: reply && { sessionId: reply.sessionId, work: reply.work, answer: reply.answer } });
      for (const m of plan.manual) {
        const v = claudeRun.verdicts[m.id];
        outcomes[m.id] = v?.result === 'fixed' ? { state: 'applied', by: 'claude', action: v.summary }
          : v?.result === 'question' ? { state: 'question', by: 'claude', question: v.question, reason: `Claude asked: ${v.question}` }
          : v ? { state: 'manual', by: 'claude', reason: `Claude skipped it: ${v.summary}` }
          : { state: 'manual', by: 'claude', unreported: true, reason: 'Claude stopped before reporting on this item. It may have changed something: see the run log. The re-check shows where it stands.' };
      }
      // Claude doesn't wait for new PHP or clear caches (a headless run can't wait): the app does, then re-checks.
      // Unreported items count too: Claude may have changed something before it stopped.
      // The 2-minute wait is only for new PHP (theme, plugins, .htaccess); settings and content changes show at once.
      if (plan.manual.some(m => outcomes[m.id].state === 'applied' || outcomes[m.id].unreported)) {
        const php = await phpChangedSince(site, runId).catch(() => ({ known: false, files: [] }));
        if (!php.known || php.files.length) {
          log(php.known ? `PHP changed (${php.files.slice(0, 3).join(', ')}${php.files.length > 3 ? ', …' : ''}): waiting 2 minutes for the web servers to load it…` : 'Waiting 2 minutes for the web servers to load any new PHP…');
          await new Promise(r => setTimeout(r, 120000));
        } else log('No PHP files changed, so no need to wait.');
        await clearCaches(site, log);
      }
    } catch (e) {
      log(`Claude Code could not finish: ${e.message}`);
      for (const m of plan.manual) outcomes[m.id] = { state: 'manual', reason: `Claude Code could not run: ${e.message}` };
    }
    progress(0.95);
  }
  // Anything still not fixed goes into the fix request.
  let request = null;
  const left = plan.manual.filter(m => !outcomes[m.id] || ['manual', 'question'].includes(outcomes[m.id].state));
  if (left.length) {
    request = fixRequest(site, template, { ...plan, manual: left }, backup?.path);
    fs.writeFileSync(path.join(dir, 'fix-request.md'), request + '\n');
    for (const m of left) outcomes[m.id] ||= { state: 'manual', reason: m.reason };
    const asked = left.filter(m => outcomes[m.id]?.state === 'question').length;
    log(asked === left.length
      ? `Waiting for your answer on ${asked} item${asked === 1 ? '' : 's'} (also saved as a fix request).`
      : `Fix request saved for ${left.length} item${left.length === 1 ? ' that needs' : 's that need'} a developer${asked ? ` (${asked} waiting for your answer to Claude)` : ''}.`);
  }
  if (backup) fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify(backup, null, 1));
  return { plan, backup, outcomes, request, claude: claudeRun };
}
