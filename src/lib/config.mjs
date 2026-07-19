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

export async function loadConfig({ configPath, env = process.env } = {}) {
  const defaults = await readJson(path.join(ROOT, 'config/default.json'));
  let explicit = {};
  if (configPath) explicit = JSON.parse(await readFile(path.resolve(configPath), 'utf8'));
  const codex = await loadCodexConfig(env);
  const codexProvider = codex.providers?.[codex.model_provider] || {};
  const config = {
    ...defaults, ...explicit,
    network: { ...defaults.network, ...explicit.network },
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
      maxOutputTokens: Number(env.DESIGNSIGNAL_MODEL_MAX_OUTPUT_TOKENS || explicit.model?.maxOutputTokens || defaults.model?.maxOutputTokens || 6000)
    },
    openAlex: {
      apiKey: env.OPENALEX_API_KEY || '',
      mailto: env.OPENALEX_MAILTO || ''
    },
    push: {
      generic: env.DESIGNSIGNAL_WEBHOOK_URL || explicit.push?.generic || '',
      feishu: env.FEISHU_WEBHOOK_URL || explicit.push?.feishu || '',
      wecom: env.WECOM_WEBHOOK_URL || explicit.push?.wecom || ''
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
    if (!['http:', 'https:'].includes(modelUrl.protocol) || modelUrl.username || modelUrl.password) throw new Error();
  } catch { throw new Error('invalid model base URL'); }
  if (!Number.isInteger(config.model.maxOutputTokens) || config.model.maxOutputTokens < 256 || config.model.maxOutputTokens > 32768) throw new Error('model max output tokens must be an integer from 256 to 32768');
  for (const [key, min, max] of [['profileMaxBytes', 1024, 1048576], ['feedbackMaxBytes', 1024, 1048576], ['recentFeedbackCount', 1, 100], ['maxDirections', 1, 50], ['maxWeaknesses', 1, 50]]) {
    if (!Number.isInteger(config.study[key]) || config.study[key] < min || config.study[key] > max) throw new Error(`invalid study.${key}`);
  }
  return config;
}
export { ROOT };
