import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { sleep } from './util.mjs';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

export class HttpStatusError extends Error {
  constructor(status, retryable = false) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryable = retryable;
  }
}

function ipv4Number(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => (value * 256) + Number(part), 0);
}

function ipv6Number(address) {
  let value = String(address).toLowerCase().split('%', 1)[0];
  if (!value.includes(':')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parsePart = part => {
    if (!part) return [];
    const pieces = part.split(':');
    const output = [];
    for (const piece of pieces) {
      if (piece.includes('.')) {
        const mapped = ipv4Number(piece);
        if (mapped === null || output.length !== pieces.length - 1) return null;
        output.push((mapped >>> 16) & 0xffff, mapped & 0xffff);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) output.push(Number.parseInt(piece, 16));
      else return null;
    }
    return output;
  };
  const left = parsePart(halves[0]);
  const right = halves.length === 2 ? parsePart(halves[1]) : [];
  if (!left || !right || (halves.length === 1 && left.length !== 8) || (halves.length === 2 && left.length + right.length >= 8)) return null;
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
  return words.reduce((result, word) => (result << 16n) | BigInt(word), 0n);
}

function ipv6InRange(value, prefix, bits) {
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (value & mask) === (prefix & mask);
}

export function isPrivateAddress(address) {
  if (!isIP(address)) return true;
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    if (value === null) return true;
    const [a, b, c] = String(address).split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 168].includes(b)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113) || a >= 224 || value === 0;
  }
  const value = ipv6Number(address);
  if (value === null) return true;
  // IPv4-mapped IPv6 addresses must receive the same policy as their IPv4 form.
  if ((value >> 32n) === 0xffffn) {
    const mapped = Number(value & 0xffffffffn);
    return isPrivateAddress(`${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`);
  }
  return value === 0n || value === 1n
    || ipv6InRange(value, 0xfc00n << 112n, 7) // unique local
    || ipv6InRange(value, 0xfe80n << 112n, 10) // link-local
    || ipv6InRange(value, 0xff00n << 112n, 8) // multicast
    || ipv6InRange(value, 0x20010db8n << 96n, 32) // documentation
    || ipv6InRange(value, 0x20010000n << 96n, 23); // special-use/reserved blocks
}

export async function resolveSafeUrl(input, policy, { dnsLookup = lookup } = {}) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe URL scheme or credentials');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!(policy.allowHosts || []).includes(host)) throw new Error(`host not allowlisted: ${host}`);
  const resolved = isIP(host) ? [{ address: host, family: isIP(host) }] : await dnsLookup(host, { all: true, verbatim: true });
  const addresses = uniqueAddresses(resolved);
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error(`private or unresolved address blocked: ${host}`);
  return { url, host, addresses };
}

export async function assertSafeUrl(input, policy, options = {}) {
  return (await resolveSafeUrl(input, policy, options)).url;
}

export function createPinnedLookup(host, addresses, offset = 0) {
  const expected = host.toLowerCase().replace(/\.$/, '');
  const values = rotate(uniqueAddresses(addresses), offset);
  if (!values.length || values.some(item => isPrivateAddress(item.address))) throw new Error(`private or unresolved address blocked: ${expected}`);
  return (hostname, options, callback) => {
    const actual = String(hostname || '').toLowerCase().replace(/\.$/, '');
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'object' && options ? options : {};
    if (actual !== expected) return done(Object.assign(new Error('pinned lookup host mismatch'), { code: 'ENOTFOUND' }));
    const family = Number(settings.family || 0);
    const matches = family ? values.filter(item => item.family === family) : values;
    if (!matches.length) return done(Object.assign(new Error('pinned lookup family unavailable'), { code: 'ENOTFOUND' }));
    return settings.all ? done(null, matches.map(item => ({ ...item }))) : done(null, matches[0].address, matches[0].family);
  };
}

