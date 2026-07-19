import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { writeReport } from '../src/lib/storage.mjs';
import { withLock } from '../src/lib/util.mjs';
import { queueDeliveries, retryOutbox } from '../src/lib/push.mjs';
import { nextScheduledAt } from '../src/lib/scheduler.mjs';

async function fixtureReport() { const s = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] }); return buildReport({ date: '2026-07-19', items: s.selected, rejected: s.rejected, health: [], selectionPolicy: s.policy, fixture: true }); }

test('dated report writes atomically, manifests once and is idempotent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-store-')), report = await fixtureReport();
  const first = await writeReport(dir, report), second = await writeReport(dir, report);
  assert.equal(first.status, 'written'); assert.equal(second.status, 'exists');
  const files = await readdir(path.join(dir, 'reports', report.date)); assert.deepEqual(files.sort(), ['report.html', 'report.json', 'report.md']);
  assert.equal((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim().split('\n').length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('per-date lock excludes concurrent holders and cleans up', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-lock-')), lock = path.join(dir, 'date.lock');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = withLock(lock, async () => gate);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => withLock(lock, async () => {}), /already locked/);
  release(); await first;
  await withLock(lock, async () => {});
  await rm(dir, { recursive: true, force: true });
});

test('23:50 Shanghai calculation is exact from UTC', () => {
  assert.equal(nextScheduledAt(new Date('2026-01-01T15:49:30Z'), 'Asia/Shanghai').toISOString(), '2026-01-01T15:50:00.000Z');
  assert.equal(nextScheduledAt(new Date('2026-01-01T15:50:30Z'), 'Asia/Shanghai').toISOString(), '2026-01-02T15:50:00.000Z');
});

test('push outbox retains missing secrets and retries configured webhook', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-push-')), report = await fixtureReport();
  const base = { network: { allowHosts: [], timeoutMs: 100, retries: 0 }, push: { generic: '', feishu: '', wecom: '' } };
  let jobs = await queueDeliveries(dir, report, base); assert.equal(jobs.length, 3); assert.ok(jobs.every(x => x.state === 'pending' && /missing/.test(x.reason)));
  base.push.generic = 'https://hooks.example.com/daily'; let calls = 0;
  await retryOutbox(dir, base, { dnsLookup: async () => [{ address: '8.8.8.8' }], fetchImpl: async () => { calls++; return new Response('', { status: 200 }); } });
  jobs = await Promise.all((await readdir(path.join(dir, 'outbox'))).map(x => readFile(path.join(dir, 'outbox', x), 'utf8').then(JSON.parse)));
  assert.equal(calls, 1); assert.equal(jobs.find(x => x.channel === 'generic').state, 'delivered'); assert.ok(jobs.filter(x => x.channel !== 'generic').every(x => x.state === 'pending'));
  assert.ok(jobs.every(x => !('endpoint' in x)));
  await rm(dir, { recursive: true, force: true });
});
