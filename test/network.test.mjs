import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl, createPinnedLookup, HttpStatusError, isPrivateAddress, safeFetch } from '../src/lib/network.mjs';
import { cachePublicAsset } from '../src/lib/cache.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const policy = { allowHosts: ['example.com'], timeoutMs: 100, retries: 0, maxPageBytes: 8 };
test('private, link-local, mapped, documentation and CGNAT addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '192.0.2.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:10.0.0.1', '::ffff:192.168.1.1']) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
});

test('SSRF guard enforces allowlist and rejects private DNS results', async () => {
  await assert.rejects(() => assertSafeUrl('https://not.example/x', policy, { dnsLookup: async () => [{ address: '8.8.8.8' }] }), /allowlisted/);
  await assert.rejects(() => assertSafeUrl('https://example.com/x', policy, { dnsLookup: async () => [{ address: '127.0.0.1' }] }), /private/);
  await assertSafeUrl('https://example.com/x', policy, { dnsLookup: async () => [{ address: '8.8.8.8' }] });
});

test('bounded fetch rejects an oversized streamed response', async () => {
  const fetchImpl = async () => new Response(new Uint8Array(9), { status: 200, headers: { 'content-type': 'text/plain' } });
  await assert.rejects(() => safeFetch('https://example.com/x', policy, { fetchImpl, dnsLookup: async () => [{ address: '8.8.8.8' }], maxBytes: 8 }), /byte limit/);
});

test('pinned lookup only returns the addresses that passed validation', async () => {
  const pinned = createPinnedLookup('example.com', [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }]);
  const one = await new Promise((resolve, reject) => pinned('example.com', { family: 4 }, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  const all = await new Promise((resolve, reject) => pinned('example.com', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(one, { address: '8.8.8.8', family: 4 });
  assert.deepEqual(all, [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }]);
  await assert.rejects(() => new Promise((resolve, reject) => pinned('other.example', {}, error => error ? reject(error) : resolve())), /host mismatch/);
});

test('safe fetch resolves once and carries the validated address set into transport', async () => {
  let dnsCalls = 0;
  const requestImpl = async (_url, _init, target) => {
    assert.equal(target.host, 'example.com');
    assert.deepEqual(target.addresses, [{ address: '8.8.8.8', family: 4 }]);
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const result = await safeFetch('https://example.com/x', policy, {
    dnsLookup: async () => { dnsCalls++; return [{ address: dnsCalls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]; }, requestImpl
  });
  assert.equal(result.body.toString(), 'ok');
  assert.equal(dnsCalls, 1);
});

test('status-aware retries do not replay 404 or POST and honor bounded Retry-After', async () => {
  const sleeps = []; let getCalls = 0;
  const get = await safeFetch('https://example.com/x', { ...policy, retries: 3, maxRetryAfterMs: 25 }, {
    dnsLookup: publicDns,
    sleepImpl: async delay => sleeps.push(delay),
    requestImpl: async () => ++getCalls === 1
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '999' } })
      : new Response('ok', { status: 200 })
  });
  assert.equal(get.body.toString(), 'ok');
  assert.deepEqual(sleeps, [25]);
  let notFoundCalls = 0;
  await assert.rejects(() => safeFetch('https://example.com/missing', { ...policy, retries: 3 }, {
    dnsLookup: publicDns, requestImpl: async () => { notFoundCalls++; return new Response('', { status: 404 }); }
  }), error => error instanceof HttpStatusError && error.status === 404 && !error.retryable);
  assert.equal(notFoundCalls, 1);
  let postCalls = 0;
  await assert.rejects(() => safeFetch('https://example.com/write', { ...policy, retries: 3 }, {
    method: 'POST', body: '{}', dnsLookup: publicDns,
    requestImpl: async () => { postCalls++; return new Response('', { status: 503 }); }
  }), error => error instanceof HttpStatusError && error.status === 503 && error.retryable);
  assert.equal(postCalls, 1);
  await assert.rejects(() => safeFetch('https://example.com/redirect', { ...policy, retries: 0 }, {
    method: 'POST', body: '{}', dnsLookup: publicDns,
    requestImpl: async () => new Response('', { status: 307, headers: { location: 'https://example.com/next' } })
  }), /side-effecting request blocked/);
});

test('request timeout remains active while the response body is streaming', async () => {
  const slowPolicy = { ...policy, timeoutMs: 15, maxPageBytes: 100 };
  await assert.rejects(() => safeFetch('https://example.com/slow', slowPolicy, {
    dnsLookup: publicDns,
    requestImpl: async (_url, init) => ({
      status: 200, ok: true, headers: new Headers({ 'content-type': 'text/plain' }),
      body: { async *[Symbol.asyncIterator]() {
        await new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
        yield Buffer.from('late');
      } }
    })
  }), error => error?.name === 'AbortError');
});

test('cache only admits bounded public data and OA PDFs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-cache-'));
  const limits = { maxPdfBytes: 10, maxImageBytes: 10, maxPageBytes: 10 };
  await assert.rejects(() => cachePublicAsset(dir, { url: 'https://example.com/a.pdf', mime: 'application/pdf', accessStatus: 'public-page' }, Buffer.from('pdf'), limits), /OA/);
  const pdf = Buffer.from('%PDF-1.7\n');
  const meta = await cachePublicAsset(dir, { url: 'https://example.com/a.pdf', mime: 'application/pdf', accessStatus: 'open-access', licenseStatus: 'cc-by', author: 'A', institution: 'I' }, pdf, limits);
  assert.equal(meta.bytes, pdf.length); assert.match(meta.hash, /^[a-f0-9]{64}$/);
  await rm(dir, { recursive: true, force: true });
});

const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
