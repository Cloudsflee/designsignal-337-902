import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-http-')), report = structuredClone(await fixtureReport()); report.items[0].title.zh = '<script>alert(1)</script>';
  await writeReport(dir, report);
  const invoke = async url => {
    const result = { headers: {}, status: 0, body: '' };
    const req = { method: 'GET', url, async *[Symbol.asyncIterator]() {} };
    const res = { setHeader(k, v) { result.headers[k] = v; }, writeHead(status, extra = {}) { result.status = status; Object.assign(result.headers, extra); }, end(value = '') { result.body += value; } };
    await handleDashboardRequest({ dataDir: dir }, req, res); return result;
  };
  const health = await invoke('/healthz'); assert.equal(health.status, 200); assert.equal(health.headers['x-content-type-options'], 'nosniff'); assert.match(health.headers['content-security-policy'], /frame-ancestors/);
  const home = await invoke('/'); assert.doesNotMatch(home.body, /<script>alert\(1\)<\/script>/); assert.match(home.body, /&lt;script&gt;alert/); assert.match(home.body, /data-category="product"/);
  const api = await invoke('/api/report'); assert.equal(JSON.parse(api.body).items.length, 6);
  await rm(dir, { recursive: true, force: true });
});

test('Responses API structured output is validated and retried', async () => {
  const raw = fixtureCandidates.find(x => x.category === 'paper'), output = structuredClone(raw); let calls = 0;
  const fetchImpl = async () => { calls++; if (calls < 3) return new Response(JSON.stringify({ output_text: '{bad' }), { status: 200, headers: { 'content-type': 'application/json' } }); return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const fakeCredential = ['sk', 'fixture'].join('-');
  const config = { model: { model: 'test', token: fakeCredential, baseUrl: 'https://api.example.com/v1' }, network: { timeoutMs: 100 } };
  const item = await enrichItem(raw, config, { fetchImpl }); assert.equal(calls, 3); assert.equal(item.id, raw.id);
});
