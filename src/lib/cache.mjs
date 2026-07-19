import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { atomicWrite, sha256 } from './util.mjs';

export async function cachePublicAsset(dataDir, record, body, limits) {
  if (!['public-feed', 'public-page', 'public-metadata', 'open-access'].includes(record.accessStatus)) throw new Error('only public/OA content may be cached');
  const max = record.mime === 'application/pdf' ? limits.maxPdfBytes : record.mime.startsWith('image/') ? limits.maxImageBytes : limits.maxPageBytes;
  if (body.length > max) throw new Error('cache asset exceeds byte limit');
  if (record.mime === 'application/pdf' && record.accessStatus !== 'open-access') throw new Error('PDF download requires verified OA status');
  const hash = sha256(body); const dir = path.join(dataDir, 'cache'); await mkdir(dir, { recursive: true });
  const meta = { url: record.url, retrievedAt: new Date().toISOString(), mime: record.mime, hash, bytes: body.length, author: record.author || '', institution: record.institution || '', accessStatus: record.accessStatus, licenseStatus: record.licenseStatus || 'unknown' };
  await atomicWrite(path.join(dir, `${hash}.json`), JSON.stringify(meta, null, 2));
  await atomicWrite(path.join(dir, `${hash}.bin`), body);
  return meta;
}
