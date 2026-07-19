import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cachePublicAsset } from '../src/lib/cache.mjs';
import { persistSelectedAssets } from '../src/lib/assets.mjs';
import { loadConfig, parseCodexToml } from '../src/lib/config.mjs';
import { listingAdapter, collectSources } from '../src/lib/adapters.mjs';
import { handleDashboardRequest } from '../src/lib/server.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { daily } from '../src/lib/daily.mjs';
import { enrichItem } from '../src/lib/model.mjs';

const dnsLookup = async () => [{ address: '8.8.8.8' }];
const exists = file => stat(file).then(() => true, () => false);

test('cache validates binary signatures and stores complete public metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-hard-cache-'));
  const limits = { maxPdfBytes: 100, maxImageBytes: 100, maxPageBytes: 100 };
  await assert.rejects(() => cachePublicAsset(dir, { kind: 'image', url: 'https://example.com/x.jpg', mime: 'image/jpeg', accessStatus: 'public-page' }, Buffer.from('<html>not an image</html>'), limits), /HTML|image/);
  await assert.rejects(() => cachePublicAsset(dir, { kind: 'pdf', url: 'https://example.com/x.pdf', mime: 'application/pdf', accessStatus: 'open-access' }, Buffer.from('<html>not a pdf</html>'), limits), /HTML|PDF/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture')]);
  const meta = await cachePublicAsset(dir, { kind: 'image', url: 'https://example.com/x.png', mime: 'image/png', accessStatus: 'public-page', licenseStatus: 'publisher-owned', author: 'A', institution: 'I' }, png, limits);
  assert.deepEqual(Object.keys(meta).sort(), ['accessStatus', 'author', 'bytes', 'hash', 'institution', 'kind', 'licenseStatus', 'localCacheRef', 'mime', 'retrievedAt', 'url'].sort());
  assert.equal((await readFile(path.join(dir, 'cache', `${meta.hash}.bin`))).length, png.length); assert.equal(meta.localCacheRef, `/assets/${meta.hash}`);
  await rm(dir, { recursive: true, force: true });
});

test('selected live assets cache article, verified OA PDF and image while auditing refusal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-assets-'));
  const policy = { allowHosts: ['example.com'], timeoutMs: 100, retries: 0, maxPageBytes: 200, maxPdfBytes: 200, maxImageBytes: 200 };
  const base = { id: 'x', category: 'paper', source: { id: 's', name: 'S', url: 'https://example.com/article', locale: 'en' }, authors: ['A'], institution: 'I', rights: { access: 'open-access', licenseStatus: 'cc-by' }, oaPdf: 'https://example.com/paper.pdf' };
  const product = { ...structuredClone(base), id: 'p', category: 'product', source: { ...base.source, url: 'https://example.com/product' }, imageUrl: 'https://example.com/image.png', rights: { access: 'public-page', licenseStatus: 'linked-only' }, oaPdf: '' };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
  const fetchImpl = async url => {
    if (String(url).endsWith('.pdf')) return new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'application/pdf' } });
    if (String(url).endsWith('.png')) return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response('<html><article>public text</article></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const result = await persistSelectedAssets({ dataDir: dir, network: policy }, [base, product], { fetchImpl, dnsLookup });
  assert.equal(result.audit.filter(x => x.status === 'cached').length, 3);
  assert.ok(result.audit.some(x => x.kind === 'pdf' && x.status === 'failed'));
  assert.ok(result.byItem.get('p').some(x => x.kind === 'image'));
  let unsafePdfFetched = false;
  const unverified = { ...base, id: 'unverified', rights: { access: 'metadata-only' } };
  const refused = await persistSelectedAssets({ dataDir: dir, network: policy }, [unverified], { dnsLookup, fetchImpl: async url => { if (String(url).endsWith('.pdf')) unsafePdfFetched = true; return new Response('<html>public article</html>', { status: 200, headers: { 'content-type': 'text/html' } }); } });
  assert.equal(unsafePdfFetched, false); assert.ok(refused.audit.some(x => x.kind === 'pdf' && /OA status/.test(x.reason)));
  await rm(dir, { recursive: true, force: true });
});

test('cached route serves only hash-addressed verified assets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-route-'));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('route')]);
  const meta = await cachePublicAsset(dir, { kind: 'image', url: 'https://example.com/x.png', mime: 'image/png', accessStatus: 'public-page' }, png, { maxPdfBytes: 100, maxImageBytes: 100, maxPageBytes: 100 });
  const invoke = async url => {
    const result = { headers: {}, status: 0, body: Buffer.alloc(0) };
    const req = { method: 'GET', url, async *[Symbol.asyncIterator]() {} };
    const res = { setHeader(k, v) { result.headers[k] = v; }, writeHead(status, extra = {}) { result.status = status; Object.assign(result.headers, extra); }, end(value = '') { result.body = Buffer.isBuffer(value) ? value : Buffer.from(value); } };
    await handleDashboardRequest({ dataDir: dir }, req, res); return result;
  };
  const ok = await invoke(`/assets/${meta.hash}`); assert.equal(ok.status, 200); assert.equal(ok.headers['content-type'], 'image/png'); assert.deepEqual(ok.body, png);
  assert.equal((await invoke('/assets/../../etc/passwd')).status, 404);
  assert.equal((await invoke('/assets/not-a-hash')).status, 404);
  await rm(dir, { recursive: true, force: true });
});

