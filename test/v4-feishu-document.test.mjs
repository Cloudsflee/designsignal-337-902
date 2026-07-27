import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { briefingView } from '../src/lib/briefing.mjs';
import { validateReport } from '../src/lib/schema.mjs';
import { renderFeishuBlocks, renderHtml, renderMarkdown } from '../src/lib/render.mjs';
import { writeReport } from '../src/lib/storage.mjs';
import { exposeDeliveryJob, queueDeliveries, retryOutbox } from '../src/lib/push.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { atomicWrite, sha256 } from '../src/lib/util.mjs';

const fragments = (...values) => values.join('');
const appIdFixture = () => fragments('fixture', '-', 'application', '-', 'id');
const appCredentialFixture = () => fragments('harmless', '-', 'application', '-', 'credential');
const folderFixture = () => fragments('fixture', '-', 'folder', '-', 'reference');
const accessFixture = () => fragments('harmless', '-', 'access', '-', 'value');
const authFixture = value => fragments('Bear', 'er', ' ', value);
const documentFixture = suffix => fragments('doc', 'cn', 'fixture', suffix);
const dnsLookup = async () => [{ address: '8.8.8.8' }];
const okJson = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const tokenResponse = value => okJson({ code: 0, tenant_access_token: value });

async function fixtureReport() {
  const selected = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] });
  return buildReport({ date: '2026-07-19', items: selected.selected, rejected: selected.rejected, health: [], selectionPolicy: selected.policy, fixture: true });
}

