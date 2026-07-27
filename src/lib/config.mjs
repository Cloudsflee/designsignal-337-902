import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson } from './util.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

const stripTomlComment = line => {
  let quote = '', escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, i);
  }
  if (quote) throw new Error('invalid Codex TOML: unterminated string');
  return line;
};

const tomlString = (value, lineNumber) => {
  const trimmed = value.trim();
  try {
    if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) return JSON.parse(trimmed);
    if (/^'[^']*'$/.test(trimmed)) return trimmed.slice(1, -1);
  } catch {}
  throw new Error(`invalid Codex TOML string at line ${lineNumber}`);
};

const consumedTomlAssignment = (sourceLine, keys, lineNumber) => {
  const leading = sourceLine.trimStart();
  const key = keys.find(candidate => new RegExp(`^${candidate}(?=\\s|=|$)`).test(leading));
  if (!key) return undefined;
  const line = stripTomlComment(sourceLine).trim();
  const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
  if (!assignment || assignment[1] !== key || !assignment[2].trim()) throw new Error(`invalid Codex TOML syntax at line ${lineNumber}`);
  return [key, assignment[2]];
};

export function parseCodexToml(input) {
  const result = { providers: {} };
  const seen = new Set();
  let section = 'top';
  for (const [index, sourceLine] of String(input).split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const leading = sourceLine.trimStart();
    if (!leading || leading.startsWith('#')) continue;
    if (leading.startsWith('[')) {
      const provider = sourceLine.match(/^\s*\[\s*model_providers\s*\.\s*([A-Za-z0-9_-]+)\s*\]\s*(?:#.*)?$/);
      const selected = provider?.[1] === result.model_provider;
      section = selected ? `provider:${provider[1]}` : 'ignored';
      if (selected) result.providers[provider[1]] ||= {};
      continue;
    }
    const keys = section === 'top'
      ? ['model', 'model_provider']
      : section.startsWith('provider:')
        ? ['base_url', 'wire_api', 'experimental_bearer_token']
        : [];
    const assignment = consumedTomlAssignment(sourceLine, keys, lineNumber);
    if (!assignment) continue;
    const [key, rawValue] = assignment;
    if (section === 'top') {
      if (seen.has(`top:${key}`)) throw new Error(`duplicate Codex TOML key at line ${lineNumber}`);
      seen.add(`top:${key}`); result[key] = tomlString(rawValue, lineNumber);
    }
    if (section.startsWith('provider:')) {
      const target = `${section}:${key}`;
      if (seen.has(target)) throw new Error(`duplicate Codex TOML key at line ${lineNumber}`);
      seen.add(target); result.providers[section.slice(9)][key] = tomlString(rawValue, lineNumber);
    }
  }
  return result;
}

async function loadCodexConfig(env) {
  const file = env.CODEX_CONFIG_FILE || (env.CODEX_HOME ? path.join(env.CODEX_HOME, 'config.toml') : '');
  if (!file) return {};
  try { return parseCodexToml(await readFile(path.resolve(file), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && !env.CODEX_CONFIG_FILE) return {};
    if (error.code === 'ENOENT') throw new Error('explicit CODEX_CONFIG_FILE could not be read');
    throw error;
  }
}

function webhookUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  try {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    return url.href;
  } catch { throw new Error('invalid webhook URL'); }
}

export async function loadConfig({ configPath, env = process.env } = {}) {
  const defaults = await readJson(path.join(ROOT, 'config/default.json'));
  let explicit = {};
  if (configPath) explicit = JSON.parse(await readFile(path.resolve(configPath), 'utf8'));
  const setting = (name, explicitValue, defaultValue) => env[name] !== undefined && env[name] !== '' ? env[name] : explicitValue ?? defaultValue;
  const codex = await loadCodexConfig(env);
  const codexProvider = codex.providers?.[codex.model_provider] || {};
  const config = {
    ...defaults, ...explicit,
    network: { ...defaults.network, ...explicit.network },
    selection: {
      ...defaults.selection, ...explicit.selection,
      priorityInstitutionPaper: { ...defaults.selection?.priorityInstitutionPaper, ...explicit.selection?.priorityInstitutionPaper }
    },
    dataDir: path.resolve(env.DESIGNSIGNAL_DATA_DIR || explicit.dataDir || path.join(ROOT, 'data')),
    host: env.DESIGNSIGNAL_HOST || explicit.host || '127.0.0.1',
    port: Number(env.DESIGNSIGNAL_PORT || explicit.port || 3379),
    timezone: env.DESIGNSIGNAL_TIMEZONE || explicit.timezone || defaults.timezone,
    model: {
      baseUrl: env.OPENAI_BASE_URL || explicit.model?.baseUrl || codexProvider.base_url || 'https://api.openai.com/v1',
      model: env.OPENAI_MODEL || explicit.model?.model || codex.model || '',
      token: env.OPENAI_API_KEY || explicit.model?.token || codexProvider.experimental_bearer_token || '',
      provider: env.OPENAI_BASE_URL || env.OPENAI_MODEL || env.OPENAI_API_KEY ? 'openai-env' : explicit.model ? 'designsignal-config' : codex.model_provider || 'openai',
      wireApi: env.OPENAI_BASE_URL || env.OPENAI_MODEL || env.OPENAI_API_KEY ? 'responses' : explicit.model?.wireApi || codexProvider.wire_api || 'responses',
      maxOutputTokens: Number(setting('DESIGNSIGNAL_MODEL_MAX_OUTPUT_TOKENS', explicit.model?.maxOutputTokens, defaults.model?.maxOutputTokens ?? 6000)),
      concurrency: Number(setting('DESIGNSIGNAL_MODEL_CONCURRENCY', explicit.model?.concurrency, defaults.model?.concurrency ?? 2)),
      timeoutMs: Number(setting('DESIGNSIGNAL_MODEL_TIMEOUT_MS', explicit.model?.timeoutMs, defaults.model?.timeoutMs ?? 180000))
    },
    openAlex: {
      apiKey: env.OPENALEX_API_KEY || '',
      mailto: env.OPENALEX_MAILTO || ''
    },
    push: {
      generic: webhookUrl(env.DESIGNSIGNAL_WEBHOOK_URL || explicit.push?.generic || ''),
      feishu: webhookUrl(env.FEISHU_WEBHOOK_URL || explicit.push?.feishu || ''),
      wecom: webhookUrl(env.WECOM_WEBHOOK_URL || explicit.push?.wecom || '')
    },
    feishuDocument: {
      appId: env.FEISHU_APP_ID || '',
      appSecret: env.FEISHU_APP_SECRET || '',
      folderToken: env.FEISHU_DOC_FOLDER_TOKEN || '',
      tenantBaseUrl: env.FEISHU_TENANT_BASE_URL || 'https://feishu.cn'
    },
    study: {
      profileFile: env.DESIGNSIGNAL_STUDY_PROFILE_FILE ? path.resolve(env.DESIGNSIGNAL_STUDY_PROFILE_FILE) : explicit.study?.profileFile ? path.resolve(explicit.study.profileFile) : '',
      profileMaxBytes: Number(explicit.study?.profileMaxBytes || defaults.study?.profileMaxBytes || 16384),
      feedbackMaxBytes: Number(explicit.study?.feedbackMaxBytes || defaults.study?.feedbackMaxBytes || 65536),
      recentFeedbackCount: Number(explicit.study?.recentFeedbackCount || defaults.study?.recentFeedbackCount || 14),
      maxDirections: Number(explicit.study?.maxDirections || defaults.study?.maxDirections || 12),
      maxWeaknesses: Number(explicit.study?.maxWeaknesses || defaults.study?.maxWeaknesses || 12)
    }
  };
  const optionalFeeds = [
    ['rsshub', env.DESIGNSIGNAL_RSSHUB_FEEDS],
    ['rsshub-wechat', env.DESIGNSIGNAL_RSSHUB_WECHAT_FEEDS],
    ['rsshub-zhihu', env.DESIGNSIGNAL_RSSHUB_ZHIHU_FEEDS]
  ].flatMap(([prefix, value]) => String(value || '').split(',').map(x => x.trim()).filter(Boolean).map((url, i) => ({ id: `${prefix}-${i + 1}`, adapter: 'feed', url, locale: 'zh', category: 'frontier', optional: true, publicAccessOnly: true })));
  config.sources = [...(explicit.sources || defaults.sources), ...optionalFeeds];
  try {
    const modelUrl = new URL(config.model.baseUrl);
    if (!['http:', 'https:'].includes(modelUrl.protocol) || modelUrl.username || modelUrl.password || modelUrl.search || modelUrl.hash) throw new Error();
  } catch { throw new Error('invalid model base URL'); }
  try {
    const tenantUrl = new URL(config.feishuDocument.tenantBaseUrl);
    if (tenantUrl.protocol !== 'https:' || tenantUrl.username || tenantUrl.password || tenantUrl.port || tenantUrl.search || tenantUrl.hash || !['', '/'].includes(tenantUrl.pathname)) throw new Error();
    config.feishuDocument.tenantBaseUrl = tenantUrl.origin;
  } catch { throw new Error('invalid Feishu document-link origin'); }
  try {
    if (typeof config.timezone !== 'string' || config.timezone.length > 100) throw new Error();
    new Intl.DateTimeFormat('en-US', { timeZone: config.timezone }).format();
  } catch { throw new Error('invalid timezone'); }
  if (!Number.isInteger(config.model.maxOutputTokens) || config.model.maxOutputTokens < 256 || config.model.maxOutputTokens > 32768) throw new Error('model max output tokens must be an integer from 256 to 32768');
  if (!Number.isInteger(config.model.concurrency) || config.model.concurrency < 1 || config.model.concurrency > 4) throw new Error('model concurrency must be an integer from 1 to 4');
  if (!Number.isInteger(config.model.timeoutMs) || config.model.timeoutMs < 10000 || config.model.timeoutMs > 600000) throw new Error('model timeout must be an integer from 10000 to 600000 milliseconds');
  const priority = config.selection.priorityInstitutionPaper;
  if (!Array.isArray(priority.institutionIds) || priority.institutionIds.length < 1 || priority.institutionIds.length > 20 || new Set(priority.institutionIds).size !== priority.institutionIds.length || priority.institutionIds.some(id => !/^I\d+$/.test(id))) throw new Error('selection.priorityInstitutionPaper.institutionIds must contain 1..20 unique OpenAlex institution IDs');
  if (!Number.isInteger(priority.freshnessDays) || priority.freshnessDays < 1 || priority.freshnessDays > 30) throw new Error('selection.priorityInstitutionPaper.freshnessDays must be an integer from 1 to 30');
  if (!Number.isFinite(priority.maxScoreGap) || priority.maxScoreGap < 0 || priority.maxScoreGap > 30) throw new Error('selection.priorityInstitutionPaper.maxScoreGap must be from 0 to 30');
  for (const [key, min, max] of [['profileMaxBytes', 1024, 1048576], ['feedbackMaxBytes', 1024, 1048576], ['recentFeedbackCount', 1, 100], ['maxDirections', 1, 50], ['maxWeaknesses', 1, 50]]) {
    if (!Number.isInteger(config.study[key]) || config.study[key] < min || config.study[key] > max) throw new Error(`invalid study.${key}`);
  }
  return config;
}
export { ROOT };
