import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureCandidates } from '../fixtures/daily.mjs';
import { selectDaily } from '../src/lib/select.mjs';
import { buildReport } from '../src/lib/report.mjs';
import { appendManifestEntry, readReportByDate, recoverReport, writeReport } from '../src/lib/storage.mjs';
import { atomicWrite, sha256, windowsAtomicReplace, withLock } from '../src/lib/util.mjs';
import { queueDeliveries, retryOutbox } from '../src/lib/push.mjs';
import { nextScheduledAt } from '../src/lib/scheduler.mjs';
import { daily } from '../src/lib/daily.mjs';

async function fixtureReport() { const s = selectDaily(fixtureCandidates, { date: '2026-07-19', history: [] }); return buildReport({ date: '2026-07-19', items: s.selected, rejected: s.rejected, health: [], selectionPolicy: s.policy, fixture: true }); }

test('dated report writes atomically, manifests once and is idempotent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-store-')), report = await fixtureReport();
  const first = await writeReport(dir, report), second = await writeReport(dir, report);
  assert.equal(first.status, 'written'); assert.equal(second.status, 'exists');
  const files = await readdir(path.join(dir, 'reports', report.date)); assert.deepEqual(files.sort(), ['report.html', 'report.json', 'report.md']);
  assert.equal((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim().split('\n').length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('manifest append uses one append handle and closes it after sync failure', async () => {
  const calls = [];
  const handle = {
    async writeFile(value) { calls.push(['write', value]); },
    async sync() { calls.push(['sync']); throw new Error('sync failed'); },
    async close() { calls.push(['close']); }
  };
  await assert.rejects(() => appendManifestEntry('/manifest', { date: '2026-07-19' }, async (...args) => { calls.push(['open', ...args]); return handle; }), /sync failed/);
  assert.deepEqual(calls.map(x => x[0]), ['open', 'write', 'sync', 'close']);
  assert.deepEqual(calls[0].slice(1), ['/manifest', 'a', 0o600]);
});

test('atomicWrite removes its synced temp file when publication fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-')), target = path.join(dir, 'target');
  await mkdir(target);
  await assert.rejects(() => atomicWrite(target, 'content'));
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite retries transient replacement failures after sync and close', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-retry-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  const calls = [], delays = [];
  let closed = false, attempts = 0, published, stats = 0, replacements = 0;
  const openImpl = async (...args) => {
    const handle = await open(...args);
    return {
      async writeFile(value) { calls.push('write'); await handle.writeFile(value); },
      async sync() { calls.push('sync'); await handle.sync(); },
      async close() { calls.push('close'); await handle.close(); closed = true; }
    };
  };
  const renameImpl = async (temp, destination) => {
    calls.push('rename');
    assert.equal(closed, true);
    if (++attempts < 3) throw Object.assign(new Error('temporarily locked'), { code: attempts === 1 ? 'EPERM' : 'EACCES' });
    published = { destination, content: await readFile(temp, 'utf8') };
  };
  await atomicWrite(target, 'new', {
    openImpl,
    platform: 'linux',
    renameImpl,
    statImpl: async () => { stats++; },
    replaceImpl: async () => { replacements++; },
    sleepImpl: async delay => delays.push(delay),
    nowImpl: () => 0
  });
  assert.deepEqual(calls, ['write', 'sync', 'close', 'rename', 'rename', 'rename']);
  assert.deepEqual(delays, [5, 10]);
  assert.equal(stats, 0);
  assert.equal(replacements, 0);
  assert.deepEqual(published, { destination: target, content: 'new' });
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite uses the Windows regular-file replacement only after sync and close', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-win-order-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  const calls = [];
  let closed = false;
  const openImpl = async (...args) => {
    const handle = await open(...args);
    return {
      async writeFile(value) { calls.push('write'); await handle.writeFile(value); },
      async sync() { calls.push('sync'); await handle.sync(); },
      async close() { calls.push('close'); await handle.close(); closed = true; }
    };
  };
  await atomicWrite(target, 'new', {
    openImpl,
    platform: 'win32',
    renameImpl: async () => { calls.push('rename'); throw Object.assign(new Error('overwrite denied'), { code: 'EPERM' }); },
    statImpl: async destination => {
      calls.push('stat');
      assert.equal(destination, target);
      assert.equal(closed, true);
      return { isFile: () => true, isSymbolicLink: () => false };
    },
    replaceImpl: async (temp, destination) => {
      calls.push('replace');
      assert.equal(closed, true);
      assert.equal(destination, target);
      assert.equal(await readFile(temp, 'utf8'), 'new');
      await writeFile(destination, await readFile(temp));
    }
  });
  assert.deepEqual(calls, ['write', 'sync', 'close', 'rename', 'stat', 'replace']);
  assert.equal(await readFile(target, 'utf8'), 'new');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite invokes fixed hidden PowerShell arguments without file content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-win-exec-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  const secretContent = ['credential', 'must', 'stay', 'in', 'file'].join('-');
  const parentCredential = ['parent', 'credential', 'must', 'not', 'leak'].join('-');
  const originalSystemRoot = process.env.SystemRoot;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  let invocation;
  process.env.SystemRoot = String.raw`C:\Windows`;
  process.env.OPENAI_API_KEY = parentCredential;
  try {
    await atomicWrite(target, secretContent, {
      platform: 'win32',
      renameImpl: async () => { throw Object.assign(new Error('overwrite denied'), { code: 'EPERM' }); },
      execFileImpl: (executable, args, options, callback) => {
        invocation = { executable, args, options };
        callback(null, '', '');
      }
    });
  } finally {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
  const source = invocation.options.env.DESIGNSIGNAL_ATOMIC_SOURCE;
  const backup = invocation.options.env.DESIGNSIGNAL_ATOMIC_BACKUP;
  assert.equal(invocation.executable, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.deepEqual(invocation.args, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', '[System.IO.File]::Replace($env:DESIGNSIGNAL_ATOMIC_SOURCE,$env:DESIGNSIGNAL_ATOMIC_DESTINATION,$env:DESIGNSIGNAL_ATOMIC_BACKUP)'
  ]);
  assert.deepEqual(invocation.options, {
    encoding: 'utf8',
    env: {
      SystemRoot: String.raw`C:\Windows`,
      DESIGNSIGNAL_ATOMIC_SOURCE: source,
      DESIGNSIGNAL_ATOMIC_DESTINATION: target,
      DESIGNSIGNAL_ATOMIC_BACKUP: backup
    },
    maxBuffer: 4096,
    shell: false,
    timeout: 1500,
    windowsHide: true
  });
  assert.match(source, /\.tmp$/);
  assert.equal(path.dirname(backup), path.dirname(target));
  assert.match(path.basename(backup), /^target\.designsignal-replace-backup\./);
  assert.equal(backup.endsWith('.json'), false);
  assert.equal(JSON.stringify(invocation).includes(secretContent), false);
  assert.equal(JSON.stringify(invocation).includes(parentCredential), false);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('windowsAtomicReplace treats consumed source as confirmed and does not require a retry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-win-consumed-'));
  const source = path.join(dir, 'source.tmp'), target = path.join(dir, 'target');
  await writeFile(source, 'new');
  await writeFile(target, 'old');
  let calls = 0, backup;
  await windowsAtomicReplace(source, target, {
    platform: 'win32',
    systemRoot: String.raw`C:\Windows`,
    execFileImpl: (executable, args, options, callback) => {
      calls++;
      backup = options.env.DESIGNSIGNAL_ATOMIC_BACKUP;
      rm(source).then(() => writeFile(backup, 'old')).then(() => callback(new Error('exit status unavailable')));
    }
  });
  assert.equal(calls, 1);
  assert.equal((await readdir(dir)).includes(path.basename(source)), false);
  assert.equal((await readdir(dir)).includes(path.basename(backup)), false);
  await rm(dir, { recursive: true, force: true });
});

