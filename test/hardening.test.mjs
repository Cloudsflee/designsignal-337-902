import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cachePublicAsset } from '../src/lib/cache.mjs';
import { attachCachedAssets, persistSelectedAssets } from '../src/lib/assets.mjs';
import { loadConfig, parseCodexToml } from '../src/lib/config.mjs';
import { listingAdapter, collectSources, openAlexAdapter } from '../src/lib/adapters.mjs';
import { handleDashboardRequest } from '../src/lib/server.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { daily } from '../src/lib/daily.mjs';
import { enrichItem } from '../src/lib/model.mjs';
import { renderHtml } from '../src/lib/render.mjs';
import { buildReport } from '../src/lib/report.mjs';

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
  const fixtureToml = await readFile(path.join(import.meta.dirname, '../fixtures/codex-config.toml'), 'utf8');
  const [providerFixture, ignoredFixture] = fixtureToml.split(/\r?\n\[ui\]\r?\n/);
  const authSetting = ['experimental', 'bearer', 'token'].join('_');
  const auth = ['harmless', 'runtime', 'fixture', 'value'].join('-');
  const providerToml = [providerFixture, `${authSetting} = ${JSON.stringify(auth)}`, '[ui]', ignoredFixture].join('\n');
  assert.ok(ignoredFixture);
  await writeFile(file, providerToml);
  const parsed = parseCodexToml(await readFile(file, 'utf8'));
  assert.deepEqual(parsed, {
    model: 'fixture-codex-model',
    model_provider: 'fixture_responses',
    providers: { fixture_responses: { base_url: 'https://fixture-models.example/v1', wire_api: 'responses', experimental_bearer_token: auth } }
  });
  const fromCodex = await loadConfig({ env: { CODEX_CONFIG_FILE: file, DESIGNSIGNAL_DATA_DIR: path.join(dir, 'data') } });
  assert.equal(fromCodex.model.model, 'fixture-codex-model'); assert.equal(fromCodex.model.token, auth); assert.equal(fromCodex.model.baseUrl, 'https://fixture-models.example/v1');
  assert.ok(!JSON.stringify(fromCodex).includes('ignored-ui.example'));
  assert.ok(!JSON.stringify(fromCodex).includes('ignored-hook-marker'));
  const fromHome = await loadConfig({ env: { CODEX_HOME: dir, DESIGNSIGNAL_DATA_DIR: path.join(dir, 'data') } }); assert.equal(fromHome.model.token, auth);
  const envCredential = ['env', 'fixture'].join('-');
  const fromEnv = await loadConfig({ env: { CODEX_CONFIG_FILE: file, OPENAI_MODEL: 'env-model', OPENAI_API_KEY: envCredential, OPENAI_BASE_URL: 'https://env.example/v1', DESIGNSIGNAL_DATA_DIR: path.join(dir, 'data') } });
  assert.deepEqual({ model: fromEnv.model.model, token: fromEnv.model.token, baseUrl: fromEnv.model.baseUrl, wireApi: fromEnv.model.wireApi }, { model: 'env-model', token: envCredential, baseUrl: 'https://env.example/v1', wireApi: 'responses' });
  await assert.rejects(() => loadConfig({ env: { CODEX_CONFIG_FILE: path.join(dir, 'missing.toml') } }), error => !error.message.includes(auth) && /CODEX_CONFIG_FILE/.test(error.message));
  const urlPassword = ['fixture', 'url', 'value'].join('-');
  const credentialedBaseUrl = ['https://name', urlPassword, '@models.example/v1'].join(':');
  await assert.rejects(() => loadConfig({ env: { OPENAI_BASE_URL: credentialedBaseUrl } }), error => error.message === 'invalid model base URL' && !error.message.includes(urlPassword));
  assert.throws(() => parseCodexToml('model = "one"\nmodel = "two"'), /duplicate/);
  const malformedCredential = ['malformed', 'credential', 'fixture'].join('-');
  for (const malformed of [
    'model_provider = "p"\n[model_providers.p]\nbase_url = true',
    'model_provider = "p"\n[model_providers.p]\nwire_api =',
    `model_provider = "p"\n[model_providers.p]\n${authSetting} = "${malformedCredential}`,
    'model_provider = "p"\n[model_providers.p]\nwire_api = "responses"\nwire_api = "chat"'
  ]) assert.throws(() => parseCodexToml(malformed), error => /invalid|duplicate/.test(error.message) && !error.message.includes(malformedCredential));
  await rm(dir, { recursive: true, force: true });
});

test('custom provider credentials never appear in model errors', async () => {
  const token = ['opaque', 'fixture', 'value'].join('-');
  const config = { model: { model: 'm', token, baseUrl: 'https://models.example/v1', wireApi: 'responses' }, network: { timeoutMs: 100, maxJsonBytes: 1024 } };
  await assert.rejects(() => enrichItem(fixtureCandidates[0], config, { fetchImpl: async () => { throw new Error(`transport accidentally included ${token}`); }, sleepImpl: async () => {} }), error => /REDACTED/.test(error.message) && !error.message.includes(token));
});

