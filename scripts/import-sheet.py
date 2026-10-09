#!/usr/bin/env python3
"""Build checklists/before-launch.json and checklists/after-launch.json from the Audit Sheet.

Usage:
  python3 scripts/import-sheet.py "/path/to/Audit Sheet.xlsx"

Reads the "QA — Before Launch" and "QA — After Launch" tabs (Task, Description, Assignee).
A row with only a Task is a section heading. Rows listed in AUTO get a check key, which the
Run Tool runner for that tab knows how to verify; every other row stays a manual item.
Sections in APPLIES_IF only count when the site uses that builder (otherwise the runner marks
them N/A).

Agency details are kept out of the repo: values from config/agency.json (emails, provider names)
become {{placeholders}}, and people's names in the Assignee column (and "<Name>'s" in text) become
the role they hold there. The app fills them back in from the same local file.
"""
import json, re, sys, pathlib
import openpyxl

ROOT = pathlib.Path(__file__).resolve().parent.parent

TABS = {
    'before-launch': ('QA — Before Launch', 'QA — Before Launch'),
    'after-launch': ('QA — After Launch', 'QA — After Launch'),
}

# Sheet task title -> automatic check key (see lib/runners/*.mjs).
AUTO = {
    'before-launch': {
        'Set up the homepage': 'wp.homepage',
        'Set up the blog posts page': 'wp.postsPage',
        'Favicon': 'html.favicon',
        'Images, titles, and alt text': 'crawl.imageAlt',
        'Custom 404 page': 'http.custom404',
        'No dummy content': 'crawl.dummyContent',
        'Social profiles configured': 'crawl.socialLinks',
        'Clickable phone numbers': 'crawl.phonesClickable',
        "No #! in dropdown menus": 'crawl.deadMenuLinks',
        'Internal links': 'crawl.internalLinks',
        'Phone number consistency': 'crawl.phoneConsistency',
        'Correct WordPress admin email': 'wp.adminEmail',
        'Staging is not indexable': 'wp.stagingNoindex',
        'Review plugins': 'wp.plugins',
        'Comments turned off': 'wp.comments',
        'WordPress up to date': 'wp.coreUpdate',
        'Hide the login URL': 'wp.hideLogin',
        'Install activity log plugin': 'wp.activityLog',
        'Sticky header bar': 'browser.stickyHeader',
        'Sticky bottom bar': 'browser.stickyBottomBar',
        'Heroes fit on mobile': 'browser.mobileFit',
        'Home not in navbar': 'html.noHomeInNav',
        'Permalinks optimized': 'wp.permalinks',
        'Yoast SEO configured': 'wp.yoast',
        'Run a page speed audit': 'lighthouse.home',
        'Open Graph tags': 'html.openGraph',
        'Logo links to homepage': 'html.logoHomeLink',
        'Two font families or fewer': 'browser.fontFamilies',
        'Site title and tagline set': 'wp.titleTagline',
        'Rename default blog category': 'wp.uncategorized',
        'Set real post authors': 'wp.postAuthors',
        'Redirect www to root': 'http.wwwRedirect',
        'Google Analytics tags present': 'html.analyticsTags',
        'Remove placeholder blogs': 'wp.placeholderPosts',
        'Heading Hierarchy': 'crawl.headings',
        'Tap Target Size (WCAG 2.2)': 'browser.tapTargets',
        'Cookie Consent Banner': 'browser.cookieConsent',
        'Privacy Policy Page': 'wp.privacyPolicy',
        'HTTP Security Headers': 'http.securityHeaders',
        'Core Web Vitals (All Sites)': 'lighthouse.home',
        'Schema Markup Validation': 'html.schema',
        'DOM size audit': 'browser.domSize',
        'WP memory limit 256M or more': 'wp.memoryLimit',
        'PHP seven 7.4 or higher': 'wp.phpVersion',
        'No source maps in production': 'http.sourceMaps',
    },
    'after-launch': {
        'Anti-spam reCAPTCHA installed': 'html.recaptcha',
        'Find & replace old URLs': 'wp.oldUrls',
        'Search & replace old URLs': 'wp.oldUrls',
        'Featured images on main pages': 'wp.featuredImages',
        'Site is indexable': 'wp.indexable',
        'Website speed': 'lighthouse.home',
        'Image optimization': 'crawl.imageWeight',
        'SSL': 'http.ssl',
        'Set up GA4 via GTM': 'html.ga4ViaGtm',
        'Set up Search Console': 'html.searchConsole',
        'XML sitemap in Search Console': 'http.sitemap',
        'No links to staging': 'crawl.stagingLinks',
        'Add default schema markup': 'html.schema',
        'Remove no-index tag': 'crawl.noindex',
        'Review robots.txt': 'http.robots',
        'Core Web Vitals — Live': 'lighthouse.home',
        'Cookie Consent — Live Test': 'browser.cookieConsent',
        'Schema Drift Check': 'html.schemaDrift',
        'No JS errors in console': 'browser.consoleErrors',
        'Core Web Vitals post launch': 'lighthouse.home',
        'DOM count not increased': 'browser.domSize',
        'No JS errors post launch': 'browser.consoleErrors',
        'No CDN fallback in production': 'html.noTailwindCdn',
        'Forms and interactive elements': 'browser.interactive',
    },
}

