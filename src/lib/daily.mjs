import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fixtureCandidates } from '../../fixtures/daily.mjs';
import { collectSources } from './adapters.mjs';
import { selectDaily } from './select.mjs';
import { enrichItems, synthesizeDaily } from './model.mjs';
import { buildReport } from './report.mjs';
import { readHistory, recoverReport, writeReport } from './storage.mjs';
import { queueDeliveries, retryOutbox } from './push.mjs';
import { atomicWrite, isoDate } from './util.mjs';
import { attachCachedAssets, persistSelectedAssets } from './assets.mjs';

const requiresCachedImage = item => ['product', 'ui'].includes(item.category);
const hasCachedImage = (byItem, item) => (byItem.get(item.id) || []).some(asset => asset.kind === 'image' && asset.localCacheRef && /^[a-f0-9]{64}$/.test(asset.hash || ''));

export async function collect(config, { dryRun = false, ctx = {} } = {}) {
  const result = await collectSources(config, ctx);
  if (!dryRun) { const dir = path.join(config.dataDir, 'collections'); await mkdir(dir, { recursive: true }); await atomicWrite(path.join(dir, `${new Date().toISOString().replaceAll(':', '-')}.json`), `${JSON.stringify(result, null, 2)}\n`); }
  return result;
}

export async function selectDailyWithRequiredAssets(config, candidates, { date, history = [], ctx = {} } = {}) {
  let pool = candidates;
  const requiredAssetRejected = [];
  const combinedAssetAudit = [];
  for (;;) {
    let selection;
    try {
      selection = selectDaily(pool, { date, history, priorityInstitutionPaper: config.selection.priorityInstitutionPaper });
    } catch (error) {
      if (!requiredAssetRejected.length) throw error;
      const wrapped = new Error(`insufficient validated image assets: ${error.message}`);
      wrapped.audit = { assets: combinedAssetAudit, rejected: requiredAssetRejected };
      throw wrapped;
    }
    const persisted = await persistSelectedAssets(config, selection.selected, ctx);
    combinedAssetAudit.push(...persisted.audit);
    const failed = selection.selected.filter(item => requiresCachedImage(item) && !hasCachedImage(persisted.byItem, item));
    if (!failed.length) {
      const rejected = [...selection.rejected, ...requiredAssetRejected].sort((a, b) => a.id.localeCompare(b.id) || a.sourceId.localeCompare(b.sourceId) || a.reason.localeCompare(b.reason));
      return { ...selection, rejected, persisted: { ...persisted, audit: combinedAssetAudit } };
    }
    for (const item of failed) requiredAssetRejected.push({ id: item.id, sourceId: item.source.id, reason: 'required-asset-failed', kind: 'image' });
    const failedIds = new Set(failed.map(item => item.id));
    pool = pool.filter(item => !failedIds.has(item.id));
  }
}

export async function daily(config, { fixture = false, dryRun = false, date = isoDate(new Date(), config.timezone), ctx = {} } = {}) {
  if (!fixture && !dryRun) {
    const recovered = await recoverReport(config.dataDir, date);
    if (recovered) {
      await queueDeliveries(config.dataDir, recovered.report, config);
      const deliveries = await retryOutbox(config.dataDir, config, ctx);
      return { ...recovered, deliveries };
    }
  }
  const collected = fixture ? { candidates: fixtureCandidates, health: [{ sourceId: 'offline-fixture', status: 'ok', count: fixtureCandidates.length, durationMs: 0 }] } : await collectSources(config, ctx);
  const history = fixture ? [] : await readHistory(config.dataDir);
  const selectedState = !fixture && !dryRun
    ? await selectDailyWithRequiredAssets(config, collected.candidates, { date, history, ctx })
    : { ...selectDaily(collected.candidates, { date, history, priorityInstitutionPaper: config.selection.priorityInstitutionPaper }), persisted: { byItem: new Map(), audit: [] } };
  const { selected, rejected, policy, persisted } = selectedState;
  const items = fixture ? selected : await enrichItems(selected, config, ctx, (item, raw) => attachCachedAssets(item, persisted.byItem.get(raw.id)));
  const generated = fixture ? null : await synthesizeDaily(items, config, ctx);
  const report = await buildReport({ date, items, rejected, health: collected.health, selectionPolicy: policy, assetAudit: persisted.audit, fixture, generated });
  if (dryRun || fixture) return { status: dryRun ? 'dry-run' : 'fixture-no-write', report };
  const result = await writeReport(config.dataDir, report);
  await queueDeliveries(config.dataDir, result.report, config);
  const deliveries = await retryOutbox(config.dataDir, config, ctx);
  return { ...result, deliveries };
}
