import { readBoundedBody } from './network.mjs';
import { validateItem, validateSynthesis } from './schema.mjs';
import { loadExamEvidence } from './evidence.mjs';
import { loadRecentFeedback, loadStudyProfile } from './study.mjs';
import { redact } from './util.mjs';

const ITEM_SYSTEM = `You are DesignSignal, an evidence-disciplined bilingual design research editor. Return only schema-compliant JSON. Never invent facts or citations. Use only the supplied candidate. Explicitly state limitations. Produce Chinese and English title, synopsis, and analyses (evidence, method, novelty, limits, whyLearn, studyAction), map only to supplied 337/902 topic identifiers, and give confidence from 0 to 1.`;
const SYNTHESIS_SYSTEM = `You are DesignSignal's evidence synthesis editor. Return only schema-compliant JSON. Synthesize only the six supplied validated items, official 337/902 evidence, optional study profile, and recent structured feedback. Never invent item IDs, exam topics, facts, or URLs. Distinguish evidence from exam hypotheses and explicitly state counterevidence and uncertainty. Produce a bilingual overview, cross-item patterns, 2-4 bilingual exam hypotheses, and one item-grounded bilingual exercise. The rubric must total exactly 100 points and use observable indicators. Evidence links must be copied verbatim from allowedEvidenceLinks.`;

const bilingualSchema = () => ({
  type: 'object', additionalProperties: false, required: ['zh', 'en'],
  properties: { zh: { type: 'string' }, en: { type: 'string' } }
});
const stringArraySchema = () => ({ type: 'array', items: { type: 'string' } });

const analysisLanguageSchema = {
  type: 'object', additionalProperties: false,
  required: ['evidence', 'method', 'novelty', 'limits', 'whyLearn', 'studyAction'],
  properties: Object.fromEntries(['evidence', 'method', 'novelty', 'limits', 'whyLearn', 'studyAction'].map(field => [field, { type: 'string' }]))
};
const itemSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'synopsis', 'analysis', 'exam', 'confidence'],
  properties: {
    title: bilingualSchema(), synopsis: bilingualSchema(),
    analysis: { type: 'object', additionalProperties: false, required: ['zh', 'en'], properties: { zh: analysisLanguageSchema, en: analysisLanguageSchema } },
    exam: { type: 'object', additionalProperties: false, required: ['337', '902'], properties: { '337': stringArraySchema(), '902': stringArraySchema() } },
    confidence: { type: 'number' }
  }
};

const synthesisSchema = {
  type: 'object', additionalProperties: false, required: ['overview', 'patterns', 'hypotheses', 'exercise'],
  properties: {
    overview: bilingualSchema(),
    patterns: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['pattern', 'itemIds'],
        properties: { pattern: bilingualSchema(), itemIds: stringArraySchema() }
      }
    },
    hypotheses: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['claim', 'rationale', 'confidence', 'supportingItemIds', 'counterevidence', 'exam', 'uncertainty'],
        properties: {
          claim: bilingualSchema(), rationale: bilingualSchema(), confidence: { type: 'number' },
          supportingItemIds: stringArraySchema(),
          counterevidence: { type: 'array', items: bilingualSchema() },
          exam: { type: 'object', additionalProperties: false, required: ['337', '902'], properties: { '337': stringArraySchema(), '902': stringArraySchema() } },
          uncertainty: bilingualSchema()
        }
      }
    },
    exercise: {
      type: 'object', additionalProperties: false,
      required: ['title', 'rationale', 'prompt', 'timeboxMinutes', 'focusItemIds', 'deliverables', 'rubric', 'answerFramework', 'failureEthicsChecks', 'evidenceLinks'],
      properties: {
        title: bilingualSchema(), rationale: bilingualSchema(), prompt: bilingualSchema(),
        timeboxMinutes: { type: 'integer' }, focusItemIds: stringArraySchema(),
        deliverables: { type: 'array', items: bilingualSchema() },
        rubric: {
          type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['criterion', 'points', 'indicators'],
            properties: {
              criterion: bilingualSchema(), points: { type: 'integer' },
              indicators: { type: 'object', additionalProperties: false, required: ['zh', 'en'], properties: { zh: stringArraySchema(), en: stringArraySchema() } }
            }
          }
        },
        answerFramework: { type: 'array', items: bilingualSchema() },
        failureEthicsChecks: { type: 'array', items: bilingualSchema() },
        evidenceLinks: stringArraySchema()
      }
    }
  }
};

function outputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  for (const output of data.output || []) for (const part of output.content || []) if (part.type === 'output_text' && part.text) return part.text;
  throw new Error('Responses API returned no output text');
}

const safeError = (error, token) => {
  let message = String(redact(error?.message || 'unknown model error'));
  if (token) message = message.replaceAll(token, '[REDACTED]');
  return message.slice(0, 1000);
};

