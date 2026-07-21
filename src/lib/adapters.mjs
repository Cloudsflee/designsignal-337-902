import { fetchJson, safeFetch } from './network.mjs';
import { sha256 } from './util.mjs';
import { listingEntries } from './listing.mjs';

const entities = value => String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const tag = (xml, names) => {
  for (const name of names) { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')); if (m) return entities(m[1]); }
  return '';
};
const attrLink = xml => xml.match(/<link[^>]+(?:href=["']([^"']+)["'])[^>]*>/i)?.[1] || tag(xml, ['link']);
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi'))].map(x => x[1]);
const imageFrom = xml => xml.match(/<(?:media:content|media:thumbnail)[^>]+url=["']([^"']+)["']/i)?.[1] || xml.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image\//i)?.[1] || xml.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
const idFor = (source, url) => `${source.id}-${sha256(url).slice(0, 16)}`;
const publicUrl = (value, base) => { if (typeof value !== 'string' || !value.trim()) return ''; try { const url = new URL(value, base); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } };

const normalizedLanguage = value => {
  const language = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
  if (['zh', 'zho', 'chi', 'chinese'].includes(language)) return 'zh';
  if (['en', 'eng', 'english'].includes(language)) return 'en';
  return '';
};

const normalizedOpenAlexId = (value, prefix) => {
  const raw = String(value || '').trim();
  if (new RegExp(`^${prefix}\\d+$`).test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== 'openalex.org' || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    const id = parsed.pathname.replace(/^\/+|\/+$/g, '');
    return new RegExp(`^${prefix}\\d+$`).test(id) ? id : '';
  } catch { return ''; }
};

const openAlexInstitutionProvenance = (work, configuredIds = []) => {
  const priorityIds = new Set(configuredIds);
  const affiliations = [];
  for (const [authorshipIndex, authorship] of (Array.isArray(work.authorships) ? work.authorships : []).entries()) {
    const authorId = normalizedOpenAlexId(authorship?.author?.id, 'A');
    const authorName = String(authorship?.author?.display_name || '').trim();
    for (const [institutionIndex, institution] of (Array.isArray(authorship?.institutions) ? authorship.institutions : []).entries()) {
      const institutionId = normalizedOpenAlexId(institution?.id, 'I');
      if (!institutionId) continue;
      affiliations.push({ institutionId, institutionName: String(institution?.display_name || '').trim(), authorId, authorName, authorshipIndex, institutionIndex });
    }
  }
  const matchedInstitutions = [];
  for (const affiliation of affiliations) {
    if (!priorityIds.has(affiliation.institutionId) || matchedInstitutions.some(entry => entry.id === affiliation.institutionId)) continue;
    if (!affiliation.institutionName) continue;
    matchedInstitutions.push({ id: affiliation.institutionId, name: affiliation.institutionName });
  }
  return { adapter: 'openalex', method: 'authorship-institution-id', affiliations, matchedInstitutions };
};

export function candidateLanguage({ declared, title = '', summary = '', configuredLocale = '', allowConfiguredFallback = false } = {}) {
  const explicit = normalizedLanguage(declared);
  if (explicit) return { locale: explicit, provenance: { method: 'declared', value: explicit } };
  if (String(declared || '').trim()) return { locale: 'unknown', provenance: { method: 'declared-unsupported', value: String(declared).trim().toLowerCase() } };
  const sample = `${title} ${summary}`.replace(/<[^>]+>/g, ' ');
  const han = (sample.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  if (han >= 4 && han * 2 >= latin) return { locale: 'zh', provenance: { method: 'inferred-script', script: 'Han' } };
  if (latin >= 8 && han === 0) return { locale: 'en', provenance: { method: 'inferred-script', script: 'Latin' } };
  const fallback = allowConfiguredFallback ? normalizedLanguage(configuredLocale) : '';
  if (fallback) return { locale: fallback, provenance: { method: 'configured-locale-fallback', configuredLocale: fallback } };
  return { locale: 'unknown', provenance: { method: 'unknown' } };
}

function raw(source, values) {
  const retrievedAt = new Date().toISOString();
  const { locale = source.locale || 'unknown', languageProvenance = { method: 'configured-locale', configuredLocale: source.locale || 'unknown' }, ...candidate } = values;
  return {
    id: idFor(source, candidate.url), category: source.category,
    source: { id: source.id, name: source.name || source.id, url: candidate.url, locale, languageProvenance, credibility: ['openalex', 'arxiv'].includes(source.adapter) ? 'scholarly-index-or-repository' : ['page', 'listing'].includes(source.adapter) ? 'institutional-page' : 'editorial-feed' }, ...candidate,
    retrievedAt
  };
}

export async function openAlexAdapter(source, config, ctx = {}) {
  if (ctx.openAlexBudget && ctx.openAlexBudget.remaining <= 0) throw new Error('OpenAlex request budget exhausted');
  if (ctx.openAlexBudget) ctx.openAlexBudget.remaining--;
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const metadataUrl = source.url.replace('{{since}}', since);
  const requestUrl = new URL(metadataUrl);
  if (config.openAlex?.apiKey) requestUrl.searchParams.set('api_key', config.openAlex.apiKey);
  if (config.openAlex?.mailto) requestUrl.searchParams.set('mailto', config.openAlex.mailto);
  let data;
  try {
    ({ data } = await fetchJson(requestUrl.href, config.network, ctx));
  } catch (error) {
    let message = String(error?.message || 'OpenAlex request failed');
    for (const secret of [config.openAlex?.apiKey, config.openAlex?.mailto].filter(Boolean)) message = message.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]');
    message = message.replace(/([?&](?:api_key|mailto)=)[^&\s]+/gi, '$1[REDACTED]');
    if (/HTTP 429/.test(message)) throw new Error('OpenAlex HTTP 429: rate limit or request budget exhausted');
    throw new Error(message);
  }
  if (!Array.isArray(data.results) || data.results.length > 100) throw new Error('invalid or excessive OpenAlex result set');
  return data.results.slice(0, 25).map(work => {
    const title = work.title || work.display_name;
    const summary = work.abstract_inverted_index ? Object.entries(work.abstract_inverted_index).flatMap(([word, positions]) => positions.map(pos => [pos, word])).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(' ').slice(0, 1500) : '';
    const language = candidateLanguage({ declared: work.language, title, summary });
    const institutionProvenance = openAlexInstitutionProvenance(work, config.selection?.priorityInstitutionPaper?.institutionIds);
    const primaryInstitution = institutionProvenance.matchedInstitutions[0]?.name || institutionProvenance.affiliations[0]?.institutionName || '';
    return raw(source, {
      url: work.primary_location?.landing_page_url || work.id, title, summary,
      locale: language.locale, languageProvenance: language.provenance,
      publishedAt: work.publication_date, authors: (work.authorships || []).slice(0, 20).map(x => x.author?.display_name).filter(Boolean),
      institution: primaryInstitution, institutionProvenance, doi: work.doi || '',
      oaPdf: work.open_access?.is_oa && work.best_oa_location?.pdf_url ? work.best_oa_location.pdf_url : '',
      rights: { access: work.open_access?.is_oa ? 'open-access' : 'metadata-only', licenseStatus: work.best_oa_location?.license || 'unknown' }
    });
  });
}

export async function arxivAdapter(source, config, ctx = {}) {
  const { body } = await safeFetch(source.url, config.network, { ...ctx, maxBytes: config.network.maxFeedBytes, accept: 'application/atom+xml, application/xml' });
  return blocks(body.toString('utf8'), 'entry').slice(0, 25).map(entry => {
    const page = tag(entry, ['id']);
    const pdf = [...entry.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)].map(x => x[1]).find(x => /\/pdf\//.test(x)) || '';
    const title = tag(entry, ['title']), summary = tag(entry, ['summary']);
    const language = candidateLanguage({ title, summary, configuredLocale: source.locale, allowConfiguredFallback: true });
    return raw(source, { url: page, title, summary, locale: language.locale, languageProvenance: language.provenance, publishedAt: tag(entry, ['published', 'updated']), authors: blocks(entry, 'author').map(x => tag(x, ['name'])), institution: 'arXiv', oaPdf: pdf, rights: { access: 'open-access', licenseStatus: 'arXiv terms; verify article license' } });
  });
}

export async function feedAdapter(source, config, ctx = {}) {
  const { body } = await safeFetch(source.url, config.network, { ...ctx, maxBytes: config.network.maxFeedBytes, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' });
  const xml = body.toString('utf8');
  const entries = blocks(xml, 'item').length ? blocks(xml, 'item') : blocks(xml, 'entry');
  return entries.slice(0, 30).map(entry => {
    const url = publicUrl(attrLink(entry), source.url);
    if (!url) return null;
    const title = tag(entry, ['title']), summary = tag(entry, ['description', 'summary', 'content:encoded', 'content']);
    const language = candidateLanguage({ title, summary, configuredLocale: source.locale, allowConfiguredFallback: true });
    return raw(source, { url, title, summary, locale: language.locale, languageProvenance: language.provenance, publishedAt: tag(entry, ['pubDate', 'published', 'updated']), authors: [tag(entry, ['dc:creator', 'author'])].filter(Boolean), institution: source.id, imageUrl: publicUrl(imageFrom(entry), url), rights: { access: 'public-feed', licenseStatus: 'linked-only' } });
  }).filter(x => x?.title);
}

export async function pageAdapter(source, config, ctx = {}) {
  const { body, url } = await safeFetch(source.url, config.network, { ...ctx, maxBytes: config.network.maxPageBytes, accept: 'text/html' });
  const html = body.toString('utf8');
  const title = entities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const description = entities(html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]);
  const imageUrl = publicUrl(html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1], url);
  const publishedAt = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i)?.[1] || html.match(/<time[^>]+datetime=["']([^"']+)/i)?.[1] || '';
  const language = candidateLanguage({ title, summary: description, configuredLocale: source.locale, allowConfiguredFallback: true });
  return [raw(source, { url, title, summary: description, locale: language.locale, languageProvenance: language.provenance, publishedAt, authors: [], institution: source.id, imageUrl, rights: { access: 'public-page', licenseStatus: 'linked-only' } })];
}

export async function listingAdapter(source, config, ctx = {}) {
  return (await listingEntries(source, config, ctx)).map(entry => {
    const language = candidateLanguage({ title: entry.title, summary: entry.summary, configuredLocale: source.locale, allowConfiguredFallback: true });
    return raw(source, { ...entry, locale: language.locale, languageProvenance: language.provenance, authors: [], institution: source.institution || source.name || source.id, rights: { access: 'public-page', licenseStatus: 'linked-only' } });
  });
}

export const adapters = { openalex: openAlexAdapter, arxiv: arxivAdapter, feed: feedAdapter, page: pageAdapter, listing: listingAdapter };

export async function collectSources(config, ctx = {}) {
  const candidates = [], health = [];
  const openAlexBudget = ctx.openAlexBudget || { remaining: config.network.openAlexRequestBudget ?? 2 };
  for (const source of config.sources) {
    const started = Date.now();
    try {
      const items = await adapters[source.adapter](source, config, { ...ctx, openAlexBudget });
      candidates.push(...items);
      const empty = items.length === 0;
      health.push({ sourceId: source.id, status: empty ? 'empty' : 'ok', count: items.length, durationMs: Date.now() - started, optional: Boolean(source.optional), ...(empty ? { impact: source.optional ? 'optional-source-empty' : 'required-source-empty', reason: 'source returned zero dated candidates' } : {}) });
    } catch (error) {
      health.push({ sourceId: source.id, status: 'degraded', count: 0, durationMs: Date.now() - started, optional: Boolean(source.optional), impact: source.optional ? 'optional-source-degraded' : 'required-source-degraded', reason: error.message });
    }
  }
  return { candidates, health };
}
