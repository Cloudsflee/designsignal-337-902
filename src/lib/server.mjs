import { createServer } from 'node:http';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { latestReport } from './storage.mjs';
import { renderHtml } from './render.mjs';
import { json } from './util.mjs';
import { loadExamEvidence } from './evidence.mjs';

const APP_JS = `document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));document.querySelectorAll('.signal').forEach(x=>x.classList.toggle('hidden',b.dataset.filter!=='all'&&x.dataset.category!==b.dataset.filter))})`;
const headers = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
const body = async (req, limit = 4096) => { const chunks = []; let total = 0; for await (const x of req) { total += x.length; if (total > limit) throw new Error('request too large'); chunks.push(x); } return Buffer.concat(chunks).toString('utf8'); };

export function createDashboardServer(config) {
  return createServer((req, res) => handleDashboardRequest(config, req, res));
}

export async function handleDashboardRequest(config, req, res) {
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    try {
      const url = new URL(req.url, 'http://local');
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok', service: 'designsignal', time: new Date().toISOString() });
      if (req.method === 'GET' && url.pathname === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' }); return res.end(APP_JS); }
      if (req.method === 'GET' && url.pathname === '/api/report') { const report = await latestReport(config.dataDir); return json(res, report ? 200 : 404, report || { error: 'no report' }); }
      if (req.method === 'GET' && url.pathname === '/api/evidence') return json(res, 200, await loadExamEvidence());
      if (req.method === 'GET' && url.pathname === '/api/source-health') { const report = await latestReport(config.dataDir); return json(res, report ? 200 : 404, report?.audit.sourceHealth || { error: 'no report' }); }
      if (req.method === 'GET' && url.pathname === '/api/outbox') { let files = []; try { files = await readdir(path.join(config.dataDir, 'outbox')); } catch {} const jobs = await Promise.all(files.filter(x => x.endsWith('.json')).map(x => readFile(path.join(config.dataDir, 'outbox', x), 'utf8').then(JSON.parse))); return json(res, 200, jobs.map(({ payload, ...job }) => job)); }
      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const raw = await body(req); const note = new URLSearchParams(raw).get('note')?.trim(); if (!note) return json(res, 400, { error: 'note required' });
        await appendFile(path.join(config.dataDir, 'feedback.ndjson'), `${JSON.stringify({ at: new Date().toISOString(), note: note.slice(0, 2000) })}\n`, { mode: 0o600, flag: 'a' });
        res.writeHead(303, { location: '/' }); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/') { const report = await latestReport(config.dataDir); if (!report) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('No report yet. Run daily first.'); } const html = renderHtml(report); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) }); return res.end(html); }
      return json(res, 404, { error: 'not found' });
    } catch (error) { return json(res, /too large/.test(error.message) ? 413 : 500, { error: error.message }); }
}

export async function serve(config) {
  const server = createDashboardServer(config);
  await new Promise((resolve, reject) => server.once('error', reject).listen(config.port, config.host, resolve));
  return server;
}
