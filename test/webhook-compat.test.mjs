import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { queueDeliveries, retryOutbox } from '../src/lib/push.mjs';
import { queueWebhookDeliveries, retryWebhookOutbox } from '../src/lib/webhook.mjs';
import { atomicWrite, sha256 } from '../src/lib/util.mjs';

const network = { allowHosts: [], timeoutMs: 100, retries: 3, maxJsonBytes: 65536, maxPageBytes: 65536 };
const emptyConfig = () => ({ network, push: { generic: '', feishu: '', wecom: '' }, feishuDocument: { appId: '', appSecret: '', folderToken: '', tenantBaseUrl: 'https://feishu.cn' } });
const dnsLookup = async () => [{ address: '8.8.8.8', family: 4 }];

async function fixtureReport() {
  const selected = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] });
  return buildReport({ date: '2026-07-19', items: selected.selected, rejected: selected.rejected, health: [], selectionPolicy: selected.policy, fixture: true });
}

test('legacy webhook identities and payload schema are preserved byte-for-byte without endpoints', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-webhook-legacy-'));
  try {
    const report = await fixtureReport(), config = emptyConfig();
    const queued = await queueDeliveries(dir, report, config);
    const webhooks = queued.filter(job => ['generic', 'feishu', 'wecom'].includes(job.channel));
    assert.deepEqual(webhooks.map(job => job.id), webhooks.map(job => sha256(`${report.date}:${job.channel}`).slice(0, 24)));
    assert.deepEqual(Object.keys(webhooks[0]), ['id', 'channel', 'reportDate', 'endpointConfigured', 'state', 'reason', 'attempts', 'nextAttemptAt', 'createdAt', 'payload']);
    const generic = webhooks.find(job => job.channel === 'generic');
    assert.equal(generic.payload.event, 'designsignal.daily');
    assert.equal(generic.payload.itemCount, 6);
    assert.equal(webhooks.find(job => job.channel === 'feishu').payload.msg_type, 'text');
    assert.equal(webhooks.find(job => job.channel === 'wecom').payload.msgtype, 'text');

    const snapshots = new Map(), fixed = new Date('2020-01-02T03:04:05.000Z');
    for (const job of webhooks) {
      const file = path.join(dir, 'outbox', `${job.id}.json`);
      await atomicWrite(file, `${JSON.stringify(job)}\n`);
      await utimes(file, fixed, fixed);
      snapshots.set(job.id, { bytes: await readFile(file), mtime: (await stat(file)).mtimeMs });
    }
    await queueDeliveries(dir, report, config);
    await retryOutbox(dir, config);
    for (const job of webhooks) {
      const file = path.join(dir, 'outbox', `${job.id}.json`), before = snapshots.get(job.id);
      assert.deepEqual(await readFile(file), before.bytes);
      assert.equal((await stat(file)).mtimeMs, before.mtime);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid calendar webhook report dates are ignored before delivery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-webhook-invalid-date-'));
  try {
    const report = await fixtureReport();
    const config = { dataDir: dir, push: { generic: '', feishu: '', wecom: '' }, network: { allowHosts: [], timeoutMs: 100, retries: 0 } };
    const jobs = await queueWebhookDeliveries(dir, report, config);
    const file = path.join(dir, 'outbox', `${jobs[0].id}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8')); stored.reportDate = '2026-02-30';
    await writeFile(file, JSON.stringify(stored));
    const result = await retryWebhookOutbox(dir, config, { fetchImpl: async () => assert.fail('network must not be reached') });
    assert.equal(result.some(job => job.id === jobs[0].id), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('all webhook channels use validated addresses and stable idempotency keys', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-webhook-send-'));
  try {
    const report = await fixtureReport();
    const config = emptyConfig();
    config.push = {
      generic: 'https://hooks.example.com/generic?key=one',
      feishu: 'https://hooks.example.com/feishu?key=two',
      wecom: 'https://hooks.example.com/wecom?key=three'
    };
    const queued = await queueDeliveries(dir, report, config), calls = [];
    const results = await retryOutbox(dir, config, {
      now: () => Date.parse('2030-01-01T00:00:00.000Z'), dnsLookup,
      requestImpl: async (url, init, target) => {
        calls.push({ url, init, target });
        return new Response('', { status: 200 });
      }
    });
    assert.equal(calls.length, 3);
    const webhookResults = results.filter(job => ['generic', 'feishu', 'wecom'].includes(job.channel));
    assert.ok(webhookResults.every(job => job.state === 'delivered'));
    for (const call of calls) {
      const channel = new URL(call.url).pathname.slice(1);
      const job = queued.find(entry => entry.channel === channel);
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.headers['idempotency-key'], `designsignal-${job.id}`);
      assert.deepEqual(JSON.parse(call.init.body), job.payload);
      assert.deepEqual(call.target.addresses, [{ address: '8.8.8.8', family: 4 }]);
    }
    const stored = await Promise.all((await readdir(path.join(dir, 'outbox'))).map(name => readFile(path.join(dir, 'outbox', name), 'utf8')));
    for (const endpoint of Object.values(config.push)) assert.ok(stored.every(value => !value.includes(endpoint)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a webhook POST is attempted once per due job and uses bounded persisted backoff', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-webhook-backoff-'));
  try {
    const report = await fixtureReport(), config = emptyConfig();
    config.push.generic = 'https://hooks.example.com/generic';
    await queueDeliveries(dir, report, config);
    const start = Date.parse('2030-01-01T00:00:00.000Z');
    let calls = 0;
    let result = await retryOutbox(dir, config, {
      now: () => start, dnsLookup,
      requestImpl: async () => { calls++; return new Response('', { status: 503 }); }
    });
    let generic = result.find(job => job.channel === 'generic');
    assert.equal(calls, 1);
    assert.equal(generic.state, 'pending');
    assert.equal(generic.attempts, 1);
    assert.equal(generic.reason, 'webhook HTTP 503');
    assert.equal(generic.nextAttemptAt, '2030-01-01T00:02:00.000Z');

    await retryOutbox(dir, config, { now: () => start + 60_000, dnsLookup, requestImpl: async () => { calls++; return new Response('', { status: 200 }); } });
    assert.equal(calls, 1);
    result = await retryOutbox(dir, config, { now: () => start + 120_000, dnsLookup, requestImpl: async () => { calls++; return new Response('', { status: 200 }); } });
    generic = result.find(job => job.channel === 'generic');
    assert.equal(calls, 2);
    assert.equal(generic.state, 'delivered');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