export async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`response exceeds ${maxBytes} byte limit`);
  const chunks = []; let total = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) throw new Error(`response exceeds ${maxBytes} byte limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function safeFetch(input, policy, options = {}) {
  const maxBytes = options.maxBytes ?? policy.maxPageBytes;
  const method = String(options.method || 'GET').toUpperCase();
  const retryLimit = Math.max(0, Number(options.retries ?? (['GET', 'HEAD'].includes(method) ? policy.retries : 0)) || 0);
  const sleepImpl = options.sleepImpl || sleep;
  let current = input;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const resolved = await resolveSafeUrl(current, policy, options);
    let redirected = false;
    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
      let response;
      try {
        response = await transport(resolved, {
          method, headers: { 'user-agent': 'DesignSignal/1.0 (+local research assistant)', accept: options.accept || '*/*', ...(options.headers || {}) },
          body: options.body, redirect: 'manual', signal: controller.signal
        }, options, attempt);
      } catch (error) {
        clearTimeout(timer);
        if (attempt >= retryLimit) throw error;
        await sleepImpl(backoffDelay(attempt, policy));
        continue;
      }
      try {
        if (REDIRECTS.has(response.status)) {
          if (!['GET', 'HEAD'].includes(method)) {
            await discardBody(response);
            throw new Error('redirect for side-effecting request blocked');
          }
          const location = response.headers.get('location');
          await discardBody(response);
          if (!location) throw new Error('redirect without location');
          current = new URL(location, current).href;
          redirected = true;
          break;
        }
        if (!response.ok) {
          const retryable = RETRYABLE_STATUSES.has(response.status) || response.status >= 500;
          const delay = retryDelay(response, attempt, policy, options);
          await discardBody(response);
          if (!retryable || attempt >= retryLimit) throw new HttpStatusError(response.status, retryable);
          clearTimeout(timer);
          await sleepImpl(delay);
          continue;
        }
        const body = await readBoundedBody(response, maxBytes);
        return { url: current, status: response.status, mime: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream', body, headers: response.headers };
      } finally {
        clearTimeout(timer);
      }
    }
    if (redirected) continue;
  }
  throw new Error('too many redirects');
}

export const fetchJson = async (url, policy, options = {}) => {
  const response = await safeFetch(url, policy, { ...options, maxBytes: policy.maxJsonBytes, accept: 'application/json' });
  if (!/json|octet-stream/.test(response.mime)) throw new Error(`unexpected JSON MIME: ${response.mime}`);
  return { ...response, data: JSON.parse(response.body.toString('utf8')) };
};

function transport(resolved, init, options, attempt) {
  if (options.fetchImpl) return options.fetchImpl(resolved.url.href, init);
  if (options.requestImpl) return options.requestImpl(resolved.url.href, init, { host: resolved.host, addresses: resolved.addresses, attempt });
  return pinnedRequest(resolved, init, attempt);
}

function pinnedRequest(resolved, init, attempt) {
  return new Promise((resolve, reject) => {
    const request = resolved.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(resolved.url, {
      method: init.method, headers: init.headers, signal: init.signal, agent: false,
      lookup: createPinnedLookup(resolved.host, resolved.addresses, attempt)
    }, response => resolve({
      status: response.statusCode || 0, ok: response.statusCode >= 200 && response.statusCode < 300, body: response,
      headers: { get: name => headerValue(response.headers[String(name).toLowerCase()]) }
    }));
    req.on('error', reject);
    if (init.body !== undefined && init.body !== null) req.write(init.body);
    req.end();
  });
}

function retryDelay(response, attempt, policy, options) {
  const raw = response.headers.get('retry-after');
  const seconds = /^\d+$/.test(String(raw || '').trim()) ? Number(raw) * 1000 : NaN;
  const date = raw && !Number.isFinite(seconds) ? Date.parse(raw) - Number(options.now?.() ?? Date.now()) : NaN;
  const requested = Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? Math.max(0, date) : backoffDelay(attempt, policy);
  return Math.min(Number(policy.maxRetryAfterMs || 30000), requested);
}
function backoffDelay(attempt, policy) { return Math.min(Number(policy.maxRetryDelayMs || 30000), 150 * 2 ** attempt); }
function headerValue(value) { return Array.isArray(value) ? value.join(', ') : value === undefined ? null : String(value); }
function uniqueAddresses(values) { const seen = new Set(); return (values || []).map(item => ({ address: String(item?.address || ''), family: Number(item?.family || isIP(item?.address)) })).filter(item => item.address && item.family && !seen.has(`${item.family}:${item.address}`) && seen.add(`${item.family}:${item.address}`)); }
function rotate(values, offset) { if (!values.length) return []; const index = Math.abs(Number(offset) || 0) % values.length; return [...values.slice(index), ...values.slice(0, index)]; }
async function discardBody(response) { try { if (typeof response.body?.cancel === 'function') await response.body.cancel(); else response.body?.destroy?.(); } catch {} }
