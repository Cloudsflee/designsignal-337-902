import path from 'node:path';
import { appendFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { atomicWrite, sha256, withLock } from './util.mjs';
import { renderHtml, renderMarkdown } from './render.mjs';

const exists = async file => stat(file).then(() => true, () => false);
export async function writeReport(dataDir, report) {
  const reports = path.join(dataDir, 'reports'), finalDir = path.join(reports, report.date), lock = path.join(dataDir, 'locks', `${report.date}.lock`);
  return withLock(lock, async () => {
    const reportFile = path.join(finalDir, 'report.json');
    if (await exists(reportFile)) return { status: 'exists', dir: finalDir, report: JSON.parse(await readFile(reportFile, 'utf8')) };
    await mkdir(reports, { recursive: true });
    const stage = path.join(reports, `.${report.date}.${process.pid}.staging`); await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
    const json = `${JSON.stringify(report, null, 2)}\n`, markdown = renderMarkdown(report), html = renderHtml(report);
    await atomicWrite(path.join(stage, 'report.json'), json); await atomicWrite(path.join(stage, 'report.md'), markdown); await atomicWrite(path.join(stage, 'report.html'), html);
    await rename(stage, finalDir);
    const line = JSON.stringify({ date: report.date, generatedAt: report.generatedAt, path: `reports/${report.date}/report.json`, sha256: sha256(json), itemIds: report.items.map(x => x.id) });
    await appendFile(path.join(dataDir, 'manifest.ndjson'), `${line}\n`, { mode: 0o600, flag: 'a' });
    const handle = await open(path.join(dataDir, 'manifest.ndjson'), 'r'); await handle.sync(); await handle.close();
    return { status: 'written', dir: finalDir, report };
  });
}

export async function readHistory(dataDir) {
  try { return (await readFile(path.join(dataDir, 'manifest.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).flatMap(x => x.itemIds.map(id => ({ id, date: x.date }))); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function latestReport(dataDir) {
  try {
    const lines = (await readFile(path.join(dataDir, 'manifest.ndjson'), 'utf8')).trim().split('\n').filter(Boolean);
    if (!lines.length) return null; const entry = JSON.parse(lines.at(-1)); return JSON.parse(await readFile(path.join(dataDir, entry.path), 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
