import { escapeHtml } from './util.mjs';

const escapeMarkdown = value => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/[<>]/g, char => char === '<' ? '&lt;' : '&gt;')
  .replace(/([\[\]*_`])/g, '\\$1');
const mdLink = (label, url) => `[${escapeMarkdown(label)}](<${String(url).replace(/>/g, '%3E')}>)`;
const biMd = value => `${escapeMarkdown(value.zh)}\n\n${escapeMarkdown(value.en)}`;
const unique = values => [...new Set(values)];

export function renderMarkdown(report) {
  const out = [
    `# DesignSignal 337/902 - ${report.date}`, '',
    `Evidence baseline: \`${report.evidence.version}\` / \`${report.evidence.hash}\``, '',
    '## 今日概览 / Daily overview', '', biMd(report.synthesis.overview), '',
    `> ${escapeMarkdown(report.synthesis.disclaimer.zh)}  `, `> ${escapeMarkdown(report.synthesis.disclaimer.en)}`, '',
    '## 跨条目模式 / Cross-item patterns', ''
  ];
  report.synthesis.patterns.forEach(pattern => out.push(`- ${escapeMarkdown(pattern.pattern.zh)} / ${escapeMarkdown(pattern.pattern.en)}  `, `  Items: ${pattern.itemIds.map(escapeMarkdown).join(', ')}`));
  out.push('');

  for (const item of report.items) {
    out.push(`## ${escapeMarkdown(item.title.zh)} / ${escapeMarkdown(item.title.en)}`, '', biMd(item.synopsis), '',
      `- ID: \`${escapeMarkdown(item.id)}\``,
      `- Source: ${mdLink(item.source.name, item.source.url)}`,
      `- Published: ${escapeMarkdown(item.publishedAt)}`,
      `- Confidence: ${item.confidence}`,
      `- 337: ${item.exam['337'].map(escapeMarkdown).join(', ')}`,
      `- 902: ${item.exam['902'].map(escapeMarkdown).join(', ')}`, '');
    for (const [field, label] of [['evidence', '证据 / Evidence'], ['method', '方法 / Method'], ['novelty', '新意 / Novelty'], ['limits', '局限 / Limits'], ['whyLearn', '学习价值 / Why learn'], ['studyAction', '学习行动 / Study action']]) {
      out.push(`### ${label}`, '', `${escapeMarkdown(item.analysis.zh[field])}  `, escapeMarkdown(item.analysis.en[field]), '');
    }
    out.push('### 引用、缓存与权利 / Citations, cache, and rights', '');
    item.citations.forEach(citation => out.push(`- ${mdLink(citation.label, citation.url)}`));
    for (const asset of item.assets || []) out.push(`- ${escapeMarkdown(asset.kind)}: ${mdLink(asset.url, asset.localCacheRef)}; ${escapeMarkdown(asset.mime)}; ${asset.bytes} bytes; ${escapeMarkdown(asset.retrievedAt)}; ${escapeMarkdown(asset.author)}; ${escapeMarkdown(asset.institution)}; ${escapeMarkdown(asset.accessStatus)}; ${escapeMarkdown(asset.licenseStatus)}`);
    if (!(item.assets || []).length) out.push('- No cached asset / 无缓存资产');
    out.push(`- Rights: ${escapeMarkdown(item.rights?.access || 'unknown')}; ${escapeMarkdown(item.rights?.licenseStatus || 'unknown')}; ${escapeMarkdown(item.rights?.author || item.image?.author || item.source.name)}; ${escapeMarkdown(item.rights?.institution || item.image?.institution || item.source.name)}`, '');
  }

  out.push('## 337/902 学习假设 / Study hypotheses', '');
  report.synthesis.hypotheses.forEach((hypothesis, index) => {
    out.push(`### ${index + 1}. ${escapeMarkdown(hypothesis.claim.zh)} / ${escapeMarkdown(hypothesis.claim.en)}`, '',
      `Confidence: ${hypothesis.confidence}`, '',
      `**理由 / Rationale**  `, escapeMarkdown(hypothesis.rationale.zh), '', escapeMarkdown(hypothesis.rationale.en), '',
      `**Supporting items:** ${hypothesis.supportingItemIds.map(id => `\`${escapeMarkdown(id)}\``).join(', ')}`, '',
      `**337:** ${hypothesis.exam['337'].map(escapeMarkdown).join(', ')}  `, `**902:** ${hypothesis.exam['902'].map(escapeMarkdown).join(', ')}`, '',
      '**反证 / Counterevidence**', '');
    hypothesis.counterevidence.forEach(entry => out.push(`- ${escapeMarkdown(entry.zh)} / ${escapeMarkdown(entry.en)}`));
    out.push('', `**不确定性 / Uncertainty**  `, escapeMarkdown(hypothesis.uncertainty.zh), '', escapeMarkdown(hypothesis.uncertainty.en), '');
  });

  const exercise = report.exercise;
  out.push(`## ${escapeMarkdown(exercise.title.zh)} / ${escapeMarkdown(exercise.title.en)}`, '',
    `Timebox: ${exercise.timeboxMinutes} minutes  `, `Focus items: ${exercise.focusItemIds.map(id => `\`${escapeMarkdown(id)}\``).join(', ')}`, '',
    '### 练习理由 / Rationale', '', biMd(exercise.rationale), '',
    '### 题目 / Prompt', '', biMd(exercise.prompt), '',
    '### 交付物 / Deliverables', '');
  exercise.deliverables.forEach(entry => out.push(`- ${escapeMarkdown(entry.zh)} / ${escapeMarkdown(entry.en)}`));
  out.push('', '### 评分标准 / 100-point rubric', '');
  exercise.rubric.forEach(row => {
    out.push(`- **${row.points} - ${escapeMarkdown(row.criterion.zh)} / ${escapeMarkdown(row.criterion.en)}**`);
    row.indicators.zh.forEach((indicator, index) => out.push(`  - ${escapeMarkdown(indicator)} / ${escapeMarkdown(row.indicators.en[index] || row.indicators.en.at(-1))}`));
  });
  out.push('', '### 答题框架 / Answer framework', '');
  exercise.answerFramework.forEach((entry, index) => out.push(`${index + 1}. ${escapeMarkdown(entry.zh)} / ${escapeMarkdown(entry.en)}`));
  out.push('', '### 失败与伦理检查 / Failure and ethics checks', '');
  exercise.failureEthicsChecks.forEach(entry => out.push(`- ${escapeMarkdown(entry.zh)} / ${escapeMarkdown(entry.en)}`));
  out.push('', '### 供给证据 / Supplied evidence', '');
  unique(exercise.evidenceLinks).forEach((link, index) => out.push(`- ${mdLink(`Evidence ${index + 1}`, link)}`));
  return `${out.join('\n')}\n`;
}
const imageSource = image => image?.localCacheRef || image?.url;
const imageAlt = item => `${item.title.zh} / ${item.title.en}`;
const biHtml = value => `<p>${escapeHtml(value.zh)}</p><p class="en">${escapeHtml(value.en)}</p>`;
const itemHtml = item => {
  const analysis = [['evidence', '证据 / Evidence'], ['method', '方法 / Method'], ['novelty', '新意 / Novelty'], ['limits', '局限 / Limits'], ['whyLearn', '学习价值 / Why learn'], ['studyAction', '学习行动 / Study action']]
    .map(([field, label]) => `<section class="analysis"><h4>${label}</h4><p>${escapeHtml(item.analysis.zh[field])}</p><p class="en">${escapeHtml(item.analysis.en[field])}</p></section>`).join('');
  const citations = item.citations.map(citation => `<li><a href="${escapeHtml(citation.url)}" rel="noopener noreferrer">${escapeHtml(citation.label)}</a></li>`).join('');
  const assets = (item.assets || []).map(asset => `<li><a href="${escapeHtml(asset.localCacheRef)}">${escapeHtml(asset.kind)} · ${escapeHtml(asset.mime)}</a><small>${asset.bytes} bytes · ${escapeHtml(asset.retrievedAt)} · ${escapeHtml(asset.author)} · ${escapeHtml(asset.institution)} · ${escapeHtml(asset.accessStatus)} · ${escapeHtml(asset.licenseStatus)}</small></li>`).join('') || '<li>无缓存资产 / No cached asset</li>';
  return `<article class="signal" data-category="${escapeHtml(item.category)}" id="${escapeHtml(item.id)}">
  <div class="signal-head">${item.image ? `<img src="${escapeHtml(imageSource(item.image))}" alt="${escapeHtml(imageAlt(item))}" width="180" height="135" loading="lazy" referrerpolicy="no-referrer">` : ''}<div><p class="meta">${escapeHtml(item.category.toUpperCase())} · ${escapeHtml(item.id)} · ${(item.confidence * 100).toFixed(0)}%</p><h3>${escapeHtml(item.title.zh)}</h3><p class="title-en">${escapeHtml(item.title.en)}</p>${biHtml(item.synopsis)}<p class="tags">337 · ${item.exam['337'].map(escapeHtml).join(' · ')}</p><p class="tags">902 · ${item.exam['902'].map(escapeHtml).join(' · ')}</p></div></div>
  <div class="analysis-grid">${analysis}</div>
  <section class="provenance"><h4>引用、缓存与权利 / Citations, cache, and rights</h4><div class="provenance-grid"><div><h5>Citations</h5><ul>${citations}</ul></div><div><h5>Cached assets</h5><ul>${assets}</ul></div><div><h5>Rights</h5><p>${escapeHtml(item.rights?.access || 'unknown')} · ${escapeHtml(item.rights?.licenseStatus || 'unknown')}</p><p class="en">${escapeHtml(item.rights?.author || item.image?.author || item.source.name)} · ${escapeHtml(item.rights?.institution || item.image?.institution || item.source.name)}</p></div></div></section>
  </article>`;
};

export function renderHtml(report) {
  const health = report.audit.sourceHealth.map(entry => `<li><span class="dot ${escapeHtml(entry.status)}"></span>${escapeHtml(entry.sourceId)} <small>${escapeHtml(entry.status)} · ${entry.count}</small></li>`).join('');
  const patterns = report.synthesis.patterns.map(pattern => `<li>${biHtml(pattern.pattern)}<small>${pattern.itemIds.map(escapeHtml).join(' · ')}</small></li>`).join('');
  const hypotheses = report.synthesis.hypotheses.map(hypothesis => `<article class="hypothesis"><div class="confidence"><span>${Math.round(hypothesis.confidence * 100)}%</span><meter min="0" max="1" value="${hypothesis.confidence}"></meter></div><h3>${escapeHtml(hypothesis.claim.zh)}</h3><p class="title-en">${escapeHtml(hypothesis.claim.en)}</p><h4>理由 / Rationale</h4>${biHtml(hypothesis.rationale)}<p class="tags">Items · ${hypothesis.supportingItemIds.map(escapeHtml).join(' · ')}</p><p class="tags">337 · ${hypothesis.exam['337'].map(escapeHtml).join(' · ')}</p><p class="tags">902 · ${hypothesis.exam['902'].map(escapeHtml).join(' · ')}</p><h4>反证 / Counterevidence</h4><ul>${hypothesis.counterevidence.map(entry => `<li>${escapeHtml(entry.zh)}<span class="en">${escapeHtml(entry.en)}</span></li>`).join('')}</ul><h4>不确定性 / Uncertainty</h4>${biHtml(hypothesis.uncertainty)}</article>`).join('');
  const exercise = report.exercise;
  const rubric = exercise.rubric.map(row => `<tr><th>${escapeHtml(row.criterion.zh)}<span class="en">${escapeHtml(row.criterion.en)}</span></th><td>${row.points}</td><td><ul>${row.indicators.zh.map((indicator, index) => `<li>${escapeHtml(indicator)}<span class="en">${escapeHtml(row.indicators.en[index] || row.indicators.en.at(-1))}</span></li>`).join('')}</ul></td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>DesignSignal ${escapeHtml(report.date)}</title><style>
  :root{--ink:#18201d;--muted:#5c6963;--line:#d9dfdc;--paper:#f7f8f6;--white:#fff;--green:#176b50;--red:#a04437;--blue:#245b91;--gold:#8a641b}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0;overflow-wrap:anywhere}a{color:var(--blue)}header{border-bottom:1px solid var(--line);background:var(--white);position:sticky;top:0;z-index:2}.bar,.page{max-width:1180px;margin:auto;padding:14px 24px}.bar{display:flex;align-items:center;gap:20px}.brand{font-weight:750;font-size:18px;line-height:1.2;margin:0;white-space:nowrap}.date,.en,small{color:var(--muted)}nav{margin-left:auto;display:flex;gap:4px}button{border:1px solid var(--line);background:white;padding:7px 11px;border-radius:5px;color:var(--ink);cursor:pointer}button[aria-pressed="true"]{background:var(--ink);color:white}.page{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:34px}.feed{min-width:0}h2{font-size:24px;margin:24px 0 4px}h3{font-size:16px;margin:0 0 8px}h4,h5{font-size:13px;margin:14px 0 5px}.signal-head h3{font-size:21px;margin:3px 0}.analysis h4,.provenance>h4{font-size:16px;margin:0 0 8px}.sidebar h2{font-size:16px;margin:0 0 8px}.overview{padding:18px 0 24px;border-bottom:2px solid var(--ink)}.disclaimer{color:var(--gold);font-size:13px}.signal{padding:30px 0;border-bottom:1px solid var(--line)}.signal-head{display:grid;grid-template-columns:180px 1fr;gap:20px}.signal-head:not(:has(img)){grid-template-columns:1fr}.signal img{width:180px;height:auto;aspect-ratio:4/3;object-fit:cover;background:#e2e6e4}.meta,.tags{color:var(--muted);font-size:13px}.title-en{color:var(--muted);font-weight:600;margin-top:0}.analysis-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 28px;margin-top:20px}.analysis{padding:16px 0;border-top:1px solid var(--line)}.analysis p{margin:5px 0}.provenance{border-top:1px solid var(--line);padding-top:18px}.provenance-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.provenance ul{padding-left:18px}.provenance li small{display:block}.hypothesis{padding:22px 0;border-top:1px solid var(--line)}.confidence{float:right;width:92px;text-align:right}.confidence meter{display:block;width:92px}.hypothesis .en{display:block}.exercise{padding:24px 0}.facts{display:flex;gap:18px;flex-wrap:wrap}.exercise-block{border-top:1px solid var(--line);padding:18px 0}.exercise-grid{display:grid;grid-template-columns:1fr 1fr;gap:30px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{text-align:left;vertical-align:top;border-top:1px solid var(--line);padding:11px 8px}th{width:25%}td:nth-child(2){width:58px;font-weight:750}.sidebar{border-left:1px solid var(--line);padding-left:24px}.sidebar>section{padding:20px 0;border-bottom:1px solid var(--line)}ul{padding-left:18px}.health{list-style:none;padding:0}.health li{display:flex;gap:7px;align-items:center}.health small{margin-left:auto}.dot{width:8px;height:8px;border-radius:50%;background:var(--red);flex:none}.dot.ok{background:var(--green)}label{display:block;margin:9px 0;font-size:13px}input,textarea{display:block;width:100%;border:1px solid var(--line);border-radius:4px;padding:7px;background:white;color:var(--ink)}.scores{display:grid;grid-template-columns:repeat(2,1fr);gap:0 8px}.hidden{display:none!important}@media(max-width:820px){.page{grid-template-columns:1fr}.bar{flex-wrap:wrap}nav{width:100%;margin:0;overflow:auto}.sidebar{border-left:0;padding-left:0}.signal-head,.analysis-grid,.provenance-grid,.exercise-grid{grid-template-columns:1fr}.signal img{width:100%;max-height:300px}.confidence{float:none;width:100%;text-align:left}.confidence meter{width:100%}th{width:32%}}@media(max-width:430px){.bar,.page{padding-left:14px;padding-right:14px}.scores{grid-template-columns:1fr}table{font-size:13px}th,td{padding:8px 4px}}
  </style></head><body><header><div class="bar"><h1 class="brand">DesignSignal 337/902</h1><div class="date">${escapeHtml(report.date)}</div><nav aria-label="Filters"><button data-filter="all" aria-pressed="true">All</button><button data-filter="paper">Papers</button><button data-filter="product">Product</button><button data-filter="ui">UI</button><button data-filter="frontier">Frontier</button></nav></div></header><main class="page"><div class="feed"><section class="overview"><h2>今日概览 / Daily overview</h2>${biHtml(report.synthesis.overview)}<p class="disclaimer">${escapeHtml(report.synthesis.disclaimer.zh)} / ${escapeHtml(report.synthesis.disclaimer.en)}</p><h3>跨条目模式 / Cross-item patterns</h3><ul>${patterns}</ul></section><section><h2>今日研究信号 / Daily research signals</h2><p class="en">Evidence baseline ${escapeHtml(report.evidence.version)} · ${escapeHtml(report.evidence.hash.slice(0, 12))}</p>${report.items.map(itemHtml).join('')}</section><section><h2>337/902 学习假设 / Study hypotheses</h2>${hypotheses}</section><section class="exercise"><h2>${escapeHtml(exercise.title.zh)}</h2><p class="title-en">${escapeHtml(exercise.title.en)}</p><div class="facts"><strong>${exercise.timeboxMinutes} min</strong><span>${exercise.focusItemIds.map(escapeHtml).join(' · ')}</span></div><div class="exercise-block"><h3>练习理由 / Rationale</h3>${biHtml(exercise.rationale)}<h3>题目 / Prompt</h3>${biHtml(exercise.prompt)}</div><div class="exercise-grid exercise-block"><div><h3>交付物 / Deliverables</h3><ol>${exercise.deliverables.map(entry => `<li>${escapeHtml(entry.zh)}<span class="en">${escapeHtml(entry.en)}</span></li>`).join('')}</ol></div><div><h3>答题框架 / Answer framework</h3><ol>${exercise.answerFramework.map(entry => `<li>${escapeHtml(entry.zh)}<span class="en">${escapeHtml(entry.en)}</span></li>`).join('')}</ol></div></div><div class="exercise-block"><h3>评分标准 / 100-point rubric</h3><table><thead><tr><th>Criterion</th><th>Points</th><th>Observable indicators</th></tr></thead><tbody>${rubric}</tbody></table></div><div class="exercise-grid exercise-block"><div><h3>失败与伦理检查 / Failure and ethics checks</h3><ul>${exercise.failureEthicsChecks.map(entry => `<li>${escapeHtml(entry.zh)}<span class="en">${escapeHtml(entry.en)}</span></li>`).join('')}</ul></div><div><h3>供给证据 / Supplied evidence</h3><ol>${unique(exercise.evidenceLinks).map(link => `<li><a href="${escapeHtml(link)}" rel="noopener noreferrer">${escapeHtml(link)}</a></li>`).join('')}</ol></div></div></section></div><aside class="sidebar"><section><h2>Source health</h2><ul class="health">${health}</ul></section><section><h2>Exam map</h2><p>337: research foundations 75 · engineering 75</p><p>902: critique 50 · system 50 · expression/plan 50</p></section><section><h2>Next-day feedback</h2><form method="post" action="/api/feedback"><label>Date<input name="date" type="date" value="${escapeHtml(report.date)}" required></label><div class="scores"><label>Comprehension<input name="comprehension" type="number" min="0" max="100" required></label><label>Transfer<input name="transfer" type="number" min="0" max="100" required></label><label>Exercise<input name="exercise" type="number" min="0" max="100" required></label><label>Minutes<input name="minutes" type="number" min="0" max="720" required></label></div><label>Weak points<input name="weakPoints" maxlength="1500"></label><label>Note<textarea name="note" maxlength="2000" rows="4"></textarea></label><button type="submit">Record</button></form></section></aside></main><script src="/app.js"></script></body></html>`;
}
