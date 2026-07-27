import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { migrateData } from '../src/lib/migration.mjs';
import { queueDeliveries } from '../src/lib/push.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { readExecutionRun } from '../src/lib/runtime.mjs';
import { validateReport } from '../src/lib/schema.mjs';
import { latestReport, readHistory, writeReport } from '../src/lib/storage.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { sha256 } from '../src/lib/util.mjs';

test('current data migration upgrades reports, manifests, delivery jobs and execution lineage once', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ds-current-migration-'));
  try {
    const config = await loadConfig({ env: { DESIGNSIGNAL_DATA_DIR: dataDir } });
    const selection = selectDaily(fixtureCandidates, {
      date: '2026-07-19',
      history: [],
      priorityInstitutionPaper: config.selection.priorityInstitutionPaper
    });
    const report = await buildReport({
      date: '2026-07-19',
      items: selection.selected,
      rejected: selection.rejected,
      health: [],
      selectionPolicy: selection.policy,
      fixture: true
    });
    await writeReport(dataDir, report);
    const jobs = await queueDeliveries(dataDir, report, config);

    const historical = structuredClone(report);
    historical.schemaVersion = 2;
    delete historical.briefing;
    delete historical.audit.selectionPolicy.priorityInstitutionPaper;
    const historicalJson = `${JSON.stringify(historical, null, 2)}\n`;
    const reportPath = path.join(dataDir, 'reports', report.date, 'report.json');
    await writeFile(reportPath, historicalJson);
    await writeFile(path.join(dataDir, 'reports', report.date, 'report.md'), 'stale markdown\n');
    await writeFile(path.join(dataDir, 'reports', report.date, 'report.html'), 'stale html\n');

    const manifestPath = path.join(dataDir, 'manifest.ndjson');
    const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).trim());
    delete manifest.itemUrls;
    manifest.sha256 = sha256(historicalJson);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    const invalidManifest = structuredClone(manifest);
    invalidManifest.itemIds[0] = 'tampered-item';
    await writeFile(manifestPath, `${JSON.stringify(invalidManifest)}\n`);
    await assert.rejects(() => migrateData(dataDir, config, { dryRun: true }), /manifest item identity mismatch/);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    const webhooks = jobs.filter(job => ['generic', 'feishu', 'wecom'].includes(job.channel));
    const missing = webhooks.find(job => job.channel === 'generic');
    await rm(path.join(dataDir, 'outbox', `${missing.id}.json`));
    for (const job of webhooks.filter(item => item !== missing)) {
      delete job.schemaVersion;
      await writeFile(path.join(dataDir, 'outbox', `${job.id}.json`), `${JSON.stringify(job)}\n`);
    }

    const unsupportedWebhook = webhooks.find(job => job.channel === 'feishu');
    unsupportedWebhook.schemaVersion = 99;
    await writeFile(path.join(dataDir, 'outbox', `${unsupportedWebhook.id}.json`), `${JSON.stringify(unsupportedWebhook)}\n`);
    await assert.rejects(() => migrateData(dataDir, config, { dryRun: true }), /unsupported webhook job schema version/);
    delete unsupportedWebhook.schemaVersion;
    await writeFile(path.join(dataDir, 'outbox', `${unsupportedWebhook.id}.json`), `${JSON.stringify(unsupportedWebhook)}\n`);

    const document = jobs.find(job => job.channel === 'feishu-document');
    const documentPath = path.join(dataDir, 'outbox', `${document.id}.json`);
    const documentJson = await readFile(documentPath, 'utf8');
    const invalidDocument = JSON.parse(documentJson);
    invalidDocument.totalBlocks = 0;
    await writeFile(documentPath, `${JSON.stringify(invalidDocument)}\n`);
    await assert.rejects(() => migrateData(dataDir, config, { dryRun: true }), /invalid Feishu document job progress/);
    await writeFile(documentPath, documentJson);

    const fixedNow = () => Date.parse('2026-07-25T00:00:00.000Z');
    const beforeDryRun = await readFile(reportPath, 'utf8');
    const planned = await migrateData(dataDir, config, { dryRun: true, now: fixedNow });
    assert.deepEqual(planned.migrated_reports, [{ date: report.date, from: 2, to: 4 }]);
    assert.deepEqual(planned.rewritten_report_artifacts, [report.date]);
    assert.deepEqual(planned.missing_delivery_identities, [`${report.date}:generic`]);
    assert.deepEqual(planned.missing_run_dates, [report.date]);
    assert.equal(await readFile(reportPath, 'utf8'), beforeDryRun);

    const applied = await migrateData(dataDir, config, { dryRun: false, now: fixedNow });
    assert.deepEqual(applied.created_delivery_identities, [`${report.date}:generic`]);
    assert.deepEqual(applied.created_run_dates, [report.date]);

    const migrated = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(validateReport(migrated), migrated);
    assert.equal(migrated.schemaVersion, 4);
    assert.equal(migrated.audit.migration.source_schema_version, 2);
    assert.equal(migrated.audit.migration.source_sha256, sha256(historicalJson));
    assert.deepEqual(await latestReport(dataDir), migrated);
    assert.equal((await readHistory(dataDir)).length, 6);

    const currentJobs = await Promise.all((await readdir(path.join(dataDir, 'outbox'))).map(async name => JSON.parse(await readFile(path.join(dataDir, 'outbox', name), 'utf8'))));
    assert.equal(currentJobs.length, 4);
    assert.ok(currentJobs.every(job => job.schemaVersion === 1));
    const run = await readExecutionRun(dataDir, report.date);
    assert.equal(run.state, 'completed');
    assert.equal(run.mode, 'historical_migration');
    assert.ok(run.stages.every(stage => stage.state === 'completed' && stage.output_bindings.length === 1));

    const second = await migrateData(dataDir, config, { dryRun: true, now: fixedNow });
    assert.deepEqual(second.migrated_reports, []);
    assert.deepEqual(second.rewritten_report_artifacts, []);
    assert.equal(second.manifest_rewritten, false);
    assert.deepEqual(second.migrated_delivery_jobs, []);
    assert.deepEqual(second.missing_delivery_identities, []);
    assert.deepEqual(second.missing_run_dates, []);
    assert.deepEqual(second.incomplete_run_dates, []);

    const runPath = path.join(dataDir, 'runs', report.date, 'run.json');
    const interruptedRun = JSON.parse(await readFile(runPath, 'utf8'));
    const integration = interruptedRun.stages.at(-1);
    Object.assign(integration, {
      state: 'pending', blocked_by: [], input_snapshot_hash: null, execution_context: null,
      output_bindings: [], failure: null, started_at: null, completed_at: null
    });
    interruptedRun.state = 'pending';
    interruptedRun.completed_at = null;
    await writeFile(runPath, `${JSON.stringify(interruptedRun, null, 2)}\n`);
    const resumable = await migrateData(dataDir, config, { dryRun: true, now: fixedNow });
    assert.deepEqual(resumable.incomplete_run_dates, [report.date]);
    await migrateData(dataDir, config, { dryRun: false, now: fixedNow });
    assert.equal((await readExecutionRun(dataDir, report.date)).state, 'completed');

    const interruptedManifest = JSON.parse((await readFile(manifestPath, 'utf8')).trim());
    interruptedManifest.sha256 = migrated.audit.migration.source_sha256;
    delete interruptedManifest.itemUrls;
    await writeFile(manifestPath, `${JSON.stringify(interruptedManifest)}\n`);
    const resumed = await migrateData(dataDir, config, { dryRun: true, now: fixedNow });
    assert.equal(resumed.manifest_rewritten, true);
    await migrateData(dataDir, config, { dryRun: false, now: fixedNow });
    assert.equal((await migrateData(dataDir, config, { dryRun: true, now: fixedNow })).manifest_rewritten, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
