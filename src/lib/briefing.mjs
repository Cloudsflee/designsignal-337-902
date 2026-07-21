const bi = (zh, en) => ({ zh, en });

export const SECTION_DEFINITIONS = [
  { id: 'academic-evidence', categories: ['paper'], title: bi('学术证据', 'Academic evidence') },
  { id: 'design-reference', categories: ['product', 'ui'], title: bi('设计参考', 'Design reference') },
  { id: 'frontier-radar', categories: ['frontier'], title: bi('前沿雷达', 'Frontier radar') }
];

export const EXAM_PARTS = {
  '337': [
    { id: '337-foundations', points: 75, title: bi('设计研究基础', 'Design research foundations') },
    { id: '337-engineering', points: 75, title: bi('设计工程', 'Design engineering') }
  ],
  '902': [
    { id: '902-critique', points: 50, title: bi('批判与重构', 'Critique and reframing') },
    { id: '902-system', points: 50, title: bi('技术与系统', 'Technology and systems') },
    { id: '902-expression', points: 50, title: bi('表达与方案', 'Expression and planning') }
  ]
};

const OFFICIAL_TOPICS = {
  '337-foundations': ['user-centered design', 'design thinking', 'sustainability', 'AI-assisted design', 'descriptive statistics', 'inferential statistics', 'visualization', 'clustering', 'classification', 'research application'],
  '337-engineering': ['product development', 'ergonomics', 'prototyping', 'materials', 'cost', 'intellectual property', 'AI', 'deep neural networks', 'reinforcement learning', 'generative AI', 'agents', 'workflows', 'large language models'],
  '902-critique': ['critical analysis', 'problem reframing'],
  '902-system': ['technology choice', 'system chain', 'diverse users', 'inclusion'],
  '902-expression': ['A3 expression', 'technical plan', 'fallback', 'weakest link', 'metrics', 'data', 'ethics']
};

const cloneBi = value => ({ zh: value.zh, en: value.en });

export function buildBriefing(items) {
  const sections = SECTION_DEFINITIONS.map(section => ({
    id: section.id,
    title: cloneBi(section.title),
    itemIds: items.filter(item => section.categories.includes(item.category)).map(item => item.id)
  }));
  const coverage = Object.fromEntries(Object.entries(EXAM_PARTS).map(([exam, definitions]) => [exam, {
    totalPoints: definitions.reduce((total, part) => total + part.points, 0),
    parts: definitions.map(definition => {
      const topicRefs = OFFICIAL_TOPICS[definition.id].flatMap(topic => {
        const itemIds = items.filter(item => item.exam[exam].includes(topic)).map(item => item.id);
        return itemIds.length ? [{ topic, itemIds }] : [];
      });
      return {
        id: definition.id,
        title: cloneBi(definition.title),
        points: definition.points,
        itemIds: [...new Set(topicRefs.flatMap(ref => ref.itemIds))],
        topicRefs
      };
    })
  }]));
  const sectionByItem = new Map(sections.flatMap(section => section.itemIds.map(itemId => [itemId, section.id])));
  const reviewRoute = items.map((item, index) => ({
    order: index + 1,
    sectionId: sectionByItem.get(item.id),
    itemId: item.id,
    topicRefs: { '337': [...item.exam['337']], '902': [...item.exam['902']] },
    action: { zh: item.analysis.zh.studyAction, en: item.analysis.en.studyAction }
  }));
  return { sections, coverage, reviewRoute };
}

export function briefingView(report) {
  const source = structuredClone(report);
  const briefing = source.schemaVersion === 4 ? source.briefing : buildBriefing(source.items);
  const itemsById = new Map(source.items.map(item => [item.id, item]));
  return {
    schemaVersion: source.schemaVersion,
    date: source.date,
    evidence: source.evidence,
    audit: source.audit,
    thesis: source.synthesis.overview,
    evidenceBoundary: source.synthesis.disclaimer,
    patterns: source.synthesis.patterns,
    coverage: briefing.coverage,
    sections: briefing.sections.map(section => ({ ...section, title: cloneBi(section.title), items: section.itemIds.map(id => itemsById.get(id)) })),
    hypotheses: source.synthesis.hypotheses,
    exercise: source.exercise,
    nextReview: briefing.reviewRoute.map(step => ({ ...step, topicRefs: { '337': [...step.topicRefs['337']], '902': [...step.topicRefs['902']] }, action: cloneBi(step.action) }))
  };
}
