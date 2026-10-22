// Checks that read Greenlight's security status (ctx.greenlight: one SSH call per run, see greenlight.mjs).
// Same contract as checks.mjs: each returns { status, summary, details? }, plus `greenlight` (a short summary
// the fixer, the report and the CLI use).
import { FEATURES, RECOMMENDED, INFORMATIONAL, ALERT_FEATURES, GREENLIGHT_MIN_VERSION, offRecommended, alertCounts, sortedAlerts, alertLine, glSummary } from './greenlight.mjs';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const onOff = (gl, k) => `${FEATURES[k]}: ${gl.features[k] ? 'on' : 'off'}`;
const result = (status, summary, details, gl) => ({ status, summary, details, greenlight: glSummary(gl) });
// Greenlight missing, inactive, too old, or answering something this app can't read.
function unavailable(gl, status) {
  const hint = { missing: `Install Greenlight v${GREENLIGHT_MIN_VERSION}+ and activate it.`, inactive: 'Activate it under Plugins.', old: null, schema: null }[gl.state];
  return result(['schema', 'bad-json', 'error'].includes(gl.state) ? 'warn' : status, `${gl.message}${hint ? ' ' + hint : ''}`, gl.sample ? [`Output: ${gl.sample}`] : undefined, gl);
}

export const GREENLIGHT_CHECKS = {
  'gl.hardening': async ctx => {
    const gl = await ctx.greenlight(); if (gl.state !== 'ok') return unavailable(gl, 'fail');
    const off = offRecommended(gl);
    const details = [...RECOMMENDED.map(k => `${gl.features[k] ? '✓' : '✕'} ${onOff(gl, k)}`),
      `For information: ${INFORMATIONAL.map(k => onOff(gl, k)).join(', ')}`,
      `Also: ${Object.keys(FEATURES).filter(k => !RECOMMENDED.includes(k) && !INFORMATIONAL.includes(k)).map(k => onOff(gl, k)).join(', ')}`, ...gl.notes];
    return off.length
      ? result('fail', `${plural(off.length, 'recommended Greenlight security feature is', 'recommended Greenlight security features are')} off: ${off.map(k => FEATURES[k]).join(', ')}.`, details, gl)
      : result('pass', `Greenlight ${gl.version}: all ${RECOMMENDED.length} recommended security features are on.`, details, gl);
  },
  'gl.alerts': async ctx => {
    const gl = await ctx.greenlight(); if (gl.state !== 'ok') return unavailable(gl, 'warn');
    const c = alertCounts(gl); const n = gl.alerts.length;
    const watching = ALERT_FEATURES.filter(k => gl.features[k]);
    const notes = [...(watching.length < ALERT_FEATURES.length ? [`Not watching: ${ALERT_FEATURES.filter(k => !gl.features[k]).map(k => FEATURES[k]).join(', ')}.`] : []), ...gl.notes];
    if (!n) return watching.length
      ? result('pass', `No open Greenlight alerts (Greenlight ${gl.version}, watching ${watching.map(k => FEATURES[k].toLowerCase()).join(', ')}).`, notes.length ? notes : undefined, gl)
      : result('warn', `No open alerts, but Greenlight's alerts are all off, so nothing is being watched.`, notes, gl);
    const by = ['high', 'medium', 'low'].filter(s => c[s]).map(s => `${c[s]} ${s}`).join(', ');
    return result(c.high ? 'fail' : 'warn', `${plural(n, 'open Greenlight alert')}: ${by}.`, [...sortedAlerts(gl).map(alertLine), ...notes], gl);
  },
};
