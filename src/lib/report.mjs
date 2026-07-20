import { loadExamEvidence } from './evidence.mjs';
import { validateReport } from './schema.mjs';

const bi = (zh, en) => ({ zh, en });

function offlineSynthesis(items, evidence) {
  const ids = items.map(item => item.id);
  const systemItems = items.filter(item => item.exam['902'].some(topic => ['system chain', 'weakest link', 'fallback', 'metrics'].includes(topic)));
  const researchItems = items.filter(item => item.exam['337'].length >= 3);
  const sourceLinks = items.map(item => item.citations[0]?.url).filter(Boolean);
  return {
    overview: bi('今日六条材料共同强调：设计论证需要把可核查证据、系统取舍与失败条件连接起来。此离线示例仅用于测试，不是动态考试预测。', 'Across today’s six items, defensible design reasoning connects auditable evidence, system trade-offs, and failure conditions. This offline example is for testing only, not a dynamic exam prediction.'),
    patterns: [
      { pattern: bi('多条材料把“技术选择”转化为可测量的系统链，而不是孤立功能。', 'Several items treat a technology choice as a measurable system chain rather than an isolated feature.'), itemIds: (systemItems.length >= 2 ? systemItems : items).slice(0, 4).map(item => item.id) },
      { pattern: bi('证据质量与包容性边界共同决定方案可信度。', 'Evidence quality and inclusion boundaries jointly determine proposal credibility.'), itemIds: ids.slice(0, 3) }
    ],
    hypotheses: [
      {
        claim: bi('902 作答可能需要指出最弱环节并给出可测量的回退路径，而非只罗列技术。', 'A strong 902 response may need to expose the weakest link and define a measurable fallback, not merely name a technology.'),
        rationale: bi('当天材料反复出现系统链、指标和回退条件，可用于训练完整技术方案。', 'The items repeatedly expose system chains, metrics, and fallback conditions that support complete technical planning.'),
        confidence: 0.72,
        supportingItemIds: (systemItems.length ? systemItems : items).map(item => item.id),
        evidence: (systemItems.length ? systemItems : items).map(item => item.id),
        counterevidence: [bi('官方大纲只定义能力范围，并未披露未来题目。', 'The official outline defines competencies but does not disclose a future question.')],
        exam: { '337': ['prototyping'], '902': ['weakest link', 'fallback', 'metrics'] },
        uncertainty: bi('材料样本只有一天，不能代表命题频率。', 'A one-day item sample cannot establish question frequency.')
      },
      {
        claim: bi('337 复习可在同一论证中连接研究证据与工程权衡。', '337 preparation may benefit from joining research evidence to engineering trade-offs in one argument.'),
        rationale: bi('当天材料同时覆盖用户研究、材料、成本与人工智能实践。', 'The items jointly cover user research, materials, cost, and AI practice.'),
        confidence: 0.68,
        supportingItemIds: (researchItems.length ? researchItems : items).map(item => item.id),
        evidence: (researchItems.length ? researchItems : items).map(item => item.id),
        counterevidence: [bi('75/75 的考试结构仍允许分别聚焦基础与工程的问题。', 'The 75/75 structure still permits separately focused foundations and engineering questions.')],
        exam: { '337': ['research application', 'product development'], '902': ['critical analysis'] },
        uncertainty: bi('跨板块整合是学习策略，不是题型承诺。', 'Cross-part integration is a study strategy, not a promised question format.')
      }
    ],
    exercise: {
      title: bi('包容性人工智能服务：证据到系统压力测试', 'Inclusive AI Service: Evidence-to-system Stress Test'),
      rationale: bi('练习要求把当天材料转化为可审查的系统方案，并明确证据边界。', 'The exercise turns today’s evidence into an auditable system proposal with explicit evidence boundaries.'),
      prompt: bi('选择今日一条材料，将其重构为包容性公共服务系统。论证一项技术选择，追踪完整的人、数据与材料链，指出最弱环节，并为被主要界面排除的用户设计回退方案。', 'Choose one item from today and reframe it as an inclusive public-service system. Defend one technology choice, trace the complete human, data, and material chain, identify its weakest link, and design a fallback for a user excluded by the primary interface.'),
      timeboxMinutes: 90,
      focusItemIds: ids.slice(0, 2),
      deliverables: [bi('一张 A3 等效系统图', 'One A3-equivalent system map'), bi('300 字证据批判', 'A 300-word evidence critique'), bi('含被否决备选项的技术决策表', 'A technology decision table with a rejected alternative'), bi('含采集方法的三个指标', 'Three metrics with collection methods'), bi('失败与伦理登记表', 'A failure and ethics register')],
      rubric: [
        { criterion: bi('证据与问题重构', 'Evidence and reframing'), points: 30, indicators: { zh: ['区分来源事实、推断和未知项'], en: ['Distinguishes source facts, inference, and unknowns'] } },
        { criterion: bi('技术与系统链', 'Technology and system chain'), points: 30, indicators: { zh: ['技术选择与完整系统链可追踪'], en: ['Technology choice is traceable through the complete system chain'] } },
        { criterion: bi('回退与最弱环节', 'Fallback and weakest link'), points: 20, indicators: { zh: ['回退方案覆盖明确失败状态'], en: ['Fallback covers a named failure state'] } },
        { criterion: bi('指标、数据与伦理', 'Metrics, data, and ethics'), points: 20, indicators: { zh: ['指标含采集方法并检查伤害'], en: ['Metrics include collection methods and harm checks'] } }
      ],
      answerFramework: [bi('主张与边界', 'Claim and boundary'), bi('证据质量', 'Evidence quality'), bi('利益相关者与被排除用户', 'Stakeholders and excluded user'), bi('系统链与技术理由', 'System chain and technology rationale'), bi('最弱环节与回退', 'Weakest link and fallback'), bi('指标、数据治理与伦理', 'Metrics, data governance, and ethics')],
      failureEthicsChecks: [bi('主要界面失效时是否仍可完成核心任务？', 'Can the core task still be completed when the primary interface fails?'), bi('数据采集是否制造不必要的监控或排除？', 'Does data collection create unnecessary surveillance or exclusion?')],
      evidenceLinks: [...new Set([...sourceLinks, ...evidence.sources.map(source => source.url)])]
    }
  };
}
export async function buildReport({ date, items, rejected, health, selectionPolicy, assetAudit = [], fixture = false, generated = null }) {
  const evidence = await loadExamEvidence();
  if (!fixture && !generated) throw new Error('live report requires dynamic synthesis');
  const content = generated || offlineSynthesis(items, evidence);
  const report = {
    schemaVersion: 3, date, generatedAt: new Date().toISOString(), fixture,
    evidence: {
      version: evidence.evidenceVersion,
      hash: evidence.documentSha256,
      sources: evidence.sources,
      allowedTopics: {
        '337': evidence.exam337.parts.flatMap(part => part.topics),
        '902': evidence.exam902.parts.flatMap(part => part.topics)
      }
    },
    items,
    synthesis: {
      disclaimer: bi('以下内容是有证据支撑的学习假设，不是预测或确定结论。', 'These are evidence-backed study hypotheses, not predictions or certainty.'),
      overview: content.overview,
      patterns: content.patterns,
      hypotheses: content.hypotheses
    },
    exercise: content.exercise,
    audit: { selectionPolicy, rejected, sourceHealth: health, assets: assetAudit, synthesis: fixture ? 'offline-fixture' : 'responses-api' }
  };
  return validateReport(report);
}
