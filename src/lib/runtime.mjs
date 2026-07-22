import path from 'node:path';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { atomicWrite, isIsoDate, redact, sha256, withLock } from './util.mjs';

export const EXECUTION_CONTEXT_SCHEMA = 'aiws.task_execution_context.v2';
export const CONTRACT_SCHEMA_VERSION = 2;
export const RUN_SCHEMA_VERSION = 1;

export const PIPELINE_STAGES = Object.freeze([
  {
    id: 'evidence', title: 'Evidence collection', depends_on: [],
    output: { key: 'evidence_bundle', asset_type: 'designsignal.evidence_bundle.v1', acceptance_criteria: ['candidate provenance is retained', 'source health and immutable external inputs are captured'] }
  },
  {
    id: 'constraints', title: 'Constraint analysis', depends_on: ['evidence'],
    output: { key: 'constraint_result', asset_type: 'designsignal.constraint_result.v1', acceptance_criteria: ['quota, language, source diversity, recency, and dedupe policies pass', 'every rejection is auditable'] }
  },
  {
    id: 'decision', title: 'Selection decision', depends_on: ['constraints'],
    output: { key: 'selection_decision', asset_type: 'designsignal.selection_decision.v1', acceptance_criteria: ['exactly six selected candidates are frozen', 'cache outcomes are recorded without hiding failures'] }
  },
  {
    id: 'execution', title: 'Analysis execution', depends_on: ['decision'],
    output: { key: 'enriched_items', asset_type: 'designsignal.enriched_items.v1', acceptance_criteria: ['all six bilingual items pass the item schema', 'citations remain restricted to supplied sources'] }
  },
  {
    id: 'acceptance', title: 'Synthesis acceptance', depends_on: ['evidence', 'constraints', 'decision', 'execution'],
    output: { key: 'accepted_report', asset_type: 'designsignal.accepted_report.v1', acceptance_criteria: ['the report passes schema v4 validation', 'hypotheses, counterevidence, exercise, and official coverage are complete'] }
  },
  {
    id: 'integration', title: 'Publication integration', depends_on: ['acceptance'],
    output: { key: 'integration_receipt', asset_type: 'designsignal.integration_receipt.v1', acceptance_criteria: ['immutable report files and manifest agree', 'delivery identities are queued before retry'] }
  }
]);

const STAGE_BY_ID = new Map(PIPELINE_STAGES.map(stage => [stage.id, stage]));
const HASH = /^[a-f0-9]{64}$/;
const VERSION_ID = /^av_[a-f0-9]{64}$/;
const STAGE_STATES = new Set(['pending', 'blocked', 'running', 'completed', 'failed', 'input_superseded']);
const RUN_STATES = new Set(['pending', 'running', 'completed', 'completed_input_superseded', 'failed', 'input_superseded']);
const MAX_RUN_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

const jsonValue = value => JSON.parse(JSON.stringify(value));

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
  return value;
}

export const canonicalJson = value => JSON.stringify(sortValue(jsonValue(value)));
const contentHash = value => sha256(canonicalJson(value));
const nowIso = now => new Date(now()).toISOString();
const runDir = (dataDir, date) => path.join(dataDir, 'runs', date);
const runFile = (dataDir, date) => path.join(runDir(dataDir, date), 'run.json');
const assetFile = (dataDir, date, versionId) => path.join(runDir(dataDir, date), 'assets', `${versionId}.json`);

function publicSource(source) {
  if (!source || typeof source !== 'object') return source;
  return redact(Object.fromEntries(Object.entries(source).filter(([key]) => !/(api[-_]?key|authorization|credential|secret|token)/i.test(key))));
}

export function createRunInput(config, date, { mode = 'live' } = {}) {
  if (!isIsoDate(date)) throw new Error('invalid run date');
  const parameters = jsonValue(redact({
    pipeline_version: 1,
    date,
    mode,
    timezone: config.timezone || 'Asia/Shanghai',
    sources: (config.sources || []).map(publicSource),
    selection: config.selection || {},
    network: config.network || {},
    model: {
      provider: config.model?.provider || '',
      model: config.model?.model || '',
      wire_api: config.model?.wireApi || 'responses',
      concurrency: config.model?.concurrency ?? 2,
      timeout_ms: config.model?.timeoutMs ?? 180000,
      max_output_tokens: config.model?.maxOutputTokens ?? 6000
    },
    study: Object.fromEntries(Object.entries(config.study || {}).filter(([key]) => key !== 'profileFile')),
    delivery: {
      generic: Boolean(config.push?.generic),
      feishu: Boolean(config.push?.feishu),
      wecom: Boolean(config.push?.wecom),
      feishu_document: Boolean(config.feishuDocument?.appId && config.feishuDocument?.appSecret && config.feishuDocument?.folderToken)
    }
  }));
  return {
    schema: EXECUTION_CONTEXT_SCHEMA,
    date,
    mode,
    immutable: true,
    repository_snapshot_hash: null,
    parameters,
    input_snapshot_hash: contentHash({ schema: EXECUTION_CONTEXT_SCHEMA, parameters })
  };
}