test('institution listings emit dated candidates and optional source failures are explicit', async () => {
  const policy = { allowHosts: ['example.com'], timeoutMs: 100, retries: 0, maxPageBytes: 5000, maxFeedBytes: 5000 };
  const html = '<ul><li><time>2026-07-18</time><a href="/news/design-1">Design research news</a></li><li><a href="/about">Undated shell</a></li></ul>';
  const ctx = { dnsLookup, fetchImpl: async url => String(url).includes('broken') ? new Response('', { status: 503 }) : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) };
  const source = { id: 'institution-news', adapter: 'listing', url: 'https://example.com/news', locale: 'zh', category: 'frontier', institution: 'Example University' };
  const items = await listingAdapter(source, { network: policy }, ctx); assert.equal(items.length, 1); assert.equal(items[0].publishedAt, '2026-07-18'); assert.match(items[0].source.url, /design-1/); assert.equal(items[0].source.locale, 'en');
  const collected = await collectSources({ network: policy, sources: [{ ...source, id: 'optional-zhihu', url: 'https://example.com/broken', optional: true }] }, ctx);
  assert.equal(collected.health[0].impact, 'optional-source-degraded'); assert.equal(collected.candidates.length, 0);
});

test('default sources use exact combined institution IDs and corrected public feeds', async () => {
  const config = await loadConfig({ env: {} });
  const institutions = config.sources.filter(x => /institutions\.id:/.test(x.url));
  assert.equal(institutions.length, 1);
  assert.equal(new URL(institutions[0].url).searchParams.get('filter').split('institutions.id:')[1], 'I99065089|I76130692|I116953780');
  assert.equal(config.sources.find(x => x.id === 'tsinghua-design-news').url, 'https://www.ad.tsinghua.edu.cn/xw/xwdt.htm');
  assert.equal(config.sources.find(x => x.id === 'core77').url, 'https://www.core77.com/rss.xml');
  assert.equal(config.sources.find(x => x.id === 'sspai').url, 'https://sspai.com/feed');
  assert.ok(config.sources.filter(x => x.adapter === 'listing').every(x => x.optional));
  assert.ok(config.sources.filter(x => x.adapter === 'listing').every(x => !/^https?:\/\/(?:www\.)?(?:tsinghua|zju|tongji)\.edu\.cn\/?$/.test(x.url)));
});

test('selection uses candidate language policy and rejects dates over 24 hours in the future', () => {
  const selection = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] });
  assert.ok(selection.selected.some(x => x.source.locale === 'zh')); assert.ok(selection.selected.some(x => x.source.locale === 'en'));
  assert.deepEqual(selection.policy.originLanguage.required, ['zh', 'en']);
  const onlyEnglish = fixtureCandidates.map(x => ({ ...structuredClone(x), source: { ...x.source, locale: 'en' } }));
  assert.throws(() => selectDaily(onlyEnglish, { date: '2026-07-19', history: [] }), /origin-language supply/);
  const future = structuredClone(fixtureCandidates[0]);
  future.id = 'future-paper'; future.source = { ...future.source, id: 'future', url: 'https://arxiv.org/abs/2607.99998' }; future.publishedAt = '2026-07-21T16:00:01.000Z';
  const withFuture = selectDaily([...fixtureCandidates, future], { date: '2026-07-19', history: [] });
  assert.ok(withFuture.rejected.some(x => x.id === future.id && x.reason === 'future-dated'));
});

