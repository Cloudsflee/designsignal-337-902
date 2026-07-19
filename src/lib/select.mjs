const quota = { paper: 2, product: 1, ui: 1, frontier: 2 };
const day = 864e5;
const canonical = value => { const u = new URL(value); u.hash = ''; for (const key of [...u.searchParams.keys()]) if (/^(utm_|ref$|source$)/i.test(key)) u.searchParams.delete(key); return u.href.replace(/\/$/, ''); };

export function selectDaily(candidates, { date, history = [], maxAgeDays = 60 } = {}) {
  const now = new Date(`${date}T23:59:59+08:00`).getTime();
  const recent = new Set(history.filter(x => now - new Date(x.date).getTime() <= maxAgeDays * day).flatMap(x => [x.id, x.url].filter(Boolean)));
  const rejected = [];
  const eligible = candidates.filter(item => {
    let reason = '';
    if (!quota[item.category]) reason = 'unsupported-category';
    else if (!item.id || !item.source?.id || !item.source?.url || !item.publishedAt) reason = 'missing-provenance';
    else if (recent.has(item.id) || recent.has(canonical(item.source.url))) reason = 'dedupe-60-day';
    else if (!Number.isFinite(new Date(item.publishedAt).getTime()) || now - new Date(item.publishedAt).getTime() > maxAgeDays * day) reason = 'stale';
    else if (['product', 'ui'].includes(item.category) && !(item.image?.url || item.imageUrl)) reason = 'missing-image';
    if (reason) rejected.push({ id: item.id || 'unknown', sourceId: item.source?.id || 'unknown', reason });
    return !reason;
  });
  const scored = eligible.map(item => {
    const age = Math.max(0, (now - new Date(item.publishedAt).getTime()) / day);
    const credibility = { 'scholarly-index-or-repository': 10, 'institutional-page': 9, 'primary-or-editorial': 8, 'editorial-feed': 6 }[item.source.credibility] || 0;
    const score = (item.confidence ?? 0.65) * 100 + Math.max(0, 30 - age) + credibility + (item.image?.url || item.imageUrl ? 3 : 0);
    return { item, score };
  }).sort((a, b) => b.score - a.score || a.item.source.id.localeCompare(b.item.source.id) || a.item.id.localeCompare(b.item.id));
  const selected = []; const usedSources = new Set();
  for (const [category, needed] of Object.entries(quota)) {
    const pool = scored.filter(x => x.item.category === category);
    const diverse = pool.filter(x => !usedSources.has(x.item.source.id));
    const picks = [...diverse, ...pool.filter(x => usedSources.has(x.item.source.id))].filter((x, i, arr) => arr.findIndex(y => y.item.id === x.item.id) === i).slice(0, needed);
    if (picks.length !== needed) throw new Error(`insufficient validated ${category} candidates: need ${needed}, found ${picks.length}`);
    for (const pick of picks) { selected.push(pick.item); usedSources.add(pick.item.source.id); }
  }
  const ids = new Set(selected.map(x => x.id));
  for (const { item, score } of scored) if (!ids.has(item.id)) rejected.push({ id: item.id, sourceId: item.source.id, reason: 'lower-deterministic-rank', score: Number(score.toFixed(2)) });
  return { selected, rejected, policy: { quota, maxAgeDays, deterministicTieBreak: 'score desc, source id, item id', sourceCount: usedSources.size } };
}
