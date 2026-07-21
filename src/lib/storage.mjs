import path from 'node:path';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { atomicWrite, sha256, withLock } from './util.mjs';
import { renderHtml, renderMarkdown } from './render.mjs';
import { validateReport } from './schema.mjs';

const exists = async file => stat(file).then(() => true, () => false);
const reportPath = date => `reports/${date}/report.json`;
const manifestPath = dataDir => path.join(dataDir, 'manifest.ndjson');

function assertDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid report date');
}

async function readManifest(dataDir) {
  try { return (await readFile(manifestPath(dataDir), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function manifestEntry(report, json) {
  return { date: report.date, generatedAt: report.generatedAt, path: reportPath(report.date), sha256: sha256(json), itemIds: report.items.map(x => x.id) };
}

function sameEntry(left, right) {
  return left.date === right.date && left.generatedAt === right.generatedAt && left.path === right.path && left.sha256 === right.sha256 && JSON.stringify(left.itemIds) === JSON.stringify(right.itemIds);
}

async function manifestState(dataDir, expected) {
  const related = (await readManifest(dataDir)).filter(entry => entry.date === expected.date || entry.path === expected.path || entry.sha256 === expected.sha256);
  if (related.some(entry => !sameEntry(entry, expected))) throw new Error(`conflicting manifest entry for ${expected.date}`);
  return related.length ? 'exists' : 'missing';
}

export async function appendManifestEntry(file, entry, openFile = open) {
  const handle = await openFile(file, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function reconcileManifest(dataDir, report, json) {
  const entry = manifestEntry(report, json);
  if (await manifestState(dataDir, entry) === 'exists') return 'exists';
  await appendManifestEntry(manifestPath(dataDir), entry);
  return 'recovered';
}

async function readReportRecordByDate(dataDir, date, { complete = false } = {}) {
  assertDate(date);
  const dir = path.join(dataDir, 'reports', date), file = path.join(dir, 'report.json');
  let json;
  try {
    if (complete) await Promise.all(['report.md', 'report.html'].map(name => readFile(path.join(dir, name))));
    json = await readFile(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const report = validateReport(JSON.parse(json));
  if (report.date !== date) throw new Error(`report date mismatch for ${date}`);
  return { dir, json, report };
}

export async function readReportByDate(dataDir, date) {
  return (await readReportRecordByDate(dataDir, date))?.report ?? null;
}

export async function recoverReport(dataDir, date) {
  assertDate(date);
  const first = await readReportRecordByDate(dataDir, date, { complete: true });
  if (!first) return null;
  const lock = path.join(dataDir, 'locks', `${date}.lock`);
  return withLock(lock, async () => {
    const record = await readReportRecordByDate(dataDir, date, { complete: true });
    if (!record) throw new Error(`report disappeared during recovery: ${date}`);
    const status = await reconcileManifest(dataDir, record.report, record.json);
    return { status, dir: record.dir, report: record.report };
  });
}

export async function writeReport(dataDir, report) {
  assertDate(report?.date);
  const reports = path.join(dataDir, 'reports'), finalDir = path.join(reports, report.date), lock = path.join(dataDir, 'locks', `${report.date}.lock`);
  return withLock(lock, async () => {
    const existing = await readReportRecordByDate(dataDir, report.date, { complete: true });
    if (existing) {
      const status = await reconcileManifest(dataDir, existing.report, existing.json);
      return { status, dir: finalDir, report: existing.report };
    }
    if (report.schemaVersion !== 4) throw new Error('new reports must use schema version 4');
    validateReport(report);
    if (await exists(finalDir)) throw new Error(`incomplete report directory for ${report.date}`);
    await mkdir(reports, { recursive: true });
    const stage = path.join(reports, `.${report.date}.${process.pid}.staging`); await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
    const json = `${JSON.stringify(report, null, 2)}\n`, markdown = renderMarkdown(report), html = renderHtml(report);
    const expected = manifestEntry(report, json);
    await manifestState(dataDir, expected);
    try {
      await atomicWrite(path.join(stage, 'report.json'), json); await atomicWrite(path.join(stage, 'report.md'), markdown); await atomicWrite(path.join(stage, 'report.html'), html);
      await rename(stage, finalDir);
    } finally { await rm(stage, { recursive: true, force: true }); }
    await reconcileManifest(dataDir, report, json);
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
    if (!lines.length) return null;
    const entry = JSON.parse(lines.at(-1));
    return validateReport(JSON.parse(await readFile(path.join(dataDir, entry.path), 'utf8')));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
