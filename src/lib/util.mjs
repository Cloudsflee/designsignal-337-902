import { createHash } from 'node:crypto';
import { link, mkdir, readFile, rename, open, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 25;
const RENAME_MAX_ELAPSED_MS = 2200;
const RENAME_MAX_DELAY_MS = 100;

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
async function renameReplacement(temp, file, { renameImpl, sleepImpl, nowImpl }) {
  const started = nowImpl();
  let lastError;
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1 && nowImpl() - started >= RENAME_MAX_ELAPSED_MS) throw lastError;
    try { return await renameImpl(temp, file); }
    catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_CODES.has(error.code) || attempt === RENAME_MAX_ATTEMPTS) throw error;
      const remaining = RENAME_MAX_ELAPSED_MS - (nowImpl() - started);
      if (remaining <= 0) throw error;
      const delay = Math.min(5 * 2 ** (attempt - 1), RENAME_MAX_DELAY_MS, remaining);
      await sleepImpl(delay);
    }
  }
}

export async function atomicWrite(file, content, {
  overwrite = true,
  openImpl = open,
  renameImpl = rename,
  sleepImpl = sleep,
  nowImpl = () => performance.now()
} = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await openImpl(temp, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (overwrite) await renameReplacement(temp, file, { renameImpl, sleepImpl, nowImpl });
    else await link(temp, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
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