function stageRecord(definition) {
  return {
    id: definition.id,
    title: definition.title,
    order: PIPELINE_STAGES.indexOf(definition) + 1,
    depends_on: [...definition.depends_on],
    state: definition.depends_on.length ? 'blocked' : 'pending',
    blocked_by: [...definition.depends_on],
    attempts: 0,
    input_snapshot_hash: null,
    input_superseded: false,
    execution_context: null,
    contract: {
      contract_schema_version: CONTRACT_SCHEMA_VERSION,
      inputs: [],
      outputs: [{
        key: definition.output.key,
        kind: 'asset',
        required: true,
        asset_type: definition.output.asset_type,
        acceptance_criteria: [...definition.output.acceptance_criteria],
        confirmation_policy: 'system'
      }]
    },
    output_bindings: [],
    failure: null,
    started_at: null,
    completed_at: null
  };
}

function createRun(date, input, now, revision = 1) {
  const timestamp = nowIso(now);
  return {
    schema_version: RUN_SCHEMA_VERSION,
    execution_context_schema: EXECUTION_CONTEXT_SCHEMA,
    run_id: `run_${date.replaceAll('-', '')}_r${revision}_${input.input_snapshot_hash.slice(0, 12)}`,
    date,
    revision,
    mode: input.mode,
    state: 'pending',
    immutable_input: true,
    input_snapshot_hash: input.input_snapshot_hash,
    repository_snapshot_hash: null,
    input_parameters: input.parameters,
    input_superseded: false,
    superseded_at: null,
    superseded_by_hash: null,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
    stages: PIPELINE_STAGES.map(stageRecord)
  };
}

