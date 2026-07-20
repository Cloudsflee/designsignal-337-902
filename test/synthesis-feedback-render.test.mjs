import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { enrichItems, synthesizeDaily } from '../src/lib/model.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { appendFeedback, loadRecentFeedback, loadStudyProfile, validateFeedback } from '../src/lib/study.mjs';
import { validateReport } from '../src/lib/schema.mjs';
import { renderHtml, renderMarkdown } from '../src/lib/render.mjs';
import { handleDashboardRequest } from '../src/lib/server.mjs';

const selectedFixture = () => selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] });
async function fixtureReport() {
  const selection = selectedFixture();
  return buildReport({ date: '2026-07-19', items: selection.selected, rejected: selection.rejected, health: [], selectionPolicy: selection.policy, fixture: true });
}
const synthesisOutput = report => ({ overview: report.synthesis.overview, patterns: report.synthesis.patterns, hypotheses: report.synthesis.hypotheses, exercise: report.exercise });
const response = output => new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitFor = async predicate => { for (let index = 0; index < 100 && !predicate(); index++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'condition did not become true'); };

test('six concurrency-limited item calls preserve order and precede the seventh synthesis call', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-synthesis-'));
  const profileFile = path.join(dir, 'profile.json');
  const privateMarker = ['profile', 'private', 'marker'].join('-');
  const modelCredential = ['model', 'fixture', 'value'].join('-');
  await writeFile(profileFile, JSON.stringify({ directions: ['systems'], weaknesses: ['evidence'], dailyMinutes: 90, secret: privateMarker }));
  const config = await loadConfig({ env: { DESIGNSIGNAL_DATA_DIR: dir, DESIGNSIGNAL_STUDY_PROFILE_FILE: profileFile, OPENAI_MODEL: 'test', OPENAI_API_KEY: modelCredential, OPENAI_BASE_URL: 'https://models.example/v1', DESIGNSIGNAL_MODEL_MAX_OUTPUT_TOKENS: '4321' } });
  config.study.recentFeedbackCount = 2;
  for (let index = 0; index < 3; index++) await appendFeedback(config, { date: `2026-07-${16 + index}`, comprehension: 60 + index, transfer: 50, exercise: 70, minutes: 45, weakPoints: [`weak-${index}`], note: `note-${index}` }, new Date('2026-07-19T12:00:00Z'));
  const report = await fixtureReport();
  const bodies = [], pending = new Map(), completionOrder = [];
  let active = 0, maxActive = 0;
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body); bodies.push(request);
    const input = JSON.parse(request.input);
    if (input.candidate) {
      const raw = input.candidate;
      active++; maxActive = Math.max(maxActive, active);
      const gate = deferred(); pending.set(raw.id, gate); await gate.promise;
      completionOrder.push(raw.id); active--;
      return response({ title: raw.title, synopsis: raw.synopsis, analysis: raw.analysis, exam: raw.exam, confidence: raw.confidence });
    }
    return response(synthesisOutput(report));
  };
  const selected = selectedFixture().selected;
  const itemPromise = enrichItems(selected, config, { fetchImpl });
  await waitFor(() => pending.size === 2);
  for (let index = 1; index < selected.length; index++) {
    pending.get(selected[index].id).resolve();
    if (index + 1 < selected.length) await waitFor(() => pending.has(selected[index + 1].id));
  }
  pending.get(selected[0].id).resolve();
  const liveItems = await itemPromise;
  assert.equal(maxActive, 2);
  assert.deepEqual(completionOrder, [...selected.slice(1).map(item => item.id), selected[0].id]);
  assert.deepEqual(liveItems.map(item => item.id), selected.map(item => item.id));
  const synthesis = await synthesizeDaily(liveItems, config, { fetchImpl });
  assert.equal(bodies.length, 7);
  assert.ok(bodies.every(body => body.max_output_tokens === 4321));
  assert.ok(bodies.every(body => body.store === false));
  assert.equal(bodies[6].text.format.name, 'designsignal_daily_synthesis');
  assert.equal(bodies[6].text.format.strict, true);
  const seventhInput = JSON.parse(bodies[6].input);
  assert.equal(seventhInput.items.length, 6);
  assert.deepEqual(seventhInput.studyProfile, { directions: ['systems'], weaknesses: ['evidence'], dailyMinutes: 90 });
  assert.equal(seventhInput.recentFeedback.length, 2);
  assert.ok(!bodies[6].input.includes(privateMarker));
  assert.equal(synthesis.hypotheses.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test('synthesis retries malformed or invented references and validates report cross-references', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-retry-'));
  const modelCredential = ['model', 'fixture', 'value'].join('-');
  const config = await loadConfig({ env: { DESIGNSIGNAL_DATA_DIR: dir, OPENAI_MODEL: 'test', OPENAI_API_KEY: modelCredential, OPENAI_BASE_URL: 'https://models.example/v1' } });
  const report = await fixtureReport(), good = synthesisOutput(report), bad = structuredClone(good);
  bad.patterns[0].itemIds[0] = 'invented-item';
  let calls = 0;
  const result = await synthesizeDaily(report.items, config, { fetchImpl: async () => response(++calls < 3 ? bad : good) });
  assert.equal(calls, 3); assert.equal(result.overview.zh, good.overview.zh);
  for (const mutate of [
    value => { value.synthesis.hypotheses[0].supportingItemIds[0] = 'invented-item'; value.synthesis.hypotheses[0].evidence[0] = 'invented-item'; },
    value => { value.synthesis.hypotheses[0].exam['337'][0] = 'invented-topic'; },
    value => { value.exercise.evidenceLinks[0] = 'https://invented.example/citation'; },
    value => { value.exercise.rubric[0].points += 1; },
    value => { value.synthesis.hypotheses[0].confidence = 1.1; }
  ]) {
    const invalid = structuredClone(report); mutate(invalid); assert.throws(() => validateReport(invalid));
  }
  await rm(dir, { recursive: true, force: true });
});

