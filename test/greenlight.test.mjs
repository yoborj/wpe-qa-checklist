// Greenlight security status: parsing, checks, fix plan, suggestions and report, against saved SSH output
// (test/fixtures/greenlight). Nothing here touches a site. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGreenlight, readGreenlight, greenlightLine, glSummary, olderThan, GREENLIGHT_MIN_VERSION } from '../lib/greenlight.mjs';
import { GREENLIGHT_CHECKS } from '../lib/checks-greenlight.mjs';
import { FIXERS, planFixes } from '../lib/fixers.mjs';
import { suggestionFor } from '../lib/suggest.mjs';
import { report } from '../lib/report.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'greenlight');
const fixture = name => fs.readFileSync(path.join(DIR, name + '.txt'), 'utf8');
const parsed = name => ({ ...parseGreenlight(fixture(name)), install: 'example' });
const run = (check, name) => GREENLIGHT_CHECKS[check]({ greenlight: async () => parsed(name) });

test('valid: features and alerts are read', () => {
  const g = parsed('valid');
  assert.equal(g.state, 'ok'); assert.equal(g.version, '0.2.0');
  assert.equal(g.features.headers, true); assert.equal(g.features.hide_usernames, false);
  assert.equal(g.alerts.length, 3); assert.deepEqual(g.scriptBaseline, ['www.googletagmanager.com', 'static.cloudflareinsights.com']);
});

test('valid: Before Launch fails on the recommended features that are off', async () => {
  const r = await run('gl.hardening', 'valid');
  assert.equal(r.status, 'fail');
  assert.match(r.summary, /2 recommended Greenlight security features are off: Hide usernames, Email obfuscation/);
  assert.deepEqual(r.greenlight.off, ['hide_usernames', 'email_obfuscation']);
  assert.ok(r.details.some(d => /For information: HSTS: off, CSP \(report-only\): on/.test(d)));
});

test('valid: After Launch fails on a high alert and lists alerts high first', async () => {
  const r = await run('gl.alerts', 'valid');
  assert.equal(r.status, 'fail');
  assert.equal(r.summary, '3 open Greenlight alerts: 1 high, 1 medium, 1 low.');
  assert.match(r.details[0], /^HIGH · Admin change · 2026-10-20 14:03 UTC · New administrator/);
  assert.match(r.details[2], /^LOW · Content · .*\(post 42\)$/);
});

test('valid-clean: everything on, no alerts → pass', async () => {
  assert.equal((await run('gl.hardening', 'valid-clean')).status, 'pass');
  const a = await run('gl.alerts', 'valid-clean');
  assert.equal(a.status, 'pass'); assert.match(a.summary, /^No open Greenlight alerts/);
});

test('valid-noisy: a PHP notice before the JSON is tolerated', () => {
  assert.equal(parsed('valid-noisy').state, 'ok');
});

test('medium/low alerts only → needs a look', async () => {
  const g = parsed('valid'); g.alerts = g.alerts.filter(a => a.severity !== 'high');
  const r = await GREENLIGHT_CHECKS['gl.alerts']({ greenlight: async () => g });
  assert.equal(r.status, 'warn'); assert.equal(r.summary, '2 open Greenlight alerts: 1 medium, 1 low.');
});

test('old Greenlight: "update Greenlight to vX.Y+"', async () => {
  const g = parsed('old');
  assert.equal(g.state, 'old'); assert.equal(g.version, '0.1.1');
  assert.equal(g.message, `Greenlight 0.1.1 has no security status: update Greenlight to v${GREENLIGHT_MIN_VERSION}+.`);
  assert.equal((await run('gl.hardening', 'old')).status, 'fail');
  assert.equal((await run('gl.alerts', 'old')).status, 'warn');
});

test('missing plugin: a clear "not installed"', async () => {
  const r = await run('gl.hardening', 'missing');
  assert.equal(r.status, 'fail'); assert.match(r.summary, /^Greenlight is not installed\. Install Greenlight v/);
  assert.equal((await run('gl.alerts', 'missing')).status, 'warn');
});

test('inactive plugin', async () => {
  const r = await run('gl.hardening', 'inactive');
  assert.equal(r.greenlight.state, 'inactive'); assert.match(r.summary, /installed but inactive/);
});

