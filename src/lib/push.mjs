import path from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { atomicWrite, isIsoDate, sha256, withLock } from './util.mjs';
import { HttpStatusError, safeFetch } from './network.mjs';
import { readReportByDate } from './storage.mjs';
import { renderFeishuBlocks } from './render.mjs';
import { queueWebhookDeliveries, retryWebhookOutbox } from './webhook.mjs';

const CHANNEL = 'feishu-document';
const JOB_VERSION = 1;
const API_ORIGIN = 'https://open.feishu.cn';
const MAX_CHILDREN = 50;
const MISSING_CONFIG = 'missing-feishu-document-config';
const DEFINITE_FAILURE = 'definite-failure';
const RECONCILIATION = 'reconciliation-required';
const inFlightStates = new Set(['creating', 'writing']);
const states = new Set(['pending', 'creating', 'created', 'writing', 'delivered', RECONCILIATION]);
const DOCUMENT_JOB_FIELDS = new Set([
  'schemaVersion', 'id', 'channel', 'reportDate', 'state', 'reason', 'attempts',
  'nextAttemptAt', 'createdAt', 'renderFingerprint', 'totalBlocks', 'nextBlockIndex',
  'documentId', 'revisionId', 'chunkCursor', 'chunkSize', 'chunkRevisionId', 'clientToken',
  'creatingAt', 'createdDocumentAt', 'writingAt', 'confirmedChunkAt', 'deliveredAt',
  'reconciliationRequiredAt'
]);
const REQUIRED_DOCUMENT_JOB_FIELDS = [
  'schemaVersion', 'id', 'channel', 'reportDate', 'state', 'reason', 'attempts',
  'nextAttemptAt', 'createdAt', 'renderFingerprint', 'totalBlocks', 'nextBlockIndex'
];

const configured = config => Boolean(config.feishuDocument?.appId && config.feishuDocument?.appSecret && config.feishuDocument?.folderToken);
const jobId = report => sha256(`${report.date}:${CHANNEL}:v${JOB_VERSION}`).slice(0, 24);
const fingerprint = report => sha256(JSON.stringify(renderFeishuBlocks(report)));
const jobPath = (dataDir, id) => path.join(dataDir, 'outbox', `${id}.json`);
const storeJob = (file, job, options) => atomicWrite(file, `${JSON.stringify(job, null, 2)}\n`, options);
const nowIso = ctx => new Date((ctx.now?.() ?? Date.now())).toISOString();

export function assertStoredDocumentJob(job, filename) {
  if (job.schemaVersion !== JOB_VERSION || job.channel !== CHANNEL || !/^[a-f0-9]{24}$/.test(job.id || '') || filename !== `${job.id}.json`) throw new Error('invalid Feishu document job identity');
  if (Object.keys(job).some(key => !DOCUMENT_JOB_FIELDS.has(key)) || REQUIRED_DOCUMENT_JOB_FIELDS.some(key => !(key in job))) throw new Error('invalid Feishu document job fields');
  if (!isIsoDate(job.reportDate) || job.id !== sha256(`${job.reportDate}:${CHANNEL}:v${JOB_VERSION}`).slice(0, 24)) throw new Error('invalid Feishu document report identity');
  if (!/^[a-f0-9]{64}$/.test(job.renderFingerprint || '') || !states.has(job.state) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 ||
      typeof job.reason !== 'string' || job.reason.length > 240 || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.nextAttemptAt))) throw new Error('invalid Feishu document job state');
  if (!Number.isSafeInteger(job.totalBlocks) || job.totalBlocks < 1 || !Number.isSafeInteger(job.nextBlockIndex) || job.nextBlockIndex < 0 || job.nextBlockIndex > job.totalBlocks) throw new Error('invalid Feishu document job progress');
  for (const field of ['creatingAt', 'createdDocumentAt', 'writingAt', 'confirmedChunkAt', 'deliveredAt', 'reconciliationRequiredAt']) {
    if (job[field] !== undefined && !Number.isFinite(Date.parse(job[field]))) throw new Error('invalid Feishu document job timestamp');
  }
  if (job.revisionId !== undefined && job.documentId === undefined) throw new Error('invalid stored Feishu document identity');
  if (job.documentId !== undefined && (!/^[A-Za-z0-9_-]{8,128}$/.test(job.documentId) || ((!Number.isSafeInteger(job.revisionId) || job.revisionId < 0) && !/^\d+$/.test(job.revisionId || '')))) throw new Error('invalid stored Feishu document identity');
  if (['created', 'writing', 'delivered'].includes(job.state) && !job.documentId) throw new Error('Feishu document state requires a document identity');
  if (job.state === 'delivered' && (job.nextBlockIndex !== job.totalBlocks || !Number.isFinite(Date.parse(job.deliveredAt)))) throw new Error('delivered Feishu document job has incomplete progress');
  const hasChunk = ['chunkCursor', 'chunkSize', 'chunkRevisionId', 'clientToken'].some(key => job[key] !== undefined);
  if (job.state === 'writing' || hasChunk) {
    if (!job.documentId || !Number.isSafeInteger(job.chunkCursor) || job.chunkCursor !== job.nextBlockIndex || !Number.isSafeInteger(job.chunkSize) || job.chunkSize < 1 || job.chunkSize > MAX_CHILDREN || job.chunkCursor + job.chunkSize > job.totalBlocks || String(job.chunkRevisionId) !== String(job.revisionId) || !/^[a-f0-9]{32}$/.test(job.clientToken || '')) throw new Error('invalid Feishu document in-flight chunk');
    if (job.clientToken !== chunkToken(job, job.chunkCursor, job.chunkSize, job.chunkRevisionId)) throw new Error('invalid Feishu document chunk token');
  }
  return job;
}