async function setupDelivery({ linkOrigin = 'https://docs.example.com' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-feishu-v4-'));
  const report = await fixtureReport();
  await writeReport(dir, report);
  const appId = appIdFixture(), appCredential = appCredentialFixture(), folder = folderFixture();
  const config = await loadConfig({ env: {
    DESIGNSIGNAL_DATA_DIR: dir,
    FEISHU_APP_ID: appId,
    FEISHU_APP_SECRET: appCredential,
    FEISHU_DOC_FOLDER_TOKEN: folder,
    FEISHU_TENANT_BASE_URL: linkOrigin
  } });
  const [job] = await queueDeliveries(dir, report, config);
  return { dir, report, config, job, appId, appCredential, folder, file: path.join(dir, 'outbox', `${job.id}.json`) };
}

async function overwriteJob(setup, changes) {
  const stored = JSON.parse(await readFile(setup.file, 'utf8'));
  Object.assign(stored, changes);
  await atomicWrite(setup.file, `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
}

test('schema v4 strictly derives named groups, official totals, references and review order', async () => {
  const report = await fixtureReport();
  assert.equal(report.schemaVersion, 4);
  assert.deepEqual(report.briefing.sections.map(x => [x.id, x.itemIds.length]), [
    ['academic-evidence', 2], ['design-reference', 2], ['frontier-radar', 2]
  ]);
  assert.deepEqual(report.briefing.coverage['337'].parts.map(x => x.points), [75, 75]);
  assert.deepEqual(report.briefing.coverage['902'].parts.map(x => x.points), [50, 50, 50]);
  assert.deepEqual(report.briefing.reviewRoute.map(x => x.order), [1, 2, 3, 4, 5, 6]);
  for (const mutate of [
    value => { value.briefing.sections[0].id = 'changed'; },
    value => { value.briefing.sections[0].itemIds.reverse(); },
    value => { value.briefing.coverage['337'].parts[0].points = 74; },
    value => { value.briefing.coverage['902'].parts[0].topicRefs[0].itemIds[0] = 'invented'; },
    value => { value.briefing.reviewRoute[1].order = 1; }
  ]) {
    const tampered = structuredClone(report);
    mutate(tampered);
    assert.throws(() => validateReport(tampered), /briefing/);
  }
});

test('Markdown, HTML and Feishu keep thesis patterns, group maps and item analysis in parity', async () => {
  const report = await fixtureReport();
  const view = briefingView(report), markdown = renderMarkdown(report), html = renderHtml(report), feishu = JSON.stringify(renderFeishuBlocks(report));
  const firstPattern = view.patterns[0].pattern.zh;
  const labels = ['核心论点与证据边界', firstPattern, '今日地图', '学术证据', '设计参考', '前沿雷达', '官方考纲覆盖', '学习假设', '练习', '下一步复习'];
  for (const output of [markdown, html, feishu]) {
    let cursor = -1;
    for (const label of labels) {
      const next = output.indexOf(label, cursor + 1);
      assert.ok(next > cursor, `${label} is missing or out of order`);
      cursor = next;
    }
    for (const section of view.sections) {
      assert.ok(output.includes(`(${section.items.length})`));
      for (const item of section.items) assert.ok(output.includes(item.title.zh));
    }
  }
  const analyses = [...html.matchAll(/<details class="analysis">([\s\S]*?)<\/details>/g)].map(match => match[1]);
  assert.equal(analyses.length, 6);
  for (const body of analyses) for (const label of ['证据 / Evidence', '方法 / Method', '新意 / Novelty', '局限 / Limits', '学习价值 / Why learn', '学习行动 / Study action']) assert.ok(body.includes(label));
  assert.equal((html.match(/<details class="provenance">/g) || []).length, 6);
  assert.equal((html.match(/data-filter=/g) || []).length, 5);
  assert.match(html, /<form method="post" action="\/api\/feedback">/);
  assert.ok(renderFeishuBlocks(report).every(block => Number.isInteger(block.block_type)));
});

test('more than 100 Feishu blocks are written as exact ordered chunks of at most 50', async () => {
  const setup = await setupDelivery();
  const accessValue = accessFixture(), documentId = documentFixture('0001');
  try {
    const blocks = renderFeishuBlocks(setup.report);
    assert.ok(blocks.length > 100);
    const observed = [];
    let writeNumber = 0;
    const fetchImpl = async (url, init) => {
      const target = new URL(url), disk = JSON.parse(await readFile(setup.file, 'utf8'));
      observed.push({ target, state: disk.state, disk, body: JSON.parse(init.body), authorization: init.headers.authorization });
      if (target.pathname.includes('/auth/')) return tokenResponse(accessValue);
      if (target.pathname.endsWith('/documents')) return okJson({ code: 0, data: { document: { document_id: documentId, revision_id: 7 } } });
      writeNumber++;
      return okJson({ code: 0, data: { document_revision_id: 7 + writeNumber } });
    };
    const [delivered] = await retryOutbox(setup.dir, setup.config, { dnsLookup, fetchImpl });
    const writes = observed.slice(2);
    assert.equal(observed.length, 2 + Math.ceil(blocks.length / 50));
    assert.deepEqual(observed.map(x => x.target.origin), Array(observed.length).fill('https://open.feishu.cn'));
    assert.deepEqual(observed.map(x => x.state), ['pending', 'creating', ...Array(writes.length).fill('writing')]);
    assert.equal(observed[0].authorization, undefined);
    assert.equal(observed[1].authorization, authFixture(accessValue));
    assert.equal(observed[1].body.folder_token, setup.folder);
    const sent = [];
    for (const [index, entry] of writes.entries()) {
      const expectedCursor = index * 50;
      const expectedRevision = 7 + index;
      assert.equal(entry.target.pathname, `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`);
      assert.equal(entry.target.searchParams.get('document_revision_id'), String(expectedRevision));
      assert.equal(entry.target.searchParams.get('client_token'), entry.disk.clientToken);
      assert.equal(entry.authorization, authFixture(accessValue));
      assert.equal(entry.body.index, expectedCursor);
      assert.equal(entry.disk.chunkCursor, expectedCursor);
      assert.equal(entry.disk.chunkRevisionId, expectedRevision);
      assert.equal(entry.disk.chunkSize, entry.body.children.length);
      assert.ok(entry.body.children.length >= 1 && entry.body.children.length <= 50);
      sent.push(...entry.body.children);
    }
    assert.deepEqual(sent, blocks);
    assert.equal(delivered.state, 'delivered');
    assert.equal(delivered.nextBlockIndex, blocks.length);
    assert.equal(delivered.revisionId, 7 + writes.length);
    assert.equal(delivered.documentUrl, `https://docs.example.com/docx/${documentId}`);
    const stored = await readFile(setup.file, 'utf8');
    for (const value of [setup.appId, setup.appCredential, setup.folder, accessValue, authFixture(accessValue), API_HOST_FIXTURE, 'folder_token', 'children']) assert.ok(!stored.includes(value));
  } finally { await rm(setup.dir, { recursive: true, force: true }); }
});

const API_HOST_FIXTURE = fragments('open', '.', 'feishu', '.', 'cn');

test('a created job resumes only unconfirmed chunks at its persisted cursor', async () => {
  const setup = await setupDelivery();
  const accessValue = accessFixture(), documentId = documentFixture('0002');
  try {
    const blocks = renderFeishuBlocks(setup.report);
    await overwriteJob(setup, { state: 'created', reason: 'ready-to-write', documentId, revisionId: 12, nextBlockIndex: 50 });
    const writes = [];
    let revision = 12;
    await retryOutbox(setup.dir, setup.config, { dnsLookup, fetchImpl: async (url, init) => {
      const target = new URL(url);
      if (target.pathname.includes('/auth/')) return tokenResponse(accessValue);
      writes.push({ target, body: JSON.parse(init.body) });
      revision++;
      return okJson({ code: 0, data: { document_revision_id: revision } });
    } });
    assert.equal(writes[0].body.index, 50);
    assert.deepEqual(writes.flatMap(x => x.body.children), blocks.slice(50));
    assert.ok(writes.every(x => x.target.pathname.endsWith(`/${documentId}/children`)));
    assert.deepEqual(writes.map(x => x.body.index), Array.from({ length: writes.length }, (_, index) => 50 + index * 50));
    const stored = JSON.parse(await readFile(setup.file, 'utf8'));
    assert.equal(stored.state, 'delivered');
    assert.equal(stored.nextBlockIndex, blocks.length);
  } finally { await rm(setup.dir, { recursive: true, force: true }); }
});

