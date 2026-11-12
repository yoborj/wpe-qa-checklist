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

// Is Claude Code installed and signed in? ({ ok, bin, reason })
export function claudeStatus() {
  const bin = claudeBin();
  if (!bin) return { ok: false, bin: null, reason: "Claude Code isn't installed on this Mac (the claude command)." };
  const r = spawnSync(bin, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 15000 });
  let loggedIn = false; try { loggedIn = !!JSON.parse(r.stdout).loggedIn; } catch { /* old CLI or odd output */ loggedIn = r.status === 0; }
  return loggedIn ? { ok: true, bin } : { ok: false, bin, reason: "Claude Code isn't signed in on this Mac. Run `claude auth login` in Terminal, then try again." };
}

// `headless` (the default): the rules for a --claude run started by the app. `rules <site>` prints the interactive
// version, where the person is in the conversation and Claude does the wait and cache clearing itself.
export const RULES = (site, { headless = true } = {}) => `You are fixing approved QA items on a production WordPress site hosted on WP Engine. The site owner approved every item listed below in the QA checklist app and confirmed this run. Work carefully: this is a live site.

${headless ? `This run is headless: the owner is not watching this conversation and cannot answer you mid-run. Their approval is already given, so do not stop to ask for a go-ahead, and do not run the wpeqa command line (its plan/approve/--yes steps and the repository's CLAUDE.md workflow are for interactive sessions). When you truly need the owner's decision or content, report that item with "result":"question" (see the JSON below): the app shows your question to the owner and continues this conversation with their answer.

This run ends the moment you stop: never sleep or wait, never start background tasks, and never schedule a wake-up or say you will resume later. Anything left running is lost and your items count as unreported. The app does the waiting after you finish (see the cache rule below).

` : ''}Rules:
- Fix only the listed items. Change nothing else on the site.
- Reach the server with: ssh -o BatchMode=yes ${site.install}@${site.install}.ssh.wpengine.net 'bash -s' <<'EOF' ... EOF  (the WP Engine SSH gateway strips quotes from command-line commands, so always send scripts on stdin). WordPress lives in ~/sites/${site.install}; WP-CLI (wp) is available there.
- Theme or plugin files: download the file into this working folder (rsync/scp), edit it here, and right before uploading compare the server copy's md5 with the one you downloaded. If it changed, someone else edited it: do not overwrite it; skip that item and say so.
- Upload PHP into ~/sites/${site.install}/_wpeprivate/stage/ first, run php -l there, and only copy it into place when it reports no syntax errors.
- Never delete anything permanently (use the trash), never create, delete or edit user accounts or passwords, never change DNS or WP Engine settings, and install no plugin unless the item is about that plugin.
${headless
  ? `- Do not wait for new PHP to load and do not clear caches yourself: after you finish, the app waits about 2 minutes (the web servers pick up new PHP slowly), clears every cache and re-runs the checks, which marks each item you fixed as verified or still flagged. Before reporting, check what you can right away (php -l passed, the file is in place with the md5 you expect, the setting is saved) and say in your summary what the re-check should show.
- For changes that don't need new PHP (settings, content, WP-CLI options), you can verify against the origin server, which skips Cloudflare's cache: curl -sk --connect-to ${new URL(site.url).hostname}:443:${site.install}.wpengine.com:443 ${site.url}/...`
  : `- After changes, wait about 2 minutes (the web servers pick up new PHP slowly), then clear caches: wp cache flush; wp eval 'if(class_exists("WpeCommon")){WpeCommon::purge_memcached();WpeCommon::purge_varnish_cache();}'; wp page-cache flush; wp cdn-cache flush.
- Verify each fix against the origin server, which skips Cloudflare's cache: curl -sk --connect-to ${new URL(site.url).hostname}:443:${site.install}.wpengine.com:443 ${site.url}/...`}
- If an item needs a decision or content from the owner, do everything you safely can first, then report it as "question" with one clear, self-contained question (say what you found and what the options are). If a safe fix isn't possible at all, report it as "skipped" and explain why. Asking or skipping is better than guessing on a live site.
- Finish with a short plain-language summary, then this JSON block exactly (one entry per item id; "question" only when result is "question"):
\`\`\`json
{"items":[{"id":"<item id>","result":"fixed" or "skipped" or "question","summary":"<one sentence>","question":"<your question to the owner>"}]}
\`\`\``;

// The owner's answer to Claude's questions, sent as the next message of the same conversation.
export const replyPrompt = (answer, items) => `The site owner answered in the QA checklist app:

${answer}

Continue with these items: ${items.map(i => `${i.id} (${i.title})`).join(', ')}. The same rules apply. Finish with your summary and the JSON block for these items.`;

// Reads Claude's final message: per-item verdicts from the JSON block. Without a JSON block, a message that
// ends in a question counts as a question about every item (Claude stopped to ask instead of reporting).
export function parseVerdicts(text, ids) {
  const verdicts = {};
  const m = text.match(/```json\s*([\s\S]*?)```/);
  try {
    for (const it of JSON.parse(m ? m[1] : '{}').items || []) {
      if (!it?.id) continue;
      const result = ['fixed', 'skipped', 'question'].includes(it.result) ? it.result : 'skipped';
      verdicts[it.id] = { id: it.id, result, summary: String(it.summary || ''), ...(result === 'question' ? { question: String(it.question || it.summary || '').trim() } : {}) };
    }
  } catch { /* unreadable JSON: fall through to the question check */ }
  const prose = text.replace(/```json[\s\S]*?```/, '').trim();
  if (!Object.keys(verdicts).length && /\?\s*$/.test(prose)) {
    const question = prose.split(/\n\s*\n/).filter(Boolean).slice(-2).join('\n\n').trim();
    for (const id of ids) verdicts[id] = { id, result: 'question', summary: 'Claude stopped to ask a question.', question };
  }
  return { verdicts, summary: prose };
}

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

// Starts Claude Code on the approved items, or (with `resume`) continues an earlier run's conversation with the
// owner's answer to its questions. The session id and working folder are saved in the run folder
// (claude-session.json) so the next answer can continue the same conversation.
export function runClaudeFix({ site, template, manual, backup, dir, log, resume = null, timeoutMs = 45 * 60 * 1000 }) {
  const st = claudeStatus();
  if (!st.ok) return Promise.reject(new Error(st.reason));
  const bin = st.bin;
  // A resumed conversation must run in the folder it started in: Claude Code keeps sessions per folder.
  const work = resume ? resume.work : path.join(dir, 'claude-work');
  fs.mkdirSync(work, { recursive: true });
  const prompt = resume ? replyPrompt(resume.answer, manual) : claudePrompt(site, template, manual, backup);
  fs.writeFileSync(path.join(dir, 'claude-prompt.md'), (resume ? '' : RULES(site) + '\n\n') + prompt + '\n');
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    '--disallowedTools', ...DISALLOWED,
    '--append-system-prompt', RULES(site), '--max-turns', '120',
    ...(resume ? ['--resume', resume.sessionId] : [])];
  log(resume
    ? `Sending your answer to Claude Code and continuing its conversation for ${manual.length} item${manual.length === 1 ? '' : 's'}…`
    : `Starting Claude Code for ${manual.length} item${manual.length === 1 ? '' : 's'} (working folder ${path.relative(process.cwd(), work) || work})…`);
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: work, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const transcript = fs.createWriteStream(path.join(dir, 'claude.jsonl'));
    let buf = '', final = null, err = '', sessionId = resume?.sessionId || null;
    const t = setTimeout(() => { log('Claude Code took longer than 45 minutes; stopping it.'); p.kill('SIGTERM'); }, timeoutMs);
    p.stdout.on('data', chunk => {
      transcript.write(chunk); buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id) sessionId = ev.session_id;
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
      if (/failed to authenticate|oauth session expired|not logged in|invalid api key/i.test(text) && (final.num_turns || 0) <= 1) return reject(new Error("Claude Code isn't signed in on this Mac. Run `claude auth login` in Terminal, then try again."));
      fs.writeFileSync(path.join(dir, 'claude-summary.md'), text + '\n');
      if (sessionId) fs.writeFileSync(path.join(dir, 'claude-session.json'), JSON.stringify({ sessionId, work }, null, 1));
      const { verdicts, summary } = parseVerdicts(text, manual.map(m => m.id));
      log(`Claude Code finished${final.num_turns ? ` in ${final.num_turns} turns` : ''}${final.total_cost_usd ? ` ($${final.total_cost_usd.toFixed(2)})` : ''}.`);
      const asked = Object.values(verdicts).filter(v => v.result === 'question');
      if (asked.length) log(`Claude has ${asked.length === 1 ? 'a question' : `${asked.length} questions`} for you: answer in the app (QA checklist → this tab) to let it continue.`);
      resolve({ verdicts, summary, sessionId, work, error: final.is_error ? (final.subtype || 'error') : null });
    });
  });
}
