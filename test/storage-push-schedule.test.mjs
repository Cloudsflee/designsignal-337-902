import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { appendManifestEntry, readReportByDate, writeReport } from '../src/lib/storage.mjs';
import { atomicWrite, withLock } from '../src/lib/util.mjs';
import { queueDeliveries, retryOutbox } from '../src/lib/push.mjs';
import { nextScheduledAt } from '../src/lib/scheduler.mjs';
import { daily } from '../src/lib/daily.mjs';

async function fixtureReport() { const s = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] }); return buildReport({ date: '2026-07-19', items: s.selected, rejected: s.rejected, health: [], selectionPolicy: s.policy, fixture: true }); }

test('dated report writes atomically, manifests once and is idempotent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-store-')), report = await fixtureReport();
  const first = await writeReport(dir, report), second = await writeReport(dir, report);
  assert.equal(first.status, 'written'); assert.equal(second.status, 'exists');
  const files = await readdir(path.join(dir, 'reports', report.date)); assert.deepEqual(files.sort(), ['report.html', 'report.json', 'report.md']);
  assert.equal((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim().split('\n').length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('manifest append uses one append handle and closes it after sync failure', async () => {
  const calls = [];
  const handle = {
    async writeFile(value) { calls.push(['write', value]); },
    async sync() { calls.push(['sync']); throw new Error('sync failed'); },
    async close() { calls.push(['close']); }
  };
  await assert.rejects(() => appendManifestEntry('/manifest', { date: '2026-07-19' }, async (...args) => { calls.push(['open', ...args]); return handle; }), /sync failed/);
  assert.deepEqual(calls.map(x => x[0]), ['open', 'write', 'sync', 'close']);
  assert.deepEqual(calls[0].slice(1), ['/manifest', 'a', 0o600]);
});

test('atomicWrite removes its synced temp file when publication fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-')), target = path.join(dir, 'target');
  await mkdir(target);
  await assert.rejects(() => atomicWrite(target, 'content'));
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite retries transient replacement failures after sync and close', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-retry-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  const calls = [], delays = [];
  let closed = false, attempts = 0, published;
  const openImpl = async (...args) => {
    const handle = await open(...args);
    return {
      async writeFile(value) { calls.push('write'); await handle.writeFile(value); },
      async sync() { calls.push('sync'); await handle.sync(); },
      async close() { calls.push('close'); await handle.close(); closed = true; }
    };
  };
  const renameImpl = async (temp, destination) => {
    calls.push('rename');
    assert.equal(closed, true);
    if (++attempts < 3) throw Object.assign(new Error('temporarily locked'), { code: attempts === 1 ? 'EPERM' : 'EACCES' });
    published = { destination, content: await readFile(temp, 'utf8') };
  };
  await atomicWrite(target, 'new', { openImpl, renameImpl, sleepImpl: async delay => delays.push(delay), nowImpl: () => 0 });
  assert.deepEqual(calls, ['write', 'sync', 'close', 'rename', 'rename', 'rename']);
  assert.deepEqual(delays, [5, 10]);
  assert.deepEqual(published, { destination: target, content: 'new' });
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite bounds transient rename retries and preserves the destination', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-exhaust-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  let attempts = 0;
  const delays = [];
  const failure = Object.assign(new Error('still busy'), { code: 'EBUSY' });
  await assert.rejects(
    () => atomicWrite(target, 'new', { renameImpl: async () => { attempts++; throw failure; }, sleepImpl: async delay => delays.push(delay), nowImpl: () => 0 }),
    error => error === failure
  );
  assert.equal(attempts, 25);
  assert.deepEqual(delays, [5, 10, 20, 40, 80, ...Array(19).fill(100)]);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite stops transient retries at the elapsed-time cap', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-time-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  let attempts = 0, now = 0;
  const failure = Object.assign(new Error('permission pending'), { code: 'EPERM' });
  await assert.rejects(() => atomicWrite(target, 'new', {
    renameImpl: async () => { attempts++; now += 750; throw failure; },
    sleepImpl: async delay => { now += delay; },
    nowImpl: () => now
  }), error => error === failure);
  assert.equal(attempts, 3);
  assert.equal(now, 2265);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite closes and cleans up when sync fails before publication', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-sync-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  const failure = new Error('sync failed');
  let closed = false, renameCalls = 0;
  const openImpl = async (...args) => {
    const handle = await open(...args);
    return {
      async writeFile(value) { await handle.writeFile(value); },
      async sync() { throw failure; },
      async close() { await handle.close(); closed = true; }
    };
  };
  await assert.rejects(() => atomicWrite(target, 'new', {
    openImpl,
    renameImpl: async () => { renameCalls++; }
  }), error => error === failure);
  assert.equal(closed, true);
  assert.equal(renameCalls, 0);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite does not retry structural rename failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-structural-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  let attempts = 0, sleeps = 0;
  const failure = Object.assign(new Error('target is a directory'), { code: 'EISDIR' });
  await assert.rejects(() => atomicWrite(target, 'new', {
    renameImpl: async () => { attempts++; throw failure; },
    sleepImpl: async () => { sleeps++; }
  }), error => error === failure);
  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite overwrite false retains exactly-once link publication', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-link-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  let renameCalls = 0, sleeps = 0;
  await assert.rejects(() => atomicWrite(target, 'new', {
    overwrite: false,
    renameImpl: async () => { renameCalls++; },
    sleepImpl: async () => { sleeps++; }
  }), error => error.code === 'EEXIST');
  assert.equal(renameCalls, 0);
  assert.equal(sleeps, 0);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('complete report without a manifest is validated and reconciled once', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-recover-')), report = await fixtureReport();
  await writeReport(dir, report);
  await rm(path.join(dir, 'manifest.ndjson'));
  const recovered = await writeReport(dir, report), again = await writeReport(dir, report);
  assert.equal(recovered.status, 'recovered'); assert.equal(again.status, 'exists');
  assert.deepEqual(await readReportByDate(dir, report.date), report);
  assert.equal((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim().split('\n').length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('daily recovers report and manifest before collection and recreates only missing outbox jobs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-daily-recover-')), report = await fixtureReport();
  await writeReport(dir, report);
  let networkCalls = 0;
  const config = { dataDir: dir, timezone: 'Asia/Shanghai', push: { generic: '', feishu: '', wecom: '' }, network: { allowHosts: [], timeoutMs: 100, retries: 0 } };
  const ctx = { fetchImpl: async () => { networkCalls++; throw new Error('collection must not run'); } };
  const first = await daily(config, { date: report.date, ctx }), second = await daily(config, { date: report.date, ctx });
  assert.equal(first.status, 'exists'); assert.equal(second.status, 'exists'); assert.equal(networkCalls, 0);
  assert.equal((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await readdir(path.join(dir, 'outbox'))).length, 3);
  await rm(dir, { recursive: true, force: true });
});

test('daily reconciles a missing manifest before collection', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-daily-manifest-')), report = await fixtureReport();
  await writeReport(dir, report); await rm(path.join(dir, 'manifest.ndjson'));
  const config = { dataDir: dir, timezone: 'Asia/Shanghai', push: { generic: '', feishu: '', wecom: '' }, network: { allowHosts: [], timeoutMs: 100, retries: 0 } };
  const result = await daily(config, { date: report.date, ctx: { fetchImpl: async () => { throw new Error('collection must not run'); } } });
  assert.equal(result.status, 'recovered');
  assert.equal((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim().split('\n').length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('conflicting manifest identity is refused', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-manifest-conflict-')), report = await fixtureReport();
  await writeReport(dir, report);
  const manifest = JSON.parse((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim());
  manifest.sha256 = '0'.repeat(64);
  await writeFile(path.join(dir, 'manifest.ndjson'), `${JSON.stringify(manifest)}\n`);
  await assert.rejects(() => writeReport(dir, report), /conflicting manifest/);
  await rm(dir, { recursive: true, force: true });
});

test('per-date lock excludes concurrent holders and cleans up', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-lock-')), lock = path.join(dir, 'date.lock');
  let release, markEntered;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { markEntered = resolve; });
  const first = withLock(lock, async () => { markEntered(); return gate; });
  await entered;
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

test('retryOutbox returns unchanged missing-endpoint jobs without rewriting them', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-push-no-write-')), report = await fixtureReport();
  const config = { network: { allowHosts: [], timeoutMs: 100, retries: 0 }, push: { generic: '', feishu: '', wecom: '' } };
  const jobs = await queueDeliveries(dir, report, config);
  const fixedTime = new Date('2020-01-02T03:04:05.000Z');
  const snapshots = new Map();
  for (const job of jobs) {
    const file = path.join(dir, 'outbox', `${job.id}.json`);
    await utimes(file, fixedTime, fixedTime);
    snapshots.set(job.id, { bytes: await readFile(file), mtimeMs: (await stat(file)).mtimeMs });
  }

  const results = await retryOutbox(dir, config);
  assert.deepEqual(results.map(job => job.id).sort(), jobs.map(job => job.id).sort());
  for (const job of jobs) {
    const file = path.join(dir, 'outbox', `${job.id}.json`), before = snapshots.get(job.id);
    assert.deepEqual(await readFile(file), before.bytes);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  }
  await rm(dir, { recursive: true, force: true });
});

test('queueDeliveries preserves delivered jobs and creates only missing identities', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-push-preserve-')), report = await fixtureReport();
  const config = { network: { allowHosts: [], timeoutMs: 100, retries: 0 }, push: { generic: '', feishu: '', wecom: '' } };
  const jobs = await queueDeliveries(dir, report, config), delivered = { ...jobs.find(job => job.channel === 'generic'), state: 'delivered', reason: '', deliveredAt: '2026-07-19T12:00:00.000Z' };
  await atomicWrite(path.join(dir, 'outbox', `${delivered.id}.json`), `${JSON.stringify(delivered, null, 2)}\n`);
  await queueDeliveries(dir, report, config);
  const stored = JSON.parse(await readFile(path.join(dir, 'outbox', `${delivered.id}.json`), 'utf8'));
  assert.deepEqual(stored, delivered); assert.equal((await readdir(path.join(dir, 'outbox'))).length, 3);
  const conflicting = { ...stored, reportDate: '2026-07-20' };
  await atomicWrite(path.join(dir, 'outbox', `${delivered.id}.json`), `${JSON.stringify(conflicting)}\n`);
  await assert.rejects(() => queueDeliveries(dir, report, config), /conflicting outbox job identity/);
  await rm(dir, { recursive: true, force: true });
});
