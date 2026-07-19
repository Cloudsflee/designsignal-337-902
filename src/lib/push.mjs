import path from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { atomicWrite, sha256 } from './util.mjs';
import { assertSafeUrl } from './network.mjs';

const channels = ['generic', 'feishu', 'wecom'];
const payload = (channel, report) => {
  const text = `DesignSignal ${report.date}: ${report.items.map(x => x.title.zh).join('；')}`;
  if (channel === 'feishu') return { msg_type: 'text', content: { text } };
  if (channel === 'wecom') return { msgtype: 'text', text: { content: text } };
  return { event: 'designsignal.daily', date: report.date, itemCount: report.items.length, report: { hypotheses: report.synthesis.hypotheses, items: report.items.map(x => ({ id: x.id, title: x.title, source: x.source.url })) } };
};

export async function queueDeliveries(dataDir, report, config) {
  const dir = path.join(dataDir, 'outbox'); await mkdir(dir, { recursive: true }); const jobs = [];
  for (const channel of channels) {
    const endpoint = config.push[channel];
    const job = { id: sha256(`${report.date}:${channel}`).slice(0, 24), channel, reportDate: report.date, endpointConfigured: Boolean(endpoint), state: 'pending', reason: endpoint ? 'queued' : 'missing-secret-or-endpoint', attempts: 0, nextAttemptAt: new Date().toISOString(), createdAt: new Date().toISOString(), payload: payload(channel, report) };
    await atomicWrite(path.join(dir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`); jobs.push(job);
  }
  return jobs;
}

async function sendJob(job, endpoint, config, ctx) {
  const url = new URL(endpoint); const policy = { ...config.network, allowHosts: [...new Set([...config.network.allowHosts, url.hostname])] };
  await assertSafeUrl(endpoint, policy, ctx);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.network.timeoutMs);
  try {
    const response = await (ctx.fetchImpl || fetch)(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', 'user-agent': 'DesignSignal/1.0' }, body: JSON.stringify(job.payload) });
    if (!response.ok) throw new Error(`webhook HTTP ${response.status}`);
  } finally { clearTimeout(timer); }
}

export async function retryOutbox(dataDir, config, ctx = {}) {
  const dir = path.join(dataDir, 'outbox'); let files;
  try { files = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = [];
  for (const file of files.filter(x => x.endsWith('.json')).sort()) {
    const full = path.join(dir, file), job = JSON.parse(await readFile(full, 'utf8'));
    if (job.state === 'delivered' || new Date(job.nextAttemptAt) > new Date()) continue;
    const endpoint = config.push[job.channel];
    if (!endpoint) { job.reason = 'missing-secret-or-endpoint'; await atomicWrite(full, `${JSON.stringify(job, null, 2)}\n`); results.push(job); continue; }
    try { await sendJob(job, endpoint, config, ctx); job.state = 'delivered'; job.reason = ''; job.deliveredAt = new Date().toISOString(); }
    catch (error) { job.attempts++; job.reason = error.message; job.nextAttemptAt = new Date(Date.now() + Math.min(864e5, 60e3 * 2 ** Math.min(job.attempts, 10))).toISOString(); }
    await atomicWrite(full, `${JSON.stringify(job, null, 2)}\n`); results.push(job);
  }
  return results;
}