test('windowsAtomicReplace leaves a fresh backup alone and safely removes it when stale', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-win-stale-'));
  const source = path.join(dir, 'source.tmp'), target = path.join(dir, 'job.json');
  await writeFile(source, 'new');
  await writeFile(target, 'old');
  let capturedBackup;
  const invoke = () => windowsAtomicReplace(source, target, {
    platform: 'win32',
    systemRoot: String.raw`C:\Windows`,
    execFileImpl: (executable, args, options, callback) => {
      capturedBackup = options.env.DESIGNSIGNAL_ATOMIC_BACKUP;
      callback(null, '', '');
    }
  });
  await invoke();
  const freshBackup = capturedBackup;
  assert.equal(freshBackup.endsWith('.json'), false);
  await writeFile(freshBackup, 'old');
  await invoke();
  assert.equal((await readdir(dir)).includes(path.basename(freshBackup)), true);
  const [pid, , uuid] = freshBackup.slice(freshBackup.indexOf('.designsignal-replace-backup.') + '.designsignal-replace-backup.'.length).split('.');
  const staleBackup = `${target}.designsignal-replace-backup.${pid}.${Date.now() - 2 * 60 * 60 * 1000}.${uuid}`;
  await writeFile(staleBackup, 'old');
  await invoke();
  assert.equal((await readdir(dir)).includes(path.basename(staleBackup)), false);
  await rm(dir, { recursive: true, force: true });
});

