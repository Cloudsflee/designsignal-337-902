const categories = new Set(['paper', 'product', 'ui', 'frontier']);
const text = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be non-empty text`); };
const url = (value, name) => { text(value, name); const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error(`${name} must use credential-free HTTP(S)`); };
const cacheRef = value => typeof value === 'string' && /^\/assets\/[a-f0-9]{64}$/.test(value);

export function validateItem(item) {
  text(item.id, 'id');
  if (!categories.has(item.category)) throw new Error(`invalid category for ${item.id}`);
  for (const lang of ['zh', 'en']) {
    text(item.title?.[lang], `title.${lang}`);
    text(item.synopsis?.[lang], `synopsis.${lang}`);
    for (const field of ['evidence', 'method', 'novelty', 'limits', 'whyLearn', 'studyAction']) text(item.analysis?.[lang]?.[field], `analysis.${lang}.${field}`);
  }
  if (!/[\u3400-\u9fff]/.test(`${item.title.zh}${item.synopsis.zh}`)) throw new Error('Chinese content required');
  if (!/[A-Za-z]/.test(`${item.title.en}${item.synopsis.en}`)) throw new Error('English content required');
  text(item.source?.id, 'source.id'); text(item.source?.name, 'source.name'); url(item.source?.url, 'source.url');
  text(item.publishedAt, 'publishedAt');
  if (!Array.isArray(item.citations) || item.citations.length === 0) throw new Error('citations required');
  item.citations.forEach((c, i) => url(c.url, `citations.${i}.url`));
  if (!Array.isArray(item.exam?.['337']) || !item.exam['337'].length || !Array.isArray(item.exam?.['902']) || !item.exam['902'].length) throw new Error('337 and 902 mappings required');
  if (!(item.confidence >= 0 && item.confidence <= 1)) throw new Error('confidence must be 0..1');
  if (['product', 'ui'].includes(item.category)) { url(item.image?.url, 'image.url'); text(item.image?.licenseStatus, 'image.licenseStatus'); if (item.image.localCacheRef && !cacheRef(item.image.localCacheRef)) throw new Error('invalid image.localCacheRef'); }
  for (const asset of item.assets || []) {
    if (!['article', 'pdf', 'image'].includes(asset.kind) || !/^[a-f0-9]{64}$/.test(asset.hash || '') || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) throw new Error('invalid cached asset identity');
    text(asset.mime, 'asset.mime'); text(asset.retrievedAt, 'asset.retrievedAt'); text(asset.author, 'asset.author'); text(asset.institution, 'asset.institution'); text(asset.accessStatus, 'asset.accessStatus'); text(asset.licenseStatus, 'asset.licenseStatus');
    url(asset.url, 'asset.url'); if (!cacheRef(asset.localCacheRef)) throw new Error('invalid asset.localCacheRef');
  }
  return item;
}

export function validateReport(report) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(report.date)) throw new Error('invalid report date');
  if (!Array.isArray(report.items) || report.items.length !== 6) throw new Error('report must contain exactly six items');
  report.items.forEach(validateItem);
  const counts = report.items.reduce((a, x) => ({ ...a, [x.category]: (a[x.category] || 0) + 1 }), {});
  if (counts.paper !== 2 || counts.product !== 1 || counts.ui !== 1 || counts.frontier !== 2) throw new Error('quota must be 2 paper, 1 product, 1 UI, 2 frontier');
  if (new Set(report.items.map(x => x.source.id)).size < 4) throw new Error('report requires at least four distinct sources');
  const locales = new Set(report.items.map(x => x.source.locale));
  if (!locales.has('zh') || !locales.has('en')) throw new Error('report requires zh-origin and en-origin sources');
  for (const h of report.synthesis?.hypotheses || []) {
    text(h.claim, 'hypothesis.claim');
    if (!h.evidence?.length || !h.counterevidence?.length) throw new Error('hypothesis requires evidence and counterevidence');
    if (!(h.confidence >= 0 && h.confidence <= 1)) throw new Error('hypothesis confidence must be 0..1');
  }
  const e = report.exercise; text(e?.prompt, 'exercise.prompt'); if (!e?.deliverables?.length || !e?.rubric?.length || !e?.evidenceLinks?.length) throw new Error('detailed exercise required');
  return report;
}
