import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { writeReport } from '../src/lib/storage.mjs';
import { handleDashboardRequest } from '../src/lib/server.mjs';
import { enrichItem } from '../src/lib/model.mjs';
import { daily } from '../src/lib/daily.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { sha256 } from '../src/lib/util.mjs';

const exists = file => stat(file).then(() => true, () => false);
async function fixtureReport() { const s = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] }); return buildReport({ date: '2026-07-19', items: s.selected, rejected: s.rejected, health: [], selectionPolicy: s.policy, fixture: true }); }

test('offline CLI daily path returns exactly six validated items and writes nothing', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ds-cli-')), dataDir = path.join(parent, 'must-not-exist');
  const config = await loadConfig({ env: { DESIGNSIGNAL_DATA_DIR: dataDir } });
  const result = await daily(config, { fixture: true, dryRun: true, date: '2026-07-19' });
  assert.equal(result.report.items.length, 6); assert.ok(result.report.items.every(x => x.title.zh && x.title.en)); assert.equal(await exists(dataDir), false);
  await rm(parent, { recursive: true, force: true });
});

test('HTTP dashboard escapes untrusted content and sends security headers/APIs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-http-')), report = structuredClone(await fixtureReport()); report.items[0].title.zh = '<script>alert(1)</script>中文';
  await writeReport(dir, report);
  const invoke = async (dataDir, url) => {
    const result = { headers: {}, status: 0, body: '' };
    const req = { method: 'GET', url, async *[Symbol.asyncIterator]() {} };
    const res = { setHeader(k, v) { result.headers[k] = v; }, writeHead(status, extra = {}) { result.status = status; Object.assign(result.headers, extra); }, end(value = '') { result.body += value; } };
    await handleDashboardRequest({ dataDir }, req, res); return result;
  };
  const health = await invoke(dir, '/healthz'); assert.equal(health.status, 200); assert.equal(health.headers['x-content-type-options'], 'nosniff'); assert.match(health.headers['content-security-policy'], /frame-ancestors/);
  const home = await invoke(dir, '/'); assert.doesNotMatch(home.body, /<script>alert\(1\)<\/script>/); assert.match(home.body, /&lt;script&gt;alert/); assert.match(home.body, /data-category="product"/);
  const api = await invoke(dir, '/api/report'); assert.equal(JSON.parse(api.body).items.length, 6);

  const legacyDir = await mkdtemp(path.join(os.tmpdir(), 'ds-http-v2-'));
  const legacy = await fixtureReport(); await writeReport(legacyDir, legacy); legacy.schemaVersion = 2; delete legacy.audit.selectionPolicy.priorityInstitutionPaper;
  const legacyJson = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(path.join(legacyDir, 'reports', legacy.date, 'report.json'), legacyJson);
  const manifestFile = path.join(legacyDir, 'manifest.ndjson'), manifest = JSON.parse((await readFile(manifestFile, 'utf8')).trim());
  manifest.sha256 = sha256(legacyJson); await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
  const legacyApi = await invoke(legacyDir, '/api/report'); assert.equal(legacyApi.status, 200); assert.equal(JSON.parse(legacyApi.body).schemaVersion, 2);

  const reportFile = path.join(dir, 'reports', report.date, 'report.json');
  const tampered = JSON.parse(await readFile(reportFile, 'utf8')); delete tampered.audit.selectionPolicy.priorityInstitutionPaper;
  await writeFile(reportFile, `${JSON.stringify(tampered, null, 2)}\n`);
  const rejected = await invoke(dir, '/api/report'); assert.equal(rejected.status, 500); assert.match(JSON.parse(rejected.body).error, /manifest hash mismatch/);
  await rm(legacyDir, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

test('outbox API returns a safe metadata projection for legacy or malformed jobs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-http-outbox-'));
  try {
    await mkdir(path.join(dir, 'outbox'));
    await writeFile(path.join(dir, 'outbox', 'fixture-job.json'), JSON.stringify({
      id: 'fixture-job', channel: 'generic', reportDate: '2026-07-19', state: 'pending',
      attempts: 0, nextAttemptAt: '2026-07-19T00:00:00.000Z', createdAt: '2026-07-19T00:00:00.000Z',
      payload: { secret: 'payload-secret-marker' }, endpoint: 'https://secret-endpoint.example', token: 'token-secret-marker'
    }));
    await writeFile(path.join(dir, 'outbox', 'broken.json'), '{not-json');
    const result = { headers: {}, status: 0, body: '' };
    const req = { method: 'GET', url: '/api/outbox', async *[Symbol.asyncIterator]() {} };
    const res = { setHeader(k, v) { result.headers[k] = v; }, writeHead(status, extra = {}) { result.status = status; Object.assign(result.headers, extra); }, end(value = '') { result.body += value; } };
    await handleDashboardRequest({ dataDir: dir, feishuDocument: { tenantBaseUrl: 'https://feishu.cn' } }, req, res);
    assert.equal(result.status, 200);
    assert.doesNotMatch(result.body, /payload-secret-marker|secret-endpoint|token-secret-marker/);
    const jobs = JSON.parse(result.body);
    assert.ok(jobs.some(job => job.state === 'invalid' && job.reason === 'invalid-job-file'));
    assert.ok(jobs.some(job => job.id === 'fixture-job' && !('payload' in job)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Responses API structured output is validated and retried', async () => {
  const raw = fixtureCandidates.find(x => x.category === 'paper'), output = structuredClone(raw); let calls = 0;
  const fetchImpl = async () => { calls++; if (calls < 3) return new Response(JSON.stringify({ output_text: '{bad' }), { status: 200, headers: { 'content-type': 'application/json' } }); return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const fakeCredential = ['sk', 'fixture'].join('-');
  const config = { model: { model: 'test', token: fakeCredential, baseUrl: 'https://api.example.com/v1' }, network: { timeoutMs: 100 } };
  const item = await enrichItem(raw, config, { fetchImpl }); assert.equal(calls, 3); assert.equal(item.id, raw.id);
});
