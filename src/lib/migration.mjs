import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { buildBriefing } from './briefing.mjs';
import { assertStoredDocumentJob, queueDeliveries } from './push.mjs';
import { renderHtml, renderMarkdown } from './render.mjs';
import { validateReport } from './schema.mjs';
import {
  canonicalJson, EXECUTION_CONTEXT_SCHEMA, openExecutionSession, readExecutionRun
} from './runtime.mjs';
import { atomicWrite, isIsoDate, sha256, withLock } from './util.mjs';
import { assertStoredWebhookJob, WEBHOOK_JOB_VERSION } from './webhook.mjs';

const REPORT_SCHEMA_VERSION = 4;
const MIGRATION_SCHEMA = 'designsignal.current_data_migration.v1';
const WEBHOOK_CHANNELS = new Set(['generic', 'feishu', 'wecom']);
const DOCUMENT_CHANNEL = 'feishu-document';

const reportFile = (dataDir, date, name = 'report.json') => path.join(dataDir, 'reports', date, name);
const clone = value => JSON.parse(JSON.stringify(value));
const completedRun = run => ['completed', 'completed_input_superseded'].includes(run?.state);

async function readOptional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function priorityFallback(report, config) {
  const policy = config.selection?.priorityInstitutionPaper || {};
  const configuredInstitutionIds = [...new Set(policy.institutionIds || [])];
  if (!configuredInstitutionIds.length) throw new Error('priority institution IDs required for schema v2 migration');
  const matchedCount = report.items.filter(item => item.category === 'paper' &&
    item.institutionProvenance?.matchedInstitutions?.some(institution => configuredInstitutionIds.includes(institution.id))).length;
  return {
    configuredInstitutionIds,
    freshnessDays: policy.freshnessDays,
    maxScoreGap: policy.maxScoreGap,
    matchedCount,
    validatedCount: 0,
    freshCount: 0,
    eligibleCount: 0,
    ineligibleReasons: matchedCount ? { 'historical-audit-unavailable': matchedCount } : {},
    decision: 'fallback',
    reason: matchedCount ? 'no-valid-priority-candidate' : 'no-matching-priority-provenance',
    selectedItemId: null,
    selectedSourceId: null,
    selectedInstitution: null,
    replacement: null
  };
}

function migrationMetadata(report) {
  const migration = report.audit?.migration;
  if (migration === undefined) return null;
  if (migration?.schema !== MIGRATION_SCHEMA || ![2, 3].includes(migration.source_schema_version) ||
      !/^[a-f0-9]{64}$/.test(migration.source_sha256 || '') || !Number.isFinite(Date.parse(migration.migrated_at))) {
    throw new Error(`invalid report migration metadata for ${report.date || 'unknown date'}`);
  }
  return migration;
}

