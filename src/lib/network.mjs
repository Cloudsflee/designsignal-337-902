import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sleep } from './util.mjs';

export function isPrivateAddress(address) {
  if (!isIP(address)) return true;
  if (address.includes(':')) {
    const x = address.toLowerCase();
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff') || x.startsWith('2001:db8:') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.');
  }
  const n = address.split('.').map(Number);
  return n[0] === 0 || n[0] === 10 || n[0] === 127 || (n[0] === 100 && n[1] >= 64 && n[1] <= 127) || (n[0] === 169 && n[1] === 254) || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && [0, 2, 168].includes(n[1])) || (n[0] === 198 && (n[1] === 18 || n[1] === 19 || n[1] === 51)) || (n[0] === 203 && n[1] === 0 && n[2] === 113) || n[0] >= 224;
}

export async function assertSafeUrl(input, policy, { dnsLookup = lookup } = {}) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe URL scheme or credentials');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!policy.allowHosts.includes(host)) throw new Error(`host not allowlisted: ${host}`);
  const literal = isIP(host) ? [{ address: host }] : await dnsLookup(host, { all: true, verbatim: true });
  if (!literal.length || literal.some(x => isPrivateAddress(x.address))) throw new Error(`private or unresolved address blocked: ${host}`);
  return url;
}

export async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`response exceeds ${maxBytes} byte limit`);
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`response exceeds ${maxBytes} byte limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function safeFetch(input, policy, options = {}) {
  const maxBytes = options.maxBytes ?? policy.maxPageBytes;
  let current = input;
  for (let redirect = 0; redirect <= 3; redirect++) {
    await assertSafeUrl(current, policy, options);
    let last;
    for (let attempt = 0; attempt <= policy.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
      try {
        const response = await (options.fetchImpl || fetch)(current, { headers: { 'user-agent': 'DesignSignal/1.0 (+local research assistant)', accept: options.accept || '*/*' }, redirect: 'manual', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new Error('redirect without location');
          current = new URL(location, current).href;
          last = { redirect: true };
          break;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await readBoundedBody(response, maxBytes);
        return { url: current, status: response.status, mime: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream', body, headers: response.headers };
      } catch (error) {
        last = error;
        if (attempt < policy.retries) await sleep(150 * 2 ** attempt);
      } finally { clearTimeout(timer); }
    }
    if (last?.redirect) continue;
    throw last;
  }
  throw new Error('too many redirects');
}

export const fetchJson = async (url, policy, options = {}) => {
  const response = await safeFetch(url, policy, { ...options, maxBytes: policy.maxJsonBytes, accept: 'application/json' });
  if (!/json|octet-stream/.test(response.mime)) throw new Error(`unexpected JSON MIME: ${response.mime}`);
  return { ...response, data: JSON.parse(response.body.toString('utf8')) };
};