function documentUrl(config, documentId) {
  const origin = config.feishuDocument?.tenantBaseUrl || 'https://feishu.cn';
  return `${origin}/docx/${encodeURIComponent(documentId)}`;
}

const chunkToken = (job, cursor, size, revision) => sha256(`${job.id}:${job.documentId}:${cursor}:${size}:${revision}:${job.renderFingerprint}`).slice(0, 32);
const clearChunk = job => { for (const key of ['chunkCursor', 'chunkSize', 'chunkRevisionId', 'clientToken', 'writingAt']) delete job[key]; };

const SAFE_JOB_FIELDS = [
  'schemaVersion', 'id', 'channel', 'reportDate', 'endpointConfigured', 'state', 'reason',
  'attempts', 'nextAttemptAt', 'createdAt', 'renderFingerprint', 'totalBlocks', 'nextBlockIndex',
  'documentId', 'revisionId', 'chunkCursor', 'chunkSize', 'chunkRevisionId', 'clientToken',
  'creatingAt', 'createdDocumentAt', 'writingAt', 'confirmedChunkAt', 'deliveredAt', 'reconciliationRequiredAt'
];

export function exposeDeliveryJob(job, config) {
  const exposed = {};
  for (const key of SAFE_JOB_FIELDS) {
    const value = job?.[key];
    if (value === undefined || value === null) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) exposed[key] = value;
  }
  if (job?.state === 'delivered' && /^[A-Za-z0-9_-]{8,128}$/.test(String(job.documentId || ''))) exposed.documentUrl = documentUrl(config, job.documentId);
  return exposed;
}

async function queueDocumentDelivery(dataDir, report, config) {
  const dir = path.join(dataDir, 'outbox');
  await mkdir(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const blocks = renderFeishuBlocks(report);
  const expected = {
    schemaVersion: JOB_VERSION,
    id: jobId(report),
    channel: CHANNEL,
    reportDate: report.date,
    state: 'pending',
    reason: configured(config) ? 'queued' : MISSING_CONFIG,
    attempts: 0,
    nextAttemptAt: createdAt,
    createdAt,
    renderFingerprint: sha256(JSON.stringify(blocks)),
    totalBlocks: blocks.length,
    nextBlockIndex: 0
  };
  const file = jobPath(dataDir, expected.id);
  let stored;
  try { stored = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await storeJob(file, expected, { overwrite: false }); stored = expected; }
    catch (createError) {
      if (createError.code !== 'EEXIST') throw createError;
      stored = JSON.parse(await readFile(file, 'utf8'));
    }
  }
  try { assertStoredDocumentJob(stored, `${expected.id}.json`); }
  catch { throw new Error(`conflicting outbox job identity for ${expected.id}`); }
  if (stored.reportDate !== report.date || stored.renderFingerprint !== expected.renderFingerprint || stored.totalBlocks !== expected.totalBlocks) throw new Error(`conflicting outbox job identity for ${expected.id}`);
  return [exposeDeliveryJob(stored, config)];
}

class DeliveryFailure extends Error {
  constructor(reason, { ambiguous = false } = {}) { super(reason); this.ambiguous = ambiguous; }
}

