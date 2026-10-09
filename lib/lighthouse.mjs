// Lighthouse (the engine behind PageSpeed Insights) on one URL, phone and desktop.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from './crawl.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'lighthouse');

function once(url, outBase, desktop) {
  return new Promise((resolve, reject) => {
    const args = [url, '--only-categories=performance', '--output=json', '--output=html', `--output-path=${outBase}`, '--quiet', '--chrome-flags=--headless=new --incognito'];
    if (desktop) args.push('--preset=desktop');
    const p = spawn(BIN, args, { env: { ...process.env, CHROME_PATH: chromePath() } });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      const json = `${outBase}.report.json`;
      if (!fs.existsSync(json)) return reject(new Error(`Lighthouse failed (${code}): ${err.trim().split('\n').pop()}`));
      const r = JSON.parse(fs.readFileSync(json, 'utf8'));
      const a = r.audits;
      resolve({
        score: r.categories.performance.score == null ? null : Math.round(r.categories.performance.score * 100),
        lcp: a['largest-contentful-paint'].numericValue ?? null,
        cls: a['cumulative-layout-shift'].numericValue ?? null,
        tbt: a['total-blocking-time'].numericValue ?? null,
        fcp: a['first-contentful-paint'].numericValue ?? null,
        report: path.basename(`${outBase}.report.html`),
        version: r.lighthouseVersion,
      });
    });
  });
}

export async function runLighthouse(url, dir) {
  if (!fs.existsSync(BIN)) throw new Error('Lighthouse is not installed. Run npm install.');
  // Phone results swing a lot run to run, so take the middle of three (by LCP).
  const phone = [];
  for (let i = 1; i <= 3; i++) phone.push(await once(url, path.join(dir, `lighthouse-phone-${i}`), false));
  const sorted = phone.slice().sort((a, b) => (a.lcp ?? Infinity) - (b.lcp ?? Infinity));
  const desktop = await once(url, path.join(dir, 'lighthouse-desktop'), true);
  return { mobile: sorted[1], mobileRuns: phone.length, mobileLcps: phone.map(p => p.lcp), desktop };
}
