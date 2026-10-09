// Runs Claude Code (headless, on this Mac) to fix approved items the app can't fix by itself.
// The person approved each item and confirmed the run in the app; Claude gets the fix request plus
// the production rules, streams its progress into the run log, and ends with a JSON verdict per item.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeBin() {
  const candidates = [process.env.CLAUDE_BIN, path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].filter(Boolean);
  const found = candidates.find(p => fs.existsSync(p));
  if (found) return found;
  const w = spawnSync('which', ['claude'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.trim() : null;
}

export const RULES = site => `You are fixing approved QA items on a production WordPress site hosted on WP Engine. The site owner approved every item listed below in the QA checklist app and confirmed this run. Work carefully: this is a live site.

Rules:
- Fix only the listed items. Change nothing else on the site.
- Reach the server with: ssh -o BatchMode=yes ${site.install}@${site.install}.ssh.wpengine.net 'bash -s' <<'EOF' ... EOF  (the WP Engine SSH gateway strips quotes from command-line commands, so always send scripts on stdin). WordPress lives in ~/sites/${site.install}; WP-CLI (wp) is available there.
- Theme or plugin files: download the file into this working folder (rsync/scp), edit it here, and right before uploading compare the server copy's md5 with the one you downloaded. If it changed, someone else edited it: do not overwrite it; skip that item and say so.
- Upload PHP into ~/sites/${site.install}/_wpeprivate/stage/ first, run php -l there, and only copy it into place when it reports no syntax errors.
- Never delete anything permanently (use the trash), never create, delete or edit user accounts or passwords, never change DNS or WP Engine settings, and install no plugin unless the item is about that plugin.
- After changes, wait about 2 minutes (the web servers pick up new PHP slowly), then clear caches: wp cache flush; wp eval 'if(class_exists("WpeCommon")){WpeCommon::purge_memcached();WpeCommon::purge_varnish_cache();}'; wp page-cache flush; wp cdn-cache flush.
- Verify each fix against the origin server, which skips Cloudflare's cache: curl -sk --connect-to ${new URL(site.url).hostname}:443:${site.install}.wpengine.com:443 ${site.url}/...
- If an item needs a decision or content from the owner, or a safe fix isn't clear, skip it and explain why. Skipping is better than guessing on a live site.
- Finish with a short plain-language summary, then this JSON block exactly (one entry per item id):
\`\`\`json
{"items":[{"id":"<item id>","result":"fixed" or "skipped","summary":"<one sentence>"}]}
\`\`\``;

export function claudePrompt(site, template, manual, backup) {
  const lines = [
    `Site: ${site.name} — ${site.url} (WP Engine install ${site.install}). Checklist: ${template.title}.`,
    backup ? `A backup was taken just before this run: ${backup.path} (database db.sql.gz, theme theme.tgz). Restore commands: ${backup.restore.join(' ; ')}` : 'No backup was taken: make no changes; report every item as skipped.',
    '', 'Approved items to fix:',
  ];
  for (const m of manual) {
    lines.push('', `- id: ${m.id}`, `  title: ${m.title}`, `  checklist description: ${m.item.description || ''}`);
    if (m.item.finding?.summary) lines.push(`  finding: ${m.item.finding.summary}`);
    for (const d of (m.item.finding?.details || []).slice(0, 15)) lines.push(`    - ${d}`);
    if (m.item.note) lines.push(`  owner's note: ${m.item.note}`);
    if (m.item.decisionNote) lines.push(`  fix note: ${m.item.decisionNote}`);
  }
  return lines.join('\n');
}

const DISALLOWED = ['Bash(sudo:*)', 'Bash(git push:*)', 'Bash(wp db reset:*)', 'Bash(wp db drop:*)', 'Bash(wp site empty:*)', 'Bash(wp user:*)', 'Bash(wp search-replace:*)', 'Bash(rm -rf /:*)', 'Bash(rm -rf ~:*)'];

export function runClaudeFix({ site, template, manual, backup, dir, log, timeoutMs = 45 * 60 * 1000 }) {
  const bin = claudeBin();
  if (!bin) return Promise.reject(new Error('Claude Code (the claude command) was not found on this Mac.'));
  const work = path.join(dir, 'claude-work');
  fs.mkdirSync(work, { recursive: true });
  const prompt = claudePrompt(site, template, manual, backup);
  fs.writeFileSync(path.join(dir, 'claude-prompt.md'), RULES(site) + '\n\n' + prompt + '\n');
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    '--disallowedTools', ...DISALLOWED,
    '--append-system-prompt', RULES(site), '--max-turns', '120', '--no-session-persistence'];
  log(`Starting Claude Code for ${manual.length} item${manual.length === 1 ? '' : 's'} (working folder ${path.relative(process.cwd(), work) || work})…`);
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: work, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const transcript = fs.createWriteStream(path.join(dir, 'claude.jsonl'));
    let buf = '', final = null, err = '';
    const t = setTimeout(() => { log('Claude Code took longer than 45 minutes; stopping it.'); p.kill('SIGTERM'); }, timeoutMs);
    p.stdout.on('data', chunk => {
      transcript.write(chunk); buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
          if (c.type === 'text' && c.text.trim()) c.text.trim().split('\n').filter(Boolean).slice(0, 6).forEach(l => log('Claude: ' + l.slice(0, 220)));
          if (c.type === 'tool_use') log(`Claude → ${c.name}: ${String(c.input?.command || c.input?.file_path || c.input?.pattern || '').split('\n')[0].slice(0, 160)}`);
        }
        if (ev.type === 'result') final = ev;
      }
    });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      clearTimeout(t); transcript.end();
      if (!final) return reject(new Error(`Claude Code ended without a result (exit ${code}). ${err.trim().split('\n').slice(-2).join(' ')}`));
      const text = final.result || '';
      fs.writeFileSync(path.join(dir, 'claude-summary.md'), text + '\n');
      const m = text.match(/```json\s*([\s\S]*?)```/);
      let verdicts = {};
      try { for (const it of JSON.parse(m ? m[1] : '{}').items || []) verdicts[it.id] = it; } catch { /* no JSON: every item is reported as unknown */ }
      log(`Claude Code finished${final.num_turns ? ` in ${final.num_turns} turns` : ''}${final.total_cost_usd ? ` ($${final.total_cost_usd.toFixed(2)})` : ''}.`);
      resolve({ verdicts, summary: text.replace(/```json[\s\S]*?```/, '').trim(), error: final.is_error ? (final.subtype || 'error') : null });
    });
  });
}
