import { safeFetch } from './network.mjs';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MAX_DETAIL_PAGES = 8;
const numericEntity = (_match, value) => {
  const code = Number.parseInt(value.replace(/^x/i, ''), /^x/i.test(value) ? 16 : 10);
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
};

const text = value => String(value || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(x[0-9a-f]+|\d+);/gi, numericEntity).replace(/\s+/g, ' ').trim();

function dateParts(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return '';
  return date.toISOString().slice(0, 10);
}

function inferredDate(month, day, now) {
  const reference = new Date(Number(now));
  if (!Number.isFinite(reference.getTime())) return '';
  let year = reference.getUTCFullYear();
  let value = dateParts(year, month, day);
  if (!value) return '';
  if (Date.parse(`${value}T00:00:00Z`) > reference.getTime() + 86_400_000) value = dateParts(--year, month, day);
  return value;
}

export function listingDate(value, now = Date.now()) {
  const source = text(value);
  const numeric = source.match(/\b(20\d{2})[\u5e74/.\-](0?[1-9]|1[0-2])[\u6708/.\-](0?[1-9]|[12]\d|3[01])\u65e5?\b/);
  if (numeric) return dateParts(numeric[1], numeric[2], numeric[3]);
  const regular = source.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (regular) return dateParts(regular[3], MONTHS[regular[1].slice(0, 3).toLowerCase()], regular[2]);
  const reversed = source.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d{2})\b/);
  if (reversed) return dateParts(reversed[3], MONTHS[reversed[2].slice(0, 3).toLowerCase()], reversed[1]);
  const short = source.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})\b/);
  if (short && MONTHS[short[1].slice(0, 3).toLowerCase()]) return inferredDate(MONTHS[short[1].slice(0, 3).toLowerCase()], short[2], now);
  const shortReversed = source.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\b/);
  if (shortReversed && MONTHS[shortReversed[2].slice(0, 3).toLowerCase()]) return inferredDate(MONTHS[shortReversed[2].slice(0, 3).toLowerCase()], shortReversed[1], now);
  return '';
}

const hrefFrom = anchor => anchor.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
const anchorTitle = anchor => text(anchor.match(/\btitle\s*=\s*["']([^"']+)["']/i)?.[1] || anchor.replace(/^<a\b[^>]*>|<\/a>$/gi, ''));
const safeArticle = (value, base, allowedHosts, source) => {
  try {
    const url = new URL(value, base);
    const allowedPath = !source.articlePathPrefix || url.pathname.startsWith(source.articlePathPrefix);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && allowedHosts.includes(url.hostname.toLowerCase()) && allowedPath ? url : null;
  } catch { return null; }
};

function nearestHeading(html) {
  const headings = [...html.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)];
  return text(headings.at(-1)?.[1]);
}

function htmlEntries(html, listingUrl, allowedHosts, now, source) {
  const anchors = [...html.matchAll(/<a\b[^>]*>[\s\S]{0,4000}?<\/a>/gi)], entries = [];
  for (const [index, match] of anchors.entries()) {
    const anchor = match[0], start = match.index, end = start + anchor.length;
    const previousEnd = index ? anchors[index - 1].index + anchors[index - 1][0].length : 0;
    const nextStart = anchors[index + 1]?.index ?? html.length;
    const windowStart = Math.max(previousEnd, start - 1200), windowEnd = Math.min(nextStart, end + 1200);
    const section = html.slice(windowStart, windowEnd), before = html.slice(windowStart, start);
    const url = safeArticle(hrefFrom(anchor), listingUrl, allowedHosts, source);
    let title = anchorTitle(anchor);
    if (/^(?:read|learn|view|see)\b|^(?:more|details?)$/i.test(title) || !title) title = nearestHeading(before) || title;
    if (!url || !title || /^(?:javascript:|mailto:|#)/i.test(hrefFrom(anchor))) continue;
    const imageRef = section.match(/<img\b[^>]+(?:src|data-src)=["']([^"']+)["']/i)?.[1];
    let imageUrl = '';
    try { if (imageRef) imageUrl = new URL(imageRef, listingUrl).href; } catch {}
    entries.push({ url: url.href, title, summary: text(section).slice(0, 1500), publishedAt: listingDate(section, now), imageUrl });
  }
  return entries;
}

function decodedFlightPayloads(html) {
  const values = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)) {
    try { values.push(JSON.parse(match[1])); } catch {}
  }
  return values;
}

