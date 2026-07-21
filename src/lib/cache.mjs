import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { atomicWrite, sha256 } from './util.mjs';

export async function cachePublicAsset(dataDir, record, body, limits) {
  if (!['public-feed', 'public-page', 'public-metadata', 'open-access'].includes(record.accessStatus)) throw new Error('only public/OA content may be cached');
  if (typeof record.mime !== 'string' || !record.mime) throw new Error('invalid asset MIME');
  if (!Buffer.isBuffer(body) || !body.length) throw new Error('cache asset body is empty');
  const kind = record.kind || (record.mime === 'application/pdf' ? 'pdf' : record.mime.startsWith('image/') ? 'image' : 'asset');
  const head = body.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<body')) {
    if (kind !== 'article') throw new Error(`HTML content rejected for ${kind || 'binary'} asset`);
  }
  const max = record.mime === 'application/pdf' ? limits.maxPdfBytes : record.mime.startsWith('image/') ? limits.maxImageBytes : limits.maxPageBytes;
  if (body.length > max) throw new Error('cache asset exceeds byte limit');
  if (record.mime === 'application/pdf' && record.accessStatus !== 'open-access') throw new Error('PDF download requires verified OA status');
  if (kind === 'pdf' && (record.mime !== 'application/pdf' || !body.subarray(0, 5).equals(Buffer.from('%PDF-')))) throw new Error('invalid PDF MIME or signature');
  if (kind === 'image') {
    const signatures = {
      'image/jpeg': body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff,
      'image/png': body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      'image/gif': /^GIF8[79]a$/.test(body.subarray(0, 6).toString('ascii')),
      'image/webp': body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP'
    };
    if (!signatures[record.mime]) throw new Error('invalid image MIME or signature');
  }
  if (kind === 'article' && !['text/html', 'text/plain', 'application/xhtml+xml'].includes(record.mime)) throw new Error('invalid public article MIME');
  const hash = sha256(body); const dir = path.join(dataDir, 'cache'); await mkdir(dir, { recursive: true });
  const localCacheRef = `/assets/${hash}`;
  const meta = { kind, url: record.url, retrievedAt: new Date().toISOString(), mime: record.mime, hash, bytes: body.length, author: record.author || '', institution: record.institution || '', accessStatus: record.accessStatus, licenseStatus: record.licenseStatus || 'unknown', localCacheRef };
  await atomicWrite(path.join(dir, `${hash}.bin`), body);
  await atomicWrite(path.join(dir, `${hash}.json`), JSON.stringify(meta, null, 2));
  return meta;
}