test('windowsAtomicReplace never spawns PowerShell outside win32', async () => {
  let spawned = false;
  await assert.rejects(() => windowsAtomicReplace('/source', '/destination', {
    platform: 'linux',
    systemRoot: String.raw`C:\Windows`,
    execFileImpl: () => { spawned = true; }
  }), /only available on win32/);
  assert.equal(spawned, false);
});

test('windowsAtomicReplace performs a real synced replacement on Windows', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-win-real-'));
  const source = path.join(dir, 'source.tmp'), target = path.join(dir, 'target');
  const writeSynced = async (file, content) => {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
  };
  try {
    await writeSynced(source, 'new');
    await writeSynced(target, 'old');
    await windowsAtomicReplace(source, target, { platform: 'win32' });
    assert.equal(await readFile(target, 'utf8'), 'new');
    await assert.rejects(() => stat(source), error => error.code === 'ENOENT');
    assert.deepEqual((await readdir(dir)).filter(name => name.includes('.designsignal-replace-backup.')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('atomicWrite bounds Windows replacement failures and preserves the destination', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-win-fail-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  const renameFailure = Object.assign(new Error('overwrite denied'), { code: 'EPERM' });
  const replaceFailure = new Error('File.Replace failed');
  let now = 0, renames = 0, replacements = 0;
  await assert.rejects(() => atomicWrite(target, 'new', {
    platform: 'win32',
    renameImpl: async () => { renames++; now += 700; throw renameFailure; },
    statImpl: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    replaceImpl: async () => { replacements++; throw replaceFailure; },
    sleepImpl: async delay => { now += delay; },
    nowImpl: () => now
  }), error => error === replaceFailure);
  assert.equal(renames, 4);
  assert.equal(replacements, 4);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite immediately rejects a Windows directory reported as EPERM', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-win-dir-')), target = path.join(dir, 'target');
  await mkdir(target);
  const failure = Object.assign(new Error('directory overwrite denied'), { code: 'EPERM' });
  let renames = 0, replacements = 0, sleeps = 0;
  await assert.rejects(() => atomicWrite(target, 'new', {
    platform: 'win32',
    renameImpl: async () => { renames++; throw failure; },
    replaceImpl: async () => { replacements++; },
    sleepImpl: async () => { sleeps++; }
  }), error => error === failure);
  assert.equal(renames, 1);
  assert.equal(replacements, 0);
  assert.equal(sleeps, 0);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite never replaces Windows symlinks or absent destinations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-win-gate-'));
  const failure = Object.assign(new Error('overwrite denied'), { code: 'EPERM' });
  let replacements = 0, sleeps = 0;
  const symlinkTarget = path.join(dir, 'symlink-target');
  await writeFile(symlinkTarget, 'old');
  await assert.rejects(() => atomicWrite(symlinkTarget, 'new', {
    platform: 'win32',
    renameImpl: async () => { throw failure; },
    statImpl: async () => ({ isFile: () => true, isSymbolicLink: () => true }),
    replaceImpl: async () => { replacements++; },
    sleepImpl: async () => { sleeps++; }
  }), error => error === failure);
  assert.equal(await readFile(symlinkTarget, 'utf8'), 'old');
  const absentTarget = path.join(dir, 'absent-target');
  let now = 0;
  await assert.rejects(() => atomicWrite(absentTarget, 'new', {
    platform: 'win32',
    renameImpl: async () => { now += 1000; throw failure; },
    statImpl: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
    replaceImpl: async () => { replacements++; },
    sleepImpl: async delay => { now += delay; },
    nowImpl: () => now
  }), error => error === failure);
  assert.equal(replacements, 0);
  assert.equal(sleeps, 0);
  assert.equal((await readdir(dir)).includes('absent-target'), false);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite excludes the Windows fallback on other platforms', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-nonwin-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  const failure = Object.assign(new Error('busy'), { code: 'EBUSY' });
  let now = 0, stats = 0, replacements = 0;
  await assert.rejects(() => atomicWrite(target, 'new', {
    platform: 'linux',
    renameImpl: async () => { now += 1000; throw failure; },
    statImpl: async () => { stats++; },
    replaceImpl: async () => { replacements++; },
    sleepImpl: async delay => { now += delay; },
    nowImpl: () => now
  }), error => error === failure);
  assert.equal(stats, 0);
  assert.equal(replacements, 0);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite bounds transient rename retries and preserves the destination', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-exhaust-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  let attempts = 0, stats = 0, replacements = 0;
  const delays = [];
  const failure = Object.assign(new Error('still busy'), { code: 'EBUSY' });
  await assert.rejects(
    () => atomicWrite(target, 'new', {
      platform: 'linux',
      renameImpl: async () => { attempts++; throw failure; },
      statImpl: async () => { stats++; },
      replaceImpl: async () => { replacements++; },
      sleepImpl: async delay => delays.push(delay),
      nowImpl: () => 0
    }),
    error => error === failure
  );
  assert.equal(attempts, 25);
  assert.deepEqual(delays, [5, 10, 20, 40, 80, ...Array(19).fill(100)]);
  assert.equal(stats, 0);
  assert.equal(replacements, 0);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite stops transient retries at the elapsed-time cap', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-time-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  let attempts = 0, now = 0, stats = 0, replacements = 0;
  const failure = Object.assign(new Error('permission pending'), { code: 'EPERM' });
  await assert.rejects(() => atomicWrite(target, 'new', {
    platform: 'linux',
    renameImpl: async () => { attempts++; now += 750; throw failure; },
    statImpl: async () => { stats++; },
    replaceImpl: async () => { replacements++; },
    sleepImpl: async delay => { now += delay; },
    nowImpl: () => now
  }), error => error === failure);
  assert.equal(attempts, 3);
  assert.equal(now, 2265);
  assert.equal(stats, 0);
  assert.equal(replacements, 0);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite closes and cleans up when sync fails before publication', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-sync-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  const failure = new Error('sync failed');
  let closed = false, renameCalls = 0;
  const openImpl = async (...args) => {
    const handle = await open(...args);
    return {
      async writeFile(value) { await handle.writeFile(value); },
      async sync() { throw failure; },
      async close() { await handle.close(); closed = true; }
    };
  };
  await assert.rejects(() => atomicWrite(target, 'new', {
    openImpl,
    renameImpl: async () => { renameCalls++; }
  }), error => error === failure);
  assert.equal(closed, true);
  assert.equal(renameCalls, 0);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite does not retry structural rename failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-structural-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  let attempts = 0, stats = 0, replacements = 0, sleeps = 0;
  const failure = Object.assign(new Error('target is a directory'), { code: 'EISDIR' });
  await assert.rejects(() => atomicWrite(target, 'new', {
    platform: 'win32',
    renameImpl: async () => { attempts++; throw failure; },
    statImpl: async () => { stats++; },
    replaceImpl: async () => { replacements++; },
    sleepImpl: async () => { sleeps++; }
  }), error => error === failure);
  assert.equal(attempts, 1);
  assert.equal(stats, 0);
  assert.equal(replacements, 0);
  assert.equal(sleeps, 0);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('atomicWrite overwrite false retains exactly-once link publication', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-atomic-link-')), target = path.join(dir, 'target');
  await writeFile(target, 'old');
  let renameCalls = 0, sleeps = 0;
  await assert.rejects(() => atomicWrite(target, 'new', {
    overwrite: false,
    renameImpl: async () => { renameCalls++; },
    sleepImpl: async () => { sleeps++; }
  }), error => error.code === 'EEXIST');
  assert.equal(renameCalls, 0);
  assert.equal(sleeps, 0);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await rm(dir, { recursive: true, force: true });
});

test('complete report without a manifest is validated and reconciled once', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-recover-')), report = await fixtureReport();
  await writeReport(dir, report);
  await rm(path.join(dir, 'manifest.ndjson'));
  const recovered = await writeReport(dir, report), again = await writeReport(dir, report);
  assert.equal(recovered.status, 'recovered'); assert.equal(again.status, 'exists');
  assert.deepEqual(await readReportByDate(dir, report.date), report);
  assert.equal((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim().split('\n').length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('immutable schema v2 report reads and recovers under its legacy audit contract', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-v2-recover-'));
  const report = await fixtureReport();
  await writeReport(dir, report);
  report.schemaVersion = 2;
  delete report.audit.selectionPolicy.priorityInstitutionPaper;
  const reportFile = path.join(dir, 'reports', report.date, 'report.json');
  const storedJson = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportFile, storedJson);
  const storedHash = sha256(storedJson);
  await rm(path.join(dir, 'manifest.ndjson'));

  assert.deepEqual(await readReportByDate(dir, report.date), report);
  const recovered = await recoverReport(dir, report.date);
  assert.equal(recovered.status, 'recovered');
  assert.deepEqual(recovered.report, report);
  assert.equal(await readFile(reportFile, 'utf8'), storedJson);
  const manifest = JSON.parse((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim());
  assert.equal(manifest.sha256, storedHash);
  const manifestJson = await readFile(path.join(dir, 'manifest.ndjson'), 'utf8');
  assert.equal((await recoverReport(dir, report.date)).status, 'exists');
  assert.equal(await readFile(reportFile, 'utf8'), storedJson);
  assert.equal(await readFile(path.join(dir, 'manifest.ndjson'), 'utf8'), manifestJson);
  const publishDir = await mkdtemp(path.join(os.tmpdir(), 'ds-v2-publish-'));
  await assert.rejects(() => writeReport(publishDir, report), /new reports must use schema version 4/);
  await rm(publishDir, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

test('daily recovers report and manifest before collection and recreates only missing outbox jobs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-daily-recover-')), report = await fixtureReport();
  await writeReport(dir, report);
  let networkCalls = 0;
  const config = { dataDir: dir, timezone: 'Asia/Shanghai', push: { generic: '', feishu: '', wecom: '' }, network: { allowHosts: [], timeoutMs: 100, retries: 0 } };
  const ctx = { fetchImpl: async () => { networkCalls++; throw new Error('collection must not run'); } };
  const first = await daily(config, { date: report.date, ctx }), second = await daily(config, { date: report.date, ctx });
  assert.equal(first.status, 'exists'); assert.equal(second.status, 'exists'); assert.equal(networkCalls, 0);
  assert.equal((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await readdir(path.join(dir, 'outbox'))).length, 4);
  await rm(dir, { recursive: true, force: true });
});

test('daily reconciles a missing manifest before collection', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-daily-manifest-')), report = await fixtureReport();
  await writeReport(dir, report); await rm(path.join(dir, 'manifest.ndjson'));
  const config = { dataDir: dir, timezone: 'Asia/Shanghai', push: { generic: '', feishu: '', wecom: '' }, network: { allowHosts: [], timeoutMs: 100, retries: 0 } };
  const result = await daily(config, { date: report.date, ctx: { fetchImpl: async () => { throw new Error('collection must not run'); } } });
  assert.equal(result.status, 'recovered');
  assert.equal((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim().split('\n').length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('conflicting manifest identity is refused', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-manifest-conflict-')), report = await fixtureReport();
  await writeReport(dir, report);
  const manifest = JSON.parse((await readFile(path.join(dir, 'manifest.ndjson'), 'utf8')).trim());
  manifest.sha256 = '0'.repeat(64);
  await writeFile(path.join(dir, 'manifest.ndjson'), `${JSON.stringify(manifest)}\n`);
  await assert.rejects(() => writeReport(dir, report), /conflicting manifest/);
  await rm(dir, { recursive: true, force: true });
});

test('per-date lock excludes concurrent holders and cleans up', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-lock-')), lock = path.join(dir, 'date.lock');
  let release, markEntered;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { markEntered = resolve; });
  const first = withLock(lock, async () => { markEntered(); return gate; });
  await entered;
  await assert.rejects(() => withLock(lock, async () => {}), /already locked/);
  release(); await first;
  await withLock(lock, async () => {});
  await rm(dir, { recursive: true, force: true });
});

test('23:50 Shanghai calculation is exact from UTC', () => {
  assert.equal(nextScheduledAt(new Date('2026-01-01T15:49:30Z'), 'Asia/Shanghai').toISOString(), '2026-01-01T15:50:00.000Z');
  assert.equal(nextScheduledAt(new Date('2026-01-01T15:50:30Z'), 'Asia/Shanghai').toISOString(), '2026-01-02T15:50:00.000Z');
});

test('push outbox queues four pending delivery identities when configuration is missing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-push-')), report = await fixtureReport();
  const base = { network: { allowHosts: [], timeoutMs: 100, retries: 0 }, push: { generic: '', feishu: '', wecom: '' } };
  const jobs = await queueDeliveries(dir, report, base);
  assert.deepEqual(jobs.map(job => job.channel), ['feishu-document', 'generic', 'feishu', 'wecom']);
  assert.ok(jobs.every(job => job.state === 'pending' && /missing/.test(job.reason)));
  assert.ok(!('payload' in jobs[0]) && jobs.slice(1).every(job => 'payload' in job));
  assert.ok(jobs.every(job => !('endpoint' in job)));
  await rm(dir, { recursive: true, force: true });
});

test('retryOutbox returns an unchanged missing-config document job without rewriting it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-push-no-write-')), report = await fixtureReport();
  const config = { network: { allowHosts: [], timeoutMs: 100, retries: 0 }, push: { generic: '', feishu: '', wecom: '' } };
  const jobs = await queueDeliveries(dir, report, config);
  const fixedTime = new Date('2020-01-02T03:04:05.000Z');
  const snapshots = new Map();
  for (const job of jobs) {
    const file = path.join(dir, 'outbox', `${job.id}.json`);
    await utimes(file, fixedTime, fixedTime);
    snapshots.set(job.id, { bytes: await readFile(file), mtimeMs: (await stat(file)).mtimeMs });
  }

  const results = await retryOutbox(dir, config);
  assert.deepEqual(results.map(job => job.id).sort(), jobs.map(job => job.id).sort());
  for (const job of jobs) {
    const file = path.join(dir, 'outbox', `${job.id}.json`), before = snapshots.get(job.id);
    assert.deepEqual(await readFile(file), before.bytes);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  }
  await rm(dir, { recursive: true, force: true });
});