function currentReport(source, sourceJson, config, migratedAt) {
  if (![2, 3, REPORT_SCHEMA_VERSION].includes(source?.schemaVersion)) throw new Error('unsupported historical report schema version');
  const originalSchemaVersion = source.schemaVersion;
  const report = clone(source);
  if (originalSchemaVersion === 2) {
    report.audit ||= {};
    report.audit.selectionPolicy ||= {};
    report.audit.selectionPolicy.priorityInstitutionPaper = priorityFallback(report, config);
  }
  if (originalSchemaVersion < REPORT_SCHEMA_VERSION) {
    report.schemaVersion = REPORT_SCHEMA_VERSION;
    report.briefing = buildBriefing(report.items);
    report.audit.migration = {
      schema: MIGRATION_SCHEMA,
      source_schema_version: originalSchemaVersion,
      source_sha256: sha256(sourceJson),
      migrated_at: migratedAt
    };
  }
  validateReport(report);
  const migration = migrationMetadata(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  return {
    date: report.date,
    report,
    json,
    sourceJson,
    sourceSha256: sha256(sourceJson),
    migrationSourceSha256: migration?.source_sha256 || sha256(sourceJson),
    sha256: sha256(json),
    sourceSchemaVersion: originalSchemaVersion,
    schemaChanged: originalSchemaVersion < REPORT_SCHEMA_VERSION,
    changed: json !== sourceJson
  };
}

async function inspectReports(dataDir, config, migratedAt) {
  let dates;
  try { dates = await readdir(path.join(dataDir, 'reports')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const date of dates.filter(isIsoDate).sort()) {
    const sourceJson = await readFile(reportFile(dataDir, date), 'utf8');
    const record = currentReport(JSON.parse(sourceJson), sourceJson, config, migratedAt);
    if (record.date !== date) throw new Error(`report date mismatch for ${date}`);
    record.markdown = renderMarkdown(record.report);
    record.html = renderHtml(record.report);
    record.markdownChanged = await readOptional(reportFile(dataDir, date, 'report.md')) !== record.markdown;
    record.htmlChanged = await readOptional(reportFile(dataDir, date, 'report.html')) !== record.html;
    record.needsWrite = record.changed || record.markdownChanged || record.htmlChanged;
    record.run = await readExecutionRun(dataDir, date);
    if (record.run && !completedRun(record.run) && record.run.mode !== 'historical_migration') throw new Error(`published report has incomplete non-migration run for ${date}`);
    record.needsRunMigration = !record.run || !completedRun(record.run);
    records.push(record);
  }
  return records;
}

async function inspectManifest(dataDir, reports) {
  const source = await readFile(path.join(dataDir, 'manifest.ndjson'), 'utf8');
  const entries = source.trim().split('\n').filter(Boolean).map(JSON.parse);
  const byDate = new Map(reports.map(record => [record.date, record]));
  if (entries.length !== reports.length || new Set(entries.map(entry => entry.date)).size !== entries.length) throw new Error('manifest/report cardinality mismatch');
  const current = entries.map(entry => {
    const record = byDate.get(entry.date);
    if (!record || entry.path !== `reports/${entry.date}/report.json` || entry.generatedAt !== record.report.generatedAt) throw new Error(`invalid manifest identity for ${entry.date}`);
    const itemIds = record.report.items.map(item => item.id);
    const itemUrls = record.report.items.map(item => item.source.url);
    if (JSON.stringify(entry.itemIds) !== JSON.stringify(itemIds)) throw new Error(`manifest item identity mismatch for ${entry.date}`);
    if (entry.itemUrls !== undefined && JSON.stringify(entry.itemUrls) !== JSON.stringify(itemUrls)) throw new Error(`manifest item URL mismatch for ${entry.date}`);
    const interruptedSourceHash = record.migrationSourceSha256 === entry.sha256;
    if (entry.sha256 !== record.sourceSha256 && !interruptedSourceHash) throw new Error(`manifest report hash mismatch for ${entry.date}`);
    return {
      date: record.date,
      generatedAt: record.report.generatedAt,
      path: `reports/${record.date}/report.json`,
      sha256: record.sha256,
      itemIds,
      itemUrls
    };
  });
  const json = `${current.map(entry => JSON.stringify(entry)).join('\n')}\n`;
  return { source, entries: current, json, changed: json !== source };
}

async function inspectOutbox(dataDir) {
  let names;
  try { names = await readdir(path.join(dataDir, 'outbox')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const name of names.filter(value => value.endsWith('.json')).sort()) {
    const file = path.join(dataDir, 'outbox', name), source = await readFile(file, 'utf8');
    const parsed = JSON.parse(source);
    let job = parsed;
    if (WEBHOOK_CHANNELS.has(parsed.channel)) {
      if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== WEBHOOK_JOB_VERSION) throw new Error(`unsupported webhook job schema version in ${name}`);
      job = { ...parsed, schemaVersion: WEBHOOK_JOB_VERSION };
      assertStoredWebhookJob(job, name);
    } else if (parsed.channel === DOCUMENT_CHANNEL) assertStoredDocumentJob(parsed, name);
    else throw new Error(`unknown outbox job ${name}`);
    const json = `${JSON.stringify(job, null, 2)}\n`;
    records.push({ file, name, job, json, source, changed: json !== source, migrated: WEBHOOK_CHANNELS.has(parsed.channel) && parsed.schemaVersion !== WEBHOOK_JOB_VERSION });
  }
  return records;
}

function missingDeliveryIdentities(reports, outbox) {
  const actual = new Set(outbox.map(record => `${record.job.reportDate}:${record.job.channel}`));
  return reports.flatMap(record => [...WEBHOOK_CHANNELS, DOCUMENT_CHANNEL]
    .map(channel => `${record.date}:${channel}`)
    .filter(identity => !actual.has(identity)));
}

function migrationInput(record) {
  const parameters = {
    pipeline_version: 1,
    migration_schema: MIGRATION_SCHEMA,
    report_date: record.date,
    source_report_sha256: record.migrationSourceSha256,
    report_sha256: record.sha256,
    limitations: ['historical stage timing and transient candidate state were not available; outputs are reconstructed from the verified published report']
  };
  return {
    schema: EXECUTION_CONTEXT_SCHEMA,
    date: record.date,
    mode: 'historical_migration',
    immutable: true,
    parameters,
    input_snapshot_hash: sha256(canonicalJson({ schema: EXECUTION_CONTEXT_SCHEMA, parameters }))
  };
}

async function createHistoricalRun(dataDir, record, outbox, now) {
  const session = await openExecutionSession(dataDir, migrationInput(record), { now });
  const provenance = {
    schema: MIGRATION_SCHEMA,
    source_report_sha256: record.migrationSourceSha256,
    report_sha256: record.sha256,
    reconstructed: true
  };
  await session.execute('evidence', async () => ({
    candidates: record.report.items,
    health: record.report.audit.sourceHealth || [],
    history: [],
    examEvidence: record.report.evidence,
    migration: provenance
  }));
  await session.execute('constraints', async () => ({
    selected: record.report.items,
    rejected: record.report.audit.rejected,
    policy: record.report.audit.selectionPolicy,
    migration: provenance
  }));
  await session.execute('decision', async () => ({
    selected: record.report.items,
    cachedAssets: Object.fromEntries(record.report.items.map(item => [item.id, item.assets || []])),
    assetAudit: record.report.audit.assets || [],
    migration: provenance
  }));
  await session.execute('execution', async () => ({ items: record.report.items, migration: provenance }));
  await session.execute('acceptance', async () => record.report);
  await session.execute('integration', async () => ({
    report_date: record.date,
    publication: { status: 'migrated', path: `reports/${record.date}`, manifest: 'manifest.ndjson' },
    deliveries: outbox.filter(item => item.job.reportDate === record.date).map(item => ({
      schemaVersion: item.job.schemaVersion,
      id: item.job.id,
      channel: item.job.channel,
      state: item.job.state
    })),
    migration: provenance
  }));
  const result = session.summary();
  if (result.state !== 'completed') throw new Error(`historical run migration incomplete for ${record.date}`);
  return result;
}

async function inspect(dataDir, config, migratedAt) {
  const reports = await inspectReports(dataDir, config, migratedAt);
  const manifest = await inspectManifest(dataDir, reports);
  const outbox = await inspectOutbox(dataDir);
  return { reports, manifest, outbox, missingDeliveries: missingDeliveryIdentities(reports, outbox) };
}

function summary(value, mode, createdRuns = [], createdDeliveries = []) {
  return {
    schema: MIGRATION_SCHEMA,
    mode,
    report_count: value.reports.length,
    migrated_reports: value.reports.filter(record => record.schemaChanged).map(record => ({ date: record.date, from: record.sourceSchemaVersion, to: REPORT_SCHEMA_VERSION })),
    rewritten_report_artifacts: value.reports.filter(record => record.markdownChanged || record.htmlChanged).map(record => record.date),
    manifest_rewritten: value.manifest.changed,
    migrated_delivery_jobs: value.outbox.filter(record => record.migrated).map(record => record.name),
    missing_delivery_identities: value.missingDeliveries,
    created_delivery_identities: createdDeliveries,
    missing_run_dates: value.reports.filter(record => !record.run).map(record => record.date),
    incomplete_run_dates: value.reports.filter(record => record.run && !completedRun(record.run)).map(record => record.date),
    created_run_dates: createdRuns.map(run => run.date)
  };
}

export async function migrateData(dataDir, config, { dryRun = true, now = Date.now } = {}) {
  const migratedAt = new Date(now()).toISOString();
  const initial = await inspect(dataDir, config, migratedAt);
  if (dryRun) return summary(initial, 'dry-run');
  return withLock(path.join(dataDir, 'locks', 'current-data-migration.lock'), async () => {
    const current = await inspect(dataDir, config, migratedAt);
    for (const record of current.reports.filter(item => item.needsWrite)) {
      if (record.changed) await atomicWrite(reportFile(dataDir, record.date), record.json);
      if (record.markdownChanged) await atomicWrite(reportFile(dataDir, record.date, 'report.md'), record.markdown);
      if (record.htmlChanged) await atomicWrite(reportFile(dataDir, record.date, 'report.html'), record.html);
    }
    for (const record of current.outbox.filter(item => item.changed)) await atomicWrite(record.file, record.json);
    if (current.manifest.changed) await atomicWrite(path.join(dataDir, 'manifest.ndjson'), current.manifest.json);
    for (const record of current.reports) await queueDeliveries(dataDir, record.report, config);
    const migratedOutbox = await inspectOutbox(dataDir);
    const createdRuns = [];
    for (const record of current.reports.filter(item => item.needsRunMigration)) createdRuns.push(await createHistoricalRun(dataDir, record, migratedOutbox, now));
    const verified = await inspect(dataDir, config, migratedAt);
    if (verified.reports.some(record => record.needsWrite || record.needsRunMigration) || verified.manifest.changed || verified.outbox.some(record => record.migrated) || verified.missingDeliveries.length) throw new Error('current data migration verification failed');
    return summary(current, 'applied', createdRuns, current.missingDeliveries);
  });
}
