import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson } from './util.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
export async function loadConfig({ configPath, env = process.env } = {}) {
  const defaults = await readJson(path.join(ROOT, 'config/default.json'));
  let explicit = {};
  if (configPath) explicit = JSON.parse(await readFile(path.resolve(configPath), 'utf8'));
  const config = {
    ...defaults, ...explicit,
    network: { ...defaults.network, ...explicit.network },
    dataDir: path.resolve(env.DESIGNSIGNAL_DATA_DIR || explicit.dataDir || path.join(ROOT, 'data')),
    host: env.DESIGNSIGNAL_HOST || explicit.host || '127.0.0.1',
    port: Number(env.DESIGNSIGNAL_PORT || explicit.port || 3379),
    timezone: env.DESIGNSIGNAL_TIMEZONE || explicit.timezone || defaults.timezone,
    model: {
      baseUrl: env.OPENAI_BASE_URL || explicit.model?.baseUrl || 'https://api.openai.com/v1',
      model: env.OPENAI_MODEL || explicit.model?.model || '',
      token: env.OPENAI_API_KEY || explicit.model?.token || ''
    },
    push: {
      generic: env.DESIGNSIGNAL_WEBHOOK_URL || explicit.push?.generic || '',
      feishu: env.FEISHU_WEBHOOK_URL || explicit.push?.feishu || '',
      wecom: env.WECOM_WEBHOOK_URL || explicit.push?.wecom || ''
    }
  };
  const feeds = String(env.DESIGNSIGNAL_RSSHUB_FEEDS || '').split(',').map(x => x.trim()).filter(Boolean);
  config.sources = [...(explicit.sources || defaults.sources), ...feeds.map((url, i) => ({ id: `rsshub-${i + 1}`, adapter: 'feed', url, locale: 'zh', category: 'frontier', optional: true }))];
  return config;
}
export { ROOT };