test('queueDeliveries preserves an existing document job and rejects identity conflicts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ds-push-preserve-')), report = await fixtureReport();
  const config = { network: { allowHosts: [], timeoutMs: 100, retries: 0 }, push: { generic: '', feishu: '', wecom: '' } };
  const documentId = ['doc', 'cn', 'fixture', '1234'].join('');
  const jobs = await queueDeliveries(dir, report, config), document = jobs.find(job => job.channel === 'feishu-document');
  const delivered = { ...document, state: 'delivered', reason: '', documentId, revisionId: 2, nextBlockIndex: document.totalBlocks, deliveredAt: '2026-07-19T12:00:00.000Z' };
  await atomicWrite(path.join(dir, 'outbox', `${delivered.id}.json`), `${JSON.stringify(delivered, null, 2)}\n`);
  await queueDeliveries(dir, report, config);
  const stored = JSON.parse(await readFile(path.join(dir, 'outbox', `${delivered.id}.json`), 'utf8'));
  assert.deepEqual(stored, delivered); assert.equal((await readdir(path.join(dir, 'outbox'))).length, 4);
  const conflicting = { ...stored, reportDate: '2026-07-20' };
  await atomicWrite(path.join(dir, 'outbox', `${delivered.id}.json`), `${JSON.stringify(conflicting)}\n`);
  await assert.rejects(() => queueDeliveries(dir, report, config), /conflicting outbox job identity/);
  await rm(dir, { recursive: true, force: true });
});
