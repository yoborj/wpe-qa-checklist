// Greenlight's security status (`wp greenlight security --format=json`), read over SSH. Read-only.
// One SSH call per run: plugin status and version, then the JSON. Every way it can go wrong (not installed,
// inactive, too old for the command, an unknown schema, output that isn't JSON) becomes a result, never a throw.
import fs from 'node:fs';
import { ssh, assertInstall } from './wpe.mjs';

// The oldest Greenlight with `wp greenlight security` (schema 1). Release notes quote this.
export const GREENLIGHT_MIN_VERSION = '0.2.0';
export const GREENLIGHT_SCHEMA = 1;

export const FEATURES = {
  headers: 'Security headers', hsts: 'HSTS', csp_report_only: 'CSP (report-only)', hide_usernames: 'Hide usernames',
  xmlrpc_off: 'XML-RPC off', file_editor_off: 'File editor off', email_obfuscation: 'Email obfuscation',
  app_passwords_off: 'Application passwords off', admin_alerts: 'Admin-change alerts', script_drift: 'Script-drift alerts',
  core_file_check: 'Core-file check', content_check: 'Content check',
};
// Should be on before launch. HSTS and CSP are shown for information only; the rest are optional.
export const RECOMMENDED = ['headers', 'hide_usernames', 'file_editor_off', 'email_obfuscation', 'admin_alerts', 'script_drift', 'core_file_check', 'content_check'];
export const INFORMATIONAL = ['hsts', 'csp_report_only'];
export const ALERT_FEATURES = ['admin_alerts', 'script_drift', 'core_file_check', 'content_check'];
export const SEVERITIES = ['high', 'medium', 'low'];
const ALERT_TYPES = { admin_change: 'Admin change', script_drift: 'Script drift', core_files: 'Core files', content_check: 'Content' };

