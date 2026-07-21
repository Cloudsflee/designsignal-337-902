import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { enrichItem, enrichItems } from '../src/lib/model.mjs';

const raw = fixtureCandidates[0];
const validOutput = item => ({ title: item.title, synopsis: item.synopsis, analysis: item.analysis, exam: item.exam, confidence: item.confidence });
const okResponse = item => new Response(JSON.stringify({ output_text: JSON.stringify(validOutput(item)) }), { status: 200, headers: { 'content-type': 'application/json' } });
const modelCredential = ['model', 'fixture', 'value'].join('-');
const modelConfig = model => ({
  model: { model: 'test-model', token: modelCredential, baseUrl: 'https://models.example/v1', wireApi: 'responses', maxOutputTokens: 6000, concurrency: 2, timeoutMs: 180000, ...model },
  network: { timeoutMs: 17, maxJsonBytes: 1024 * 1024 }
});

test('model concurrency and timeout settings have safe defaults and validated ranges', async () => {
  const defaults = await loadConfig({ env: {} });
  assert.equal(defaults.model.concurrency, 2);
  assert.equal(defaults.model.timeoutMs, 180000);
  const configured = await loadConfig({ env: { DESIGNSIGNAL_MODEL_CONCURRENCY: '4', DESIGNSIGNAL_MODEL_TIMEOUT_MS: '600000' } });
  assert.equal(configured.model.concurrency, 4);
  assert.equal(configured.model.timeoutMs, 600000);
  for (const value of ['0', '5', '1.5', 'no']) await assert.rejects(() => loadConfig({ env: { DESIGNSIGNAL_MODEL_CONCURRENCY: value } }), /model concurrency/);
  for (const value of ['9999', '600001', '10000.5', 'no']) await assert.rejects(() => loadConfig({ env: { DESIGNSIGNAL_MODEL_TIMEOUT_MS: value } }), /model timeout/);
});

test('429, 503, and abort failures use injected bounded backoff and at most three attempts', async t => {
  await t.test('429 honors numeric Retry-After', async () => {
    let calls = 0; const delays = [];
    const fetchImpl = async () => ++calls === 1
      ? new Response('private response body', { status: 429, headers: { 'retry-after': '7' } })
      : okResponse(raw);
    await enrichItem(raw, modelConfig(), { fetchImpl, sleepImpl: async delay => delays.push(delay) });
    assert.equal(calls, 2); assert.deepEqual(delays, [7000]);
  });
  await t.test('503 uses exponential backoff', async () => {
    let calls = 0; const delays = [];
    const fetchImpl = async () => ++calls < 3 ? new Response('', { status: 503 }) : okResponse(raw);
    await enrichItem(raw, modelConfig(), { fetchImpl, sleepImpl: async delay => delays.push(delay) });
    assert.equal(calls, 3); assert.deepEqual(delays, [1000, 2000]);
  });
  await t.test('AbortError uses exponential backoff', async () => {
    let calls = 0; const delays = [];
    const fetchImpl = async () => {
      if (++calls < 3) throw Object.assign(new Error('provider abort detail'), { name: 'AbortError' });
      return okResponse(raw);
    };
    await enrichItem(raw, modelConfig(), { fetchImpl, sleepImpl: async delay => delays.push(delay) });
    assert.equal(calls, 3); assert.deepEqual(delays, [1000, 2000]);
  });
});

test('nonretryable 4xx stops immediately and all model error text is redacted', async () => {
  const credential = ['private', 'fixture', 'marker'].join('-');
  const requestMarker = 'request-private-marker';
  const responseMarker = 'response-private-marker';
  const queryMarker = 'query-private-marker';
  const privateRaw = structuredClone(raw);
  privateRaw.synopsis.en = requestMarker;
  let calls = 0;
  const config = modelConfig({ token: credential, baseUrl: `https://models.example/v1?private=${queryMarker}` });
  await assert.rejects(
    () => enrichItem(privateRaw, config, { fetchImpl: async () => { calls++; return new Response(responseMarker, { status: 400 }); }, sleepImpl: async () => assert.fail('400 must not sleep') }),
    error => error.message === 'structured model output failed: model HTTP 400'
      && ![credential, requestMarker, responseMarker, queryMarker].some(marker => error.message.includes(marker))
  );
  assert.equal(calls, 1);

  const transportMarker = 'transport-private-marker';
  await assert.rejects(
    () => enrichItem(raw, config, { fetchImpl: async () => { throw new Error(`${transportMarker} ${credential} ${config.model.baseUrl}`); }, sleepImpl: async () => {} }),
    error => /\[REDACTED\]/.test(error.message) && ![transportMarker, credential, queryMarker, config.model.baseUrl].some(marker => error.message.includes(marker))
  );
});

test('model timeout uses the model setting and retries through injected timers', async () => {
  const timeoutMs = 45678, timerDelays = [], backoffDelays = [];
  const setTimeoutImpl = (callback, delay) => { timerDelays.push(delay); queueMicrotask(callback); return Symbol('timer'); };
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('abort detail'), { name: 'AbortError' })), { once: true });
  });
  await assert.rejects(
    () => enrichItem(raw, modelConfig({ timeoutMs }), { fetchImpl, setTimeoutImpl, clearTimeoutImpl: () => {}, sleepImpl: async delay => backoffDelays.push(delay) }),
    error => /timed out \[REDACTED\]/.test(error.message)
  );
  assert.deepEqual(timerDelays, [timeoutMs, timeoutMs, timeoutMs]);
  assert.deepEqual(backoffDelays, [1000, 2000]);
});

test('item analysis stops scheduling after failure and exposes only the public item ID', async () => {
  const selected = fixtureCandidates.slice(0, 4);
  let calls = 0, releaseSecond;
  const second = new Promise(resolve => { releaseSecond = resolve; });
  const fetchImpl = async (_url, init) => {
    const candidate = JSON.parse(JSON.parse(init.body).input).candidate;
    calls++;
    if (candidate.id === selected[0].id) return new Response('private provider body', { status: 400 });
    await second;
    return okResponse(candidate);
  };
  const pending = enrichItems(selected, modelConfig(), { fetchImpl, sleepImpl: async () => {} });
  await new Promise(resolve => setImmediate(resolve));
  releaseSecond();
  await assert.rejects(pending, error => error.message === `model analysis failed for item ${selected[0].id}`);
  assert.equal(calls, 2);
});