function jsonString(value) {
  try { return JSON.parse(`"${value}"`); } catch { return value.replace(/\\"/g, '"'); }
}

function flightEntries(html, listingUrl, allowedHosts, now, source) {
  const entries = [];
  for (const payload of decodedFlightPayloads(html)) {
    for (const section of payload.split(/ContentItem_root__/).slice(1)) {
      const href = section.match(/"href":"((?:\\.|[^"\\])*)"/);
      if (!href) continue;
      const tail = section.slice(href.index + href[0].length);
      const child = tail.match(/"children":\["((?:\\.|[^"\\])*)"/);
      const url = safeArticle(jsonString(href[1]), listingUrl, allowedHosts, source);
      const title = child ? text(jsonString(child[1])) : '';
      const publishedAt = listingDate(section.slice(0, 12_000), now);
      if (url && title) entries.push({ url: url.href, title, summary: title, publishedAt, imageUrl: '' });
    }
  }
  return entries;
}

function mergedEntries(values) {
  const byUrl = new Map();
  for (const value of values) {
    const current = byUrl.get(value.url);
    if (!current) byUrl.set(value.url, value);
    else byUrl.set(value.url, {
      ...current,
      title: current.title.length >= value.title.length ? current.title : value.title,
      summary: current.summary.length >= value.summary.length ? current.summary : value.summary,
      publishedAt: current.publishedAt || value.publishedAt,
      imageUrl: current.imageUrl || value.imageUrl
    });
  }
  return [...byUrl.values()];
}

function explicitDetailDate(html, now) {
  const value = html.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta\b[^>]*(?:property|name)=["'](?:article:published_time|date|datePublished)["'][^>]*\bcontent=["']([^"']+)["']/i)?.[1] || '';
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return listingDate(html, now);
}

function scopedListingHtml(html, className) {
  if (!className) return html;
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opening = new RegExp(`<([A-Za-z][\\w:-]*)\\b[^>]*\\bclass=["'][^"']*${escaped}[^"']*["'][^>]*>`, 'i').exec(html);
  if (!opening) return '';
  const end = html.toLowerCase().indexOf(`</${opening[1].toLowerCase()}>`, opening.index + opening[0].length);
  return end < 0 ? '' : html.slice(opening.index, end + opening[1].length + 3);
}

export async function listingEntries(source, config, ctx = {}) {
  const response = await safeFetch(source.url, config.network, { ...ctx, maxBytes: config.network.maxPageBytes, accept: 'text/html, application/xhtml+xml' });
  const html = response.body.toString('utf8'), listingUrl = response.url;
  const allowedHosts = config.network.allowHosts.map(host => host.toLowerCase());
  const now = Number(ctx.now?.() ?? Date.now());
  const parsed = htmlEntries(scopedListingHtml(html, source.listingContainerClass), listingUrl, allowedHosts, now, source);
  if (source.listingFormat === 'next-flight') parsed.push(...flightEntries(html, listingUrl, allowedHosts, now, source));
  const entries = mergedEntries(parsed), listingHost = new URL(listingUrl).hostname.toLowerCase();
  const detailLimit = Math.min(MAX_DETAIL_PAGES, Math.max(0, Math.trunc(Number(source.detailDateMax) || 0)));
  const detailPolicy = { ...config.network, allowHosts: [listingHost] };
  let attempted = 0;
  for (const entry of entries) {
    if (entry.publishedAt || attempted >= detailLimit || new URL(entry.url).hostname.toLowerCase() !== listingHost) continue;
    attempted++;
    try {
      const detail = await safeFetch(entry.url, detailPolicy, { ...ctx, maxBytes: config.network.maxPageBytes, accept: 'text/html, application/xhtml+xml' });
      entry.publishedAt = explicitDetailDate(detail.body.toString('utf8'), now);
    } catch {}
  }
  return entries.filter(entry => entry.publishedAt).slice(0, 30);
}
