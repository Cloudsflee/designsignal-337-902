const quota = { paper: 2, product: 1, ui: 1, frontier: 2 };
const day = 864e5;
const defaultPriorityInstitutionPaper = { institutionIds: ['I99065089', 'I76130692', 'I116953780'], freshnessDays: 7, maxScoreGap: 5 };
const tieBreak = (a, b) => b.score - a.score || a.item.source.id.localeCompare(b.item.source.id) || a.item.id.localeCompare(b.item.id);
const canonical = value => { try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return ''; u.hash = ''; for (const key of [...u.searchParams.keys()]) if (/^(utm_|ref$|source$)/i.test(key)) u.searchParams.delete(key); return u.href.replace(/\/$/, ''); } catch { return ''; } };

const scoreCandidate = (item, now) => {
  const age = Math.max(0, (now - new Date(item.publishedAt).getTime()) / day);
  const credibility = { 'scholarly-index-or-repository': 10, 'institutional-page': 9, 'primary-or-editorial': 8, 'editorial-feed': 6 }[item.source.credibility] || 0;
  return (item.confidence ?? 0.65) * 100 + Math.max(0, 30 - age) + credibility + (item.image?.url || item.imageUrl ? 3 : 0);
};

const matchedPriorityInstitution = (item, configuredIds) => {
  const provenance = item.institutionProvenance;
  if (!provenance || provenance.adapter !== 'openalex' || provenance.method !== 'authorship-institution-id') return null;
  if (!Array.isArray(provenance.affiliations) || !Array.isArray(provenance.matchedInstitutions)) return null;
  const affiliations = provenance.affiliations.filter(entry => entry && /^I\d+$/.test(entry.institutionId || '') && Number.isInteger(entry.authorshipIndex) && Number.isInteger(entry.institutionIndex));
  for (const match of provenance.matchedInstitutions) {
    if (!match || !configuredIds.has(match.id) || !/^I\d+$/.test(match.id) || typeof match.name !== 'string' || !match.name.trim()) continue;
    if (affiliations.some(entry => entry.institutionId === match.id)) return { id: match.id, name: match.name.trim() };
  }
  return null;
};

const invariantsHold = selected => {
  const counts = selected.reduce((all, item) => ({ ...all, [item.category]: (all[item.category] || 0) + 1 }), {});
  return Object.entries(quota).every(([category, needed]) => counts[category] === needed)
    && ['zh', 'en'].every(locale => selected.some(item => item.source.locale === locale))
    && new Set(selected.map(item => item.id)).size === selected.length
    && new Set(selected.map(item => item.source.id)).size >= 4;
};

const priorityAudit = policy => ({
  configuredInstitutionIds: [...policy.institutionIds],
  freshnessDays: policy.freshnessDays,
  maxScoreGap: policy.maxScoreGap,
  matchedCount: 0,
  validatedCount: 0,
  freshCount: 0,
  eligibleCount: 0,
  ineligibleReasons: {},
  decision: 'fallback',
  reason: 'no-matching-priority-provenance',
  selectedItemId: null,
  selectedSourceId: null,
  selectedInstitution: null,
  replacement: null
});

const fallbackReason = (audit, priorityRejected) => {
  if (audit.matchedCount === 0) return 'no-matching-priority-provenance';
  if (audit.validatedCount === 0) {
    const reasons = [...new Set(priorityRejected)];
    if (reasons.length === 1 && reasons[0] === 'dedupe-60-day') return 'all-priority-candidates-deduplicated';
    if (reasons.length === 1) return `all-priority-candidates-${reasons[0]}`;
    return 'no-valid-priority-candidate';
  }
  if (audit.freshCount === 0) return 'outside-strict-freshness-window';
  if (audit.eligibleCount === 0) return 'score-gap-exceeds-limit';
  return 'no-safe-replacement';
};

