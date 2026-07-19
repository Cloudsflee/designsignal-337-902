import { loadExamEvidence } from './evidence.mjs';
import { validateReport } from './schema.mjs';

export async function buildReport({ date, items, rejected, health, selectionPolicy, fixture = false }) {
  const evidence = await loadExamEvidence();
  const citations = items.map(x => x.citations[0]?.url).filter(Boolean);
  const report = {
    schemaVersion: 1, date, generatedAt: new Date().toISOString(), fixture,
    evidence: { version: evidence.evidenceVersion, hash: evidence.documentSha256, sources: evidence.sources },
    items,
    synthesis: {
      disclaimer: 'These are evidence-backed study hypotheses, not predictions or certainty.',
      hypotheses: [
        { claim: 'A strong 902 response may need to expose the weakest link and define a measurable fallback, not merely name a technology.', confidence: 0.72, evidence: (items.filter(x => x.exam['902'].some(t => ['weakest link', 'fallback', 'metrics'].includes(t))).length ? items.filter(x => x.exam['902'].some(t => ['weakest link', 'fallback', 'metrics'].includes(t))) : items).map(x => x.id), counterevidence: ['The official outline defines competencies but does not disclose a future question.'] },
        { claim: '337 preparation benefits from joining research evidence to engineering trade-offs in one argument.', confidence: 0.68, evidence: (items.filter(x => x.exam['337'].length >= 3).length ? items.filter(x => x.exam['337'].length >= 3) : items).map(x => x.id), counterevidence: ['The 75/75 outline still permits separately focused questions.'] }
      ]
    },
    exercise: {
      title: 'Inclusive AI service: evidence-to-system stress test', timeboxMinutes: 90,
      prompt: 'Choose one item from today and reframe it as an inclusive public-service system. Defend one technology choice, trace the complete human/data/material chain, identify its weakest link, and design a fallback that still works for a user excluded by the primary interface.',
      deliverables: ['One A3-equivalent system map', '300-word evidence critique', 'Technology decision table with rejected alternative', 'Three metrics with collection method', 'Failure and ethics register'],
      rubric: [{ criterion: 'Evidence and reframing', points: 30 }, { criterion: 'Technology/system chain', points: 30 }, { criterion: 'Fallback and weakest link', points: 20 }, { criterion: 'Metrics/data/ethics', points: 20 }],
      answerFramework: ['Claim and boundary', 'Evidence quality', 'Stakeholders and excluded user', 'System chain and technology rationale', 'Weakest link and fallback', 'Metrics, data governance, ethics'],
      evidenceLinks: [...new Set([...citations, ...evidence.sources.map(x => x.url)])]
    },
    audit: { selectionPolicy, rejected, sourceHealth: health }
  };
  return validateReport(report);
}
