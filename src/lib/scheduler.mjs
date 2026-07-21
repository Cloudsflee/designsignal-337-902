import { redact } from './util.mjs';

export function nextScheduledAt(now = new Date(), timeZone = 'Asia/Shanghai', hour = 23, minute = 50) {
  const start = Math.floor(now.getTime() / 60000) * 60000 + 60000;
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 27 * 60; i++) {
    const date = new Date(start + i * 60000), parts = formatter.formatToParts(date);
    const get = type => Number(parts.find(x => x.type === type)?.value);
    if (get('hour') === hour && get('minute') === minute) return date;
  }
  throw new Error(`cannot calculate ${hour}:${minute} in ${timeZone}`);
}

export async function runScheduler(run, { timeZone = 'Asia/Shanghai', logger = console } = {}) {
  for (;;) {
    const next = nextScheduledAt(new Date(), timeZone);
    logger.log(JSON.stringify({ event: 'scheduled', at: next.toISOString(), timezone: timeZone }));
    await new Promise(resolve => setTimeout(resolve, Math.min(next.getTime() - Date.now(), 2 ** 31 - 1)));
    if (Date.now() + 1000 < next.getTime()) continue;
    try { await run(); }
    catch (error) { logger.error(JSON.stringify({ event: 'daily-failed', message: redact(String(error?.message || 'daily run failed')) })); }
  }
}
