#!/usr/bin/env node
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { collect, daily } from './lib/daily.mjs';
import { loadExamEvidence } from './lib/evidence.mjs';
import { retryOutbox } from './lib/push.mjs';
import { runScheduler } from './lib/scheduler.mjs';
import { serve } from './lib/server.mjs';
import { parseArgs, redact } from './lib/util.mjs';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { selectDaily } from './lib/select.mjs';
import { buildReport } from './lib/report.mjs';

const [command, ...rest] = process.argv.slice(2), args = parseArgs(rest);
const config = await loadConfig({ configPath: args.config === true ? undefined : args.config });
const print = value => process.stdout.write(`${JSON.stringify(redact(value), null, args.json ? 0 : 2)}\n`);

try {
  if (command === 'collect') print(await collect(config, { dryRun: Boolean(args['dry-run']) }));
  else if (command === 'daily') {
    const result = await daily(config, { fixture: Boolean(args.fixture), dryRun: Boolean(args['dry-run']), date: typeof args.date === 'string' ? args.date : undefined });
    print(args.json && result.report ? result.report.items : result);
  } else if (command === 'serve') {
    const server = await serve(config); process.stdout.write(`DesignSignal listening on http://${config.host}:${config.port}\n`);
    const close = () => server.close(() => process.exit(0)); process.on('SIGINT', close); process.on('SIGTERM', close);
  } else if (command === 'doctor') {
    const checks = [];
    checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.versions.node });
    const evidence = await loadExamEvidence(); checks.push({ name: 'exam-evidence', ok: /^[a-f0-9]{64}$/.test(evidence.documentSha256), detail: evidence.evidenceVersion });
    const selection = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [], priorityInstitutionPaper: config.selection.priorityInstitutionPaper }); const report = await buildReport({ date: '2026-07-19', items: selection.selected, rejected: selection.rejected, health: [], selectionPolicy: selection.policy, fixture: true });
    checks.push({ name: 'offline-fixture', ok: report.items.length === 6, detail: `${report.items.length} validated items` });
    await mkdir(config.dataDir, { recursive: true }); await access(config.dataDir); checks.push({ name: 'data-dir', ok: true, detail: path.resolve(config.dataDir) });
    const ok = checks.every(x => x.ok); print({ ok, checks, modelConfigured: Boolean(config.model.model && config.model.token), feishuDocumentConfigured: Boolean(config.feishuDocument.appId && config.feishuDocument.appSecret && config.feishuDocument.folderToken) }); if (!ok) process.exitCode = 1;
  } else if (command === 'schedule') await runScheduler(() => daily(config), { timeZone: config.timezone });
  else if (command === 'push' && args._[0] === 'retry') print(await retryOutbox(config.dataDir, config));
  else { process.stderr.write('Usage: node src/cli.mjs collect|daily|serve|doctor|schedule [--fixture] [--dry-run] [--json] [--config PATH]\n'); process.exitCode = 2; }
} catch (error) { process.stderr.write(`${redact(error.message)}\n`); process.exitCode = 1; }