async function structuredResponse({ config, ctx, instructions, input, schema, name, validate }) {
  if (!config.model.model || !config.model.token) throw new Error('live model generation requires OPENAI_MODEL and OPENAI_API_KEY');
  if ((config.model.wireApi || 'responses') !== 'responses') throw new Error('configured model provider must use the Responses wire API');
  const endpoint = new URL('responses', config.model.baseUrl.replace(/\/?$/, '/')).href;
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.network.timeoutMs * 2);
      let responseBody;
      try {
        const response = await (ctx.fetchImpl || fetch)(endpoint, {
          method: 'POST', signal: controller.signal,
          headers: { authorization: `Bearer ${config.model.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: config.model.model,
            instructions,
            input: JSON.stringify(input),
            max_output_tokens: config.model.maxOutputTokens || 6000,
            text: { format: { type: 'json_schema', name, strict: true, schema } }
          })
        });
        if (!response.ok) throw new Error(`model HTTP ${response.status}`);
        responseBody = await readBoundedBody(response, config.network.maxJsonBytes || 2 * 1024 * 1024);
      } finally { clearTimeout(timer); }
      const parsed = JSON.parse(outputText(JSON.parse(responseBody.toString('utf8'))));
      return validate(parsed);
    } catch (error) { last = error; }
  }
  throw new Error(`structured model output failed after 3 attempts: ${safeError(last, config.model.token)}`);
}

export async function enrichItem(raw, config, ctx = {}) {
  const evidence = await loadExamEvidence();
  const allowed337 = new Set(evidence.exam337.parts.flatMap(part => part.topics));
  const allowed902 = new Set(evidence.exam902.parts.flatMap(part => part.topics));
  return structuredResponse({
    config, ctx, instructions: ITEM_SYSTEM, schema: itemSchema, name: 'designsignal_item',
    input: { candidate: raw, allowedExamTopics: { '337': [...allowed337], '902': [...allowed902] } },
    validate(output) {
      for (const topic of output.exam?.['337'] || []) if (!allowed337.has(topic)) throw new Error('invented 337 topic');
      for (const topic of output.exam?.['902'] || []) if (!allowed902.has(topic)) throw new Error('invented 902 topic');
      const item = {
        id: raw.id, category: raw.category, title: output.title, synopsis: output.synopsis,
        source: raw.source, publishedAt: raw.publishedAt, retrievedAt: new Date().toISOString(),
        analysis: output.analysis, exam: output.exam,
        citations: [{ label: 'Primary source', url: raw.source.url }], confidence: output.confidence,
        rights: raw.rights
      };
      const imageUrl = raw.imageUrl || raw.image?.url;
      if (imageUrl) item.image = { url: imageUrl, remoteUrl: imageUrl, mime: 'image/unknown', hash: 'remote-unfetched', author: raw.authors?.join(', ') || raw.image?.author || raw.source.name, institution: raw.institution || raw.image?.institution || raw.source.name, accessStatus: 'remote-link', licenseStatus: raw.rights?.licenseStatus || raw.image?.licenseStatus || 'unknown' };
      return validateItem(item);
    }
  });
}

const clip = (value, max = 2400) => String(value ?? '').slice(0, max);
const boundedItem = item => ({
  id: item.id, category: item.category,
  title: { zh: clip(item.title.zh, 500), en: clip(item.title.en, 500) },
  synopsis: { zh: clip(item.synopsis.zh), en: clip(item.synopsis.en) },
  source: { name: clip(item.source.name, 500), url: item.source.url, locale: item.source.locale },
  analysis: Object.fromEntries(['zh', 'en'].map(lang => [lang, Object.fromEntries(['evidence', 'method', 'novelty', 'limits', 'whyLearn', 'studyAction'].map(field => [field, clip(item.analysis[lang][field])]))])),
  exam: item.exam, citations: item.citations, confidence: item.confidence
});

export async function synthesizeDaily(items, config, ctx = {}) {
  if (!Array.isArray(items) || items.length !== 6) throw new Error('synthesis requires six validated items');
  items.forEach(validateItem);
  const evidence = await loadExamEvidence();
  const [studyProfile, recentFeedback] = await Promise.all([loadStudyProfile(config), loadRecentFeedback(config)]);
  const allowedEvidenceLinks = [...new Set([...items.flatMap(item => item.citations.map(citation => citation.url)), ...evidence.sources.map(source => source.url)])];
  const input = {
    items: items.map(boundedItem),
    examEvidence: {
      version: evidence.evidenceVersion, authority: evidence.authority,
      sources: evidence.sources,
      '337': evidence.exam337,
      '902': evidence.exam902,
      calibration: evidence.calibration
    },
    allowedEvidenceLinks,
    studyProfile: redact(studyProfile),
    recentFeedback: redact(recentFeedback)
  };
  return structuredResponse({
    config, ctx, instructions: SYNTHESIS_SYSTEM, input, schema: synthesisSchema, name: 'designsignal_daily_synthesis',
    validate(output) {
      output.hypotheses?.forEach(hypothesis => { hypothesis.evidence = [...(hypothesis.supportingItemIds || [])]; });
      return validateSynthesis(output, items, evidence);
    }
  });
}
