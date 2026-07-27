import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fixtureCandidates } from '../../fixtures/daily.mjs';
import { collectSources } from './adapters.mjs';
import { selectDaily } from './select.mjs';
import { enrichItems, synthesizeDaily } from './model.mjs';
import { buildReport } from './report.mjs';
import { readHistory, recoverReport, writeReport } from './storage.mjs';
import { queueDeliveries, retryOutbox } from './push.mjs';
import { atomicWrite, isoDate, isIsoDate, withLock } from './util.mjs';
import { attachCachedAssets, persistSelectedAssets } from './assets.mjs';
import { loadExamEvidence } from './evidence.mjs';
import { loadRecentFeedback, loadStudyProfile } from './study.mjs';
import { validateItem, validateReport } from './schema.mjs';
import { createRunInput, openExecutionSession, readExecutionRun } from './runtime.mjs';

export async function collect(config, { dryRun = false, ctx = {} } = {}) {
  const result = await collectSources(config, ctx);
  if (!dryRun) {
    const dir = path.join(config.dataDir, 'collections');
    await mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, `${new Date().toISOString().replaceAll(':', '-')}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

const fixtureHealth = () => [{ sourceId: 'offline-fixture', status: 'ok', count: fixtureCandidates.length, durationMs: 0 }];
const requiresCachedImage = item => ['product', 'ui'].includes(item.category);
const hasCachedImage = (byItem, item) =>
  (byItem.get(item.id) || []).some(
    asset => asset.kind === 'image' && asset.localCacheRef && /^[a-f0-9]{64}$/.test(asset.hash || '')
  );

export async function selectDailyWithRequiredAssets(config, candidates, { date, history = [], ctx = {} } = {}) {
  let pool = candidates;
  const requiredAssetRejected = [];
  const combinedAssetAudit = [];
  for (;;) {
    let selection;
    try {
      selection = selectDaily(pool, {
        date,
        history,
        priorityInstitutionPaper: config.selection.priorityInstitutionPaper
      });
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
      const rejected = [...selection.rejected, ...requiredAssetRejected].sort(
        (a, b) => a.id.localeCompare(b.id) || a.sourceId.localeCompare(b.sourceId) || a.reason.localeCompare(b.reason)
      );
      return { ...selection, rejected, persisted: { ...persisted, audit: combinedAssetAudit } };
    }
    for (const item of failed)
      requiredAssetRejected.push({ id: item.id, sourceId: item.source.id, reason: 'required-asset-failed', kind: 'image' });
    const failedIds = new Set(failed.map(item => item.id));
    pool = pool.filter(item => !failedIds.has(item.id));
  }
}

function assertEvidenceBundle(bundle) {
  if (!Array.isArray(bundle?.candidates) || !Array.isArray(bundle.health) || !Array.isArray(bundle.history) || !bundle.examEvidence) throw new Error('evidence bundle is incomplete');
  return bundle;
}

function assertConstraintResult(result) {
  if (!Array.isArray(result?.selected) || result.selected.length !== 6 || !Array.isArray(result.rejected) || !result.policy) throw new Error('constraint result is incomplete');
  return result;
}

function assertSelectionDecision(result) {
  if (
    !Array.isArray(result?.selected) ||
    result.selected.length !== 6 ||
    !Array.isArray(result.rejected) ||
    !result.policy ||
    !Array.isArray(result.assetAudit) ||
    !result.cachedAssets ||
    typeof result.cachedAssets !== 'object'
  )
    throw new Error('selection decision is incomplete');
  return result;
}

function assertEnrichedItems(result) {
  if (!Array.isArray(result?.items) || result.items.length !== 6) throw new Error('execution must produce six items');
  result.items.forEach(validateItem);
  return result;
}

const integrationReceipt = (date, publication, deliveries) => ({
  report_date: date,
  publication: {
    status: publication.status,
    path: `reports/${date}`,
    manifest: 'manifest.ndjson'
  },
  deliveries
});

async function executePipeline(config, { fixture, dryRun, date, ctx }) {
  const persistent = !fixture && !dryRun;
  const input = createRunInput(config, date, { mode: persistent ? 'live' : fixture ? 'fixture' : 'dry-run' });
  const session = await openExecutionSession(config.dataDir, input, { persist: persistent });

  await session.execute('evidence', async () => {
    const [collected, history, examEvidence, studyProfile, recentFeedback] = await Promise.all([
      fixture ? { candidates: fixtureCandidates, health: fixtureHealth() } : collectSources(config, ctx),
      fixture ? [] : readHistory(config.dataDir),
      loadExamEvidence(),
      fixture ? null : loadStudyProfile(config),
      fixture ? [] : loadRecentFeedback(config)
    ]);
    return assertEvidenceBundle({ ...collected, history, examEvidence, studyProfile, recentFeedback });
  });

  await session.execute('constraints', async ({ inputs }) => {
    const source = assertEvidenceBundle(inputs.evidence);
    return {
      ...assertConstraintResult(selectDaily(source.candidates, {
      date,
      history: source.history,
      priorityInstitutionPaper: config.selection.priorityInstitutionPaper
      })),
      candidates: source.candidates,
      history: source.history
    };
  });

  await session.execute('decision', async ({ inputs }) => {
    const constraints = assertConstraintResult(inputs.constraints);
    if (!persistent)
      return assertSelectionDecision({
        selected: constraints.selected,
        rejected: constraints.rejected,
        policy: constraints.policy,
        cachedAssets: {},
        assetAudit: []
      });
    const selection = await selectDailyWithRequiredAssets(config, constraints.candidates, {
        date,
        history: constraints.history,
        ctx
      }),
      persisted = selection.persisted;
    return assertSelectionDecision({
      selected: selection.selected,
      rejected: selection.rejected,
      policy: selection.policy,
      cachedAssets: Object.fromEntries([...persisted.byItem.entries()]),
      assetAudit: persisted.audit
    });
  });

  await session.execute('execution', async ({ inputs }) => {
    const selectedDecision = assertSelectionDecision(inputs.decision);
    const items = fixture
      ? selectedDecision.selected
      : await enrichItems(selectedDecision.selected, config, ctx, (item, raw) => attachCachedAssets(item, selectedDecision.cachedAssets[raw.id]));
    return assertEnrichedItems({ items });
  });

  const report = await session.execute('acceptance', async ({ inputs }) => {
    const source = assertEvidenceBundle(inputs.evidence);
    const selectedDecision = assertSelectionDecision(inputs.decision);
    const analyzed = assertEnrichedItems(inputs.execution);
    const generated = fixture ? null : await synthesizeDaily(analyzed.items, config, ctx, {
      examEvidence: source.examEvidence,
      studyProfile: source.studyProfile,
      recentFeedback: source.recentFeedback
    });
    return validateReport(await buildReport({
      date,
      items: analyzed.items,
      rejected: selectedDecision.rejected,
      health: source.health,
      selectionPolicy: selectedDecision.policy,
      assetAudit: selectedDecision.assetAudit,
      fixture,
      generated,
      examEvidence: source.examEvidence
    }));
  });

  if (!persistent) {
    const status = dryRun ? 'dry-run' : 'fixture-no-write';
    await session.execute('integration', async () => integrationReceipt(date, { status }, []));
    return { status, report, execution: session.summary() };
  }

  const receipt = await session.execute('integration', async ({ inputs }) => {
    const acceptedReport = validateReport(inputs.acceptance);
    const publication = await writeReport(config.dataDir, acceptedReport);
    await queueDeliveries(config.dataDir, publication.report, config);
    const deliveries = await retryOutbox(config.dataDir, config, ctx);
    return integrationReceipt(date, publication, deliveries);
  });
  return {
    status: receipt.publication.status,
    dir: path.join(config.dataDir, receipt.publication.path),
    report,
    deliveries: receipt.deliveries,
    execution: session.summary()
  };
}

async function recoverPublishedRun(config, date, recovered, ctx) {
  await queueDeliveries(config.dataDir, recovered.report, config);
  const deliveries = await retryOutbox(config.dataDir, config, ctx);
  let execution = await readExecutionRun(config.dataDir, date, { verifyAssets: false });
  if (execution && execution.stages.slice(0, 5).every(stage => stage.state === 'completed')) {
    const input = createRunInput(config, date, { mode: 'live' });
    const session = await openExecutionSession(config.dataDir, input, { allowInputSuperseded: true });
    await session.execute('integration', async () => integrationReceipt(date, recovered, deliveries));
    execution = session.summary();
  }
  return { ...recovered, deliveries, ...(execution ? { execution } : {}) };
}

async function runDaily(config, { fixture, dryRun, date, ctx }) {
  if (!fixture && !dryRun) {
    const recovered = await recoverReport(config.dataDir, date);
    if (recovered) return recoverPublishedRun(config, date, recovered, ctx);
  }
  return executePipeline(config, { fixture, dryRun, date, ctx });
}

export async function daily(config, { fixture = false, dryRun = false, date = isoDate(new Date(), config.timezone), ctx = {} } = {}) {
  if (!isIsoDate(date)) throw new Error('invalid report date');
  if (fixture || dryRun) return runDaily(config, { fixture, dryRun, date, ctx });
  const lock = path.join(config.dataDir, 'locks', `${date}.run.lock`);
  return withLock(lock, () => runDaily(config, { fixture, dryRun, date, ctx }));
}