test('bad JSON: no crash, a warning with a sample', async () => {
  const g = parsed('bad-json');
  assert.equal(g.state, 'bad-json');
  const r = await run('gl.hardening', 'bad-json');
  assert.equal(r.status, 'warn'); assert.match(r.details[0], /^Output: \{"greenlight_version"/);
});

test('schema 2: unsupported schema', async () => {
  const g = parsed('schema-2');
  assert.equal(g.state, 'schema'); assert.equal(g.schema, 2); assert.match(g.message, /Unsupported schema/);
  assert.equal((await run('gl.hardening', 'schema-2')).status, 'warn');
});

test('garbage and empty SSH output never throw', () => {
  for (const out of ['', 'x', null, undefined, 'GL_PLUGIN active 0.2.0\n<<<GL_JSON>>>\n[]\n<<</GL_JSON>>>\nGL_EXIT 0', 'GL_PLUGIN active 0.2.0\nGL_EXIT 255'])
    assert.ok(['error', 'bad-json'].includes(parseGreenlight(out).state), String(out));
  const g = parseGreenlight('GL_PLUGIN active 0.2.0\n<<<GL_JSON>>>\n{"schema":1,"features":"x","alerts":[1,{"message":"m","severity":"urgent"}]}\n<<</GL_JSON>>>\nGL_EXIT 0');
  assert.equal(g.state, 'ok'); assert.equal(g.alerts.length, 1); assert.equal(g.alerts[0].severity, 'low'); assert.equal(g.notes.length, 2);
});

test('version comparison', () => {
  assert.ok(olderThan('0.1.1', '0.2.0')); assert.ok(!olderThan('0.10.0', '0.2.0')); assert.ok(!olderThan('0.2.0', '0.2.0')); assert.ok(olderThan('', '0.2.0'));
});

test('readGreenlight replays a fixture instead of SSH', async () => {
  process.env.WPEQA_GREENLIGHT_FIXTURE = path.join(DIR, 'valid.txt');
  try { const g = await readGreenlight('example'); assert.equal(g.state, 'ok'); assert.equal(g.fixture, true); }
  finally { delete process.env.WPEQA_GREENLIGHT_FIXTURE; }
});

// The fix plan as the approve → backup → apply flow sees it.
const template = { title: 'QA — Before Launch', sections: [{ items: [{ id: 'gl', title: 'Greenlight security hardening', check: 'gl.hardening' }] }] };
const tabWith = tool => ({ items: { gl: { decision: 'approve', status: tool.status, tool } } });
const site = { install: 'example', url: 'https://example.wpenginepowered.com' };

test('fix: turns on only the recommended features that are off, one short command each', async () => {
  const p = planFixes(template, tabWith(await run('gl.hardening', 'valid')), site);
  assert.equal(p.auto.length, 1);
  assert.match(p.auto[0].action, /Turn on 2 Greenlight security features: Hide usernames, Email obfuscation/);
  const script = FIXERS['gl.hardening'].script(p.auto[0].item, site);
  assert.deepEqual(script.split('\n').filter(l => l.startsWith('wp ')), ['wp greenlight set hide_usernames 1 || exit 1', 'wp greenlight set email_obfuscation 1 || exit 1']);
});

test('fix: not offered when Greenlight is missing or too old', async () => {
  for (const name of ['missing', 'old']) {
    const p = planFixes(template, tabWith(await run('gl.hardening', name)), site);
    assert.equal(p.auto.length, 0); assert.equal(p.manual.length, 1); assert.match(p.manual[0].reason, name === 'missing' ? /not installed/ : /too old/);
  }
});

test('suggestions: hardening, and the security-headers / email checks name the Greenlight feature', async () => {
  const h = suggestionFor('gl.hardening', await run('gl.hardening', 'valid'));
  assert.equal(h.auto, true);
  assert.match(suggestionFor('gl.hardening', await run('gl.hardening', 'old')).text, /^Update Greenlight to v/);
  assert.equal(suggestionFor('gl.hardening', await run('gl.hardening', 'old')).auto, false);
  const off = suggestionFor('audit.emails', { status: 'warn' }, parsed('valid'));
  assert.match(off.text, /Greenlight's Email obfuscation is off on this site \(Greenlight 0\.2\.0\)/);
  const on = suggestionFor('http.securityHeaders', { status: 'fail' }, parsed('valid'));
  assert.match(on.text, /Greenlight's Security headers is already on/);
  assert.match(suggestionFor('http.securityHeaders', { status: 'fail' }, null).text, /Greenlight's Security headers \(Greenlight → Security\)/);
});

test('report and one-line summary include Greenlight', async () => {
  const tool = await run('gl.hardening', 'valid');
  const md = report({ name: 'Example', url: site.url, install: 'example' }, 'before-launch', template, { tabs: { 'before-launch': { items: { gl: { status: 'fail', tool } }, runs: [] } } });
  assert.match(md, /\*\*Security:\*\* Greenlight 0\.2\.0 \(example\) · 6\/8 recommended security features on \(off: Hide usernames, Email obfuscation\) · HSTS off, CSP \(report-only\) on · open alerts: 1 high, 1 medium, 1 low/);
  assert.match(md, /2 recommended Greenlight security features are off/);
  assert.equal(greenlightLine(glSummary(parsed('missing'))), 'Greenlight (example): Greenlight is not installed.');
});
