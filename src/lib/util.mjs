import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, rm } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const isoDate = (date = new Date(), timeZone = 'Asia/Shanghai') => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};
export const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const parseArgs = args => {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) out._.push(args[i]);
    else {
      const [key, inline] = args[i].slice(2).split('=', 2);
      out[key] = inline ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    }
  }
  return out;
};
export async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
export async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, file);
}
export async function withLock(lockFile, fn) {
  await mkdir(path.dirname(lockFile), { recursive: true });
  let handle;
  try { handle = await open(lockFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`date already locked: ${path.basename(lockFile, '.lock')}`); throw error; }
  try { return await fn(); }
  finally { await handle.close(); await rm(lockFile, { force: true }); }
}
export const redact = value => {
  const sensitive = /(api[-_]?key|authorization|token|secret|webhook|mailto)/i;
  const visit = (v, key = '') => {
    if (sensitive.test(key)) return '[REDACTED]';
    if (Array.isArray(v)) return v.map(x => visit(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]));
    if (typeof v === 'string') return v.replace(/([?&](?:api_key|mailto)=)[^&\s]+/gi, '$1[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
    return v;
  };
  return visit(value);
};
export const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
};
