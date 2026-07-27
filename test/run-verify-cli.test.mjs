import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunInput, openExecutionSession } from '../src/lib/runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cleanEnv = () => ({
  ...process.env,
  CODEX_CONFIG_FILE: '',
  CODEX_HOME: '',
  DESIGNSIGNAL_DATA_DIR: '',
  OPENAI_BASE_URL: '',
  OPENAI_MODEL: '',
  OPENAI_API_KEY: '',
  DESIGNSIGNAL_WEBHOOK_URL: '',
  FEISHU_WEBHOOK_URL: '',
  WECOM_WEBHOOK_URL: '',
  FEISHU_APP_ID: '',
  FEISHU_APP_SECRET: '',
  FEISHU_DOC_FOLDER_TOKEN: ''
});
const minimalConfig = dataDir => ({
  dataDir,
  timezone: 'Asia/Shanghai',
  sources: [],
  selection: {},
  network: {},
  model: {},
  study: {},
  push: {},
  feishuDocument: {}
});
const exists = file => stat(file).then(() => true, () => false);

async function runCli(args, { env = cleanEnv() } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['src/cli.mjs', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function writeConfig(parent, dataDir) {
  const configPath = path.join(parent, 'config.json');
  await writeFile(configPath, `${JSON.stringify({ dataDir })}\n`);
  return configPath;
}

async function completeRun(dataDir, date = '2026-07-22') {
  const session = await openExecutionSession(dataDir, createRunInput(minimalConfig(dataDir), date));
  await session.execute('evidence', async () => ({ stage: 'evidence', values: [1] }));
  await session.execute('constraints', async ({ inputs }) => ({ stage: 'constraints', evidence: inputs.evidence.values.length }));
  await session.execute('decision', async ({ inputs }) => ({ stage: 'decision', constraints: inputs.constraints.evidence }));
  await session.execute('execution', async ({ inputs }) => ({ stage: 'execution', decision: inputs.decision.constraints }));
  await session.execute('acceptance', async ({ inputs }) => ({ stage: 'acceptance', sources: Object.keys(inputs).sort() }));
  await session.execute('integration', async ({ inputs }) => ({ stage: 'integration', accepted: inputs.acceptance.sources.length }));
  return session.summary();
}

async function snapshotFiles(dir) {
  const entries = new Map();
  async function visit(current, relative = '') {
    const names = await readdir(current, { withFileTypes: true });
    for (const name of names) {
      const file = path.join(current, name.name);
      const rel = path.join(relative, name.name);
      if (name.isDirectory()) await visit(file, rel);
      else entries.set(rel, await readFile(file));
    }
  }
  await visit(dir);
  return entries;
}

function assertSnapshotsEqual(before, after) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, bytes] of before) assert.deepEqual(after.get(file), bytes, file);
}

test('run verify succeeds with a read-only machine-readable summary', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ds-run-verify-ok-'));
  try {
    const dataDir = path.join(parent, 'data');
    const configPath = await writeConfig(parent, dataDir);
    await completeRun(dataDir);
    const runRoot = path.join(dataDir, 'runs', '2026-07-22');
    const before = await snapshotFiles(runRoot);

    const result = await runCli(['run', 'verify', '--date', '2026-07-22', '--json', '--config', configPath]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.schema_version, 'designsignal.run_verify_result.v1');
    assert.equal(summary.ok, true);
    assert.equal(summary.stage_count, 6);
    assert.equal(summary.completed_stage_count, 6);
    assert.equal(summary.verified_bindings, 6);
    assert.equal(summary.verified_assets, 6);
    assert.equal(summary.stages.length, 6);
    assert.doesNotMatch(result.stdout, /"payload"|"input_parameters"/);
    assertSnapshotsEqual(before, await snapshotFiles(runRoot));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('run verify requires an explicit date and does not create state', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ds-run-verify-date-'));
  try {
    const dataDir = path.join(parent, 'absent');
    const configPath = await writeConfig(parent, dataDir);
    const result = await runCli(['run', 'verify', '--json', '--config', configPath]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /run verify --date YYYY-MM-DD/);
    assert.equal(await exists(dataDir), false);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('run verify fails closed for a missing run', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ds-run-verify-missing-'));
  try {
    const dataDir = path.join(parent, 'data');
    const configPath = await writeConfig(parent, dataDir);
    const result = await runCli(['run', 'verify', '--date', '2026-07-22', '--json', '--config', configPath]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /execution run not found for 2026-07-22/);
    assert.equal(await exists(dataDir), false);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('run verify rejects tampered assets without repair or mutation', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ds-run-verify-tamper-'));
  try {
    const dataDir = path.join(parent, 'data');
    const configPath = await writeConfig(parent, dataDir);
    const run = await completeRun(dataDir);
    const version = run.stages[0].output_bindings[0].version_id;
    const assetPath = path.join(dataDir, 'runs', '2026-07-22', 'assets', `${version}.json`);
    const asset = JSON.parse(await readFile(assetPath, 'utf8'));
    asset.payload.stage = 'tampered';
    await writeFile(assetPath, `${JSON.stringify(asset, null, 2)}\n`);
    const before = await snapshotFiles(path.join(dataDir, 'runs', '2026-07-22'));

    const result = await runCli(['run', 'verify', '--date', '2026-07-22', '--json', '--config', configPath]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /integrity|invalid|mismatch/);
    assertSnapshotsEqual(before, await snapshotFiles(path.join(dataDir, 'runs', '2026-07-22')));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('run verify rejects rebound output bindings without mutation', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ds-run-verify-rebound-'));
  try {
    const dataDir = path.join(parent, 'data');
    const configPath = await writeConfig(parent, dataDir);
    await completeRun(dataDir);
    const runPath = path.join(dataDir, 'runs', '2026-07-22', 'run.json');
    const run = JSON.parse(await readFile(runPath, 'utf8'));
    run.stages[1].output_bindings[0].asset_id = 'asset_constraints_rebound';
    await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
    const before = await snapshotFiles(path.join(dataDir, 'runs', '2026-07-22'));

    const result = await runCli(['run', 'verify', '--date', '2026-07-22', '--json', '--config', configPath]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /mismatched output binding|mismatch|invalid/);
    assertSnapshotsEqual(before, await snapshotFiles(path.join(dataDir, 'runs', '2026-07-22')));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('run show and run restart CLI behavior remain available', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ds-run-verify-compat-'));
  try {
    const dataDir = path.join(parent, 'data');
    const configPath = await writeConfig(parent, dataDir);
    const session = await openExecutionSession(dataDir, createRunInput(minimalConfig(dataDir), '2026-07-22'));
    await session.execute('evidence', async () => ({ stage: 'evidence' }));

    const shown = await runCli(['run', 'show', '--date', '2026-07-22', '--json', '--config', configPath]);
    assert.equal(shown.code, 0);
    assert.equal(JSON.parse(shown.stdout).stages[0].state, 'completed');

    const restarted = await runCli(['run', 'restart', '--date', '2026-07-22', '--reason', 'cli compat', '--json', '--config', configPath]);
    assert.equal(restarted.code, 0);
    assert.equal(JSON.parse(restarted.stdout).state, 'superseded');
    assert.equal(await exists(path.join(dataDir, 'runs', '2026-07-22', 'revisions', 'run.1.json')), true);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