test('OpenAlex work language overrides Chinese institution locale and auth stays request-only', async () => {
  const apiKey = ['openalex', 'fixture', 'value'].join('-');
  const mailto = ['request', 'example.test'].join('@');
  const source = { id: 'oa-institutions', name: 'Chinese institutions', adapter: 'openalex', url: 'https://api.openalex.org/works?filter=institutions.id:I116953780', locale: 'zh', category: 'paper' };
  const network = { allowHosts: ['api.openalex.org'], timeoutMs: 100, retries: 0, maxJsonBytes: 10000, maxPageBytes: 10000 };
  let requested = '';
  const data = { results: [
    { id: 'https://openalex.org/W1', language: 'en', title: 'Designing accessible public services', publication_date: '2026-07-18', authorships: [{ author: { display_name: 'A' }, institutions: [{ id: 'https://openalex.org/I116953780', display_name: 'Tongji University' }] }], open_access: { is_oa: false } },
    { id: 'https://openalex.org/W2', language: 'fr', title: 'An English-looking translated title', publication_date: '2026-07-18', authorships: [], open_access: { is_oa: false } }
  ] };
  const items = await openAlexAdapter(source, { network, openAlex: { apiKey, mailto } }, { dnsLookup, fetchImpl: async url => { requested = String(url); return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  assert.equal(items[0].source.locale, 'en');
  assert.equal(items[0].source.languageProvenance.method, 'declared');
  assert.equal(items[0].institution, 'Tongji University');
  assert.equal(items[1].source.locale, 'unknown'); assert.equal(items[1].source.languageProvenance.method, 'declared-unsupported');
  assert.equal(new URL(requested).searchParams.get('api_key'), apiKey);
  assert.equal(new URL(requested).searchParams.get('mailto'), mailto);
  assert.ok(!JSON.stringify(items).includes(apiKey)); assert.ok(!JSON.stringify(items).includes(mailto));
  assert.equal(source.url, 'https://api.openalex.org/works?filter=institutions.id:I116953780');
});

test('OpenAlex 429 and budget exhaustion are audited while arXiv fallback continues', async () => {
  const secret = ['health', 'fixture', 'value'].join('-');
  const mailto = ['audit', 'example.test'].join('@');
  const network = { allowHosts: ['api.openalex.org', 'export.arxiv.org'], timeoutMs: 100, retries: 0, maxJsonBytes: 10000, maxFeedBytes: 10000, maxPageBytes: 10000, openAlexRequestBudget: 1 };
  const sources = [
    { id: 'oa-rate-limited', adapter: 'openalex', url: 'https://api.openalex.org/works?filter=x', category: 'paper', locale: 'en' },
    { id: 'oa-over-budget', adapter: 'openalex', url: 'https://api.openalex.org/works?filter=y', category: 'paper', locale: 'en' },
    { id: 'arxiv-fallback', adapter: 'arxiv', url: 'https://export.arxiv.org/api/query?q=x', category: 'paper', locale: 'en' }
  ];
  const atom = '<feed><entry><id>https://arxiv.org/abs/2607.00001</id><title>Fallback design paper</title><summary>Evidence from a public repository.</summary><published>2026-07-18T00:00:00Z</published><author><name>A</name></author></entry></feed>';
  const result = await collectSources({ network, sources, openAlex: { apiKey: secret, mailto } }, { dnsLookup, fetchImpl: async url => String(url).includes('openalex') ? new Response('', { status: 429 }) : new Response(atom, { status: 200, headers: { 'content-type': 'application/atom+xml' } }) });
  assert.match(result.health.find(x => x.sourceId === 'oa-rate-limited').reason, /429.*budget/i);
  assert.match(result.health.find(x => x.sourceId === 'oa-over-budget').reason, /budget exhausted/i);
  assert.equal(result.health.find(x => x.sourceId === 'arxiv-fallback').status, 'ok');
  assert.equal(result.candidates.length, 1);
  const healthJson = JSON.stringify(result.health);
  assert.ok(!healthJson.includes(secret)); assert.ok(!healthJson.includes(mailto)); assert.ok(!healthJson.includes(encodeURIComponent(mailto)));
});

test('anchor-window listings support nested markup and required zero-item sources are empty', async () => {
  const policy = { allowHosts: ['example.com'], timeoutMs: 100, retries: 0, maxPageBytes: 10000, maxFeedBytes: 10000 };
  const nested = '<main><article><time datetime="2026-07-18">2026年7月18日</time><div><h2><a href="/nested"><span>嵌套设计研究</span></a></h2></div></article></main>';
  const source = { id: 'nested-news', adapter: 'listing', url: 'https://example.com/news', locale: 'en', category: 'frontier' };
  const items = await listingAdapter(source, { network: policy }, { dnsLookup, fetchImpl: async () => new Response(nested, { status: 200, headers: { 'content-type': 'text/html' } }) });
  assert.equal(items.length, 1); assert.equal(items[0].title, '嵌套设计研究'); assert.equal(items[0].source.locale, 'zh'); assert.equal(items[0].source.languageProvenance.method, 'inferred-script');
  const empty = await collectSources({ network: policy, sources: [source] }, { dnsLookup, fetchImpl: async () => new Response('<nav><a href="/about">About</a></nav>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  assert.equal(empty.health[0].status, 'empty'); assert.equal(empty.health[0].impact, 'required-source-empty');
});

test('cached images render only their local cache reference and retain remote provenance', async () => {
  const selected = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] });
  const product = selected.selected.find(x => x.category === 'product');
  const remoteUrl = product.image.url, hash = 'a'.repeat(64);
  attachCachedAssets(product, [{ kind: 'image', url: remoteUrl, mime: 'image/jpeg', hash, bytes: 12, retrievedAt: '2026-07-19T00:00:00Z', author: 'A', institution: 'I', accessStatus: 'public-feed', licenseStatus: 'linked-only', localCacheRef: `/assets/${hash}` }]);
  const report = await buildReport({ date: '2026-07-19', items: selected.selected, rejected: selected.rejected, health: [], selectionPolicy: selected.policy, fixture: true });
  const html = renderHtml(report);
  assert.equal(product.image.remoteUrl, remoteUrl);
  assert.match(html, new RegExp(`src="/assets/${hash}"`));
  assert.ok(!html.includes(`src="${remoteUrl}"`));
});

test('fixture runs never write even without dry-run', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ds-fixture-write-')), dataDir = path.join(parent, 'absent');
  const config = await loadConfig({ env: { DESIGNSIGNAL_DATA_DIR: dataDir } });
  const result = await daily(config, { fixture: true, date: '2026-07-19' });
  assert.equal(result.status, 'fixture-no-write'); assert.equal(await exists(dataDir), false);
  await rm(parent, { recursive: true, force: true });
});