export function selectDaily(candidates, { date, history = [], maxAgeDays = 60, priorityInstitutionPaper = defaultPriorityInstitutionPaper } = {}) {
  const now = new Date(`${date}T23:59:59+08:00`).getTime();
  if (!Number.isFinite(now)) throw new Error('invalid selection date');
  if (!Array.isArray(priorityInstitutionPaper.institutionIds) || priorityInstitutionPaper.institutionIds.length < 1 || priorityInstitutionPaper.institutionIds.length > 20 || new Set(priorityInstitutionPaper.institutionIds).size !== priorityInstitutionPaper.institutionIds.length || priorityInstitutionPaper.institutionIds.some(id => !/^I\d+$/.test(id))) throw new Error('invalid priority institution IDs');
  if (!Number.isInteger(priorityInstitutionPaper.freshnessDays) || priorityInstitutionPaper.freshnessDays < 1 || priorityInstitutionPaper.freshnessDays > 30) throw new Error('invalid priority freshnessDays');
  if (!Number.isFinite(priorityInstitutionPaper.maxScoreGap) || priorityInstitutionPaper.maxScoreGap < 0 || priorityInstitutionPaper.maxScoreGap > 30) throw new Error('invalid priority maxScoreGap');
  const configuredIds = new Set(priorityInstitutionPaper.institutionIds || []);
  const boundedPolicy = {
    institutionIds: [...configuredIds],
    freshnessDays: priorityInstitutionPaper.freshnessDays,
    maxScoreGap: priorityInstitutionPaper.maxScoreGap
  };
  const priority = priorityAudit(boundedPolicy);
  const recent = new Set(history.filter(x => now - new Date(x.date).getTime() <= maxAgeDays * day).flatMap(x => [x.id, canonical(x.url)].filter(Boolean)));
  const rejectedByKey = new Map();
  const priorityRejected = [];
  const keyFor = item => `${item.id || 'unknown'}\0${item.source?.id || 'unknown'}`;
  const reject = (item, reason, extra = {}) => rejectedByKey.set(keyFor(item), { id: item.id || 'unknown', sourceId: item.source?.id || 'unknown', reason, ...extra });
  const baseEligible = [];

  for (const item of candidates) {
    const matched = item.category === 'paper' ? matchedPriorityInstitution(item, configuredIds) : null;
    if (matched) priority.matchedCount++;
    let reason = '';
    const sourceUrl = item.source?.url ? canonical(item.source.url) : '';
    const published = new Date(item.publishedAt).getTime();
    if (!quota[item.category]) reason = 'unsupported-category';
    else if (!item.id || !item.source?.id || !item.source?.url || !item.publishedAt) reason = 'missing-provenance';
    else if (!sourceUrl) reason = 'invalid-source-url';
    else if (recent.has(item.id) || recent.has(sourceUrl)) reason = 'dedupe-60-day';
    else if (!Number.isFinite(published)) reason = 'invalid-published-at';
    else if (published > now) reason = 'future-dated';
    else if (now - published > maxAgeDays * day) reason = 'stale';
    else if (!['zh', 'en'].includes(item.source.locale)) reason = 'missing-origin-language';
    else if (['product', 'ui'].includes(item.category) && !canonical(item.image?.url || item.imageUrl || '')) reason = 'missing-image';
    if (reason) {
      reject(item, reason);
      if (matched) { priorityRejected.push(reason); priority.ineligibleReasons[reason] = (priority.ineligibleReasons[reason] || 0) + 1; }
    } else {
      baseEligible.push({ item, score: scoreCandidate(item, now), sourceUrl, matched });
      if (matched) priority.validatedCount++;
    }
  }

  const ranked = baseEligible.sort(tieBreak);
  const seenIds = new Set(), seenUrls = new Set(), scored = [];
  for (const candidate of ranked) {
    if (seenIds.has(candidate.item.id) || seenUrls.has(candidate.sourceUrl)) {
      reject(candidate.item, 'duplicate-candidate');
      if (candidate.matched) {
        priority.validatedCount--;
        priorityRejected.push('duplicate-candidate');
        priority.ineligibleReasons['duplicate-candidate'] = (priority.ineligibleReasons['duplicate-candidate'] || 0) + 1;
      }
      continue;
    }
    seenIds.add(candidate.item.id); seenUrls.add(candidate.sourceUrl); scored.push(candidate);
  }

  const availableLocales = new Set(scored.map(x => x.item.source.locale));
  if (!availableLocales.has('zh') || !availableLocales.has('en')) throw new Error(`insufficient origin-language supply: require zh and en, found ${[...availableLocales].sort().join(', ') || 'none'}`);
  const selected = []; const usedSources = new Set();
  for (const [category, needed] of Object.entries(quota)) {
    const pool = scored.filter(x => x.item.category === category);
    const diverse = pool.filter(x => !usedSources.has(x.item.source.id));
    const picks = [...diverse, ...pool.filter(x => usedSources.has(x.item.source.id))].filter((x, i, arr) => arr.findIndex(y => y.item.id === x.item.id) === i).slice(0, needed);
    if (picks.length !== needed) throw new Error(`insufficient validated ${category} candidates: need ${needed}, found ${picks.length}`);
    for (const pick of picks) { selected.push(pick.item); usedSources.add(pick.item.source.id); }
  }

  const languageDecisions = [];
  for (const locale of ['zh', 'en']) {
    if (selected.some(x => x.source.locale === locale)) {
      languageDecisions.push({ locale, decision: 'satisfied-by-rank', itemId: selected.find(x => x.source.locale === locale).id });
      continue;
    }
    const alternatives = scored.filter(x => x.item.source.locale === locale && !selected.some(y => y.id === x.item.id));
    let replacement;
    for (const candidate of alternatives) {
      const outgoing = selected
        .filter(x => x.category === candidate.item.category)
        .map(item => ({ item, score: scored.find(x => x.item.id === item.id)?.score ?? -Infinity }))
        .filter(x => selected.filter(y => y.source.locale === x.item.source.locale).length > 1)
        .sort((a, b) => a.score - b.score || b.item.source.id.localeCompare(a.item.source.id) || b.item.id.localeCompare(a.item.id))[0];
      if (outgoing) { replacement = { candidate, outgoing }; break; }
    }
    if (!replacement) throw new Error(`insufficient origin-language supply within category quotas for ${locale}`);
    const index = selected.findIndex(x => x.id === replacement.outgoing.item.id);
    selected[index] = replacement.candidate.item;
    usedSources.clear(); selected.forEach(x => usedSources.add(x.source.id));
    languageDecisions.push({ locale, decision: 'quota-preserving-replacement', itemId: replacement.candidate.item.id, replacedItemId: replacement.outgoing.item.id });
  }
  if (usedSources.size < 4) throw new Error(`insufficient source diversity after language policy: found ${usedSources.size}, need 4`);

  const paperScores = scored.filter(entry => entry.item.category === 'paper');
  const bestPaperScore = paperScores[0]?.score ?? -Infinity;
  const freshPriority = paperScores.filter(entry => entry.matched && (now - new Date(entry.item.publishedAt).getTime()) / day < boundedPolicy.freshnessDays);
  priority.freshCount = freshPriority.length;
  for (const entry of paperScores.filter(candidate => candidate.matched && !freshPriority.includes(candidate))) priority.ineligibleReasons['outside-strict-freshness-window'] = (priority.ineligibleReasons['outside-strict-freshness-window'] || 0) + 1;
  const qualifyingPriority = freshPriority.filter(entry => bestPaperScore - entry.score <= boundedPolicy.maxScoreGap).sort(tieBreak);
  priority.eligibleCount = qualifyingPriority.length;
  for (const entry of freshPriority.filter(candidate => !qualifyingPriority.includes(candidate))) priority.ineligibleReasons['score-gap-exceeds-limit'] = (priority.ineligibleReasons['score-gap-exceeds-limit'] || 0) + 1;
  const outgoingOptions = selected
    .filter(item => item.category === 'paper')
    .map(item => ({ item, score: scored.find(entry => entry.item.id === item.id)?.score ?? -Infinity }))
    .sort((a, b) => a.score - b.score || b.item.source.id.localeCompare(a.item.source.id) || b.item.id.localeCompare(a.item.id));
  let safePriority = null;
  for (const candidate of qualifyingPriority) {
    if (selected.some(item => item.id === candidate.item.id)) {
      safePriority = { candidate, outgoing: null };
      break;
    }
    const outgoing = outgoingOptions.find(option => {
      const prospective = selected.map(item => item.id === option.item.id ? candidate.item : item);
      return invariantsHold(prospective);
    });
    if (outgoing) {
      safePriority = { candidate, outgoing };
      break;
    }
  }
  if (safePriority && !safePriority.outgoing) {
    const { candidate } = safePriority;
    priority.decision = 'satisfied-by-rank';
    priority.reason = 'highest-ranked-safe-priority-paper-already-selected';
    priority.selectedItemId = candidate.item.id;
    priority.selectedSourceId = candidate.item.source.id;
    priority.selectedInstitution = candidate.matched;
  } else if (safePriority) {
    const { candidate, outgoing } = safePriority;
    const index = selected.findIndex(item => item.id === outgoing.item.id);
    selected[index] = candidate.item;
    usedSources.clear(); selected.forEach(item => usedSources.add(item.source.id));
    priority.decision = 'quota-preserving-replacement';
    priority.reason = 'highest-ranked-safe-priority-paper-selected';
    priority.selectedItemId = candidate.item.id;
    priority.selectedSourceId = candidate.item.source.id;
    priority.selectedInstitution = candidate.matched;
    priority.replacement = { replacedItemId: outgoing.item.id, replacedSourceId: outgoing.item.source.id };
    reject(outgoing.item, 'priority-institution-replacement', { score: Number(outgoing.score.toFixed(2)) });
  }
  if (priority.decision === 'fallback') priority.reason = fallbackReason(priority, priorityRejected);

  for (const languageDecision of languageDecisions) {
    if (selected.some(item => item.id === languageDecision.itemId)) continue;
    languageDecision.replacedByPriorityItemId = selected.find(item => item.source.locale === languageDecision.locale)?.id;
    languageDecision.decision = 'maintained-after-priority-replacement';
    languageDecision.itemId = languageDecision.replacedByPriorityItemId;
  }

  const ids = new Set(selected.map(x => x.id));
  for (const { item, score } of scored) if (!ids.has(item.id) && !rejectedByKey.has(keyFor(item))) reject(item, 'lower-deterministic-rank', { score: Number(score.toFixed(2)) });
  const rejected = [...rejectedByKey.values()].sort((a, b) => a.id.localeCompare(b.id) || a.sourceId.localeCompare(b.sourceId) || a.reason.localeCompare(b.reason));
  return { selected, rejected, policy: { quota, maxAgeDays, deterministicTieBreak: 'score desc, source id, item id', sourceCount: usedSources.size, originLanguage: { required: ['zh', 'en'], selected: Object.fromEntries(['zh', 'en'].map(locale => [locale, selected.filter(x => x.source.locale === locale).length])), decisions: languageDecisions }, priorityInstitutionPaper: priority } };
}
