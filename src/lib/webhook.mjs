import path from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { HttpStatusError, safeFetch } from './network.mjs';
import { atomicWrite, sha256 } from './util.mjs';

const CHANNELS = ['generic', 'feishu', 'wecom'];
const MISSING_ENDPOINT = 'missing-secret-or-endpoint';
const MAX_RESPONSE_BYTES = 64 * 1024;

const payload = (channel, report) => {
  const text = `DesignSignal ${report.date}: ${report.items.map(item => item.title.zh).join('；')}`;
  if (channel === 'feishu') return { msg_type: 'text', content: { text } };
  if (channel === 'wecom') return { msgtype: 'text', text: { content: text } };
  return {
    event: 'designsignal.daily', date: report.date, itemCount: report.items.length,
    report: {
      hypotheses: report.synthesis.hypotheses,
      items: report.items.map(item => ({ id: item.id, title: item.title, source: item.source.url }))
    }
  };
};

const jobId = (date, channel) => sha256(`${date}:${channel}`).slice(0, 24);
const jobFile = (dir, id) => path.join(dir, `${id}.json`);
const endpointFor = (config, channel) => config.push?.[channel] || '';
const nowValue = ctx => Number(ctx.now?.() ?? Date.now());

function expectedJob(report, channel, config, createdAt) {
  const endpoint = endpointFor(config, channel);
  return {
    id: jobId(report.date, channel), channel, reportDate: report.date,
    endpointConfigured: Boolean(endpoint), state: 'pending',
    reason: endpoint ? 'queued' : MISSING_ENDPOINT, attempts: 0,
    nextAttemptAt: createdAt, createdAt, payload: payload(channel, report)
  };
}

function compatibleIdentity(stored, expected, filename) {
  return stored?.id === expected.id && filename === `${expected.id}.json` &&
    stored.channel === expected.channel && stored.reportDate === expected.reportDate &&
    JSON.stringify(stored.payload) === JSON.stringify(expected.payload);
}

function validStoredJob(job, filename) {
  if (!CHANNELS.includes(job?.channel) || filename !== `${job.id}.json`) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(job.reportDate || '') || job.id !== jobId(job.reportDate, job.channel)) return false;
  if (!['pending', 'delivered'].includes(job.state) || !Number.isSafeInteger(job.attempts) || job.attempts < 0) return false;
  if (!Number.isFinite(Date.parse(job.nextAttemptAt)) || !validPayload(job.channel, job.payload, job.reportDate)) return false;
  return true;
}

function validPayload(channel, value, reportDate) {
  if (!value || JSON.stringify(value).length > 256 * 1024) return false;
  if (channel === 'feishu') return value.msg_type === 'text' && typeof value.content?.text === 'string';
  if (channel === 'wecom') return value.msgtype === 'text' && typeof value.text?.content === 'string';
  return value.event === 'designsignal.daily' && value.date === reportDate &&
    Number.isSafeInteger(value.itemCount) && Array.isArray(value.report?.hypotheses) &&
    Array.isArray(value.report?.items) && value.report.items.length === value.itemCount;
}

export async function queueWebhookDeliveries(dataDir, report, config) {
  const dir = path.join(dataDir, 'outbox');
  await mkdir(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const jobs = [];
  for (const channel of CHANNELS) {
    const expected = expectedJob(report, channel, config, createdAt);
    const file = jobFile(dir, expected.id);
    let stored;
    try { stored = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await atomicWrite(file, `${JSON.stringify(expected, null, 2)}\n`, { overwrite: false }); stored = expected; }
      catch (createError) {
        if (createError.code !== 'EEXIST') throw createError;
        stored = JSON.parse(await readFile(file, 'utf8'));
      }
    }
    if (!compatibleIdentity(stored, expected, path.basename(file))) throw new Error(`conflicting outbox job identity for ${expected.id}`);
    jobs.push(stored);
  }
  return jobs;
}

async function sendWebhook(job, endpoint, config, ctx) {
  let url;
  try { url = new URL(endpoint); }
  catch { throw new Error('invalid webhook endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid webhook endpoint');
  const policy = { ...config.network, allowHosts: [...new Set([...(config.network?.allowHosts || []), url.hostname.toLowerCase()])] };
  await safeFetch(url.href, policy, {
    ...ctx, method: 'POST', body: JSON.stringify(job.payload), retries: 0,
    maxBytes: config.network?.maxJsonBytes || MAX_RESPONSE_BYTES,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'idempotency-key': `designsignal-${job.id}`
    }
  });
}

function failureReason(error) {
  return error instanceof HttpStatusError ? `webhook HTTP ${error.status}` : 'webhook delivery failed';
}

export async function retryWebhookOutbox(dataDir, config, ctx = {}) {
  const dir = path.join(dataDir, 'outbox');
  let files;
  try { files = await readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = [];
  for (const name of files.filter(file => file.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    const job = JSON.parse(await readFile(file, 'utf8'));
    if (!CHANNELS.includes(job.channel) || !validStoredJob(job, name)) continue;
    if (job.state === 'delivered' || new Date(job.nextAttemptAt).getTime() > nowValue(ctx)) { results.push(job); continue; }
    const endpoint = endpointFor(config, job.channel);
    if (!endpoint) { results.push(job); continue; }
    try {
      await sendWebhook(job, endpoint, config, ctx);
      job.state = 'delivered'; job.reason = ''; job.deliveredAt = new Date(nowValue(ctx)).toISOString();
    } catch (error) {
      job.state = 'pending'; job.attempts++; job.reason = failureReason(error);
      const delay = Math.min(86_400_000, 60_000 * 2 ** Math.min(job.attempts, 10));
      job.nextAttemptAt = new Date(nowValue(ctx) + delay).toISOString();
    }
    await atomicWrite(file, `${JSON.stringify(job, null, 2)}\n`);
    results.push(job);
  }
  return results;
}
