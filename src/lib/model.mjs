import { readBoundedBody } from './network.mjs';
import { validateItem, validateSynthesis } from './schema.mjs';
import { loadExamEvidence } from './evidence.mjs';
import { loadRecentFeedback, loadStudyProfile } from './study.mjs';
import { redact, sleep } from './util.mjs';

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

const MAX_RETRY_AFTER_MS = 30000;
const RETRY_BASE_MS = 1000;

class ModelError extends Error {
  constructor(message, { retryable = false, retryAfterMs = 0, kind = 'unknown' } = {}) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.kind = kind;
  }
}

const retryAfterMs = response => {
  const value = response.headers.get('retry-after');
  if (!value || !/^\d+(?:\.\d+)?$/.test(value.trim())) return 0;
  return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
};

function publicFailure(error) {
  if (error instanceof ModelError) return error;
  // A provider can return malformed JSON or a schema-invalid object even with
  // HTTP 200. Retry those boundedly, but never expose provider details.
  const message = String(error?.message || '');
  if (/response exceeds \d+ byte limit/i.test(message)) return new ModelError('model response exceeded configured limit [REDACTED]', { kind: 'response-limit' });
  return new ModelError('invalid structured model output [REDACTED]', { retryable: true, kind: 'invalid-output' });
}

function responsesEndpoint(baseUrl) {
  const endpoint = new URL(baseUrl);
  // Config loading rejects query/fragment components. Keep direct library
  // callers safe as well by dropping them before constructing the endpoint.
  endpoint.search = '';
  endpoint.hash = '';
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = /\/responses$/i.test(pathname) ? pathname || '/responses' : `${pathname || ''}/responses`;
  return endpoint.href;
}

async function structuredResponse({ config, ctx, instructions, input, schema, name, validate }) {
  if (!config.model.model || !config.model.token) throw new Error('live model generation requires OPENAI_MODEL and OPENAI_API_KEY');
  if ((config.model.wireApi || 'responses') !== 'responses') throw new Error('configured model provider must use the Responses wire API');
  const endpoint = responsesEndpoint(config.model.baseUrl);
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    let timedOut = false;
    try {
      const controller = new AbortController();
      const setTimer = ctx.setTimeoutImpl || setTimeout;
      const clearTimer = ctx.clearTimeoutImpl || clearTimeout;
      const timer = setTimer(() => { timedOut = true; controller.abort(); }, config.model.timeoutMs ?? 180000);
      let responseBody;
      try {
        let response;
        try {
          response = await (ctx.fetchImpl || fetch)(endpoint, {
            method: 'POST', signal: controller.signal,
            headers: { authorization: `Bearer ${config.model.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: config.model.model,
              instructions,
              input: JSON.stringify(input),
              max_output_tokens: config.model.maxOutputTokens || 6000,
              store: false,
              text: { format: { type: 'json_schema', name, strict: true, schema } }
            })
          });
        } catch (error) {
          if (timedOut) throw new ModelError('model request timed out [REDACTED]', { retryable: true });
          if (error?.name === 'AbortError') throw new ModelError('model request aborted [REDACTED]', { retryable: true });
          throw new ModelError('model network error [REDACTED]', { retryable: true });
        }
        if (!response.ok) {
          const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
          throw new ModelError(`model HTTP ${response.status}`, { retryable, retryAfterMs: retryable ? retryAfterMs(response) : 0, kind: 'http' });
        }
        responseBody = await readBoundedBody(response, config.network.maxJsonBytes || 2 * 1024 * 1024);
      } finally { clearTimer(timer); }
      const parsed = JSON.parse(outputText(JSON.parse(responseBody.toString('utf8'))));
      return validate(parsed);
    } catch (error) {
      last = timedOut ? new ModelError('model request timed out [REDACTED]', { retryable: true, kind: 'timeout' }) : publicFailure(error);
      if (!last.retryable) throw new Error(`structured model output failed: ${last.message}`);
      if (attempt < 2) {
        const delay = Math.max(Math.min(RETRY_BASE_MS * 2 ** attempt, MAX_RETRY_AFTER_MS), last.retryAfterMs || 0);
        await (ctx.sleepImpl || sleep)(delay);
      }
    }
  }
  throw new Error(`structured model output failed after 3 attempts: ${last?.message || 'unknown model error [REDACTED]'}`);
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
        rights: raw.rights,
        ...(raw.institutionProvenance ? { institution: raw.institution, institutionProvenance: raw.institutionProvenance } : {})
      };
      const imageUrl = raw.imageUrl || raw.image?.url;
      if (imageUrl) item.image = { url: imageUrl, remoteUrl: imageUrl, mime: 'image/unknown', hash: 'remote-unfetched', author: raw.authors?.join(', ') || raw.image?.author || raw.source.name, institution: raw.institution || raw.image?.institution || raw.source.name, accessStatus: 'remote-link', licenseStatus: raw.rights?.licenseStatus || raw.image?.licenseStatus || 'unknown' };
      return validateItem(item);
    }
  });
}

export async function enrichItems(rawItems, config, ctx = {}, transform = value => value) {
  const results = new Array(rawItems.length);
  let nextIndex = 0;
  const workerCount = Math.min(config.model.concurrency ?? 2, rawItems.length);
  const active = new Map();
  const start = index => {
    const pending = enrichItem(rawItems[index], config, ctx)
      .then(item => ({ index, ok: true, value: transform(item, rawItems[index]) }))
      .catch(() => ({ index, ok: false }));
    active.set(index, pending);
  };
  while (nextIndex < rawItems.length && active.size < workerCount) start(nextIndex++);
  while (active.size) {
    const settled = await Promise.race(active.values());
    active.delete(settled.index);
    if (!settled.ok) {
      const remaining = await Promise.all(active.values());
      const index = Math.min(settled.index, ...remaining.filter(item => !item.ok).map(item => item.index));
      throw new Error(`model analysis failed for item ${rawItems[index].id}`);
    }
    results[settled.index] = settled.value;
    if (nextIndex < rawItems.length) start(nextIndex++);
  }
  return results;
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
