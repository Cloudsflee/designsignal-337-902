import { fetchJson, safeFetch } from './network.mjs';
import { sha256 } from './util.mjs';

const entities = value => String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const tag = (xml, names) => {
  for (const name of names) { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')); if (m) return entities(m[1]); }
  return '';
};
const attrLink = xml => xml.match(/<link[^>]+(?:href=["']([^"']+)["'])[^>]*>/i)?.[1] || tag(xml, ['link']);
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi'))].map(x => x[1]);
const imageFrom = xml => xml.match(/<(?:media:content|media:thumbnail)[^>]+url=["']([^"']+)["']/i)?.[1] || xml.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
const idFor = (source, url) => `${source.id}-${sha256(url).slice(0, 16)}`;

function raw(source, values) {
  const text = `${values.title || ''}\n${values.summary || ''}`;
  const retrievedAt = new Date().toISOString();
  return {
    id: idFor(source, values.url), category: source.category,
    source: { id: source.id, name: source.id, url: values.url, locale: source.locale, credibility: ['openalex', 'arxiv'].includes(source.adapter) ? 'scholarly-index-or-repository' : source.adapter === 'page' ? 'institutional-page' : 'editorial-feed' }, ...values,
    retrievedAt,
    cache: { url: values.url, retrievedAt, mime: 'text/plain', bytes: Buffer.byteLength(text), hash: sha256(text), author: (values.authors || []).join(', '), institution: values.institution || source.id, accessStatus: values.rights?.access || 'public-metadata', licenseStatus: values.rights?.licenseStatus || 'unknown' }
  };
}

export async function openAlexAdapter(source, config, ctx = {}) {
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const url = source.url.replace('{{since}}', since);
  const { data } = await fetchJson(url, config.network, ctx);
  if (!Array.isArray(data.results) || data.results.length > 100) throw new Error('invalid or excessive OpenAlex result set');
  return data.results.slice(0, 25).map(work => raw(source, {
    url: work.primary_location?.landing_page_url || work.id,
    title: work.title || work.display_name,
    summary: work.abstract_inverted_index ? Object.entries(work.abstract_inverted_index).flatMap(([word, positions]) => positions.map(pos => [pos, word])).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(' ').slice(0, 1500) : '',
    publishedAt: work.publication_date, authors: (work.authorships || []).slice(0, 20).map(x => x.author?.display_name).filter(Boolean),
    institution: work.authorships?.[0]?.institutions?.[0]?.display_name || '', doi: work.doi || '',
    oaPdf: work.open_access?.is_oa && work.best_oa_location?.pdf_url ? work.best_oa_location.pdf_url : '',
    rights: { access: work.open_access?.is_oa ? 'open-access' : 'metadata-only', licenseStatus: work.best_oa_location?.license || 'unknown' }
  }));
}

export async function arxivAdapter(source, config, ctx = {}) {
  const { body } = await safeFetch(source.url, config.network, { ...ctx, maxBytes: config.network.maxFeedBytes, accept: 'application/atom+xml, application/xml' });
  return blocks(body.toString('utf8'), 'entry').slice(0, 25).map(entry => {
    const page = tag(entry, ['id']);
    const pdf = [...entry.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)].map(x => x[1]).find(x => /\/pdf\//.test(x)) || '';
    return raw(source, { url: page, title: tag(entry, ['title']), summary: tag(entry, ['summary']), publishedAt: tag(entry, ['published', 'updated']), authors: blocks(entry, 'author').map(x => tag(x, ['name'])), institution: 'arXiv', oaPdf: pdf, rights: { access: 'open-access', licenseStatus: 'arXiv terms; verify article license' } });
  });
}

export async function feedAdapter(source, config, ctx = {}) {
  const { body } = await safeFetch(source.url, config.network, { ...ctx, maxBytes: config.network.maxFeedBytes, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' });
  const xml = body.toString('utf8');
  const entries = blocks(xml, 'item').length ? blocks(xml, 'item') : blocks(xml, 'entry');
  return entries.slice(0, 30).map(entry => {
    const url = attrLink(entry);
    return raw(source, { url, title: tag(entry, ['title']), summary: tag(entry, ['description', 'summary', 'content:encoded', 'content']), publishedAt: tag(entry, ['pubDate', 'published', 'updated']), authors: [tag(entry, ['dc:creator', 'author'])].filter(Boolean), institution: source.id, imageUrl: imageFrom(entry), rights: { access: 'public-feed', licenseStatus: 'linked-only' } });
  }).filter(x => x.url && x.title);
}

export async function pageAdapter(source, config, ctx = {}) {
  const { body, url } = await safeFetch(source.url, config.network, { ...ctx, maxBytes: config.network.maxPageBytes, accept: 'text/html' });
  const html = body.toString('utf8');
  const title = entities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const description = entities(html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]);
  const imageUrl = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1];
  const publishedAt = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i)?.[1] || html.match(/<time[^>]+datetime=["']([^"']+)/i)?.[1] || '';
  return [raw(source, { url, title, summary: description, publishedAt, authors: [], institution: source.id, imageUrl, rights: { access: 'public-page', licenseStatus: 'linked-only' } })];
}

export const adapters = { openalex: openAlexAdapter, arxiv: arxivAdapter, feed: feedAdapter, page: pageAdapter };

export async function collectSources(config, ctx = {}) {
  const candidates = [], health = [];
  for (const source of config.sources) {
    const started = Date.now();
    try {
      const items = await adapters[source.adapter](source, config, ctx);
      candidates.push(...items);
      health.push({ sourceId: source.id, status: 'ok', count: items.length, durationMs: Date.now() - started });
    } catch (error) {
      health.push({ sourceId: source.id, status: 'degraded', count: 0, durationMs: Date.now() - started, reason: error.message });
    }
  }
  return { candidates, health };
}