test('tenant-token timeout and 5xx back off without create or reconciliation', async () => {
  for (const failure of ['timeout', 'server']) {
    const setup = await setupDelivery();
    try {
      let calls = 0;
      const [job] = await retryOutbox(setup.dir, setup.config, { dnsLookup, fetchImpl: async url => {
        calls++;
        assert.match(new URL(url).pathname, /tenant_access_token/);
        if (failure === 'timeout') throw new Error('fixture transport interruption');
        return new Response('', { status: 503 });
      } });
      assert.equal(calls, 1);
      assert.equal(job.state, 'pending');
      assert.equal(job.reason, 'definite-failure');
      assert.equal(job.attempts, 1);
      assert.equal(job.nextBlockIndex, 0);
      assert.equal(job.documentId, undefined);
    } finally { await rm(setup.dir, { recursive: true, force: true }); }
  }
});

test('ambiguous create and write failures require reconciliation and are never retried', async () => {
  for (const phase of ['create', 'write']) {
    const setup = await setupDelivery();
    const accessValue = accessFixture(), documentId = documentFixture('0003');
    try {
      let calls = 0;
      const fetchImpl = async url => {
        calls++;
        const target = new URL(url);
        if (target.pathname.includes('/auth/')) return tokenResponse(accessValue);
        if (phase === 'write' && target.pathname.endsWith('/documents')) return okJson({ code: 0, data: { document: { document_id: documentId, revision_id: 2 } } });
        return new Response('', { status: 503 });
      };
      let [job] = await retryOutbox(setup.dir, setup.config, { dnsLookup, fetchImpl });
      const expectedCalls = phase === 'create' ? 2 : 3;
      assert.equal(job.state, 'reconciliation-required');
      assert.equal(calls, expectedCalls);
      if (phase === 'write') {
        assert.equal(job.nextBlockIndex, 0);
        assert.equal(job.chunkCursor, 0);
        assert.equal(job.chunkSize, 50);
        assert.match(job.clientToken, /^[a-f0-9]{32}$/);
      }
      [job] = await retryOutbox(setup.dir, setup.config, { dnsLookup, fetchImpl });
      assert.equal(job.state, 'reconciliation-required');
      assert.equal(calls, expectedCalls);
      assert.ok(!('documentUrl' in exposeDeliveryJob(job, setup.config)));
      const stored = await readFile(setup.file, 'utf8');
      for (const value of [setup.appId, setup.appCredential, setup.folder, accessValue, authFixture(accessValue)]) assert.ok(!stored.includes(value));
    } finally { await rm(setup.dir, { recursive: true, force: true }); }
  }
});

test('interrupted chunks reconcile and malformed progress is rejected before network access', async () => {
  const interrupted = await setupDelivery();
  const documentId = documentFixture('0004');
  try {
    const stored = await overwriteJob(interrupted, { state: 'writing', reason: '', documentId, revisionId: 5, nextBlockIndex: 0, chunkCursor: 0, chunkSize: 50, chunkRevisionId: 5 });
    stored.clientToken = sha256(`${stored.id}:${documentId}:0:50:5:${stored.renderFingerprint}`).slice(0, 32);
    await atomicWrite(interrupted.file, `${JSON.stringify(stored, null, 2)}\n`);
    let calls = 0;
    const [job] = await retryOutbox(interrupted.dir, interrupted.config, { dnsLookup, fetchImpl: async () => { calls++; throw new Error('network must remain unused'); } });
    assert.equal(job.state, 'reconciliation-required');
    assert.equal(job.reason, 'interrupted-write');
    assert.equal(calls, 0);
  } finally { await rm(interrupted.dir, { recursive: true, force: true }); }

  const invalid = await setupDelivery();
  try {
    await overwriteJob(invalid, { nextBlockIndex: invalid.job.totalBlocks + 1 });
    let calls = 0;
    await assert.rejects(() => retryOutbox(invalid.dir, invalid.config, { dnsLookup, fetchImpl: async () => { calls++; } }), /invalid Feishu document job progress/);
    assert.equal(calls, 0);
  } finally { await rm(invalid.dir, { recursive: true, force: true }); }
});

test('invalid calendar report dates are rejected before Feishu network access', async () => {
  const fixture = await setupDelivery();
  try {
    await overwriteJob(fixture, { reportDate: '2026-02-30' });
    await assert.rejects(() => retryOutbox(fixture.dir, fixture.config, { fetchImpl: async () => assert.fail('network must not be reached') }), /invalid Feishu document report identity/);
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
