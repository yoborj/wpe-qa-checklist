// Applies a tab's approved fixes for one site: backup first, then each automatic fix, then caches.
// Approved items without an automatic fix go into a fix request for a developer.
import fs from 'node:fs';
import path from 'node:path';
import { sshRun, fixPreamble } from './wpe.mjs';
import { FIXERS, planFixes, fixRequest } from './fixers.mjs';
import { runClaudeFix } from './claude.mjs';

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

export async function fixTab({ site, template, tabState, runId, dir, log, progress, claude = false }) {
  const plan = planFixes(template, tabState, site);
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
    log('Clearing caches…');
    await sshRun(site.install, `${fixPreamble(site.install)}wp cache flush >/dev/null 2>&1
wp eval 'if ( class_exists( "WpeCommon" ) ) { WpeCommon::purge_memcached(); WpeCommon::purge_varnish_cache(); } if ( function_exists( "rocket_clean_domain" ) ) { rocket_clean_domain(); }' >/dev/null 2>&1
wp page-cache flush >/dev/null 2>&1; wp cdn-cache flush >/dev/null 2>&1; echo done`);
  }
  if (useClaude) {
    try {
      claudeRun = await runClaudeFix({ site, template, manual: plan.manual, backup, dir, log });
      for (const m of plan.manual) {
        const v = claudeRun.verdicts[m.id];
        outcomes[m.id] = v?.result === 'fixed' ? { state: 'applied', by: 'claude', action: v.summary } : { state: 'manual', by: 'claude', reason: v ? `Claude skipped it: ${v.summary}` : 'Claude did not report on this item.' };
      }
    } catch (e) {
      log(`Claude Code could not finish: ${e.message}`);
      for (const m of plan.manual) outcomes[m.id] = { state: 'manual', reason: `Claude Code could not run: ${e.message}` };
    }
    progress(0.95);
  }
  // Anything still not fixed goes into the fix request.
  let request = null;
  const left = plan.manual.filter(m => !outcomes[m.id] || outcomes[m.id].state === 'manual');
  if (left.length) {
    request = fixRequest(site, template, { ...plan, manual: left }, backup?.path);
    fs.writeFileSync(path.join(dir, 'fix-request.md'), request + '\n');
    for (const m of left) outcomes[m.id] ||= { state: 'manual', reason: m.reason };
    log(`Fix request saved for ${left.length} item${left.length === 1 ? ' that needs' : 's that need'} a developer.`);
  }
  if (backup) fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify(backup, null, 1));
  return { plan, backup, outcomes, request, claude: claudeRun };
}
