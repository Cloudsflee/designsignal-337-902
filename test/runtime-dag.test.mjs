import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { daily } from '../src/lib/daily.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { buildReport } from '../src/lib/report.mjs';
import {
  CONTRACT_SCHEMA_VERSION,
  EXECUTION_CONTEXT_SCHEMA,
  PIPELINE_STAGES,
  TaskContextNotReadyError,
  createRunInput,
  openExecutionSession,
  readExecutionRun,
  supersedeExecutionRun
} from '../src/lib/runtime.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { handleDashboardRequest } from '../src/lib/server.mjs';
import { writeReport } from '../src/lib/storage.mjs';

const minimalConfig = overrides => ({
  timezone: 'Asia/Shanghai', sources: [], selection: {}, network: {}, model: {}, study: {}, push: {}, feishuDocument: {}, ...overrides
});

const invoke = async (config, url) => {
  const result = { headers: {}, status: 0, body: '' };
  const req = { method: 'GET', url, async *[Symbol.asyncIterator]() {} };
  const res = {
    setHeader(key, value) { result.headers[key] = value; },
    writeHead(status, headers = {}) { result.status = status; Object.assign(result.headers, headers); },
    end(value = '') { result.body += value; }
  };
  await handleDashboardRequest(config, req, res);
  return result;
};

async function fixtureReport(date = '2026-07-22') {
  const selection = selectDaily(fixtureCandidates, { date, history: [] });
  return buildReport({ date, items: selection.selected, rejected: selection.rejected, health: [], selectionPolicy: selection.policy, fixture: true });
}