async function requestJson(url, init, config, ctx, phase, { remoteSideEffect = false } = {}) {
  const policy = { ...config.network, allowHosts: [...new Set([...(config.network.allowHosts || []), new URL(API_ORIGIN).hostname])] };
  let response;
  try {
    response = await safeFetch(url, policy, { ...ctx, ...init, retries: 0, maxBytes: config.network.maxJsonBytes });
  } catch (error) {
    if (error instanceof HttpStatusError && !error.retryable) throw new DeliveryFailure(DEFINITE_FAILURE);
    if (/unsafe URL|allowlisted|private or unresolved/.test(error?.message || '')) throw new DeliveryFailure(DEFINITE_FAILURE);
    throw new DeliveryFailure(`${phase}-${remoteSideEffect ? 'ambiguous' : 'unavailable'}`, { ambiguous: remoteSideEffect });
  }
  let data;
  try { data = JSON.parse(response.body.toString('utf8')); }
  catch { throw new DeliveryFailure(`${phase}-${remoteSideEffect ? 'ambiguous' : 'invalid'}`, { ambiguous: remoteSideEffect }); }
  if (data?.code !== 0) throw new DeliveryFailure(DEFINITE_FAILURE);
  return data;
}

const headers = token => ({ 'content-type': 'application/json; charset=utf-8', ...(token ? { authorization: `Bearer ${token}` } : {}), 'user-agent': 'DesignSignal/1.0' });

