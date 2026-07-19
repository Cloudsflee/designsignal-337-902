import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fixtureCandidates } from '../../fixtures/daily.mjs';
import { collectSources } from './adapters.mjs';
import { selectDaily } from './select.mjs';
import { enrichItem } from './model.mjs';
import { buildReport } from './report.mjs';
import { readHistory, writeReport } from './storage.mjs';
import { queueDeliveries, retryOutbox } from './push.mjs';
import { atomicWrite, isoDate } from './util.mjs';

export async function collect(config, { dryRun = false, ctx = {} } = {}) {
  const result = await collectSources(config, ctx);
  if (!dryRun) { const dir = path.join(config.dataDir, 'collections'); await mkdir(dir, { recursive: true }); await atomicWrite(path.join(dir, `${new Date().toISOString().replaceAll(':', '-')}.json`), `${JSON.stringify(result, null, 2)}\n`); }
  return result;
}

export async function daily(config, { fixture = false, dryRun = false, date = isoDate(new Date(), config.timezone), ctx = {} } = {}) {
  const collected = fixture ? { candidates: fixtureCandidates, health: [{ sourceId: 'offline-fixture', status: 'ok', count: fixtureCandidates.length, durationMs: 0 }] } : await collectSources(config, ctx);
  const history = fixture ? [] : await readHistory(config.dataDir);
  const { selected, rejected, policy } = selectDaily(collected.candidates, { date, history });
  const items = fixture ? selected : await Promise.all(selected.map(x => enrichItem(x, config, ctx)));
  const report = await buildReport({ date, items, rejected, health: collected.health, selectionPolicy: policy, fixture });
  if (dryRun) return { status: 'dry-run', report };
  const result = await writeReport(config.dataDir, report);
  if (result.status === 'written') await queueDeliveries(config.dataDir, report, config);
  const deliveries = await retryOutbox(config.dataDir, config, ctx);
  return { ...result, deliveries };
}
