const analysis = (zhFocus, enFocus) => ({
  zh: {
    evidence: `原始来源提供了可核查的发布日期、作者或机构信息；本条关注${zhFocus}。`,
    method: `先区分来源主张、所用方法与可复核证据，再把${zhFocus}映射为设计研究变量。`,
    novelty: `新意在于把${zhFocus}连接到可执行的设计决策，而不只停留在概念描述。`,
    limits: '当前材料不能证明跨场景有效性，且二手摘要可能遗漏样本与失败条件。',
    whyLearn: '适合练习证据分级、系统链推演及对技术乐观叙事的批判。',
    studyAction: '用20分钟画出证据链，标出一个混杂变量、一个最弱环节和一个验证指标。'
  },
  en: {
    evidence: `The primary source exposes a checkable date and author or institution; this item focuses on ${enFocus}.`,
    method: `Separate claims, methods, and auditable evidence, then translate ${enFocus} into design-research variables.`,
    novelty: `Its useful novelty is the connection between ${enFocus} and an actionable design decision.`,
    limits: 'The available material does not establish transfer across contexts, and summaries can omit samples and failure conditions.',
    whyLearn: 'It supports practice in evidence grading, system-chain reasoning, and criticism of optimistic technology narratives.',
    studyAction: 'Spend 20 minutes diagramming the evidence chain and mark one confounder, weakest link, and validation metric.'
  }
});

const make = ({ id, category, zh, en, synopsisZh, synopsisEn, source, url, date, confidence, exam337, exam902, image }) => ({
  id, category, title: { zh, en }, synopsis: { zh: synopsisZh, en: synopsisEn },
  source: { id: source.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: source, url, locale: /[\u3400-\u9fff]/.test(zh) ? 'zh' : 'en', credibility: 'primary-or-editorial' },
  publishedAt: `${date}T08:00:00.000Z`, retrievedAt: '2026-07-19T12:00:00.000Z',
  analysis: analysis(synopsisZh.slice(0, 24), synopsisEn.slice(0, 42)),
  exam: { '337': exam337, '902': exam902 }, citations: [{ label: 'Primary source', url }], confidence,
  rights: { access: 'public-metadata', licenseStatus: category === 'paper' ? 'open-access-metadata; verify PDF license before download' : 'linked-only', author: source, institution: source },
  ...(image ? { image: { url: image, mime: 'image/jpeg', hash: `fixture-${id}`, author: source, institution: source, accessStatus: 'remote-link', licenseStatus: 'publisher-owned; display by remote reference' } } : {})
});

export const fixtureCandidates = [
  make({ id: 'paper-participatory-ai-20260718', category: 'paper', zh: '参与式人工智能设计中的权力审计', en: 'Auditing Power in Participatory AI Design', synopsisZh: '研究用参与式工作坊追踪谁能定义问题、数据和成功标准。', synopsisEn: 'A participatory study traces who controls problem definitions, data, and success criteria.', source: 'arXiv cs.HC', url: 'https://arxiv.org/abs/2607.01234', date: '2026-07-18', confidence: 0.81, exam337: ['user-centered design', 'inferential statistics', 'AI-assisted design'], exam902: ['critical analysis', 'problem reframing', 'ethics'] }),
  make({ id: 'paper-circular-material-20260717', category: 'paper', zh: '循环材料选择的多目标设计评估', en: 'Multi-objective Evaluation for Circular Material Selection', synopsisZh: '论文比较成本、碳影响与可维修性之间的权衡，并报告敏感性分析。', synopsisEn: 'The paper compares cost, carbon impact, and repairability trade-offs with sensitivity analysis.', source: 'OpenAlex indexed journal', url: 'https://openalex.org/W4400123456', date: '2026-07-17', confidence: 0.84, exam337: ['sustainability', 'materials', 'cost', 'visualization'], exam902: ['technology choice', 'metrics', 'fallback'] }),
  make({ id: 'product-repairable-kettle-20260716', category: 'product', zh: '可维修模块化电热水壶案例', en: 'A Repairable Modular Kettle Case', synopsisZh: '产品案例把加热、控制与外壳拆成可替换模块，并公开维修路径。', synopsisEn: 'The product separates heating, control, and enclosure into replaceable modules and exposes a repair path.', source: 'Core77', url: 'https://www.core77.com/posts/135000', date: '2026-07-16', confidence: 0.75, exam337: ['product development', 'prototyping', 'materials', 'intellectual property'], exam902: ['system chain', 'weakest link', 'fallback'], image: 'https://s3files.core77.com/blog/images/lead_n_spotlight/135000_title__134999_114953_hero.jpg' }),
  make({ id: 'ui-accessible-transit-20260715', category: 'ui', zh: '面向低视力乘客的多模态换乘界面', en: 'A Multimodal Transfer Interface for Low-vision Riders', synopsisZh: '界面案例组合高对比视觉、触觉提示和语音确认，覆盖中断与恢复状态。', synopsisEn: 'The interface combines high-contrast visuals, haptics, and spoken confirmation across interruption and recovery.', source: 'Awwwards', url: 'https://www.awwwards.com/sites/example-accessible-transit', date: '2026-07-15', confidence: 0.72, exam337: ['ergonomics', 'prototyping', 'user-centered design'], exam902: ['diverse users', 'inclusion', 'A3 expression'], image: 'https://assets.awwwards.com/awards/submissions/2026/07/example-transit.jpg' }),
  make({ id: 'frontier-agent-evals-20260718', category: 'frontier', zh: '长程智能体任务的可复现实证评估', en: 'Reproducible Evaluation of Long-horizon Agent Tasks', synopsisZh: '研究团队提出带环境快照、失败分类和成本记录的智能体评估协议。', synopsisEn: 'A research team proposes an agent evaluation protocol with environment snapshots, failure classes, and cost logs.', source: 'Microsoft Research', url: 'https://www.microsoft.com/en-us/research/blog/evaluating-long-horizon-agents/', date: '2026-07-18', confidence: 0.8, exam337: ['agents', 'workflows', 'large language models'], exam902: ['technical plan', 'metrics', 'data', 'weakest link'] }),
  make({ id: 'frontier-small-models-20260717', category: 'frontier', zh: '端侧小模型的能耗与隐私权衡', en: 'Energy and Privacy Trade-offs in On-device Small Models', synopsisZh: '文章用端侧基准讨论延迟、能耗、隐私与精度，指出云端回退的风险。', synopsisEn: 'Device benchmarks expose latency, energy, privacy, and accuracy trade-offs plus cloud fallback risk.', source: 'Hugging Face', url: 'https://huggingface.co/blog/on-device-model-evaluation', date: '2026-07-17', confidence: 0.78, exam337: ['deep neural networks', 'generative AI', 'cost'], exam902: ['technology choice', 'fallback', 'ethics', 'metrics'] }),
  make({ id: 'rejected-old-paper', category: 'paper', zh: '旧论文候选', en: 'Stale Paper Candidate', synopsisZh: '用于验证新鲜度拒绝。', synopsisEn: 'Used to verify freshness rejection.', source: 'OpenAlex', url: 'https://openalex.org/W1', date: '2025-01-01', confidence: 0.4, exam337: ['classification'], exam902: ['critical analysis'] })
];