async function tenantToken(config, ctx) {
  const data = await requestJson(`${API_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ app_id: config.feishuDocument.appId, app_secret: config.feishuDocument.appSecret })
  }, config, ctx, 'tenant-token');
  if (typeof data.tenant_access_token !== 'string' || !data.tenant_access_token) throw new DeliveryFailure('tenant-token-invalid');
  return data.tenant_access_token;
}

function validateDocumentIdentity(document) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(document?.document_id || '')) throw new DeliveryFailure('create-ambiguous', { ambiguous: true });
  if ((!Number.isSafeInteger(document.revision_id) || document.revision_id < 0) && !/^\d+$/.test(document.revision_id || '')) throw new DeliveryFailure('create-ambiguous', { ambiguous: true });
  return { documentId: document.document_id, revisionId: document.revision_id };
}

async function createDocument(job, file, config, ctx, token) {
  job.state = 'creating'; job.reason = ''; job.creatingAt = nowIso(ctx); await storeJob(file, job);
  const data = await requestJson(`${API_ORIGIN}/open-apis/docx/v1/documents`, {
    method: 'POST', headers: headers(token), body: JSON.stringify({ folder_token: config.feishuDocument.folderToken, title: `DesignSignal 337/902 - ${job.reportDate}` })
  }, config, ctx, 'create', { remoteSideEffect: true });
  Object.assign(job, validateDocumentIdentity(data?.data?.document));
  job.state = 'created'; job.reason = 'ready-to-write'; job.createdDocumentAt = nowIso(ctx);
  await storeJob(file, job);
}

async function writeDocument(job, file, report, config, ctx, token) {
  const blocks = renderFeishuBlocks(report);
  if (sha256(JSON.stringify(blocks)) !== job.renderFingerprint) throw new DeliveryFailure('render-fingerprint-mismatch');
  if (blocks.length !== job.totalBlocks) throw new DeliveryFailure('render-block-count-mismatch');
  const id = encodeURIComponent(job.documentId);
  while (job.nextBlockIndex < blocks.length) {
    const cursor = job.nextBlockIndex;
    const children = blocks.slice(cursor, cursor + MAX_CHILDREN);
    const revision = job.revisionId;
    const clientToken = chunkToken(job, cursor, children.length, revision);
    Object.assign(job, { state: 'writing', reason: '', chunkCursor: cursor, chunkSize: children.length, chunkRevisionId: revision, clientToken, writingAt: nowIso(ctx) });
    await storeJob(file, job);
    const query = new URLSearchParams({ document_revision_id: String(revision), client_token: clientToken });
    const data = await requestJson(`${API_ORIGIN}/open-apis/docx/v1/documents/${id}/blocks/${id}/children?${query}`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ children, index: cursor })
    }, config, ctx, 'write', { remoteSideEffect: true });
    const nextRevision = data?.data?.document_revision_id ?? data?.data?.revision_id;
    if ((!Number.isSafeInteger(nextRevision) || nextRevision < 0) && !/^\d+$/.test(nextRevision || '')) throw new DeliveryFailure('write-ambiguous', { ambiguous: true });
    job.revisionId = nextRevision;
    job.nextBlockIndex = cursor + children.length;
    clearChunk(job);
    if (job.nextBlockIndex === blocks.length) {
      job.state = 'delivered'; job.reason = ''; job.deliveredAt = nowIso(ctx);
    } else {
      job.state = 'created'; job.reason = 'ready-to-write'; job.confirmedChunkAt = nowIso(ctx);
    }
    await storeJob(file, job);
  }
}

function backoff(job, ctx) {
  job.attempts++;
  clearChunk(job);
  job.state = job.documentId ? 'created' : 'pending';
  job.reason = DEFINITE_FAILURE;
  const delay = Math.min(864e5, 60e3 * 2 ** Math.min(job.attempts, 10));
  job.nextAttemptAt = new Date((ctx.now?.() ?? Date.now()) + delay).toISOString();
}

async function runJob(job, file, report, config, ctx) {
  if (inFlightStates.has(job.state)) {
    const interrupted = job.state;
    job.state = RECONCILIATION; job.reason = `interrupted-${interrupted === 'creating' ? 'create' : 'write'}`; job.reconciliationRequiredAt = nowIso(ctx); await storeJob(file, job); return;
  }
  if (job.state === RECONCILIATION || job.state === 'delivered') return;
  if (!configured(config)) {
    if (job.state !== 'pending' || job.reason !== MISSING_CONFIG) { job.state = 'pending'; job.reason = MISSING_CONFIG; await storeJob(file, job); }
    return;
  }
  try {
    const token = await tenantToken(config, ctx);
    if (!job.documentId) await createDocument(job, file, config, ctx, token);
    await writeDocument(job, file, report, config, ctx, token);
  } catch (error) {
    if (error instanceof DeliveryFailure && !error.ambiguous) backoff(job, ctx);
    else {
      job.state = RECONCILIATION; job.reason = error instanceof DeliveryFailure ? error.message : RECONCILIATION; job.reconciliationRequiredAt = nowIso(ctx);
    }
    await storeJob(file, job);
  }
}

async function retryDocumentOutbox(dataDir, config, ctx = {}) {
  const dir = path.join(dataDir, 'outbox'); let files;
  try { files = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = [];
  for (const name of files.filter(x => x.endsWith('.json')).sort()) {
    const file = path.join(dir, name), job = JSON.parse(await readFile(file, 'utf8'));
    if (job.channel !== CHANNEL) continue;
    assertStoredDocumentJob(job, name);
    if (job.state === 'delivered' || job.state === RECONCILIATION) { results.push(exposeDeliveryJob(job, config)); continue; }
    if (inFlightStates.has(job.state)) {
      await runJob(job, file, null, config, ctx);
      results.push(exposeDeliveryJob(job, config));
      continue;
    }
    if (new Date(job.nextAttemptAt) > new Date(ctx.now?.() ?? Date.now())) { results.push(exposeDeliveryJob(job, config)); continue; }
    if (!configured(config)) {
      await runJob(job, file, null, config, ctx);
      results.push(exposeDeliveryJob(job, config));
      continue;
    }
    const report = await readReportByDate(dataDir, job.reportDate);
    if (!report) throw new Error(`report identity does not match outbox job ${job.id}`);
    if (renderFeishuBlocks(report).length !== job.totalBlocks) throw new Error(`invalid Feishu document job progress for ${job.id}`);
    if (fingerprint(report) !== job.renderFingerprint) {
      job.state = RECONCILIATION; job.reason = 'render-fingerprint-mismatch'; job.reconciliationRequiredAt = nowIso(ctx); await storeJob(file, job);
      results.push(exposeDeliveryJob(job, config));
      continue;
    }
    await runJob(job, file, report, config, ctx);
    results.push(exposeDeliveryJob(job, config));
  }
  return results;
}

async function queueDeliveriesUnlocked(dataDir, report, config) {
  const document = await queueDocumentDelivery(dataDir, report, config);
  const webhooks = await queueWebhookDeliveries(dataDir, report, config);
  return [...document, ...webhooks];
}

export async function queueDeliveries(dataDir, report, config) {
  return withLock(path.join(dataDir, 'locks', 'outbox.lock'), () => queueDeliveriesUnlocked(dataDir, report, config));
}

async function retryOutboxUnlocked(dataDir, config, ctx = {}) {
  const document = await retryDocumentOutbox(dataDir, config, ctx);
  const webhooks = await retryWebhookOutbox(dataDir, config, ctx);
  return [...document, ...webhooks];
}

export async function retryOutbox(dataDir, config, ctx = {}) {
  return withLock(path.join(dataDir, 'locks', 'outbox.lock'), () => retryOutboxUnlocked(dataDir, config, ctx));
}