# Sections that only apply when the site uses that builder.
APPLIES_IF = {'Elementor': 'elementor', 'YOOtheme': 'yootheme'}


def load_agency():
    for f in ('agency.json', 'agency.example.json'):
        try:
            return json.loads((ROOT / 'config' / f).read_text())
        except (OSError, ValueError):
            pass
    return {}


AGENCY = load_agency()
PEOPLE = {name: role for role, name in (AGENCY.get('people') or {}).items() if name}
# Longest values first so "hello@agency.com" wins over a shorter overlapping value.
VALUES = sorted(((k, v) for k, v in AGENCY.items() if isinstance(v, str) and v and not k.startswith('_')), key=lambda kv: -len(kv[1]))


def generic_text(t):
    for key, val in VALUES:
        t = re.sub(re.escape(val), '{{%s}}' % key, t, flags=re.I)
    for name in PEOPLE:
        t = re.sub(r"\(?\b%s's\)?" % re.escape(name), '({{agencyName}})', t)
    return t


def generic_owner(o):
    parts = [p.strip() for p in str(o).split('/')]
    return ' / '.join(PEOPLE.get(p, p) for p in parts)


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:60]


def build(wb, key):
    sheet, title = TABS[key]
    ws = wb[sheet]
    sections, current = [], None
    for i, row in enumerate(ws.iter_rows(values_only=True), 1):
        if i == 1:
            continue
        task, desc, who = [(c or '').strip() if isinstance(c, str) else (c or '') for c in row[:3]]
        if not task:
            continue
        if not desc and not who:
            current = {'id': slug(task), 'title': task, 'appliesIf': APPLIES_IF.get(task), 'items': []}
            sections.append(current)
            continue
        if current is None:
            current = {'id': 'general', 'title': 'General', 'appliesIf': None, 'items': []}
            sections.append(current)
        current['items'].append({
            'id': f"{current['id']}--{slug(task)}",
            'row': i,
            'title': task,
            'description': generic_text(str(desc)),
            'owner': generic_owner(who),
            'check': AUTO[key].get(task),
        })
    unmapped = set(AUTO[key]) - {it['title'] for s in sections for it in s['items']}
    if unmapped:
        sys.exit(f'{key}: AUTO titles not found in sheet: {sorted(unmapped)}')
    return {'id': key, 'title': title, 'source': sheet, 'sections': sections}


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
    for key in TABS:
        data = build(wb, key)
        out = ROOT / 'checklists' / f'{key}.json'
        out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + '\n')
        n = sum(len(s['items']) for s in data['sections'])
        a = sum(1 for s in data['sections'] for it in s['items'] if it['check'])
        print(f'{out.relative_to(ROOT)}: {len(data["sections"])} sections, {n} items, {a} automatic')


if __name__ == '__main__':
    main()
