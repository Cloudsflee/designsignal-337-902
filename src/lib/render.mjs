import { briefingView } from './briefing.mjs';
import { escapeHtml } from './util.mjs';
import { PIPELINE_STAGES } from './runtime.mjs';

const ANALYSIS_FIELDS = [
  ['evidence', '证据 / Evidence'], ['method', '方法 / Method'], ['novelty', '新意 / Novelty'],
  ['limits', '局限 / Limits'], ['whyLearn', '学习价值 / Why learn'], ['studyAction', '学习行动 / Study action']
];
const escapeMarkdown = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/[<>]/g, char => char === '<' ? '&lt;' : '&gt;').replace(/([\[\]*_`])/g, '\\$1');
const mdLink = (label, url) => `[${escapeMarkdown(label)}](<${String(url).replace(/>/g, '%3E')}>)`;
const biMd = value => `${escapeMarkdown(value.zh)}\n\n${escapeMarkdown(value.en)}`;
const unique = values => [...new Set(values)];
const imageSource = image => image?.localCacheRef || image?.url;
const biHtml = value => `<p>${escapeHtml(value.zh)}</p><p class="en">${escapeHtml(value.en)}</p>`;

function coverageMarkdown(coverage, out) {
  for (const exam of ['337', '902']) {
    out.push(`### ${exam} - ${coverage[exam].totalPoints} points`, '');
    for (const part of coverage[exam].parts) {
      out.push(`- **${part.points} - ${escapeMarkdown(part.title.zh)} / ${escapeMarkdown(part.title.en)}**`, `  Items: ${part.itemIds.map(id => `\`${escapeMarkdown(id)}\``).join(', ')}`);
      for (const ref of part.topicRefs) out.push(`  - ${escapeMarkdown(ref.topic)}: ${ref.itemIds.map(id => `\`${escapeMarkdown(id)}\``).join(', ')}`);
    }
    out.push('');
  }
}

function itemMarkdown(item, out) {
  out.push(`### ${escapeMarkdown(item.title.zh)} / ${escapeMarkdown(item.title.en)}`, '',
    `- 337: ${item.exam['337'].map(escapeMarkdown).join(', ')}`,
    `- 902: ${item.exam['902'].map(escapeMarkdown).join(', ')}`,
    `- Synopsis: ${escapeMarkdown(item.synopsis.zh)} / ${escapeMarkdown(item.synopsis.en)}`,
    `- Why learn: ${escapeMarkdown(item.analysis.zh.whyLearn)} / ${escapeMarkdown(item.analysis.en.whyLearn)}`,
    `- Study action: ${escapeMarkdown(item.analysis.zh.studyAction)} / ${escapeMarkdown(item.analysis.en.studyAction)}`, '',
    `ID: \`${escapeMarkdown(item.id)}\` · Source: ${mdLink(item.source.name, item.source.url)} · Published: ${escapeMarkdown(item.publishedAt)} · Confidence: ${item.confidence}`, '');
  for (const [field, label] of ANALYSIS_FIELDS) out.push(`#### ${label}`, '', biMd({ zh: item.analysis.zh[field], en: item.analysis.en[field] }), '');
  out.push('#### 引用、缓存与权利 / Citations, cache, and rights', '');
  item.citations.forEach(citation => out.push(`- ${mdLink(citation.label, citation.url)}`));
  for (const asset of item.assets || []) out.push(`- ${escapeMarkdown(asset.kind)}: ${mdLink(asset.url, asset.localCacheRef)}; ${escapeMarkdown(asset.mime)}; ${asset.bytes} bytes; ${escapeMarkdown(asset.retrievedAt)}; ${escapeMarkdown(asset.author)}; ${escapeMarkdown(asset.institution)}; ${escapeMarkdown(asset.accessStatus)}; ${escapeMarkdown(asset.licenseStatus)}`);
  if (!(item.assets || []).length) out.push('- No cached asset / 无缓存资产');
  out.push(`- Rights: ${escapeMarkdown(item.rights?.access || 'unknown')}; ${escapeMarkdown(item.rights?.licenseStatus || 'unknown')}; ${escapeMarkdown(item.rights?.author || item.image?.author || item.source.name)}; ${escapeMarkdown(item.rights?.institution || item.image?.institution || item.source.name)}`, '');
}

export function renderMarkdown(report) {
  const view = briefingView(report), out = [`# DesignSignal 337/902 - ${view.date}`, '',
    '## 核心论点与证据边界 / Thesis and evidence boundary', '', biMd(view.thesis), ''];
  view.patterns.forEach(pattern => out.push(`- ${escapeMarkdown(pattern.pattern.zh)} / ${escapeMarkdown(pattern.pattern.en)}  `, `  Items: ${pattern.itemIds.map(escapeMarkdown).join(', ')}`));
  out.push('', `> ${escapeMarkdown(view.evidenceBoundary.zh)}  `, `> ${escapeMarkdown(view.evidenceBoundary.en)}`, '',
    '## 今日地图 / Map', '');
  view.sections.forEach(section => out.push(`- **${escapeMarkdown(section.title.zh)} / ${escapeMarkdown(section.title.en)} (${section.items.length})**  `, `  ${section.items.map(item => escapeMarkdown(item.title.zh)).join('；')}`));
  out.push('', '## 官方考纲覆盖 / Official coverage', '', `Evidence baseline: \`${view.evidence.version}\` / \`${view.evidence.hash}\``, '');
  coverageMarkdown(view.coverage, out);
  for (const section of view.sections) {
    out.push(`## ${escapeMarkdown(section.title.zh)} / ${escapeMarkdown(section.title.en)}`, '');
    section.items.forEach(item => itemMarkdown(item, out));
  }
  out.push('## 337/902 学习假设 / Study hypotheses', '');
  view.hypotheses.forEach((hypothesis, index) => {
    out.push(`### ${index + 1}. ${escapeMarkdown(hypothesis.claim.zh)} / ${escapeMarkdown(hypothesis.claim.en)}`, '', `Confidence: ${hypothesis.confidence}`, '',
      '**理由 / Rationale**', '', biMd(hypothesis.rationale), '', `**Supporting items:** ${hypothesis.supportingItemIds.map(id => `\`${escapeMarkdown(id)}\``).join(', ')}`, '',
      `**337:** ${hypothesis.exam['337'].map(escapeMarkdown).join(', ')}  `, `**902:** ${hypothesis.exam['902'].map(escapeMarkdown).join(', ')}`, '', '**反证 / Counterevidence**', '');
    hypothesis.counterevidence.forEach(entry => out.push(`- ${escapeMarkdown(entry.zh)} / ${escapeMarkdown(entry.en)}`));
    out.push('', '**不确定性 / Uncertainty**', '', biMd(hypothesis.uncertainty), '');
  });
  const exercise = view.exercise;
  out.push(`## 练习 / Exercise`, '', `### ${escapeMarkdown(exercise.title.zh)} / ${escapeMarkdown(exercise.title.en)}`, '', `Timebox: ${exercise.timeboxMinutes} minutes  `, `Focus items: ${exercise.focusItemIds.map(id => `\`${escapeMarkdown(id)}\``).join(', ')}`, '',
    '#### 练习理由 / Rationale', '', biMd(exercise.rationale), '', '#### 题目 / Prompt', '', biMd(exercise.prompt), '', '#### 交付物 / Deliverables', '');
  exercise.deliverables.forEach(entry => out.push(`- ${escapeMarkdown(entry.zh)} / ${escapeMarkdown(entry.en)}`));
  out.push('', '#### 评分标准 / 100-point rubric', '');
  exercise.rubric.forEach(row => out.push(`- **${row.points} - ${escapeMarkdown(row.criterion.zh)} / ${escapeMarkdown(row.criterion.en)}**: ${row.indicators.zh.map((x, i) => `${escapeMarkdown(x)} / ${escapeMarkdown(row.indicators.en[i] || row.indicators.en.at(-1))}`).join('; ')}`));
  out.push('', '#### 答题框架 / Answer framework', ''); exercise.answerFramework.forEach((entry, i) => out.push(`${i + 1}. ${escapeMarkdown(entry.zh)} / ${escapeMarkdown(entry.en)}`));
  out.push('', '#### 失败与伦理检查 / Failure and ethics checks', ''); exercise.failureEthicsChecks.forEach(entry => out.push(`- ${escapeMarkdown(entry.zh)} / ${escapeMarkdown(entry.en)}`));
  out.push('', '#### 供给证据 / Supplied evidence', ''); unique(exercise.evidenceLinks).forEach((link, i) => out.push(`- ${mdLink(`Evidence ${i + 1}`, link)}`));
  out.push('', '## 下一步复习 / Next review', '');
  view.nextReview.forEach(step => out.push(`${step.order}. **${escapeMarkdown(step.itemId)}** (${escapeMarkdown(step.sectionId)})  `, `   337: ${step.topicRefs['337'].map(escapeMarkdown).join(', ')} · 902: ${step.topicRefs['902'].map(escapeMarkdown).join(', ')}  `, `   ${escapeMarkdown(step.action.zh)} / ${escapeMarkdown(step.action.en)}`));
  return `${out.join('\n')}\n`;
}

const anchorSlug = value => String(value ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';

function itemHtml(item, anchor) {
  const dimensions = ANALYSIS_FIELDS.map(([field, label]) => `<section><h5>${label}</h5>${biHtml({ zh: item.analysis.zh[field], en: item.analysis.en[field] })}</section>`).join('');
  const citations = item.citations.map(citation => `<li><a href="${escapeHtml(citation.url)}" rel="noopener noreferrer">${escapeHtml(citation.label)}</a></li>`).join('');
  const assets = (item.assets || []).map(asset => `<li><a href="${escapeHtml(asset.localCacheRef)}">${escapeHtml(asset.kind)} · ${escapeHtml(asset.mime)}</a><small>${asset.bytes} bytes · ${escapeHtml(asset.retrievedAt)} · ${escapeHtml(asset.author)} · ${escapeHtml(asset.institution)} · ${escapeHtml(asset.accessStatus)} · ${escapeHtml(asset.licenseStatus)}</small></li>`).join('') || '<li>无缓存资产 / No cached asset</li>';
  const provenance = `<details class="provenance"><summary><h4>引用、缓存与权利 / Citations, cache, and rights</h4></summary><div class="provenance-grid"><div><h5>Citations</h5><ul>${citations}</ul></div><div><h5>Cached assets</h5><ul>${assets}</ul></div><div><h5>Rights</h5><p>${escapeHtml(item.rights?.access || 'unknown')} · ${escapeHtml(item.rights?.licenseStatus || 'unknown')}</p><p class="en">${escapeHtml(item.rights?.author || item.image?.author || item.source.name)} · ${escapeHtml(item.rights?.institution || item.image?.institution || item.source.name)}</p></div></div></details>`;
  return `<article class="signal" data-category="${escapeHtml(item.category)}" id="${anchor}" data-toc-target><div class="signal-head">${item.image ? `<img src="${escapeHtml(imageSource(item.image))}" alt="${escapeHtml(`${item.title.zh} / ${item.title.en}`)}" width="180" height="135" loading="lazy" referrerpolicy="no-referrer">` : ''}<div><p class="meta">${escapeHtml(item.category.toUpperCase())} · ${escapeHtml(item.id)} · ${(item.confidence * 100).toFixed(0)}%</p><h3>${escapeHtml(item.title.zh)}</h3><p class="title-en">${escapeHtml(item.title.en)}</p><p class="tags">337 · ${item.exam['337'].map(escapeHtml).join(' · ')}</p><p class="tags">902 · ${item.exam['902'].map(escapeHtml).join(' · ')}</p><p><strong>Synopsis</strong> ${escapeHtml(item.synopsis.zh)}<span class="en">${escapeHtml(item.synopsis.en)}</span></p><p><strong>Why learn</strong> ${escapeHtml(item.analysis.zh.whyLearn)}<span class="en">${escapeHtml(item.analysis.en.whyLearn)}</span></p><p><strong>Study action</strong> ${escapeHtml(item.analysis.zh.studyAction)}<span class="en">${escapeHtml(item.analysis.en.studyAction)}</span></p></div></div><details class="analysis"><summary><h4>六维分析 / Six-dimension analysis</h4></summary><div class="analysis-grid">${dimensions}</div></details>${provenance}</article>`;
}

const coverageHtml = coverage => ['337', '902'].map(exam => `<section class="exam"><h3>${exam} · ${coverage[exam].totalPoints} points</h3>${coverage[exam].parts.map(part => `<div><h4>${part.points} · ${escapeHtml(part.title.zh)} / ${escapeHtml(part.title.en)}</h4><p class="tags">Items · ${part.itemIds.map(escapeHtml).join(' · ')}</p><ul>${part.topicRefs.map(ref => `<li>${escapeHtml(ref.topic)} <small>${ref.itemIds.map(escapeHtml).join(' · ')}</small></li>`).join('')}</ul></div>`).join('')}</section>`).join('');

const stageLabels = {
  evidence: ['调研取证', 'Evidence collection'], constraints: ['约束分析', 'Constraint analysis'], decision: ['方案决策', 'Selection decision'],
  execution: ['分析执行', 'Analysis execution'], acceptance: ['测试验收', 'Synthesis acceptance'], integration: ['集成交付', 'Publication integration']
};
const stateLabels = {
  pending: '待执行 / Pending', blocked: '已阻塞 / Blocked', running: '执行中 / Running', completed: '已完成 / Completed', failed: '失败 / Failed',
  input_superseded: '输入已替代 / Input superseded', not_recorded: '未记录 / Not recorded'
};
const shortVersion = value => value ? escapeHtml(String(value).replace(/^(?:av_|ctx_)/, '').slice(0, 12)) : 'none';

function pipelineHtml(run) {
  const stages = run?.stages || PIPELINE_STAGES.map((stage, index) => ({
    ...stage, order: index + 1, state: 'not_recorded', blocked_by: [], contract: { inputs: [], outputs: [{ ...stage.output }] }, output_bindings: []
  }));
  const rows = stages.map(stage => {
    const labels = stageLabels[stage.id] || [stage.title, stage.title];
    const inputs = (stage.contract?.inputs || []).map(input => shortVersion(input.version_id)).join(' · ') || 'none';
    const outputs = (stage.output_bindings || []).map(output => shortVersion(output.version_id)).join(' · ') || 'none';
    const lineage = (stage.output_bindings || []).flatMap(output => output.derived_from || []).map(shortVersion).join(' · ') || 'root';
    const blocked = stage.blocked_by?.length ? `<p class="run-blocked">Blocked by ${stage.blocked_by.map(escapeHtml).join(' · ')}</p>` : '';
    const failure = stage.failure?.message ? `<p class="run-failure">${escapeHtml(stage.failure.message)}</p>` : '';
    return `<li class="run-stage state-${escapeHtml(stage.state)}"><div class="run-index" aria-hidden="true">${stage.order}</div><div class="run-stage-main"><h3>${escapeHtml(labels[0])}<span>${escapeHtml(labels[1])}</span></h3><p class="run-state">${escapeHtml(stateLabels[stage.state] || stage.state)}</p>${blocked}${failure}</div><dl><div><dt>Input snapshot</dt><dd><code>${shortVersion(stage.input_snapshot_hash)}</code></dd></div><div><dt>Input versions</dt><dd><code>${inputs}</code></dd></div><div><dt>Output version</dt><dd><code>${outputs}</code></dd></div><div><dt>Derived from</dt><dd><code>${lineage}</code></dd></div></dl></li>`;
  }).join('');
  const state = run ? escapeHtml(run.state) : 'legacy_unverified';
  const snapshot = run ? shortVersion(run.input_snapshot_hash) : 'none';
  return `<section class="band pipeline" id="run-pipeline" data-toc-target><div class="pipeline-head"><div><h2>运行流程 / Execution flow</h2><p class="en">${run ? `${escapeHtml(run.date)} · ` : ''}${state} · snapshot <code>${snapshot}</code></p></div><span class="run-schema">${run ? escapeHtml(run.execution_context_schema) : 'no run record'}</span></div><ol class="run-stages">${rows}</ol></section>`;
}

export function renderHtml(report, { run = null, showPipeline = Boolean(run) } = {}) {
  const view = briefingView(report), exercise = view.exercise;
  const health = (view.audit.sourceHealth || []).map(entry => `<li><span class="dot ${escapeHtml(entry.status)}"></span>${escapeHtml(entry.sourceId)} <small>${escapeHtml(entry.status)} · ${entry.count}</small></li>`).join('');
  const hypotheses = view.hypotheses.map(h => `<article class="hypothesis"><div class="confidence">${Math.round(h.confidence * 100)}%<meter min="0" max="1" value="${h.confidence}"></meter></div><h3>${escapeHtml(h.claim.zh)}</h3><p class="title-en">${escapeHtml(h.claim.en)}</p><h4>理由 / Rationale</h4>${biHtml(h.rationale)}<p class="tags">Items · ${h.supportingItemIds.map(escapeHtml).join(' · ')}</p><p class="tags">337 · ${h.exam['337'].map(escapeHtml).join(' · ')} · 902 · ${h.exam['902'].map(escapeHtml).join(' · ')}</p><h4>反证 / Counterevidence</h4><ul>${h.counterevidence.map(x => `<li>${escapeHtml(x.zh)}<span class="en">${escapeHtml(x.en)}</span></li>`).join('')}</ul><h4>不确定性 / Uncertainty</h4>${biHtml(h.uncertainty)}</article>`).join('');
  const rubric = exercise.rubric.map(row => `<tr><th>${escapeHtml(row.criterion.zh)}<span class="en">${escapeHtml(row.criterion.en)}</span></th><td>${row.points}</td><td>${row.indicators.zh.map((x, i) => `${escapeHtml(x)}<span class="en">${escapeHtml(row.indicators.en[i] || row.indicators.en.at(-1))}</span>`).join('')}</td></tr>`).join('');
  let signalNumber = 0;
  const sections = view.sections.map((section, sectionIndex) => ({
    ...section,
    anchor: `briefing-${sectionIndex + 1}-${anchorSlug(section.id)}`,
    anchoredItems: section.items.map(item => ({ item, anchor: `signal-${++signalNumber}-${anchorSlug(item.id)}` }))
  }));
  const grouped = sections.map(section => `<section class="group" id="${section.anchor}" data-toc-target><h2>${escapeHtml(section.title.zh)} / ${escapeHtml(section.title.en)}</h2>${section.anchoredItems.map(({ item, anchor }) => itemHtml(item, anchor)).join('')}</section>`).join('');
  const route = view.nextReview.map(step => `<li><strong>${step.order}. ${escapeHtml(step.itemId)}</strong><span class="en">${escapeHtml(step.action.zh)} / ${escapeHtml(step.action.en)}</span><small>337 · ${step.topicRefs['337'].map(escapeHtml).join(' · ')} | 902 · ${step.topicRefs['902'].map(escapeHtml).join(' · ')}</small></li>`).join('');
  const patterns = view.patterns.map(x => `<li>${escapeHtml(x.pattern.zh)}<span class="en">${escapeHtml(x.pattern.en)}</span><small>${x.itemIds.map(escapeHtml).join(' · ')}</small></li>`).join('');
  const map = view.sections.map(section => `<li><strong>${escapeHtml(section.title.zh)} / ${escapeHtml(section.title.en)} (${section.items.length})</strong><span class="en">${section.items.map(item => escapeHtml(item.title.zh)).join(' · ')}</span></li>`).join('');
  const briefingToc = sections.map(section => `<li><a href="#${section.anchor}">${escapeHtml(section.title.zh)}<span>${escapeHtml(section.title.en)}</span></a><ol>${section.anchoredItems.map(({ item, anchor }) => `<li><a href="#${anchor}">${escapeHtml(item.title.zh)}<span>${escapeHtml(item.title.en)}</span></a></li>`).join('')}</ol></li>`).join('');
  const pipelineToc = showPipeline ? '<li><a href="#run-pipeline">运行流程<span>Execution flow</span></a></li>' : '';
  const toc = `<aside class="toc-panel" id="report-toc" aria-label="Report table of contents"><div class="toc-head"><p>目录 / Contents</p><button class="icon-button toc-close" type="button" data-toc-close aria-label="Close contents" title="Close contents"><span aria-hidden="true">&times;</span></button></div><nav class="toc-nav" aria-label="Report contents"><p class="toc-label">概览 / Overview</p><ol>${pipelineToc}<li><a href="#overview">核心论点<span>Thesis and evidence boundary</span></a></li><li><a href="#daily-map">今日地图<span>Daily map</span></a></li><li><a href="#official-coverage">官方考纲覆盖<span>Official coverage</span></a></li></ol><p class="toc-label">简报 / Briefing</p><ol>${briefingToc}</ol><p class="toc-label">学习 / Study</p><ol><li><a href="#study-hypotheses">学习假设<span>Study hypotheses</span></a></li><li><a href="#study-exercise">练习<span>Exercise</span></a></li><li><a href="#next-review">下一步复习<span>Next review</span></a></li></ol></nav></aside>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>DesignSignal ${escapeHtml(view.date)}</title><style>
:root{--ink:#18201d;--muted:#5c6963;--line:#d9dfdc;--paper:#f7f8f6;--white:#fff;--green:#176b50;--red:#a04437;--blue:#245b91;--gold:#8a641b;--header-height:65px}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:calc(var(--header-height) + 18px)}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0;overflow-wrap:anywhere}body.drawer-open{overflow:hidden}a{color:var(--blue)}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #68a8db;outline-offset:3px}header{border-bottom:1px solid var(--line);background:var(--white);position:sticky;top:0;z-index:20}.bar,.page{max-width:1440px;margin:auto;padding:14px 24px}.bar{display:flex;align-items:center;gap:20px;min-height:var(--header-height)}.brand{font-size:18px;line-height:1.2;margin:0;white-space:nowrap}.date,.en,small{color:var(--muted)}.en{display:block}.filters{margin-left:auto;display:flex;gap:4px;overflow-x:auto}.filters button{flex:0 0 auto}button{border:1px solid var(--line);background:white;padding:7px 11px;border-radius:5px;color:var(--ink);cursor:pointer}button[aria-pressed="true"]{background:var(--ink);color:white}.icon-button{display:inline-grid;width:38px;height:38px;padding:0;place-items:center;font-size:24px;line-height:1}.toc-toggle,.toc-close{display:none}.page{display:grid;grid-template-columns:220px minmax(0,1fr) 270px;gap:34px;align-items:start}.feed{min-width:0;max-width:800px;width:100%;margin-inline:auto}.toc-panel{position:sticky;top:calc(var(--header-height) + 1px);max-height:calc(100vh - var(--header-height) - 1px);overflow-y:auto;padding:22px 18px 28px 0;border-right:1px solid var(--line);scrollbar-gutter:stable}.toc-head{display:flex;align-items:center;justify-content:space-between}.toc-head p{font-size:15px;font-weight:700;margin:0}.toc-nav{display:block;margin:0;overflow:visible}.toc-nav ol{list-style:none;margin:4px 0 16px;padding:0}.toc-nav ol ol{border-left:1px solid var(--line);margin:5px 0 8px 9px;padding-left:9px}.toc-label{color:var(--muted);font-size:11px;font-weight:700;letter-spacing:0;margin:18px 0 5px;text-transform:uppercase}.toc-nav a{display:block;border-radius:4px;color:var(--muted);font-size:13px;line-height:1.35;padding:5px 7px;text-decoration:none}.toc-nav a span{display:block;color:inherit;font-size:11px}.toc-nav a:hover{background:#e9eeeb;color:var(--ink)}.toc-nav a[aria-current="location"]{background:#e3ebe7;color:var(--green);font-weight:700}.toc-backdrop{display:none}.back-to-top{position:fixed;right:20px;bottom:20px;z-index:15;box-shadow:0 2px 10px #18201d26}.back-to-top[hidden]{display:none}[id]{scroll-margin-top:calc(var(--header-height) + 18px)}h2{font-size:24px;margin:28px 0 8px}h3{font-size:18px;margin:14px 0 8px}h4,h5{font-size:14px;margin:12px 0 5px}.boundary{color:var(--gold)}.band{padding:18px 0 24px;border-bottom:1px solid var(--line)}.pipeline-head{display:flex;align-items:end;justify-content:space-between;gap:16px}.pipeline-head h2{margin-bottom:0}.run-schema{color:var(--muted);font-size:12px}.run-stages{list-style:none;margin:18px 0 0;padding:0;border-top:1px solid var(--line)}.run-stage{display:grid;grid-template-columns:34px minmax(150px,.8fr) minmax(0,1.7fr);gap:14px;padding:14px 0;border-bottom:1px solid var(--line);min-height:112px}.run-index{display:grid;place-items:center;align-self:start;width:28px;height:28px;border:1px solid var(--line);border-radius:50%;font-weight:700}.run-stage h3{font-size:15px;line-height:1.35;margin:0}.run-stage h3 span{display:block;color:var(--muted);font-size:12px;font-weight:500}.run-state{font-size:12px;font-weight:700;margin:5px 0}.state-completed .run-index{background:var(--green);border-color:var(--green);color:white}.state-running .run-index{background:var(--gold);border-color:var(--gold);color:white}.state-failed .run-index,.state-input_superseded .run-index{background:var(--red);border-color:var(--red);color:white}.state-blocked,.state-not_recorded{color:var(--muted)}.run-stage dl{display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;margin:0}.run-stage dl div{min-width:0}.run-stage dt{color:var(--muted);font-size:11px}.run-stage dd{margin:0;font-size:12px;overflow-wrap:anywhere}.run-stage code,.pipeline-head code{font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.run-blocked,.run-failure{font-size:12px;margin:4px 0}.run-failure{color:var(--red)}.coverage-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px}.signal{padding:28px 0;border-bottom:1px solid var(--line)}.signal-head{display:grid;grid-template-columns:180px minmax(0,1fr);gap:20px}.signal-head:not(:has(img)){grid-template-columns:1fr}.signal img{width:180px;aspect-ratio:4/3;object-fit:cover;background:#e2e6e4}.meta,.tags{color:var(--muted);font-size:13px}.title-en{font-weight:600;margin-top:0}.analysis-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 28px;margin-top:18px}details{border-top:1px solid var(--line);padding:10px 0}summary{cursor:pointer}summary h4{display:inline}.provenance{margin-top:10px}.provenance-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.provenance li small,.route small{display:block}.hypothesis{padding:20px 0;border-top:1px solid var(--line)}.confidence{float:right;width:92px;text-align:right}.confidence meter{display:block;width:92px}.exercise-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px}.exercise-block{border-top:1px solid var(--line);padding:16px 0}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{text-align:left;vertical-align:top;border-top:1px solid var(--line);padding:10px 8px}th{width:25%}td:nth-child(2){width:58px}.sidebar{border-left:1px solid var(--line);min-width:0;padding-left:24px}.sidebar>section{padding:20px 0;border-bottom:1px solid var(--line)}.health{list-style:none;padding:0}.health li{display:flex;gap:7px}.health small{margin-left:auto}.dot{width:8px;height:8px;border-radius:50%;background:var(--red);margin-top:8px}.dot.ok{background:var(--green)}label{display:block;margin:9px 0;font-size:13px}input,textarea{display:block;width:100%;border:1px solid var(--line);border-radius:4px;padding:7px}.scores{display:grid;grid-template-columns:1fr 1fr;gap:8px}.hidden{display:none!important}@media(max-width:1199px) and (min-width:821px){.page{grid-template-columns:210px minmax(0,1fr)}.sidebar{grid-column:2;border-left:0;border-top:1px solid var(--line);display:grid;grid-template-columns:1fr 1fr;gap:28px;padding-left:0}.sidebar>section{min-width:0}}@media(max-width:820px){:root{--header-height:112px}.page{grid-template-columns:1fr}.bar{flex-wrap:wrap;gap:8px 12px}.toc-toggle{display:inline-grid;order:-1}.date{margin-left:auto}.filters{width:100%;margin:0;overflow:auto}nav{width:100%;margin:0;overflow:auto}.toc-panel{position:fixed;inset:0 auto 0 0;z-index:40;width:min(86vw,320px);max-height:none;padding:18px;background:var(--white);border-right:1px solid var(--line);box-shadow:6px 0 24px #18201d33;transform:translateX(-105%);transition:transform .2s ease}.toc-panel.is-open{transform:translateX(0)}.toc-close{display:inline-grid}.toc-nav{max-height:calc(100vh - 64px);overflow-y:auto}.toc-backdrop{position:fixed;inset:0;z-index:30;width:100%;height:100%;border:0;border-radius:0;background:#18201d66}.toc-backdrop:not([hidden]){display:block}.sidebar{border-left:0;border-top:1px solid var(--line);padding-left:0}.signal-head,.analysis-grid,.provenance-grid,.exercise-grid,.coverage-grid{grid-template-columns:1fr}.run-stage{grid-template-columns:34px minmax(0,1fr)}.run-stage dl{grid-column:2;grid-template-columns:1fr}.pipeline-head{align-items:start;flex-direction:column}.signal img{width:100%;max-height:300px}.confidence{float:none;width:100%;text-align:left}.confidence meter{width:100%}th{width:32%}}@media(max-width:430px){:root{--header-height:118px}.bar,.page{padding-left:14px;padding-right:14px}.scores{grid-template-columns:1fr}table{font-size:13px}th,td{padding:8px 4px}.brand{white-space:normal}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.toc-panel{transition:none}}
</style></head><body><header><div class="bar"><button class="icon-button toc-toggle" type="button" data-toc-open aria-label="Open contents" aria-controls="report-toc" aria-expanded="false" title="Open contents"><span aria-hidden="true">&#9776;</span></button><h1 class="brand">DesignSignal 337/902</h1><div class="date">${escapeHtml(view.date)}</div><nav class="filters" aria-label="Filters"><button data-filter="all" aria-pressed="true">All</button><button data-filter="paper">Papers</button><button data-filter="product">Product</button><button data-filter="ui">UI</button><button data-filter="frontier">Frontier</button></nav></div></header><button class="toc-backdrop" type="button" data-toc-backdrop aria-label="Close contents" hidden></button><main class="page">${toc}<div class="feed">${showPipeline ? pipelineHtml(run) : ''}<section class="band thesis" id="overview" data-toc-target><h2>核心论点与证据边界 / Thesis and evidence boundary</h2>${biHtml(view.thesis)}<ul>${patterns}</ul><p class="boundary">${escapeHtml(view.evidenceBoundary.zh)} / ${escapeHtml(view.evidenceBoundary.en)}</p></section><section class="band map" id="daily-map" data-toc-target><h2>今日地图 / Map</h2><ul>${map}</ul></section><section class="band coverage" id="official-coverage" data-toc-target><h2>官方考纲覆盖 / Official coverage</h2><p class="en">Evidence baseline ${escapeHtml(view.evidence.version)} · ${escapeHtml(view.evidence.hash.slice(0, 12))}</p><div class="coverage-grid">${coverageHtml(view.coverage)}</div></section>${grouped}<section id="study-hypotheses" data-toc-target><h2>337/902 学习假设 / Study hypotheses</h2>${hypotheses}</section><section class="exercise" id="study-exercise" data-toc-target><h2>练习 / Exercise</h2><h3>${escapeHtml(exercise.title.zh)} / ${escapeHtml(exercise.title.en)}</h3><p>${exercise.timeboxMinutes} min · ${exercise.focusItemIds.map(escapeHtml).join(' · ')}</p><div class="exercise-block"><h4>练习理由 / Rationale</h4>${biHtml(exercise.rationale)}<h4>题目 / Prompt</h4>${biHtml(exercise.prompt)}</div><div class="exercise-grid exercise-block"><div><h4>交付物 / Deliverables</h4><ol>${exercise.deliverables.map(x => `<li>${escapeHtml(x.zh)}<span class="en">${escapeHtml(x.en)}</span></li>`).join('')}</ol></div><div><h4>答题框架 / Answer framework</h4><ol>${exercise.answerFramework.map(x => `<li>${escapeHtml(x.zh)}<span class="en">${escapeHtml(x.en)}</span></li>`).join('')}</ol></div></div><div class="exercise-block"><h4>评分标准 / 100-point rubric</h4><table><thead><tr><th>Criterion</th><th>Points</th><th>Indicators</th></tr></thead><tbody>${rubric}</tbody></table></div><div class="exercise-block"><h4>失败与伦理检查 / Failure and ethics checks</h4><ul>${exercise.failureEthicsChecks.map(x => `<li>${escapeHtml(x.zh)}<span class="en">${escapeHtml(x.en)}</span></li>`).join('')}</ul><h4>供给证据 / Supplied evidence</h4><ol>${unique(exercise.evidenceLinks).map(link => `<li><a href="${escapeHtml(link)}" rel="noopener noreferrer">${escapeHtml(link)}</a></li>`).join('')}</ol></div></section><section class="route" id="next-review" data-toc-target><h2>下一步复习 / Next review</h2><ol>${route}</ol></section></div><aside class="sidebar"><section><h2>Source health</h2><ul class="health">${health}</ul></section><section><h2>Next-day feedback</h2><form method="post" action="/api/feedback"><label>Date<input name="date" type="date" value="${escapeHtml(view.date)}" required></label><div class="scores"><label>Comprehension<input name="comprehension" type="number" min="0" max="100" required></label><label>Transfer<input name="transfer" type="number" min="0" max="100" required></label><label>Exercise<input name="exercise" type="number" min="0" max="100" required></label><label>Minutes<input name="minutes" type="number" min="0" max="720" required></label></div><label>Weak points<input name="weakPoints" maxlength="1500"></label><label>Note<textarea name="note" maxlength="2000" rows="4"></textarea></label><button type="submit">Record</button></form></section></aside></main><button class="icon-button back-to-top" type="button" data-back-to-top aria-label="Back to top" title="Back to top" hidden><span aria-hidden="true">&#8593;</span></button><script src="/app.js"></script></body></html>`;
}

const richText = content => [{ text_run: { content: String(content), text_element_style: {} } }];
const feishuBlock = (blockType, key, content) => ({ block_type: blockType, [key]: { elements: richText(content), style: {} } });
const paragraph = content => feishuBlock(2, 'text', content);
const heading = (level, content) => feishuBlock(level + 2, `heading${level}`, content);
const bullet = content => feishuBlock(12, 'bullet', content);

export function renderFeishuBlocks(report) {
  const view = briefingView(report), blocks = [];
  blocks.push(heading(1, `DesignSignal 337/902 - ${view.date}`));
  blocks.push(heading(2, '核心论点与证据边界 / Thesis and evidence boundary'), paragraph(`${view.thesis.zh}\n${view.thesis.en}`), paragraph(`${view.evidenceBoundary.zh}\n${view.evidenceBoundary.en}`));
  view.patterns.forEach(x => blocks.push(bullet(`${x.pattern.zh} / ${x.pattern.en}\nItems: ${x.itemIds.join(', ')}`)));
  blocks.push(heading(2, '今日地图 / Map'));
  view.sections.forEach(section => blocks.push(bullet(`${section.title.zh} / ${section.title.en} (${section.items.length})\n${section.items.map(item => item.title.zh).join(' / ')}`)));
  blocks.push(heading(2, '官方考纲覆盖 / Official coverage'), paragraph(`Evidence baseline: ${view.evidence.version} / ${view.evidence.hash}`));
  for (const exam of ['337', '902']) {
    blocks.push(heading(3, `${exam} - ${view.coverage[exam].totalPoints} points`));
    for (const part of view.coverage[exam].parts) {
      blocks.push(bullet(`${part.points} - ${part.title.zh} / ${part.title.en}\nItems: ${part.itemIds.join(', ')}`));
      part.topicRefs.forEach(ref => blocks.push(bullet(`${ref.topic}: ${ref.itemIds.join(', ')}`)));
    }
  }
  for (const section of view.sections) {
    blocks.push(heading(2, `${section.title.zh} / ${section.title.en}`));
    for (const item of section.items) {
      blocks.push(heading(3, `${item.title.zh} / ${item.title.en}`), paragraph(`337: ${item.exam['337'].join(', ')}\n902: ${item.exam['902'].join(', ')}`), paragraph(`Synopsis: ${item.synopsis.zh} / ${item.synopsis.en}`), paragraph(`Why learn: ${item.analysis.zh.whyLearn} / ${item.analysis.en.whyLearn}`), paragraph(`Study action: ${item.analysis.zh.studyAction} / ${item.analysis.en.studyAction}`));
      for (const [field, label] of ANALYSIS_FIELDS) blocks.push(bullet(`${label}\n${item.analysis.zh[field]}\n${item.analysis.en[field]}`));
      blocks.push(bullet(`Provenance: ${item.source.name} - ${item.source.url}\nCitations: ${item.citations.map(x => x.url).join(', ')}\nRights: ${item.rights?.access || 'unknown'} / ${item.rights?.licenseStatus || 'unknown'}`));
    }
  }
  blocks.push(heading(2, '337/902 学习假设 / Study hypotheses'));
  view.hypotheses.forEach((h, i) => blocks.push(heading(3, `${i + 1}. ${h.claim.zh} / ${h.claim.en}`), paragraph(`Confidence: ${h.confidence}\n${h.rationale.zh}\n${h.rationale.en}\nItems: ${h.supportingItemIds.join(', ')}\n337: ${h.exam['337'].join(', ')} | 902: ${h.exam['902'].join(', ')}\nCounterevidence: ${h.counterevidence.map(x => `${x.zh} / ${x.en}`).join('; ')}\nUncertainty: ${h.uncertainty.zh} / ${h.uncertainty.en}`)));
  blocks.push(heading(2, '练习 / Exercise'), heading(3, `${view.exercise.title.zh} / ${view.exercise.title.en}`), paragraph(`Rationale: ${view.exercise.rationale.zh} / ${view.exercise.rationale.en}\nPrompt: ${view.exercise.prompt.zh} / ${view.exercise.prompt.en}\nTimebox: ${view.exercise.timeboxMinutes} min\nFocus: ${view.exercise.focusItemIds.join(', ')}`), heading(3, '交付物 / Deliverables'));
  view.exercise.deliverables.forEach(x => blocks.push(bullet(`${x.zh} / ${x.en}`)));
  blocks.push(heading(3, '评分标准 / 100-point rubric'));
  view.exercise.rubric.forEach(row => blocks.push(bullet(`${row.points} - ${row.criterion.zh} / ${row.criterion.en}\n${row.indicators.zh.map((x, i) => `${x} / ${row.indicators.en[i] || row.indicators.en.at(-1)}`).join('; ')}`)));
  blocks.push(heading(3, '答题框架 / Answer framework'));
  view.exercise.answerFramework.forEach(x => blocks.push(bullet(`${x.zh} / ${x.en}`)));
  blocks.push(heading(3, '失败与伦理检查 / Failure and ethics checks'));
  view.exercise.failureEthicsChecks.forEach(x => blocks.push(bullet(`${x.zh} / ${x.en}`)));
  blocks.push(heading(3, '供给证据 / Supplied evidence'));
  unique(view.exercise.evidenceLinks).forEach(link => blocks.push(bullet(link)));
  blocks.push(heading(2, '下一步复习 / Next review'));
  view.nextReview.forEach(step => blocks.push(feishuBlock(13, 'ordered', `${step.order}. ${step.itemId} (${step.sectionId})\n337: ${step.topicRefs['337'].join(', ')} | 902: ${step.topicRefs['902'].join(', ')}\n${step.action.zh} / ${step.action.en}`)));
  return blocks;
}
