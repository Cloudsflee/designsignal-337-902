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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(report.date)) throw new Error('invalid report date');
  if (!Array.isArray(report.items) || report.items.length !== 6) throw new Error('report must contain exactly six items');
  report.items.forEach(validateItem);
  for (const item of report.items) {
    const itemUrls = new Set([item.source.url, ...(item.assets || []).map(asset => asset.url)]);
    for (const citation of item.citations) if (!itemUrls.has(citation.url)) throw new Error(`item ${item.id} contains invented citation URL`);
  }
  if (new Set(report.items.map(item => item.id)).size !== report.items.length) throw new Error('report item IDs must be unique');
  const counts = report.items.reduce((all, item) => ({ ...all, [item.category]: (all[item.category] || 0) + 1 }), {});
  if (counts.paper !== 2 || counts.product !== 1 || counts.ui !== 1 || counts.frontier !== 2) throw new Error('quota must be 2 paper, 1 product, 1 UI, 2 frontier');
  if (new Set(report.items.map(item => item.source.id)).size < 4) throw new Error('report requires at least four distinct sources');
  const locales = new Set(report.items.map(item => item.source.locale));
  if (!locales.has('zh') || !locales.has('en')) throw new Error('report requires zh-origin and en-origin sources');
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
  return report;
}
