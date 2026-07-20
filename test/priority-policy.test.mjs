import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAlexAdapter } from '../src/lib/adapters.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { validateReport } from '../src/lib/schema.mjs';
import { fixtureCandidates } from '../fixtures/daily.mjs';

const institutionIds = ['I99065089', 'I76130692', 'I116953780'];
const policy = { institutionIds, freshnessDays: 7, maxScoreGap: 5 };
const dnsLookup = async () => [{ address: '8.8.8.8' }];
const provenance = (id = 'I76130692', name = 'Zhejiang University') => ({
  adapter: 'openalex', method: 'authorship-institution-id',
  affiliations: [{ institutionId: id, institutionName: name, authorId: 'A1', authorName: 'Author', authorshipIndex: 1, institutionIndex: 0 }],
  matchedInstitutions: [{ id, name }]
});

const priorityCandidate = ({ id = 'priority-paper', date = '2026-07-18', confidence = 0.77, sourceId = 'openalex-priority', locale = 'en' } = {}) => {
  const item = structuredClone(fixtureCandidates[0]);
  item.id = id; item.publishedAt = `${date}T08:00:00.000Z`; item.confidence = confidence;
  item.source = { ...item.source, id: sourceId, name: 'OpenAlex priority institutions', url: `https://openalex.org/W-${id}`, locale, credibility: 'scholarly-index-or-repository' };
  item.citations = [{ label: 'Primary source', url: item.source.url }];
  item.institution = 'Zhejiang University'; item.institutionProvenance = provenance();
  return item;
};

test('priority paper is audited as rank-satisfied and selection is deterministic', () => {
  const candidates = structuredClone(fixtureCandidates);
  candidates[1].institutionProvenance = provenance('I99065089', 'Tsinghua University');
  const a = selectDaily(candidates, { date: '2026-07-19', history: [], priorityInstitutionPaper: policy });
  const b = selectDaily([...candidates].reverse(), { date: '2026-07-19', history: [], priorityInstitutionPaper: policy });
  assert.deepEqual(a.selected.map(item => item.id), b.selected.map(item => item.id));
  assert.equal(a.policy.priorityInstitutionPaper.decision, 'satisfied-by-rank');
  assert.equal(a.policy.priorityInstitutionPaper.selectedItemId, candidates[1].id);
  assert.deepEqual(a.policy.priorityInstitutionPaper.selectedInstitution, { id: 'I99065089', name: 'Tsinghua University' });
});

test('best bounded priority paper safely replaces a ranked paper without weakening invariants', () => {
  const candidate = priorityCandidate();
  const result = selectDaily([...fixtureCandidates, candidate], { date: '2026-07-19', history: [], priorityInstitutionPaper: policy });
  const audit = result.policy.priorityInstitutionPaper;
  assert.equal(audit.decision, 'quota-preserving-replacement');
  assert.equal(audit.selectedItemId, candidate.id);
  assert.ok(result.selected.some(item => item.id === candidate.id));
  assert.equal(result.selected.filter(item => item.category === 'paper').length, 2);
  assert.ok(new Set(result.selected.map(item => item.source.locale)).has('zh'));
  assert.ok(new Set(result.selected.map(item => item.source.locale)).has('en'));
  assert.ok(new Set(result.selected.map(item => item.source.id)).size >= 4);
  assert.ok(result.rejected.some(entry => entry.id === audit.replacement.replacedItemId && entry.reason === 'priority-institution-replacement'));
});

test('priority freshness, quality, dedupe and unsafe replacement use exact fallbacks', () => {
  const stale = selectDaily([...fixtureCandidates, priorityCandidate({ id: 'old-priority', date: '2026-07-10', confidence: 1 })], { date: '2026-07-19', history: [], priorityInstitutionPaper: policy });
  assert.equal(stale.policy.priorityInstitutionPaper.reason, 'outside-strict-freshness-window');
  const low = selectDaily([...fixtureCandidates, priorityCandidate({ id: 'low-priority', confidence: 0.4 })], { date: '2026-07-19', history: [], priorityInstitutionPaper: policy });
  assert.equal(low.policy.priorityInstitutionPaper.reason, 'score-gap-exceeds-limit');
  const duplicate = priorityCandidate({ id: 'known-priority' });
  const deduped = selectDaily([...fixtureCandidates, duplicate], { date: '2026-07-19', history: [{ id: duplicate.id, date: '2026-07-18' }], priorityInstitutionPaper: policy });
  assert.equal(deduped.policy.priorityInstitutionPaper.reason, 'all-priority-candidates-deduplicated');
  assert.ok(deduped.rejected.some(entry => entry.id === duplicate.id && entry.reason === 'dedupe-60-day'));

  const constrained = structuredClone(fixtureCandidates);
  for (const item of constrained) {
    if (item.category === 'paper') continue;
    const zh = item.source.locale === 'zh';
    item.source.id = zh ? 'shared-zh' : 'shared-en';
  }
  const unsafe = priorityCandidate({ id: 'unsafe-priority', sourceId: 'shared-en' });
  const noReplacement = selectDaily([...constrained, unsafe], { date: '2026-07-19', history: [], priorityInstitutionPaper: policy });
  assert.equal(noReplacement.policy.sourceCount, 4);
  assert.equal(noReplacement.policy.priorityInstitutionPaper.reason, 'no-safe-replacement');
  assert.ok(!noReplacement.selected.some(item => item.id === unsafe.id));
});

