import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { validateItem, validateReport } from '../src/lib/schema.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { loadExamEvidence } from '../src/lib/evidence.mjs';
import { redact } from '../src/lib/util.mjs';

const selection = () => selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] });

test('deterministic quota is exactly 2/1/1/2 with diverse provenance', () => {
  const a = selection(), b = selection();
  assert.deepEqual(a.selected.map(x => x.id), b.selected.map(x => x.id));
  assert.deepEqual(a.selected.reduce((n, x) => ({ ...n, [x.category]: (n[x.category] || 0) + 1 }), {}), { paper: 2, product: 1, ui: 1, frontier: 2 });
  assert.equal(new Set(a.selected.map(x => x.source.id)).size, 6);
  assert.ok(a.rejected.some(x => x.reason === 'stale'));
});

test('bilingual item schema, provenance, image and exam mappings validate', () => {
  for (const item of selection().selected) {
    assert.equal(validateItem(item), item);
    assert.match(item.title.zh, /[\u3400-\u9fff]/);
    assert.match(item.title.en, /[A-Za-z]/);
    assert.ok(item.citations[0].url.startsWith('http'));
    assert.ok(item.exam['337'].length && item.exam['902'].length);
    if (['product', 'ui'].includes(item.category)) assert.ok(item.image.url);
  }
});

test('60-day dedupe is audited and never silently reused', () => {
  const extra = structuredClone(fixtureCandidates[0]); extra.id = 'paper-extra'; extra.source.id = 'extra-source'; extra.source.url = 'https://arxiv.org/abs/2607.99999'; extra.citations[0].url = extra.source.url;
  const result = selectDaily([...fixtureCandidates, extra], { date: '2026-07-19', history: [{ id: fixtureCandidates[0].id, date: '2026-07-01' }] });
  assert.ok(!result.selected.some(x => x.id === fixtureCandidates[0].id));
  assert.ok(result.rejected.some(x => x.id === fixtureCandidates[0].id && x.reason === 'dedupe-60-day'));
});

test('report hypotheses include evidence and counterevidence and exercise is detailed', async () => {
  const s = selection(); const report = await buildReport({ date: '2026-07-19', items: s.selected, rejected: s.rejected, health: [], selectionPolicy: s.policy, fixture: true });
  assert.equal(validateReport(report), report);
  assert.ok(report.synthesis.hypotheses.every(x => x.evidence.length && x.counterevidence.length));
  assert.equal(report.exercise.rubric.reduce((n, x) => n + x.points, 0), 100);
  assert.ok(report.exercise.evidenceLinks.length >= 3);
});

test('verified evidence is versioned, hashed and totals 150/150', async () => {
  const evidence = await loadExamEvidence();
  assert.match(evidence.documentSha256, /^[a-f0-9]{64}$/);
  assert.equal(evidence.exam337.parts.reduce((n, x) => n + x.points, 0), 150);
  assert.equal(evidence.exam902.parts.reduce((n, x) => n + x.points, 0), 150);
  assert.equal(evidence.sources.length, 3);
  assert.ok(evidence.sources.every(x => /^[a-f0-9]{64}$/.test(x.urlSha256)));
});

test('credential redaction covers nested keys, bearer tokens and sk tokens', () => {
  const fakeApiKey = ['top', 'fixture'].join('-');
  const fakeBearer = ['Bearer', 'fixture'].join(' ');
  const fakePrefixedToken = [['s', 'k'].join(''), 'fixturevalue'].join('-');
  const fakeWebhook = new URL('/fixture', 'https://example.com').href;
  const value = redact({ apiKey: fakeApiKey, nested: { note: ['Authorization', fakeBearer, 'and', fakePrefixedToken].join(' ') }, webhook: fakeWebhook });
  assert.equal(value.apiKey, '[REDACTED]'); assert.equal(value.webhook, '[REDACTED]');
  const serialized = JSON.stringify(value);
  for (const fixture of [fakeApiKey, 'fixture', fakePrefixedToken, fakeWebhook]) assert.ok(!serialized.includes(fixture));
});
