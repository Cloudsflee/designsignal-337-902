import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { isoDate } from './util.mjs';

const DEFAULTS = Object.freeze({
  profileMaxBytes: 16 * 1024,
  feedbackMaxBytes: 64 * 1024,
  recentFeedbackCount: 14,
  maxDirections: 12,
  maxWeaknesses: 12
});

const boundedInteger = (value, name, min, max) => {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return number;
};

const boundedText = (value, name, max, { required = true } = {}) => {
  const result = String(value ?? '').trim();
  if (required && !result) throw new Error(`${name} is required`);
  if (result.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return result;
};

const boundedList = (value, name, maxItems, maxLength) => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > maxItems) throw new Error(`${name} exceeds ${maxItems} entries`);
  return value.map((entry, index) => boundedText(entry, `${name}.${index}`, maxLength));
};

async function readBoundedFile(file, maxBytes) {
  const handle = await open(file, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
    return await readFile(handle, 'utf8');
  } finally { await handle.close(); }
}

export async function loadStudyProfile(config) {
  const file = config.study?.profileFile;
  if (!file) return null;
  let parsed;
  try { parsed = JSON.parse(await readBoundedFile(file, config.study.profileMaxBytes || DEFAULTS.profileMaxBytes)); }
  catch (error) { throw new Error(`study profile could not be loaded: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('study profile must be a JSON object');
  return {
    directions: boundedList(parsed.directions ?? [], 'study profile directions', config.study.maxDirections || DEFAULTS.maxDirections, 240),
    weaknesses: boundedList(parsed.weaknesses ?? [], 'study profile weaknesses', config.study.maxWeaknesses || DEFAULTS.maxWeaknesses, 240),
    dailyMinutes: boundedInteger(parsed.dailyMinutes, 'study profile dailyMinutes', 10, 720)
  };
}

export function validateFeedback(input, now = new Date(), timeZone = 'UTC') {
  const date = boundedText(input.date, 'date', 10);
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) throw new Error('date must be YYYY-MM-DD');
  const today = isoDate(now, timeZone);
  if (date > today) throw new Error('date cannot be in the future');
  const weakInput = Array.isArray(input.weakPoints)
    ? input.weakPoints
    : String(input.weakPoints ?? '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
  return {
    date,
    comprehension: boundedInteger(input.comprehension, 'comprehension', 0, 100),
    transfer: boundedInteger(input.transfer, 'transfer', 0, 100),
    exercise: boundedInteger(input.exercise, 'exercise', 0, 100),
    minutes: boundedInteger(input.minutes, 'minutes', 0, 720),
    weakPoints: boundedList(weakInput, 'weakPoints', 12, 120),
    note: boundedText(input.note, 'note', 2000, { required: false })
  };
}

export async function appendFeedback(config, input, now = new Date()) {
  const feedback = { at: now.toISOString(), ...validateFeedback(input, now, config.timezone || 'UTC') };
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.dataDir, 'feedback.ndjson');
  const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW || 0);
  const handle = await open(file, flags, 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(`${JSON.stringify(feedback)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  return feedback;
}

export async function loadRecentFeedback(config) {
  const file = path.join(config.dataDir, 'feedback.ndjson');
  const maxBytes = config.study?.feedbackMaxBytes || DEFAULTS.feedbackMaxBytes;
  const maxCount = config.study?.recentFeedbackCount || DEFAULTS.recentFeedbackCount;
  let handle;
  try {
    handle = await open(file, 'r');
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stats.size - length);
    let content = buffer.toString('utf8');
    if (stats.size > length) content = content.slice(content.indexOf('\n') + 1);
    const lines = content.trim().split('\n').filter(Boolean).slice(-maxCount);
    const recent = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const at = boundedText(parsed.at, 'feedback at', 40);
        if (Number.isNaN(Date.parse(at))) continue;
        recent.push({ at, ...validateFeedback(parsed, new Date('9999-12-31T00:00:00Z')) });
      } catch {}
    }
    return recent;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  } finally { await handle?.close(); }
}