// "0.10.2" > "0.9" (numeric per part; a pre-release suffix is ignored).
export function olderThan(v, min) {
  const n = s => String(s || '').replace(/^v/, '').split(/[-+]/)[0].split('.').map(x => parseInt(x, 10) || 0);
  const a = n(v), b = n(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  return false;
}

export const greenlightScript = install => `cd ~/sites/${assertInstall(install)} || exit 3
st=$(wp plugin get greenlight --field=status 2>/dev/null) || { echo GL_MISSING; exit 0; }
v=$(wp plugin get greenlight --field=version 2>/dev/null)
echo "GL_PLUGIN $st $v"
case "$st" in active|active-network|must-use) ;; *) exit 0 ;; esac
e=$(mktemp /tmp/wpeqa.XXXXXX)
echo '<<<GL_JSON>>>'
wp greenlight security --format=json 2>"$e"; rc=$?
echo; echo '<<</GL_JSON>>>'
echo "GL_EXIT $rc"
echo '<<<GL_ERR>>>'; tail -c 2000 "$e"; echo; echo '<<</GL_ERR>>>'
rm -f "$e"
`;

const between = (s, tag) => (s.match(new RegExp(`<<<${tag}>>>\\n?([\\s\\S]*?)<<</${tag}>>>`)) || [])[1];
const lastLine = s => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

// The SSH output of greenlightScript → { state, version, message, … }. state is one of:
// ok · missing · inactive · old · schema · bad-json · error.
export function parseGreenlight(out) {
  out = String(out ?? '');
  if (/^GL_MISSING\b/m.test(out)) return { state: 'missing', version: null, message: 'Greenlight is not installed.' };
  const p = out.match(/^GL_PLUGIN (\S+)[ \t]*(\S*)/m);
  if (!p) return { state: 'error', version: null, message: 'Could not read the plugin list over SSH (WP-CLI gave no answer).' };
  const [, status, version] = p; const v = version || null;
  if (!['active', 'active-network', 'must-use'].includes(status)) return { state: 'inactive', version: v, message: `Greenlight ${v || ''} is installed but ${status}.`.replace('  ', ' ') };
  const json = between(out, 'GL_JSON') ?? ''; const err = between(out, 'GL_ERR') ?? ''; const code = +((out.match(/^GL_EXIT (\d+)/m) || [])[1] ?? NaN);
  const update = `update Greenlight to v${GREENLIGHT_MIN_VERSION}+`;
  if (code !== 0) {
    if (/not a registered (sub)?command|is not a registered wp command/i.test(err + json) || olderThan(v, GREENLIGHT_MIN_VERSION))
      return { state: 'old', version: v, message: `Greenlight ${v || '(unknown version)'} has no security status: ${update}.` };
    return { state: 'error', version: v, message: `\`wp greenlight security\` failed${Number.isNaN(code) ? '' : ` (exit ${code})`}: ${lastLine(err) || lastLine(json) || 'no output'}` };
  }
  let data = null;
  try { data = JSON.parse(json.trim()); } catch {
    // PHP notices printed before the JSON: try the outermost {…}.
    const a = json.indexOf('{'), b = json.lastIndexOf('}');
    if (a >= 0 && b > a) try { data = JSON.parse(json.slice(a, b + 1)); } catch { /* not JSON */ }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { state: 'bad-json', version: v, message: `Greenlight ${v || ''} answered, but not with valid JSON.`.replace('  ', ' '), sample: json.trim().slice(0, 200) };
  const gv = typeof data.greenlight_version === 'string' && data.greenlight_version ? data.greenlight_version : v;
  if (data.schema !== GREENLIGHT_SCHEMA) return { state: 'schema', version: gv, schema: data.schema ?? null, message: `Greenlight ${gv} reports security schema ${data.schema ?? '(none)'}; this app reads schema ${GREENLIGHT_SCHEMA}. Unsupported schema: update the QA app.` };
  const notes = [];
  const f = data.features && typeof data.features === 'object' && !Array.isArray(data.features) ? data.features : null;
  if (!f) notes.push('The JSON has no "features" object; every feature is treated as off.');
  const features = Object.fromEntries(Object.keys(FEATURES).map(k => [k, f?.[k] === true]));
  const unknown = Object.keys(FEATURES).filter(k => f && typeof f[k] !== 'boolean');
  if (f && unknown.length) notes.push(`Not reported (treated as off): ${unknown.map(k => FEATURES[k]).join(', ')}.`);
  const list = x => Array.isArray(x) ? x.filter(d => typeof d === 'string') : [];
  const raw = Array.isArray(data.alerts) ? data.alerts : [];
  const alerts = raw.filter(a => a && typeof a === 'object' && typeof a.message === 'string').map(a => ({
    id: String(a.id ?? ''), type: String(a.type ?? ''), severity: SEVERITIES.includes(a.severity) ? a.severity : 'low',
    time: typeof a.time === 'string' ? a.time : null, message: a.message, url: typeof a.url === 'string' ? a.url : null, post_id: Number.isInteger(a.post_id) ? a.post_id : null,
  }));
  if (raw.length !== alerts.length) notes.push(`${raw.length - alerts.length} alert(s) were not in the expected shape and are not shown.`);
  return { state: 'ok', version: gv, schema: GREENLIGHT_SCHEMA, features, scriptBaseline: list(data.script_baseline), trustedEmbedDomains: list(data.trusted_embed_domains), alerts, notes, message: `Greenlight ${gv}.` };
}

// Reads one install. WPEQA_GREENLIGHT_FIXTURE=<file> replays a saved SSH output instead (for tests and demos).
export async function readGreenlight(install) {
  if (process.env.WPEQA_GREENLIGHT_FIXTURE) return { ...parseGreenlight(fs.readFileSync(process.env.WPEQA_GREENLIGHT_FIXTURE, 'utf8')), install, fixture: true };
  try { return { ...parseGreenlight(await ssh(install, greenlightScript(install), { timeoutMs: 120000 })), install }; }
  catch (e) { return { state: 'error', version: null, install, message: `Could not reach WordPress over SSH: ${e.message}` }; }
}

export const offRecommended = gl => gl.state === 'ok' ? RECOMMENDED.filter(k => !gl.features[k]) : [];
export const alertCounts = gl => Object.fromEntries(SEVERITIES.map(s => [s, (gl.alerts || []).filter(a => a.severity === s).length]));
const when = t => { const d = t && new Date(t); return d && !isNaN(d) ? d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'time unknown'; };
export const alertLine = a => `${a.severity.toUpperCase()} · ${ALERT_TYPES[a.type] || a.type || 'Alert'} · ${when(a.time)} · ${a.message}${a.url ? ` · ${a.url}` : ''}${a.post_id ? ` (post ${a.post_id})` : ''}`;
// Newest first within each severity, high first.
export const sortedAlerts = gl => [...(gl.alerts || [])].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || String(b.time).localeCompare(String(a.time)));

// What a check result keeps about Greenlight (for the fixer, the report and the CLI).
export const glSummary = gl => ({ state: gl.state, version: gl.version, install: gl.install, message: gl.message, ...(gl.state === 'ok' ? { features: gl.features, off: offRecommended(gl), alerts: alertCounts(gl) } : {}) });

// One line for reports and the CLI: "Greenlight 0.2.0 · 7/8 recommended security features on (off: …) · …".
export function greenlightLine(g) {
  if (!g) return 'Greenlight: not checked yet.';
  if (g.state !== 'ok') return `Greenlight${g.install ? ` (${g.install})` : ''}: ${g.message}`;
  const off = g.off || [];
  const a = g.alerts || {}; const open = SEVERITIES.filter(s => a[s]).map(s => `${a[s]} ${s}`);
  return [`Greenlight ${g.version}${g.install ? ` (${g.install})` : ''}`,
    `${RECOMMENDED.length - off.length}/${RECOMMENDED.length} recommended security features on${off.length ? ` (off: ${off.map(k => FEATURES[k]).join(', ')})` : ''}`,
    INFORMATIONAL.map(k => `${FEATURES[k]} ${g.features?.[k] ? 'on' : 'off'}`).join(', '),
    open.length ? `open alerts: ${open.join(', ')}` : 'no open alerts'].join(' · ');
}