test('Codex TOML provider loads with environment precedence and redaction-safe errors', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-codex-')), file = path.join(dir, 'config.toml');
  const auth = ['fixture', 'bearer', 'value'].join('-');
  await writeFile(file, `model = "codex-model"\nmodel_provider = "private_provider"\n[model_providers.private_provider]\nbase_url = "https://models.example.com/v1"\nwire_api = "responses"\nexperimental_bearer_token = "${auth}"\n`);
  const parsed = parseCodexToml(await readFile(file, 'utf8')); assert.equal(parsed.providers.private_provider.wire_api, 'responses');
  const fromCodex = await loadConfig({ env: { CODEX_CONFIG_FILE: file, DESIGNSIGNAL_DATA_DIR: path.join(dir, 'data') } });
  assert.equal(fromCodex.model.model, 'codex-model'); assert.equal(fromCodex.model.token, auth); assert.equal(fromCodex.model.baseUrl, 'https://models.example.com/v1');
  const fromHome = await loadConfig({ env: { CODEX_HOME: dir, DESIGNSIGNAL_DATA_DIR: path.join(dir, 'data') } }); assert.equal(fromHome.model.token, auth);
  const envCredential = ['env', 'fixture'].join('-');
  const fromEnv = await loadConfig({ env: { CODEX_CONFIG_FILE: file, OPENAI_MODEL: 'env-model', OPENAI_API_KEY: envCredential, OPENAI_BASE_URL: 'https://env.example/v1', DESIGNSIGNAL_DATA_DIR: path.join(dir, 'data') } });
  assert.deepEqual({ model: fromEnv.model.model, token: fromEnv.model.token, baseUrl: fromEnv.model.baseUrl, wireApi: fromEnv.model.wireApi }, { model: 'env-model', token: envCredential, baseUrl: 'https://env.example/v1', wireApi: 'responses' });
  await assert.rejects(() => loadConfig({ env: { CODEX_CONFIG_FILE: path.join(dir, 'missing.toml') } }), error => !error.message.includes(auth) && /CODEX_CONFIG_FILE/.test(error.message));
  await assert.rejects(() => loadConfig({ env: { OPENAI_BASE_URL: 'https://name:secret@models.example/v1' } }), error => error.message === 'invalid model base URL' && !error.message.includes('secret'));
  assert.throws(() => parseCodexToml('model = "one"\nmodel = "two"'), /duplicate/);
  await rm(dir, { recursive: true, force: true });
});

test('custom provider credentials never appear in model errors', async () => {
  const token = ['opaque', 'fixture', 'value'].join('-');
  const config = { model: { model: 'm', token, baseUrl: 'https://models.example/v1', wireApi: 'responses' }, network: { timeoutMs: 100, maxJsonBytes: 1024 } };
  await assert.rejects(() => enrichItem(fixtureCandidates[0], config, { fetchImpl: async () => { throw new Error(`transport accidentally included ${token}`); } }), error => /REDACTED/.test(error.message) && !error.message.includes(token));
});

test('institution listings emit dated candidates and optional source failures are explicit', async () => {
  const policy = { allowHosts: ['example.com'], timeoutMs: 100, retries: 0, maxPageBytes: 5000, maxFeedBytes: 5000 };
  const html = '<ul><li><time>2026-07-18</time><a href="/news/design-1">Design research news</a></li><li><a href="/about">Undated shell</a></li></ul>';
  const ctx = { dnsLookup, fetchImpl: async url => String(url).includes('broken') ? new Response('', { status: 503 }) : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) };
  const source = { id: 'institution-news', adapter: 'listing', url: 'https://example.com/news', locale: 'zh', category: 'frontier', institution: 'Example University' };
  const items = await listingAdapter(source, { network: policy }, ctx); assert.equal(items.length, 1); assert.equal(items[0].publishedAt, '2026-07-18'); assert.match(items[0].source.url, /design-1/);
  const collected = await collectSources({ network: policy, sources: [{ ...source, id: 'optional-zhihu', url: 'https://example.com/broken', optional: true }] }, ctx);
  assert.equal(collected.health[0].impact, 'optional-source-degraded'); assert.equal(collected.candidates.length, 0);
});

test('default sources use institution filters and deterministic zh/en policy', async () => {
  const config = await loadConfig({ env: {} });
  for (const name of ['tsinghua', 'zhejiang', 'tongji']) assert.ok(config.sources.some(x => x.id === `openalex-${name}` && /institutions\.id:/.test(x.url)));
  assert.ok(config.sources.filter(x => x.adapter === 'listing').every(x => !/^https?:\/\/(?:www\.)?(?:tsinghua|zju|tongji)\.edu\.cn\/?$/.test(x.url)));
  const selection = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] });
  assert.ok(selection.selected.some(x => x.source.locale === 'zh')); assert.ok(selection.selected.some(x => x.source.locale === 'en'));
  assert.deepEqual(selection.policy.originLanguage.required, ['zh', 'en']);
  const onlyEnglish = fixtureCandidates.map(x => ({ ...structuredClone(x), source: { ...x.source, locale: 'en' } }));
  assert.throws(() => selectDaily(onlyEnglish, { date: '2026-07-19', history: [] }), /origin-language supply/);
});

test('fixture runs never write even without dry-run', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ds-fixture-write-')), dataDir = path.join(parent, 'absent');
  const config = await loadConfig({ env: { DESIGNSIGNAL_DATA_DIR: dataDir } });
  const result = await daily(config, { fixture: true, date: '2026-07-19' });
  assert.equal(result.status, 'fixture-no-write'); assert.equal(await exists(dataDir), false);
  await rm(parent, { recursive: true, force: true });
});