function assertRun(record, expectedDate) {
  if (!record || record.schema_version !== RUN_SCHEMA_VERSION || record.execution_context_schema !== EXECUTION_CONTEXT_SCHEMA) throw new Error('unsupported execution run schema');
  if (!isIsoDate(record.date) || (expectedDate && record.date !== expectedDate)) throw new Error('execution run date mismatch');
  if (!/^run_\d{8}_r\d+_[a-f0-9]{12}$/.test(record.run_id || '') || !RUN_STATES.has(record.state) || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('invalid execution run identity');
  if (!HASH.test(record.input_snapshot_hash || '') || !Array.isArray(record.stages) || record.stages.length !== PIPELINE_STAGES.length) throw new Error('invalid execution run');
  for (const [index, definition] of PIPELINE_STAGES.entries()) {
    const stage = record.stages[index];
    if (stage?.id !== definition.id || stage.order !== index + 1 || !STAGE_STATES.has(stage.state) || JSON.stringify(stage.depends_on) !== JSON.stringify(definition.depends_on)) throw new Error(`invalid execution stage ${definition.id}`);
    if (stage.contract?.contract_schema_version !== CONTRACT_SCHEMA_VERSION || !Array.isArray(stage.contract.inputs) || !Array.isArray(stage.contract.outputs) || !Array.isArray(stage.output_bindings)) throw new Error(`invalid execution contract ${definition.id}`);
    if (stage.input_snapshot_hash !== null && !HASH.test(stage.input_snapshot_hash || '')) throw new Error(`invalid input snapshot ${definition.id}`);
    if (stage.contract.outputs.length !== 1 || stage.contract.outputs[0].key !== definition.output.key || stage.contract.outputs[0].asset_type !== definition.output.asset_type) throw new Error(`invalid output contract ${definition.id}`);
    if (stage.state === 'completed' && stage.output_bindings.length !== 1) throw new Error(`completed stage ${definition.id} requires one output binding`);
    for (const binding of stage.output_bindings) {
      if (binding.key !== definition.output.key || binding.asset_type !== definition.output.asset_type || binding.asset_id !== `asset_${definition.id}_${definition.output.key}`) throw new Error(`mismatched output binding ${definition.id}`);
      if (!VERSION_ID.test(binding.version_id || '') || !HASH.test(binding.sha256 || '') || !Array.isArray(binding.derived_from) || binding.derived_from.some(version => !VERSION_ID.test(version))) throw new Error(`invalid output binding ${definition.id}`);
      if (binding.confirmation?.policy !== 'system' || binding.confirmation?.state !== 'confirmed') throw new Error(`unconfirmed output binding ${definition.id}`);
    }
  }
  return record;
}

async function readRunFile(dataDir, date) {
  if (!isIsoDate(date)) throw new Error('invalid run date');
  try {
    const file = runFile(dataDir, date), metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RUN_BYTES) throw new Error('invalid execution run file');
    return assertRun(JSON.parse(await readFile(file, 'utf8')), date);
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function nextRevision(dataDir, date) {
  let files = [];
  try { files = await readdir(path.join(runDir(dataDir, date), 'revisions')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const revisions = files.map(name => /^run\.(\d+)\.json$/.exec(name)?.[1]).filter(Boolean).map(Number);
  return Math.max(0, ...revisions) + 1;
}

async function saveRun(dataDir, record, now) {
  record.updated_at = nowIso(now);
  await atomicWrite(runFile(dataDir, record.date), `${JSON.stringify(record, null, 2)}\n`);
}

function assetMaterial({ assetType, assetId, producerStage, inputSnapshotHash, derivedFrom, payload }) {
  return {
    asset_schema_version: 1,
    asset_id: assetId,
    asset_type: assetType,
    producer_stage: producerStage,
    input_snapshot_hash: inputSnapshotHash,
    derived_from: [...derivedFrom],
    payload: jsonValue(payload)
  };
}

const materialFromEnvelope = envelope => ({
  asset_schema_version: envelope.asset_schema_version,
  asset_id: envelope.asset_id,
  asset_type: envelope.asset_type,
  producer_stage: envelope.producer_stage,
  input_snapshot_hash: envelope.input_snapshot_hash,
  derived_from: envelope.derived_from,
  payload: envelope.payload
});

async function writeAsset(dataDir, date, input, now) {
  const material = assetMaterial(input);
  const hash = contentHash(material);
  const versionId = `av_${hash}`;
  const envelope = { ...material, version_id: versionId, sha256: hash, created_at: nowIso(now) };
  const file = assetFile(dataDir, date, versionId);
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_ASSET_BYTES) throw new Error('execution asset exceeds size limit');
  try { await atomicWrite(file, serialized, { overwrite: false }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readAsset(dataDir, date, versionId);
    if (existing.version_id !== versionId || existing.sha256 !== hash || contentHash(materialFromEnvelope(existing)) !== hash) throw new Error(`conflicting immutable asset version ${versionId}`);
    return existing;
  }
  return envelope;
}

async function readAsset(dataDir, date, versionId) {
  if (!VERSION_ID.test(versionId || '')) throw new Error('invalid asset version');
  const file = assetFile(dataDir, date, versionId), metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ASSET_BYTES) throw new Error(`invalid asset file ${versionId}`);
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  const hash = contentHash(materialFromEnvelope(envelope));
  if (envelope.version_id !== versionId || envelope.sha256 !== hash || versionId !== `av_${hash}`) throw new Error(`asset version integrity failure ${versionId}`);
  return envelope;
}

function assertBindingAsset(binding, asset) {
  if (asset.asset_id !== binding.asset_id || asset.asset_type !== binding.asset_type || asset.version_id !== binding.version_id || asset.sha256 !== binding.sha256 || canonicalJson(asset.derived_from) !== canonicalJson(binding.derived_from)) throw new Error(`asset binding mismatch ${binding.version_id}`);
  return asset;
}

function dependencyBindings(record, definition) {
  return definition.depends_on.flatMap(dependencyId => {
    const dependency = record.stages.find(stage => stage.id === dependencyId);
    if (dependency?.state !== 'completed' || dependency.output_bindings.length !== 1) throw new TaskContextNotReadyError(`stage ${definition.id} is blocked by ${dependencyId}`);
    return dependency.output_bindings.map(binding => ({ dependency_id: dependencyId, ...binding }));
  });
}

function resolvedContract(record, definition, bindings) {
  const inputs = definition.depends_on.length
    ? bindings.map(binding => ({
        key: `${binding.dependency_id}_${binding.key}`,
        kind: 'asset',
        required: true,
        source: 'stage_output',
        selector: `${binding.dependency_id}.${binding.key}`,
        ref_id: binding.asset_id,
        version_id: binding.version_id
      }))
    : [{
        key: 'run_request', kind: 'context', required: true, source: 'run_context', selector: '$',
        ref_id: record.run_id, version_id: `ctx_${record.input_snapshot_hash}`
      }];
  return {
    contract_schema_version: CONTRACT_SCHEMA_VERSION,
    inputs,
    outputs: [{
      key: definition.output.key,
      kind: 'asset',
      required: true,
      asset_type: definition.output.asset_type,
      acceptance_criteria: [...definition.output.acceptance_criteria],
      confirmation_policy: 'system'
    }]
  };
}

function stageInputHash(record, definition, contract, bindings) {
  return contentHash({
    schema: EXECUTION_CONTEXT_SCHEMA,
    run_id: record.run_id,
    run_input_snapshot_hash: record.input_snapshot_hash,
    stage_id: definition.id,
    contract_schema_version: CONTRACT_SCHEMA_VERSION,
    inputs: contract.inputs,
    input_assets: bindings.map(binding => ({ ref_id: binding.asset_id, version_id: binding.version_id, sha256: binding.sha256 }))
  });
}

function executionContext(record, definition, contract, bindings, inputSnapshotHash) {
  return {
    schema: EXECUTION_CONTEXT_SCHEMA,
    run_id: record.run_id,
    date: record.date,
    stage_id: definition.id,
    immutable: true,
    input_snapshot_hash: inputSnapshotHash,
    repository_snapshot_hash: null,
    dependency_graph: PIPELINE_STAGES.map(stage => ({ id: stage.id, depends_on: stage.depends_on })),
    contract,
    input_assets: bindings.map(binding => ({
      key: binding.key,
      asset_id: binding.asset_id,
      asset_type: binding.asset_type,
      version_id: binding.version_id,
      sha256: binding.sha256,
      producer_stage: binding.dependency_id
    }))
  };
}

function refreshStates(record) {
  for (const stage of record.stages) {
    if (['completed', 'running', 'failed', 'input_superseded'].includes(stage.state)) continue;
    stage.blocked_by = stage.depends_on.filter(id => record.stages.find(candidate => candidate.id === id)?.state !== 'completed');
    stage.state = stage.blocked_by.length ? 'blocked' : 'pending';
  }
  if (record.stages.every(stage => stage.state === 'completed')) {
    record.state = record.input_superseded || record.stages.some(stage => stage.input_superseded) ? 'completed_input_superseded' : 'completed';
    record.completed_at ||= record.stages.at(-1).completed_at;
  } else if (record.stages.some(stage => stage.state === 'input_superseded') || record.input_superseded) record.state = 'input_superseded';
  else if (record.stages.some(stage => stage.state === 'failed')) record.state = 'failed';
  else if (record.stages.some(stage => stage.state === 'running')) record.state = 'running';
  else record.state = 'pending';
}

export class TaskContextNotReadyError extends Error {
  constructor(message) {
    super(`task_context_not_ready: ${message}`);
    this.name = 'TaskContextNotReadyError';
    this.code = 'task_context_not_ready';
    this.statusCode = 409;
  }
}

class ExecutionSession {
  constructor({ dataDir, input, record, persist, now, allowInputSuperseded = false }) {
    this.dataDir = dataDir;
    this.input = input;
    this.record = record;
    this.persist = persist;
    this.now = now;
    this.allowInputSuperseded = allowInputSuperseded;
    this.memoryAssets = new Map();
  }

  async save() {
    refreshStates(this.record);
    if (this.persist) await saveRun(this.dataDir, this.record, this.now);
  }

  async readBinding(binding) {
    if (this.persist) {
      try { return assertBindingAsset(binding, await readAsset(this.dataDir, this.record.date, binding.version_id)); }
      catch (error) { throw new TaskContextNotReadyError(`asset ${binding.version_id} is unavailable or invalid: ${error.message}`); }
    }
    const asset = this.memoryAssets.get(binding.version_id);
    if (!asset) throw new TaskContextNotReadyError(`asset ${binding.version_id} is missing`);
    if (contentHash(materialFromEnvelope(asset)) !== asset.sha256) throw new TaskContextNotReadyError(`asset ${binding.version_id} failed integrity validation`);
    try { return assertBindingAsset(binding, asset); }
    catch (error) { throw new TaskContextNotReadyError(error.message); }
  }

  async writeOutput(definition, stage, payload, bindings) {
    const input = {
      assetType: definition.output.asset_type,
      assetId: `asset_${definition.id}_${definition.output.key}`,
      producerStage: definition.id,
      inputSnapshotHash: stage.input_snapshot_hash,
      derivedFrom: bindings.map(binding => binding.version_id),
      payload
    };
    if (this.persist) return writeAsset(this.dataDir, this.record.date, input, this.now);
    const material = assetMaterial(input), hash = contentHash(material), versionId = `av_${hash}`;
    const asset = { ...material, version_id: versionId, sha256: hash, created_at: nowIso(this.now) };
    this.memoryAssets.set(versionId, asset);
    return asset;
  }

  async inputsFor(definition, bindings) {
    const entries = await Promise.all(bindings.map(async binding => [binding.dependency_id, (await this.readBinding(binding)).payload]));
    return Object.fromEntries(entries);
  }

  async verifyBindings(bindings) {
    for (const binding of bindings) {
      const asset = await this.readBinding(binding);
      if (asset.version_id !== binding.version_id || asset.sha256 !== binding.sha256) throw new TaskContextNotReadyError(`input ${binding.version_id} was superseded during execution`);
    }
  }

  async output(stageId) {
    const stage = this.record.stages.find(candidate => candidate.id === stageId);
    if (stage?.state !== 'completed' || stage.output_bindings.length !== 1) throw new TaskContextNotReadyError(`stage ${stageId} has no accepted output`);
    return (await this.readBinding(stage.output_bindings[0])).payload;
  }

  async execute(stageId, handler) {
    const definition = STAGE_BY_ID.get(stageId);
    if (!definition) throw new Error(`unknown execution stage ${stageId}`);
    const stage = this.record.stages.find(candidate => candidate.id === stageId);
    const bindings = dependencyBindings(this.record, definition);
    const contract = resolvedContract(this.record, definition, bindings);
    const inputSnapshotHash = stageInputHash(this.record, definition, contract, bindings);

    if (stage.state === 'completed') {
      if (stage.input_snapshot_hash !== inputSnapshotHash || canonicalJson(stage.contract) !== canonicalJson(contract)) {
        stage.state = 'input_superseded'; stage.input_superseded = true;
        await this.save();
        throw new TaskContextNotReadyError(`completed stage ${stageId} no longer matches its immutable inputs`);
      }
      await this.verifyBindings(stage.output_bindings);
      return this.output(stageId);
    }
    if ((this.record.input_superseded && !(this.allowInputSuperseded && stageId === 'integration')) || stage.state === 'input_superseded') throw new TaskContextNotReadyError(`run ${this.record.run_id} requires an explicit new revision`);

    stage.contract = contract;
    stage.input_snapshot_hash = inputSnapshotHash;
    stage.execution_context = executionContext(this.record, definition, contract, bindings, inputSnapshotHash);
    stage.state = 'running'; stage.blocked_by = []; stage.attempts += 1;
    stage.started_at = nowIso(this.now); stage.completed_at = null; stage.failure = null;
    await this.save();

    try {
      const payload = jsonValue(await handler({ inputs: await this.inputsFor(definition, bindings), context: stage.execution_context, attempt: stage.attempts }));
      if (payload === null || typeof payload !== 'object') throw new Error(`stage ${stageId} produced no typed output`);
      await this.verifyBindings(bindings);
      const asset = await this.writeOutput(definition, stage, payload, bindings);
      stage.output_bindings = [{
        key: definition.output.key,
        asset_id: asset.asset_id,
        asset_type: asset.asset_type,
        version_id: asset.version_id,
        sha256: asset.sha256,
        derived_from: [...asset.derived_from],
        confirmation: { policy: 'system', state: 'confirmed', confirmed_at: nowIso(this.now), evidence: 'stage acceptance criteria and deterministic validator passed' }
      }];
      stage.state = 'completed'; stage.completed_at = nowIso(this.now); stage.failure = null;
      await this.save();
      return payload;
    } catch (error) {
      if (error instanceof TaskContextNotReadyError) {
        stage.state = 'input_superseded'; stage.input_superseded = true;
      } else {
        stage.state = 'failed';
        stage.failure = { code: 'stage_execution_failed', message: redact(String(error?.message || 'stage execution failed')), failed_at: nowIso(this.now) };
      }
      await this.save();
      throw error;
    }
  }

  summary() { return publicExecutionRun(this.record); }
}

export async function openExecutionSession(dataDir, input, { persist = true, now = Date.now, allowInputSuperseded = false } = {}) {
  if (!input || input.schema !== EXECUTION_CONTEXT_SCHEMA || !HASH.test(input.input_snapshot_hash || '')) throw new Error('invalid execution input');
  if (!persist) return new ExecutionSession({ dataDir, input, record: createRun(input.date, input, now), persist: false, now, allowInputSuperseded });
  let record = await readRunFile(dataDir, input.date);
  if (!record) {
    record = createRun(input.date, input, now, await nextRevision(dataDir, input.date));
    await saveRun(dataDir, record, now);
  } else if (record.input_snapshot_hash !== input.input_snapshot_hash) {
    record.input_superseded = true;
    record.superseded_at ||= nowIso(now);
    record.superseded_by_hash = input.input_snapshot_hash;
    refreshStates(record);
    await saveRun(dataDir, record, now);
    if (!allowInputSuperseded) throw new TaskContextNotReadyError(`run input changed from ${record.input_snapshot_hash.slice(0, 12)} to ${input.input_snapshot_hash.slice(0, 12)}`);
  } else if (record.input_superseded && !allowInputSuperseded) {
    throw new TaskContextNotReadyError(`run ${record.run_id} requires an explicit new revision`);
  }
  return new ExecutionSession({ dataDir, input, record, persist: true, now, allowInputSuperseded });
}

export async function supersedeExecutionRun(dataDir, date, { reason = 'operator-requested-new-revision', now = Date.now } = {}) {
  if (!isIsoDate(date)) throw new Error('invalid run date');
  return withLock(path.join(dataDir, 'locks', `${date}.run.lock`), async () => {
    const record = await readRunFile(dataDir, date);
    if (!record) return null;
    if (record.state === 'completed' || record.state === 'completed_input_superseded') throw new Error('completed execution runs are immutable');
    try {
      const published = await lstat(path.join(dataDir, 'reports', date, 'report.json'));
      if (published) throw new Error('a published report cannot be replaced by a new run revision');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const archive = path.join(runDir(dataDir, date), 'revisions', `run.${record.revision}.json`);
    const archived = { ...record, state: 'superseded', superseded_at: nowIso(now), superseded_reason: String(reason).slice(0, 240) };
    await atomicWrite(archive, `${JSON.stringify(archived, null, 2)}\n`, { overwrite: false });
    await rm(runFile(dataDir, date));
    return publicExecutionRun(archived);
  });
}

export async function readExecutionRun(dataDir, date, { verifyAssets = true } = {}) {
  const record = await readRunFile(dataDir, date);
  if (!record) return null;
  if (verifyAssets) for (const stage of record.stages) for (const binding of stage.output_bindings) assertBindingAsset(binding, await readAsset(dataDir, date, binding.version_id));
  return publicExecutionRun(record);
}

export async function latestExecutionRun(dataDir) {
  let names;
  try { names = await readdir(path.join(dataDir, 'runs')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const date of names.filter(isIsoDate).sort().reverse()) {
    try {
      const metadata = await lstat(runFile(dataDir, date));
      if (metadata.isFile() && !metadata.isSymbolicLink()) return await readExecutionRun(dataDir, date);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

export function publicExecutionRun(record) {
  return jsonValue({
    schema_version: record.schema_version,
    execution_context_schema: record.execution_context_schema,
    run_id: record.run_id,
    date: record.date,
    revision: record.revision,
    mode: record.mode,
    state: record.state,
    immutable_input: record.immutable_input,
    input_snapshot_hash: record.input_snapshot_hash,
    repository_snapshot_hash: record.repository_snapshot_hash,
    input_superseded: record.input_superseded,
    superseded_at: record.superseded_at,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at,
    stages: record.stages.map(stage => ({
      id: stage.id,
      title: stage.title,
      order: stage.order,
      depends_on: stage.depends_on,
      state: stage.state,
      blocked_by: stage.blocked_by,
      attempts: stage.attempts,
      input_snapshot_hash: stage.input_snapshot_hash,
      input_superseded: stage.input_superseded,
      contract: stage.contract,
      output_bindings: stage.output_bindings,
      failure: stage.failure,
      started_at: stage.started_at,
      completed_at: stage.completed_at
    }))
  });
}
