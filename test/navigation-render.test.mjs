import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { renderHtml } from '../src/lib/render.mjs';
import { APP_JS } from '../src/lib/server.mjs';

async function fixtureReport() {
  const selection = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] });
  return buildReport({ date: '2026-07-19', items: selection.selected, rejected: selection.rejected, health: [], selectionPolicy: selection.policy, fixture: true });
}

const tocBody = html => html.match(/<nav class="toc-nav"[\s\S]*?<\/nav>/)?.[0] || '';
const tocAnchors = html => [...tocBody(html).matchAll(/<a href="#([^"]+)">/g)].map(match => match[1]);
const targetAnchors = html => [...html.matchAll(/<(?:section|article)[^>]*\sid="([^"]+)"[^>]*\sdata-toc-target(?:\s|>)/g)].map(match => match[1]);

test('TOC anchors are unique, resolvable, deterministic, and ordered for schema v2/v3/v4', async () => {
  const current = await fixtureReport();
  for (const version of [2, 3, 4]) {
    const report = structuredClone(current);
    report.schemaVersion = version;
    if (version < 4) delete report.briefing;
    if (version === 2) delete report.audit.selectionPolicy.priorityInstitutionPaper;
    const first = renderHtml(report), second = renderHtml(report);
    const links = tocAnchors(first), targets = targetAnchors(first);
    assert.equal(links.length, 15);
    assert.deepEqual(links, targets);
    assert.deepEqual(links, tocAnchors(second));
    assert.equal(new Set(links).size, links.length);
    for (const anchor of links) assert.equal((first.match(new RegExp(`id="${anchor}"`, 'g')) || []).length, 1);
  }
});

test('briefing TOC contains three groups and exactly six escaped nested item links', async () => {
  const report = await fixtureReport();
  report.schemaVersion = 2;
  delete report.briefing;
  delete report.audit.selectionPolicy.priorityInstitutionPaper;
  report.items[0].title = { zh: '<旧标签 & 一>', en: 'Legacy "label" & one' };
  const html = renderHtml(report), toc = tocBody(html);
  assert.equal((toc.match(/href="#briefing-/g) || []).length, 3);
  assert.equal((toc.match(/href="#signal-/g) || []).length, 6);
  assert.match(toc, /&lt;旧标签 &amp; 一&gt;/);
  assert.match(toc, /Legacy &quot;label&quot; &amp; one/);
  assert.doesNotMatch(toc, /<旧标签|Legacy "label"/);
  assert.equal((toc.match(/<ol><li><a href="#signal-/g) || []).length, 3);
});

test('dashboard exposes accessible drawer, responsive layout, and external-script contracts', async () => {
  const html = renderHtml(await fixtureReport());
  assert.match(html, /data-toc-open[^>]*aria-controls="report-toc"[^>]*aria-expanded="false"/);
  assert.match(html, /data-toc-close[^>]*aria-label="Close contents"/);
  assert.match(html, /data-toc-backdrop[^>]*hidden/);
  assert.match(html, /data-back-to-top[^>]*aria-label="Back to top"[^>]*hidden/);
  assert.match(html, /<script src="\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?! src=)|\sonclick=/);
  assert.match(html, /grid-template-columns:220px minmax\(0,1fr\) 270px/);
  assert.match(html, /@media\(max-width:1199px\) and \(min-width:821px\).*grid-template-columns:210px minmax\(0,1fr\).*\.sidebar\{grid-column:2/s);
  assert.match(html, /@media\(max-width:820px\).*\.toc-panel\{position:fixed.*transform:translateX\(-105%\).*\.toc-panel\.is-open\{transform:translateX\(0\)/s);
  assert.match(html, /body\.drawer-open\{overflow:hidden\}/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\).*scroll-behavior:auto/s);
});

test('APP_JS retains filters and all navigation interaction hooks', () => {
  assert.doesNotThrow(() => new Function(APP_JS));
  for (const hook of [
    "querySelectorAll('[data-filter]')", "classList.toggle('hidden'", "setAttribute('aria-pressed'",
    "key === 'Escape'", "key === 'Tab'", "classList.toggle('drawer-open'", "returnFocus.focus()",
    "querySelectorAll('a[href^=\"#\"]')", "addEventListener('hashchange'", "'IntersectionObserver' in window",
    "addEventListener('scroll', currentFromPosition", "aria-current', 'location'", "data-back-to-top",
    "reducedMotion.matches ? 'auto' : 'smooth'"
  ]) assert.ok(APP_JS.includes(hook), `missing APP_JS hook: ${hook}`);
  assert.doesNotMatch(APP_JS, /\.onclick\s*=/);
});