test('six-stage runtime persists contract v2, direct lineage, and immutable output versions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-runtime-contract-'));
  try {
    const input = createRunInput(minimalConfig(), '2026-07-22');
    const session = await openExecutionSession(dir, input);
    for (const stage of PIPELINE_STAGES) {
      await session.execute(stage.id, ({ inputs, context }) => ({ stage: stage.id, dependencies: Object.keys(inputs), snapshot: context.input_snapshot_hash }));
    }

    const run = await readExecutionRun(dir, '2026-07-22');
    assert.equal(run.state, 'completed');
    assert.equal(run.execution_context_schema, EXECUTION_CONTEXT_SCHEMA);
    assert.deepEqual(run.stages.map(stage => stage.state), Array(6).fill('completed'));
    assert.ok(run.stages.every(stage => stage.contract.contract_schema_version === CONTRACT_SCHEMA_VERSION));
    assert.deepEqual(run.stages.map(stage => stage.output_bindings[0].derived_from.length), [0, 1, 1, 1, 4, 1]);
    assert.ok(run.stages.every(stage => stage.output_bindings[0].confirmation.state === 'confirmed'));

    const assets = await readdir(path.join(dir, 'runs', '2026-07-22', 'assets'));
    assert.equal(assets.length, 6);
    assert.ok(assets.every(name => /^av_[a-f0-9]{64}\.json$/.test(name)));
    assert.doesNotMatch(JSON.stringify(run), /"payload"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('completed stages resume without replay and failed stages retry in place', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-runtime-resume-'));
  try {
    const input = createRunInput(minimalConfig(), '2026-07-22');
    let session = await openExecutionSession(dir, input), evidenceCalls = 0;
    await session.execute('evidence', async () => { evidenceCalls++; return { candidates: [1] }; });

    session = await openExecutionSession(dir, input);
    assert.deepEqual(await session.execute('evidence', async () => { evidenceCalls++; throw new Error('must not replay'); }), { candidates: [1] });
    assert.equal(evidenceCalls, 1);
    await assert.rejects(() => session.execute('constraints', async () => { throw new Error('bounded failure'); }), /bounded failure/);
    assert.equal(session.summary().stages[1].attempts, 1);
    assert.equal(session.summary().stages[1].state, 'failed');

    session = await openExecutionSession(dir, input);
    await session.execute('constraints', async ({ inputs }) => ({ candidateCount: inputs.evidence.candidates.length }));
    assert.equal(session.summary().stages[1].attempts, 2);
    assert.equal(session.summary().stages[1].state, 'completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an explicit restart archives an incomplete run and increments its revision', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-runtime-revision-'));
  try {
    const firstInput = createRunInput(minimalConfig({ model: { model: 'model-a' } }), '2026-07-22');
    const first = await openExecutionSession(dir, firstInput);
    await first.execute('evidence', async () => ({ evidence: true }));
    const archived = await supersedeExecutionRun(dir, '2026-07-22', { reason: 'approved config update' });
    assert.equal(archived.state, 'superseded');
    assert.equal(archived.revision, 1);

    const secondInput = createRunInput(minimalConfig({ model: { model: 'model-b' } }), '2026-07-22');
    const second = await openExecutionSession(dir, secondInput);
    assert.equal(second.summary().revision, 2);
    assert.match(second.summary().run_id, /_r2_/);
    const revision = JSON.parse(await readFile(path.join(dir, 'runs', '2026-07-22', 'revisions', 'run.1.json'), 'utf8'));
    assert.equal(revision.superseded_reason, 'approved config update');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('changed run parameters and tampered upstream versions hard-block downstream execution', async () => {
  const staleDir = await mkdtemp(path.join(os.tmpdir(), 'ds-runtime-stale-'));
  try {
    const input = createRunInput(minimalConfig({ model: { model: 'model-a' } }), '2026-07-22');
    const session = await openExecutionSession(staleDir, input);
    await session.execute('evidence', async () => ({ evidence: true }));
    const changed = createRunInput(minimalConfig({ model: { model: 'model-b' } }), '2026-07-22');
    await assert.rejects(() => openExecutionSession(staleDir, changed), error => error instanceof TaskContextNotReadyError && error.code === 'task_context_not_ready');
    assert.equal((await readExecutionRun(staleDir, '2026-07-22')).state, 'input_superseded');
  } finally { await rm(staleDir, { recursive: true, force: true }); }

  const tamperDir = await mkdtemp(path.join(os.tmpdir(), 'ds-runtime-tamper-'));
  try {
    const input = createRunInput(minimalConfig(), '2026-07-22');
    const session = await openExecutionSession(tamperDir, input);
    await session.execute('evidence', async () => ({ evidence: true }));
    const version = session.summary().stages[0].output_bindings[0].version_id;
    const file = path.join(tamperDir, 'runs', '2026-07-22', 'assets', `${version}.json`);
    await assert.rejects(() => session.execute('constraints', async () => {
      const envelope = JSON.parse(await readFile(file, 'utf8'));
      envelope.payload.evidence = false;
      await writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`);
      return { selected: true };
    }), error => error instanceof TaskContextNotReadyError && /superseded|integrity|invalid/.test(error.message));
    const raw = JSON.parse(await readFile(path.join(tamperDir, 'runs', '2026-07-22', 'run.json'), 'utf8'));
    assert.equal(raw.stages[1].state, 'input_superseded');
  } finally { await rm(tamperDir, { recursive: true, force: true }); }
});

test('a report-write crash window completes only integration and exposes the DAG through HTTP', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-runtime-recover-'));
  try {
    const config = await loadConfig({ env: { DESIGNSIGNAL_DATA_DIR: dir } });
    const date = '2026-07-22', report = await fixtureReport(date);
    const input = createRunInput(config, date, { mode: 'live' });
    const session = await openExecutionSession(dir, input);
    await session.execute('evidence', async () => ({ captured: true }));
    await session.execute('constraints', async () => ({ selected: true }));
    await session.execute('decision', async () => ({ frozen: true }));
    await session.execute('execution', async () => ({ analyzed: true }));
    await session.execute('acceptance', async () => report);
    await writeReport(dir, report);

    const recovered = await daily(config, { date, ctx: { fetchImpl: async () => { throw new Error('recovery must not collect or call the model'); } } });
    assert.equal(recovered.status, 'exists');
    assert.equal(recovered.execution.state, 'completed');
    assert.equal(recovered.execution.stages.at(-1).state, 'completed');

    const api = await invoke(config, '/api/run');
    assert.equal(api.status, 200);
    const exposed = JSON.parse(api.body);
    assert.equal(exposed.stages.length, 6);
    assert.doesNotMatch(api.body, /"payload"/);
    assert.equal((await invoke(config, '/api/runs/2026-02-30')).status, 400);

    const html = await invoke(config, '/');
    assert.equal(html.status, 200);
    assert.match(html.body, /id="run-pipeline" data-toc-target/);
    assert.match(html.body, /调研取证/);
    assert.match(html.body, /Output version/);

    await openExecutionSession(dir, createRunInput(config, '2026-07-23', { mode: 'live' }));
    const active = await invoke(config, '/');
    assert.match(active.body, /2026-07-23 · pending · snapshot/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
