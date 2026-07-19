import { safeFetch } from './network.mjs';
import { cachePublicAsset } from './cache.mjs';
import { redact } from './util.mjs';

const identity = item => ({ author: (item.authors || []).join(', ') || item.source.name, institution: item.institution || item.source.name });

async function fetchAndCache(config, item, descriptor, ctx) {
  const { body, mime, url } = await safeFetch(descriptor.url, config.network, { ...ctx, maxBytes: descriptor.maxBytes, accept: descriptor.accept });
  return cachePublicAsset(config.dataDir, { ...identity(item), ...descriptor, url, mime }, body, config.network);
}

export async function persistSelectedAssets(config, selected, ctx = {}) {
  const byItem = new Map();
  const audit = [];
  for (const item of selected) {
    const descriptors = [{ kind: 'article', url: item.source.url, maxBytes: config.network.maxPageBytes, accept: 'text/html, text/plain, application/xhtml+xml', accessStatus: 'public-page', licenseStatus: item.rights?.licenseStatus || 'linked-only' }];
    if (item.oaPdf && item.rights?.access === 'open-access') descriptors.push({ kind: 'pdf', url: item.oaPdf, maxBytes: config.network.maxPdfBytes, accept: 'application/pdf', accessStatus: 'open-access', licenseStatus: item.rights?.licenseStatus || 'unknown' });
    else if (item.oaPdf) audit.push({ itemId: item.id, kind: 'pdf', status: 'failed', reason: 'PDF refused: OA status not verified' });
    if (['product', 'ui'].includes(item.category) && item.imageUrl) descriptors.push({ kind: 'image', url: item.imageUrl, maxBytes: config.network.maxImageBytes, accept: 'image/jpeg, image/png, image/gif, image/webp', accessStatus: item.rights?.access === 'public-feed' ? 'public-feed' : 'public-page', licenseStatus: item.rights?.licenseStatus || 'unknown' });
    for (const descriptor of descriptors) {
      try {
        const meta = await fetchAndCache(config, item, descriptor, ctx);
        const assets = byItem.get(item.id) || [];
        assets.push(meta); byItem.set(item.id, assets);
        audit.push({ itemId: item.id, kind: descriptor.kind, status: 'cached', hash: meta.hash, mime: meta.mime, bytes: meta.bytes, localCacheRef: meta.localCacheRef });
      } catch (error) {
        audit.push({ itemId: item.id, kind: descriptor.kind, status: 'failed', reason: redact(error.message) });
      }
    }
  }
  return { byItem, audit };
}

export function attachCachedAssets(item, assets = []) {
  if (!assets.length) return item;
  item.assets = assets;
  const image = assets.find(x => x.kind === 'image');
  if (image) item.image = { ...item.image, ...image, url: item.image?.url || image.url };
  return item;
}
