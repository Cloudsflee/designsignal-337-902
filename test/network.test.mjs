import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl, isPrivateAddress, safeFetch } from '../src/lib/network.mjs';
import { cachePublicAsset } from '../src/lib/cache.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const policy = { allowHosts: ['example.com'], timeoutMs: 100, retries: 0, maxPageBytes: 8 };
test('private, link-local, mapped, documentation and CGNAT addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '192.0.2.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
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

test('cache only admits bounded public data and OA PDFs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-cache-'));
  const limits = { maxPdfBytes: 10, maxImageBytes: 10, maxPageBytes: 10 };
  await assert.rejects(() => cachePublicAsset(dir, { url: 'https://example.com/a.pdf', mime: 'application/pdf', accessStatus: 'public-page' }, Buffer.from('pdf'), limits), /OA/);
  const pdf = Buffer.from('%PDF-1.7\n');
  const meta = await cachePublicAsset(dir, { url: 'https://example.com/a.pdf', mime: 'application/pdf', accessStatus: 'open-access', licenseStatus: 'cc-by', author: 'A', institution: 'I' }, pdf, limits);
  assert.equal(meta.bytes, pdf.length); assert.match(meta.hash, /^[a-f0-9]{64}$/);
  await rm(dir, { recursive: true, force: true });
});
