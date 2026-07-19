import { readBoundedBody } from './network.mjs';
import { validateItem } from './schema.mjs';
import { loadExamEvidence } from './evidence.mjs';
import { redact } from './util.mjs';

const SYSTEM = `You are DesignSignal, an evidence-disciplined bilingual design research editor. Return only JSON. Never invent facts or citations. Explicitly state limitations. Preserve supplied URLs. Produce Chinese and English title, synopsis, and analyses (evidence, method, novelty, limits, whyLearn, studyAction), map to supplied 337/902 topic identifiers, and give confidence 0..1.`;

function outputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  for (const out of data.output || []) for (const part of out.content || []) if (part.type === 'output_text' && part.text) return part.text;
  throw new Error('Responses API returned no output text');
}

export async function enrichItem(raw, config, ctx = {}) {
  if (!config.model.model || !config.model.token) throw new Error('live bilingual enrichment requires OPENAI_MODEL and OPENAI_API_KEY');
  if ((config.model.wireApi || 'responses') !== 'responses') throw new Error('configured model provider must use the Responses wire API');
  const endpoint = new URL('responses', config.model.baseUrl.replace(/\/?$/, '/')).href;
  const evidence = await loadExamEvidence();
  const allowed337 = new Set(evidence.exam337.parts.flatMap(x => x.topics)), allowed902 = new Set(evidence.exam902.parts.flatMap(x => x.topics));
  const schema = { type: 'object', additionalProperties: true, required: ['id', 'category', 'title', 'synopsis', 'source', 'publishedAt', 'analysis', 'exam', 'citations', 'confidence'] };
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.network.timeoutMs * 2);
      let responseBody;
      try {
        const response = await (ctx.fetchImpl || fetch)(endpoint, {
          method: 'POST', signal: controller.signal,
          headers: { authorization: `Bearer ${config.model.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: config.model.model, instructions: SYSTEM, input: JSON.stringify({ candidate: raw, allowedExamTopics: { '337': [...allowed337], '902': [...allowed902] } }), text: { format: { type: 'json_schema', name: 'designsignal_item', strict: false, schema } } })
        });
        if (!response.ok) throw new Error(`model HTTP ${response.status}`);
        responseBody = await readBoundedBody(response, config.network.maxJsonBytes || 2 * 1024 * 1024);
      } finally { clearTimeout(timer); }
      const item = JSON.parse(outputText(JSON.parse(responseBody.toString('utf8'))));
      item.id = raw.id; item.category = raw.category; item.source = raw.source; item.publishedAt = raw.publishedAt;
      item.citations = [{ label: 'Primary source', url: raw.source.url }];
      item.exam = { '337': (item.exam?.['337'] || []).filter(x => allowed337.has(x)), '902': (item.exam?.['902'] || []).filter(x => allowed902.has(x)) };
      if (raw.imageUrl) item.image = { url: raw.imageUrl, mime: 'image/unknown', hash: 'remote-unfetched', author: raw.authors?.join(', ') || raw.source.name, institution: raw.institution || raw.source.name, accessStatus: 'remote-link', licenseStatus: raw.rights?.licenseStatus || 'unknown' };
      item.rights = raw.rights; item.retrievedAt = new Date().toISOString();
      return validateItem(item);
    } catch (error) { last = error; }
  }
  const safeMessage = String(redact(last?.message || 'unknown model error')).replaceAll(config.model.token, '[REDACTED]');
  throw new Error(`structured model output failed after 3 attempts: ${safeMessage}`);
}