test('unmatched and malformed affiliation provenance remains ordinary', () => {
  const unmatched = priorityCandidate({ id: 'unmatched' });
  unmatched.institutionProvenance = provenance('I123456', 'Other University');
  const malformed = priorityCandidate({ id: 'malformed', confidence: 0.79 });
  malformed.institutionProvenance.affiliations[0].institutionId = 'https://openalex.org/I76130692?display=Zhejiang';
  const result = selectDaily([...fixtureCandidates, unmatched, malformed], { date: '2026-07-19', history: [], priorityInstitutionPaper: policy });
  assert.equal(result.policy.priorityInstitutionPaper.matchedCount, 0);
  assert.equal(result.policy.priorityInstitutionPaper.reason, 'no-matching-priority-provenance');
});

test('OpenAlex normalizes every authorship and matches only configured structured IDs', async () => {
  const source = { id: 'oa', adapter: 'openalex', url: 'https://api.openalex.org/works?filter=x', locale: 'en', category: 'paper' };
  const network = { allowHosts: ['api.openalex.org'], timeoutMs: 100, retries: 0, maxJsonBytes: 20000, maxPageBytes: 10000 };
  const work = {
    id: 'https://openalex.org/W1', language: 'en', title: 'Multi-author design research', publication_date: '2026-07-18', open_access: { is_oa: false },
    authorships: [
      { author: { id: 'https://openalex.org/A1', display_name: 'First' }, institutions: [{ id: 'https://openalex.org/I123', display_name: 'Tsinghua University' }] },
      { author: { id: 'A2', display_name: 'Second' }, institutions: [{ id: 'https://openalex.org/I116953780', display_name: 'Tongji University' }, { id: 'bad-I76130692', display_name: 'Zhejiang University' }] }
    ]
  };
  const config = { network, selection: { priorityInstitutionPaper: policy }, openAlex: {} };
  const items = await openAlexAdapter(source, config, { dnsLookup, fetchImpl: async () => new Response(JSON.stringify({ results: [work] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(items[0].institutionProvenance.affiliations.length, 2);
  assert.deepEqual(items[0].institutionProvenance.matchedInstitutions, [{ id: 'I116953780', name: 'Tongji University' }]);
  assert.equal(items[0].institution, 'Tongji University');
});

test('config bounds and report schema reject policy tampering', async () => {
  const config = await loadConfig({ env: {} });
  assert.deepEqual(config.selection.priorityInstitutionPaper.institutionIds, institutionIds);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-priority-config-'));
  const badFile = path.join(dir, 'bad.json');
  await writeFile(badFile, JSON.stringify({ selection: { priorityInstitutionPaper: { freshnessDays: 31 } } }));
  await assert.rejects(() => loadConfig({ configPath: badFile, env: {} }), /freshnessDays/);
  await rm(dir, { recursive: true, force: true });

  const selected = selectDaily([...fixtureCandidates, priorityCandidate()], { date: '2026-07-19', history: [], priorityInstitutionPaper: policy });
  const report = await buildReport({ date: '2026-07-19', items: selected.selected, rejected: selected.rejected, health: [], selectionPolicy: selected.policy, fixture: true });
  const badSource = structuredClone(report); badSource.audit.selectionPolicy.priorityInstitutionPaper.selectedSourceId = 'tampered';
  assert.throws(() => validateReport(badSource), /inconsistent/);
  const badReplacement = structuredClone(report); badReplacement.audit.selectionPolicy.priorityInstitutionPaper.replacement.replacedItemId = report.items[0].id;
  assert.throws(() => validateReport(badReplacement), /still appears/);
  const badCount = structuredClone(report); badCount.audit.selectionPolicy.priorityInstitutionPaper.eligibleCount = 0;
  assert.throws(() => validateReport(badCount));
});