test('study profile and recent feedback are bounded and feedback endpoint stores structured fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-feedback-')), profileFile = path.join(dir, 'profile.json');
  await writeFile(profileFile, JSON.stringify({ directions: ['research'], weaknesses: ['transfer'], dailyMinutes: 60 }));
  const config = await loadConfig({ env: { DESIGNSIGNAL_DATA_DIR: dir, DESIGNSIGNAL_STUDY_PROFILE_FILE: profileFile } });
  assert.deepEqual(await loadStudyProfile(config), { directions: ['research'], weaknesses: ['transfer'], dailyMinutes: 60 });
  assert.equal(validateFeedback({ date: '2026-07-20', comprehension: 80, transfer: 80, exercise: 80, minutes: 60, weakPoints: [], note: '' }, new Date('2026-07-19T16:30:00Z'), 'Asia/Shanghai').date, '2026-07-20');
  await writeFile(profileFile, 'x'.repeat(config.study.profileMaxBytes + 1));
  await assert.rejects(() => loadStudyProfile(config), /exceeds/);

  const payload = { date: '2026-07-19', comprehension: 88, transfer: 76, exercise: 91, minutes: 85, weakPoints: ['metrics', 'ethics'], note: 'Transfer worked.' };
  const raw = JSON.stringify(payload), result = { headers: {}, status: 0, body: '' };
  const req = { method: 'POST', url: '/api/feedback', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } };
  const res = { setHeader(key, value) { result.headers[key] = value; }, writeHead(status, headers = {}) { result.status = status; Object.assign(result.headers, headers); }, end(value = '') { result.body += value; } };
  await handleDashboardRequest(config, req, res);
  assert.equal(result.status, 303);
  const stored = JSON.parse((await readFile(path.join(dir, 'feedback.ndjson'), 'utf8')).trim());
  assert.deepEqual({ date: stored.date, comprehension: stored.comprehension, transfer: stored.transfer, exercise: stored.exercise, minutes: stored.minutes, weakPoints: stored.weakPoints, note: stored.note }, payload);
  config.study.recentFeedbackCount = 1;
  assert.equal((await loadRecentFeedback(config)).length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('Markdown and HTML render all bilingual report fields with escaped content', async () => {
  const report = await fixtureReport();
  report.items[0].analysis.zh.studyAction = '<script>unsafe()</script> 学习行动';
  const markdown = renderMarkdown(report), html = renderHtml(report);
  for (const marker of ['今日地图', '学习行动', '反证', '不确定性', '评分标准', '答题框架', '失败与伦理检查', '供给证据']) {
    assert.ok(markdown.includes(marker)); assert.ok(html.includes(marker));
  }
  assert.ok(markdown.includes('&lt;script&gt;unsafe()&lt;/script&gt;'));
  assert.ok(html.includes('&lt;script&gt;unsafe()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>unsafe()</script>'));
  assert.equal(report.exercise.rubric.reduce((total, row) => total + row.points, 0), 100);
});

test('dashboard HTML has a continuous heading outline and retains interactive mobile-safe structure', async () => {
  const html = renderHtml(await fixtureReport());
  const headingLevels = [...html.matchAll(/<h([1-6])(?:\s[^>]*)?>/g)].map(match => Number(match[1]));
  assert.equal(headingLevels[0], 1);
  assert.equal(headingLevels.filter(level => level === 1).length, 1);
  assert.match(html, /<h1 class="brand">DesignSignal 337\/902<\/h1>/);
  for (let index = 1; index < headingLevels.length; index++) {
    assert.ok(headingLevels[index] <= headingLevels[index - 1] + 1, `heading jumped from h${headingLevels[index - 1]} to h${headingLevels[index]}`);
  }
  assert.match(html, /<section class="band thesis"><h2>核心论点与证据边界 \/ Thesis and evidence boundary<\/h2>/);
  assert.match(html, /<article class="signal"[^>]*>[\s\S]*?<h3>/);
  assert.match(html, /<details class="analysis"><summary><h4>/);
  assert.match(html, /<details class="provenance"><summary><h4>[\s\S]*?<h5>Citations<\/h5>/);
  assert.match(html, /<aside class="sidebar"><section><h2>Source health<\/h2>/);

  assert.equal((html.match(/data-filter=/g) || []).length, 5);
  assert.match(html, /<form method="post" action="\/api\/feedback">/);
  for (const name of ['date', 'comprehension', 'transfer', 'exercise', 'minutes', 'weakPoints', 'note']) assert.match(html, new RegExp(`name="${name}"`));
  assert.match(html, /table-layout:fixed/);
  assert.match(html, /@media\(max-width:820px\)\{\.page\{grid-template-columns:1fr\}/);
  assert.match(html, /nav\{width:100%;margin:0;overflow:auto\}/);
  assert.match(html, /\.signal-head,\.analysis-grid,\.provenance-grid,\.exercise-grid,\.coverage-grid\{grid-template-columns:1fr\}/);
  assert.match(html, /@media\(max-width:430px\).*\.scores\{grid-template-columns:1fr\}/);
});

test('every evidence image has escaped bilingual alt text and prefers its local cached asset', async () => {
  const report = await fixtureReport();
  const imageItems = report.items.filter(item => item.image);
  const third = report.items.find(item => item.category === 'frontier');
  third.image = { ...structuredClone(imageItems[0].image), url: 'https://remote.example/frontier.jpg' };
  imageItems.push(third);

  imageItems.forEach((item, index) => {
    item.title = { zh: `证据图 ${index + 1} <模块>`, en: `Evidence image ${index + 1} "interface" & system` };
    item.image.localCacheRef = `/assets/${String(index + 1).repeat(64)}`;
  });
  const html = renderHtml(report);
  const images = [...html.matchAll(/<img\s[^>]+>/g)].map(match => match[0]);
  assert.equal(images.length, 3);
  images.forEach((image, index) => {
    assert.match(image, new RegExp(`src="/assets/${String(index + 1).repeat(64)}"`));
    assert.ok(image.includes(`alt="证据图 ${index + 1} &lt;模块&gt; / Evidence image ${index + 1} &quot;interface&quot; &amp; system"`));
    assert.match(image, /width="180" height="135" loading="lazy" referrerpolicy="no-referrer"/);
    assert.doesNotMatch(image.match(/alt="([^"]*)"/)[1], /https?:/);
    assert.ok(!image.includes('remote.example'));
  });
});
