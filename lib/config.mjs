// Agency details (emails, provider names, who holds each role) live in config/agency.json, which is
// git-ignored; config/agency.example.json is the committed template. Checklist text refers to them as
// {{placeholders}} so the repo itself stays generic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');

export function agency() {
  for (const f of ['agency.json', 'agency.example.json']) {
    try { const c = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); return { ...c, people: c.people || {}, _source: f }; } catch { /* try the next */ }
  }
  return { people: {}, _source: null };
}

// "{{adminEmail}}" → the configured value (left as-is when not configured).
export const fill = (text, a = agency()) => String(text ?? '').replace(/\{\{(\w+)\}\}/g, (m, k) => (typeof a[k] === 'string' && a[k] ? a[k] : m));

// "SEO / Account Manager" → "SEO / Account Manager (Alex)" when people are configured for those roles.
export function ownerLabel(owner, a = agency()) {
  if (!owner) return owner;
  const names = [...new Set(owner.split('/').map(p => a.people?.[p.trim()]).filter(Boolean))];
  return names.length ? `${owner} (${names.join(', ')})` : owner;
}
