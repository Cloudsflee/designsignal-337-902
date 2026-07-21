import { buildBriefing } from './briefing.mjs';
import { isIsoDate } from './util.mjs';
const categories = new Set(['paper', 'product', 'ui', 'frontier']);
const analysisFields = ['evidence', 'method', 'novelty', 'limits', 'whyLearn', 'studyAction'];
const text = (value, name, max = 12000) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be non-empty text`);
  if (value.length > max) throw new Error(`${name} exceeds ${max} characters`);
};
const url = (value, name) => {
  text(value, name, 4096);
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${name} must use credential-free HTTP(S)`);
};
const cacheRef = value => typeof value === 'string' && /^\/assets\/[a-f0-9]{64}$/.test(value);
const bilingual = (value, name) => {
  text(value?.zh, `${name}.zh`);
  text(value?.en, `${name}.en`);
  if (!/[\u3400-\u9fff]/.test(value.zh)) throw new Error(`${name}.zh must contain Chinese text`);
  if (!/[A-Za-z]/.test(value.en)) throw new Error(`${name}.en must contain English text`);
};
const stringList = (value, name, { min = 1, max = 30 } = {}) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${name} must contain ${min}..${max} entries`);
  value.forEach((entry, index) => text(entry, `${name}.${index}`, 1000));
};
const bilingualList = (value, name, bounds) => {
  if (!Array.isArray(value) || value.length < (bounds?.min ?? 1) || value.length > (bounds?.max ?? 30)) throw new Error(`${name} has invalid length`);
  value.forEach((entry, index) => bilingual(entry, `${name}.${index}`));
};
const exactSubset = (values, allowed, name, { min = 1 } = {}) => {
  stringList(values, name, { min });
  if (new Set(values).size !== values.length) throw new Error(`${name} contains duplicates`);
  for (const value of values) if (!allowed.has(value)) throw new Error(`${name} contains an invented reference`);
};

const integer = (value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
};

function validateSelectionPolicy(policy, items, rejected) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('audit.selectionPolicy required');
  const expectedQuota = { paper: 2, product: 1, ui: 1, frontier: 2 };
  if (JSON.stringify(policy.quota) !== JSON.stringify(expectedQuota)) throw new Error('selectionPolicy quota is invalid');
  integer(policy.maxAgeDays, 'selectionPolicy.maxAgeDays', { min: 1, max: 365 });
  text(policy.deterministicTieBreak, 'selectionPolicy.deterministicTieBreak', 200);
  const actualSources = new Set(items.map(item => item.source.id)).size;
  if (policy.sourceCount !== actualSources) throw new Error('selectionPolicy sourceCount does not match selected items');
  if (JSON.stringify(policy.originLanguage?.required) !== JSON.stringify(['zh', 'en'])) throw new Error('selectionPolicy originLanguage.required is invalid');
  for (const locale of ['zh', 'en']) {
    const actual = items.filter(item => item.source.locale === locale).length;
    if (policy.originLanguage?.selected?.[locale] !== actual) throw new Error(`selectionPolicy originLanguage.selected.${locale} does not match selected items`);
  }
  if (!Array.isArray(policy.originLanguage?.decisions) || policy.originLanguage.decisions.length !== 2) throw new Error('selectionPolicy originLanguage.decisions must contain zh and en');
  const decisionLocales = new Set();
  for (const decision of policy.originLanguage.decisions) {
    if (!['zh', 'en'].includes(decision?.locale) || decisionLocales.has(decision.locale)) throw new Error('selectionPolicy originLanguage decisions must uniquely cover zh and en');
    decisionLocales.add(decision.locale);
    if (!['satisfied-by-rank', 'quota-preserving-replacement', 'maintained-after-priority-replacement'].includes(decision.decision)) throw new Error('invalid origin-language decision');
    if (!items.some(item => item.id === decision.itemId && item.source.locale === decision.locale)) throw new Error('origin-language decision item does not match selected items');
  }

  const priority = policy.priorityInstitutionPaper;
  if (!priority || typeof priority !== 'object' || Array.isArray(priority)) throw new Error('selectionPolicy.priorityInstitutionPaper required');
  if (!Array.isArray(priority.configuredInstitutionIds) || priority.configuredInstitutionIds.length < 1 || priority.configuredInstitutionIds.length > 20 || new Set(priority.configuredInstitutionIds).size !== priority.configuredInstitutionIds.length || priority.configuredInstitutionIds.some(id => !/^I\d+$/.test(id))) throw new Error('invalid configured priority institution IDs');
  integer(priority.freshnessDays, 'priorityInstitutionPaper.freshnessDays', { min: 1, max: 30 });
  if (!Number.isFinite(priority.maxScoreGap) || priority.maxScoreGap < 0 || priority.maxScoreGap > 30) throw new Error('priorityInstitutionPaper.maxScoreGap must be 0..30');
  for (const field of ['matchedCount', 'validatedCount', 'freshCount', 'eligibleCount']) integer(priority[field], `priorityInstitutionPaper.${field}`, { max: 100000 });
  if (priority.validatedCount > priority.matchedCount || priority.freshCount > priority.validatedCount || priority.eligibleCount > priority.freshCount) throw new Error('priorityInstitutionPaper eligibility counts are inconsistent');
  if (!priority.ineligibleReasons || typeof priority.ineligibleReasons !== 'object' || Array.isArray(priority.ineligibleReasons)) throw new Error('priorityInstitutionPaper.ineligibleReasons must be an object');
  for (const [reason, count] of Object.entries(priority.ineligibleReasons)) { text(reason, 'priorityInstitutionPaper.ineligibleReasons key', 200); integer(count, `priorityInstitutionPaper.ineligibleReasons.${reason}`, { min: 1, max: 100000 }); }
  if (!['satisfied-by-rank', 'quota-preserving-replacement', 'fallback'].includes(priority.decision)) throw new Error('invalid priorityInstitutionPaper decision');
  text(priority.reason, 'priorityInstitutionPaper.reason', 200);
  if (priority.decision === 'satisfied-by-rank' && priority.reason !== 'highest-ranked-safe-priority-paper-already-selected') throw new Error('rank-satisfied priority reason is inconsistent');
  if (priority.decision === 'quota-preserving-replacement' && priority.reason !== 'highest-ranked-safe-priority-paper-selected') throw new Error('priority replacement reason is inconsistent');
  if (priority.decision === 'fallback') {
    const reasonValid = priority.reason === 'no-matching-priority-provenance'
      || priority.reason === 'all-priority-candidates-deduplicated'
      || priority.reason === 'no-valid-priority-candidate'
      || priority.reason === 'outside-strict-freshness-window'
      || priority.reason === 'score-gap-exceeds-limit'
      || priority.reason === 'no-safe-replacement'
      || /^all-priority-candidates-(?:unsupported-category|missing-provenance|invalid-source-url|invalid-published-at|future-dated|stale|missing-origin-language|missing-image|duplicate-candidate)$/.test(priority.reason);
    if (!reasonValid) throw new Error('invalid priority fallback reason');
    if (priority.reason === 'no-matching-priority-provenance' && priority.matchedCount !== 0) throw new Error('priority fallback reason conflicts with matchedCount');
    if (priority.reason === 'outside-strict-freshness-window' && (priority.validatedCount < 1 || priority.freshCount !== 0)) throw new Error('priority freshness fallback counts are inconsistent');
    if (priority.reason === 'score-gap-exceeds-limit' && (priority.freshCount < 1 || priority.eligibleCount !== 0)) throw new Error('priority quality fallback counts are inconsistent');
    if (priority.reason === 'no-safe-replacement' && priority.eligibleCount < 1) throw new Error('priority no-safe-replacement fallback requires an eligible candidate');
  }

  const selectedIds = new Set(items.map(item => item.id));
  if (priority.decision === 'fallback') {
    if (priority.selectedItemId !== null || priority.selectedSourceId !== null || priority.selectedInstitution !== null || priority.replacement !== null) throw new Error('fallback priority decision must not identify a selected paper or replacement');
  } else {
    text(priority.selectedItemId, 'priorityInstitutionPaper.selectedItemId', 300);
    text(priority.selectedSourceId, 'priorityInstitutionPaper.selectedSourceId', 300);
    const selected = items.find(item => item.id === priority.selectedItemId);
    if (!selected || selected.category !== 'paper' || selected.source.id !== priority.selectedSourceId) throw new Error('priority selected paper is inconsistent with report items');
    text(priority.selectedInstitution?.id, 'priorityInstitutionPaper.selectedInstitution.id', 50);
    text(priority.selectedInstitution?.name, 'priorityInstitutionPaper.selectedInstitution.name', 500);
    if (!priority.configuredInstitutionIds.includes(priority.selectedInstitution.id)) throw new Error('priority selected institution is not configured');
    if (!selected.institutionProvenance?.matchedInstitutions?.some(institution => institution.id === priority.selectedInstitution.id && institution.name === priority.selectedInstitution.name)) throw new Error('priority selected institution is inconsistent with item provenance');
    if (priority.eligibleCount < 1) throw new Error('selected priority paper must be eligible');
    if (priority.decision === 'satisfied-by-rank' && priority.replacement !== null) throw new Error('rank-satisfied priority decision cannot contain replacement');
    if (priority.decision === 'quota-preserving-replacement') {
      text(priority.replacement?.replacedItemId, 'priorityInstitutionPaper.replacement.replacedItemId', 300);
      text(priority.replacement?.replacedSourceId, 'priorityInstitutionPaper.replacement.replacedSourceId', 300);
      if (selectedIds.has(priority.replacement.replacedItemId)) throw new Error('priority replacement still appears in selected items');
      if (!rejected.some(entry => entry.id === priority.replacement.replacedItemId && entry.sourceId === priority.replacement.replacedSourceId && entry.reason === 'priority-institution-replacement')) throw new Error('priority replacement is not consistently audited as rejected');
    }
  }

  if (!Array.isArray(rejected)) throw new Error('audit.rejected must be an array');
  const rejectedKeys = new Set();
  for (const entry of rejected) {
    text(entry.id, 'audit.rejected.id', 300); text(entry.sourceId, 'audit.rejected.sourceId', 300); text(entry.reason, 'audit.rejected.reason', 200);
    const key = `${entry.id}\0${entry.sourceId}`;
    if (rejectedKeys.has(key)) throw new Error('audit.rejected contains ambiguous duplicate records');
    rejectedKeys.add(key);
    if (selectedIds.has(entry.id) && entry.reason !== 'duplicate-candidate') throw new Error('selected item is also recorded as rejected');
  }
}

function validateInstitutionProvenance(provenance) {
  if (!provenance || provenance.adapter !== 'openalex' || provenance.method !== 'authorship-institution-id') throw new Error('invalid institutionProvenance identity');
  if (!Array.isArray(provenance.affiliations) || provenance.affiliations.length > 5000 || !Array.isArray(provenance.matchedInstitutions) || provenance.matchedInstitutions.length > 20) throw new Error('invalid institutionProvenance collections');
  for (const affiliation of provenance.affiliations) {
    if (!/^I\d+$/.test(affiliation?.institutionId || '') || !Number.isSafeInteger(affiliation.authorshipIndex) || affiliation.authorshipIndex < 0 || !Number.isSafeInteger(affiliation.institutionIndex) || affiliation.institutionIndex < 0) throw new Error('invalid normalized OpenAlex affiliation');
    if (affiliation.institutionName) text(affiliation.institutionName, 'institutionProvenance.affiliation.institutionName', 500);
    if (affiliation.authorId && !/^A\d+$/.test(affiliation.authorId)) throw new Error('invalid normalized OpenAlex author ID');
    if (affiliation.authorName) text(affiliation.authorName, 'institutionProvenance.affiliation.authorName', 500);
  }
  const matchedIds = new Set();
  for (const institution of provenance.matchedInstitutions) {
    if (!/^I\d+$/.test(institution?.id || '') || matchedIds.has(institution.id)) throw new Error('invalid matched OpenAlex institution ID');
    text(institution.name, 'institutionProvenance.matchedInstitution.name', 500);
    if (!provenance.affiliations.some(affiliation => affiliation.institutionId === institution.id && affiliation.institutionName === institution.name)) throw new Error('matched institution is missing from normalized affiliations');
    matchedIds.add(institution.id);
  }
}

export function validateItem(item) {
  text(item.id, 'id', 300);
  if (!categories.has(item.category)) throw new Error(`invalid category for ${item.id}`);
  bilingual(item.title, 'title');
  bilingual(item.synopsis, 'synopsis');
  for (const lang of ['zh', 'en']) for (const field of analysisFields) text(item.analysis?.[lang]?.[field], `analysis.${lang}.${field}`);
  text(item.source?.id, 'source.id', 300); text(item.source?.name, 'source.name', 500); url(item.source?.url, 'source.url');
  text(item.publishedAt, 'publishedAt', 50);
  if (!Array.isArray(item.citations) || item.citations.length === 0 || item.citations.length > 20) throw new Error('citations required');
  item.citations.forEach((citation, index) => { text(citation.label, `citations.${index}.label`, 300); url(citation.url, `citations.${index}.url`); });
  stringList(item.exam?.['337'], 'exam.337'); stringList(item.exam?.['902'], 'exam.902');
  if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error('confidence must be 0..1');
  if (['product', 'ui'].includes(item.category)) {
    url(item.image?.url, 'image.url');
    if (item.image.remoteUrl) url(item.image.remoteUrl, 'image.remoteUrl');
    text(item.image?.licenseStatus, 'image.licenseStatus');
    if (item.image.localCacheRef && !cacheRef(item.image.localCacheRef)) throw new Error('invalid image.localCacheRef');
  }
  if (item.rights) {
    for (const field of ['access', 'licenseStatus']) text(item.rights[field], `rights.${field}`, 500);
  }
  if (item.institutionProvenance) {
    if (item.institution) text(item.institution, 'institution', 500);
    validateInstitutionProvenance(item.institutionProvenance);
  }
  for (const asset of item.assets || []) {
    if (!['article', 'pdf', 'image'].includes(asset.kind) || !/^[a-f0-9]{64}$/.test(asset.hash || '') || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) throw new Error('invalid cached asset identity');
    text(asset.mime, 'asset.mime'); text(asset.retrievedAt, 'asset.retrievedAt'); text(asset.author, 'asset.author'); text(asset.institution, 'asset.institution'); text(asset.accessStatus, 'asset.accessStatus'); text(asset.licenseStatus, 'asset.licenseStatus');
    url(asset.url, 'asset.url'); if (!cacheRef(asset.localCacheRef)) throw new Error('invalid asset.localCacheRef');
  }
  return item;
}

export function validateSynthesis(value, items, evidence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('synthesis output must be an object');
  const itemIds = new Set(items.map(item => item.id));
  const allowedUrls = new Set([
    ...items.flatMap(item => [item.source.url, ...item.citations.map(citation => citation.url), ...(item.assets || []).map(asset => asset.url)]),
    ...evidence.sources.map(source => source.url)
  ]);
  const topics337 = new Set(evidence.exam337.parts.flatMap(part => part.topics));
  const topics902 = new Set(evidence.exam902.parts.flatMap(part => part.topics));

  bilingual(value.overview, 'overview');
  if (!Array.isArray(value.patterns) || value.patterns.length < 1 || value.patterns.length > 8) throw new Error('patterns must contain 1..8 entries');
  value.patterns.forEach((pattern, index) => {
    bilingual(pattern.pattern, `patterns.${index}.pattern`);
    exactSubset(pattern.itemIds, itemIds, `patterns.${index}.itemIds`, { min: 2 });
  });

  if (!Array.isArray(value.hypotheses) || value.hypotheses.length < 2 || value.hypotheses.length > 4) throw new Error('hypotheses must contain 2..4 entries');
  value.hypotheses.forEach((hypothesis, index) => {
    bilingual(hypothesis.claim, `hypotheses.${index}.claim`);
    bilingual(hypothesis.rationale, `hypotheses.${index}.rationale`);
    bilingual(hypothesis.uncertainty, `hypotheses.${index}.uncertainty`);
    bilingualList(hypothesis.counterevidence, `hypotheses.${index}.counterevidence`, { min: 1, max: 8 });
    exactSubset(hypothesis.supportingItemIds, itemIds, `hypotheses.${index}.supportingItemIds`);
    exactSubset(hypothesis.evidence, itemIds, `hypotheses.${index}.evidence`);
    if (JSON.stringify(hypothesis.evidence) !== JSON.stringify(hypothesis.supportingItemIds)) throw new Error(`hypotheses.${index}.evidence must match supportingItemIds`);
    exactSubset(hypothesis.exam?.['337'], topics337, `hypotheses.${index}.exam.337`);
    exactSubset(hypothesis.exam?.['902'], topics902, `hypotheses.${index}.exam.902`);
    if (!Number.isFinite(hypothesis.confidence) || hypothesis.confidence < 0 || hypothesis.confidence > 1) throw new Error(`hypotheses.${index}.confidence must be 0..1`);
  });

  const exercise = value.exercise;
  bilingual(exercise?.title, 'exercise.title'); bilingual(exercise?.rationale, 'exercise.rationale'); bilingual(exercise?.prompt, 'exercise.prompt');
  if (!Number.isInteger(exercise.timeboxMinutes) || exercise.timeboxMinutes < 10 || exercise.timeboxMinutes > 720) throw new Error('exercise.timeboxMinutes must be 10..720');
  exactSubset(exercise.focusItemIds, itemIds, 'exercise.focusItemIds');
  bilingualList(exercise.deliverables, 'exercise.deliverables', { min: 1, max: 12 });
  bilingualList(exercise.answerFramework, 'exercise.answerFramework', { min: 1, max: 16 });
  bilingualList(exercise.failureEthicsChecks, 'exercise.failureEthicsChecks', { min: 1, max: 16 });
  if (!Array.isArray(exercise.rubric) || exercise.rubric.length < 2 || exercise.rubric.length > 10) throw new Error('exercise.rubric must contain 2..10 entries');
  exercise.rubric.forEach((row, index) => {
    bilingual(row.criterion, `exercise.rubric.${index}.criterion`);
    if (!Number.isInteger(row.points) || row.points <= 0 || row.points > 100) throw new Error(`exercise.rubric.${index}.points is invalid`);
    if (!row.indicators || typeof row.indicators !== 'object') throw new Error(`exercise.rubric.${index}.indicators required`);
    stringList(row.indicators.zh, `exercise.rubric.${index}.indicators.zh`, { min: 1, max: 8 });
    stringList(row.indicators.en, `exercise.rubric.${index}.indicators.en`, { min: 1, max: 8 });
  });
  if (exercise.rubric.reduce((total, row) => total + row.points, 0) !== 100) throw new Error('exercise rubric must total 100 points');
  exactSubset(exercise.evidenceLinks, allowedUrls, 'exercise.evidenceLinks');
  return value;
}

export function validateReport(report) {
  if (![2, 3, 4].includes(report.schemaVersion)) throw new Error('unsupported report schema version');
  if (!isIsoDate(report.date)) throw new Error('invalid report date');
  if (!Array.isArray(report.items) || report.items.length !== 6) throw new Error('report must contain exactly six items');
  report.items.forEach(validateItem);
  for (const item of report.items) {
    const itemUrls = new Set([item.source.url, ...(item.assets || []).map(asset => asset.url)]);
    for (const citation of item.citations) if (!itemUrls.has(citation.url)) throw new Error(`item ${item.id} contains invented citation URL`);
  }
  if (new Set(report.items.map(item => item.id)).size !== report.items.length) throw new Error('report item IDs must be unique');
  if (report.schemaVersion === 4 && report.items.some(item => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/.test(item.id))) throw new Error('schema v4 report item IDs must be safe identifiers');
  const counts = report.items.reduce((all, item) => ({ ...all, [item.category]: (all[item.category] || 0) + 1 }), {});
  if (counts.paper !== 2 || counts.product !== 1 || counts.ui !== 1 || counts.frontier !== 2) throw new Error('quota must be 2 paper, 1 product, 1 UI, 2 frontier');
  if (new Set(report.items.map(item => item.source.id)).size < 4) throw new Error('report requires at least four distinct sources');
  const locales = new Set(report.items.map(item => item.source.locale));
  if (!locales.has('zh') || !locales.has('en')) throw new Error('report requires zh-origin and en-origin sources');
  // Schema v2 predates the priority-institution audit. Its immutable contract
  // remains readable; v3 and v4 require the complete selection policy.
  if (report.schemaVersion >= 3) validateSelectionPolicy(report.audit?.selectionPolicy, report.items, report.audit?.rejected);
  const evidenceShape = {
    sources: report.evidence.sources,
    exam337: { parts: [{ topics: report.evidence.allowedTopics?.['337'] || [] }] },
    exam902: { parts: [{ topics: report.evidence.allowedTopics?.['902'] || [] }] }
  };
  report.evidence.sources.forEach((source, index) => url(source.url, `evidence.sources.${index}.url`));
  for (const [exam, allowed] of [['337', new Set(evidenceShape.exam337.parts[0].topics)], ['902', new Set(evidenceShape.exam902.parts[0].topics)]]) {
    report.items.forEach(item => exactSubset(item.exam[exam], allowed, `item ${item.id} exam.${exam}`));
  }
  validateSynthesis({ ...report.synthesis, exercise: report.exercise }, report.items, evidenceShape);
  if (report.schemaVersion === 4) {
    const expected = buildBriefing(report.items);
    if (JSON.stringify(report.briefing) !== JSON.stringify(expected)) throw new Error('briefing classification, coverage, references, totals, or review route is invalid');
    for (const [exam, coverage] of Object.entries(report.briefing.coverage)) {
      if (coverage.parts.some(part => !part.itemIds.length || !part.topicRefs.length)) throw new Error(`briefing coverage for ${exam} must reference every official part`);
    }
  }
  return report;
}
