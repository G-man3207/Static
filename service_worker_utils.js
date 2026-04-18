// Static - pure service-worker helpers for caps, playbooks, and drift scoring.
globalThis.__static_sw_utils__ = (() => {
  const sumCounts = (counts) => {
    let total = 0;
    for (const value of Object.values(counts || {})) {
      if (typeof value === "number" && value > 0) total += value;
    }
    return total;
  };

  const mergeCounts = (target, source) => {
    let changed = false;
    for (const [key, value] of Object.entries(source || {})) {
      if (typeof value === "number" && value > 0) {
        target[key] = (target[key] || 0) + value;
        changed = true;
      }
    }
    return changed;
  };

  const trimCountMap = (counts, maxEntries) => {
    const entries = Object.entries(counts || {});
    if (entries.length <= maxEntries) return counts || {};
    entries.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, maxEntries));
  };

  const sortedCountEntries = (counts, limit) =>
    Object.entries(counts || {})
      .filter(([, count]) => typeof count === "number" && count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit);

  const idPressureFor = (counts) => {
    const entries = Object.entries(counts || {}).filter(([, count]) => count > 0);
    const uniqueIds = entries.length;
    const repeatedIds = entries.filter(([, count]) => count >= 2).length;
    const oneShotIds = entries.filter(([, count]) => count === 1).length;
    return {
      oneShotIds,
      oneShotPressure: uniqueIds ? oneShotIds / uniqueIds : 0,
      repeatedIds,
      uniqueIds,
    };
  };

  const weekKeyFor = (time) => {
    const date = new Date(time);
    const year = date.getUTCFullYear();
    const yearStart = Date.UTC(year, 0, 1);
    const day = Math.floor(
      (Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - yearStart) / 86400000
    );
    return `${year}-W${String(Math.floor(day / 7) + 1).padStart(2, "0")}`;
  };

  const ensurePlaybookWeek = (entry, now) => {
    entry.playbook ||= { weeks: {} };
    entry.playbook.weeks ||= {};
    const weekKey = weekKeyFor(now);
    const week =
      entry.playbook.weeks[weekKey] ||
      (entry.playbook.weeks[weekKey] = {
        total: 0,
        vectorCounts: {},
        pathKindCounts: {},
        idCounts: {},
        firstSeen: now,
        lastSeen: now,
      });
    week.firstSeen ||= now;
    week.lastSeen = now;
    return week;
  };

  const enforcePlaybookCaps = (entry) => {
    if (!entry.playbook || !entry.playbook.weeks) return;
    for (const week of Object.values(entry.playbook.weeks)) {
      week.vectorCounts = trimCountMap(week.vectorCounts, 50);
      week.pathKindCounts = trimCountMap(week.pathKindCounts, 50);
      week.idCounts = trimCountMap(week.idCounts, 1000);
    }
    const weekKeys = Object.keys(entry.playbook.weeks).sort();
    if (weekKeys.length <= 10) return;
    for (const key of weekKeys.slice(0, weekKeys.length - 10)) {
      delete entry.playbook.weeks[key];
    }
  };

  const enforceCaps = (probeLog) => {
    for (const origin of Object.keys(probeLog)) {
      const entry = probeLog[origin];
      entry.idCounts ||= {};
      entry.idCounts = trimCountMap(entry.idCounts, 2000);
      enforcePlaybookCaps(entry);
    }
    const origins = Object.keys(probeLog);
    if (origins.length <= 100) return;
    origins.sort((a, b) => (probeLog[b].lastUpdated || 0) - (probeLog[a].lastUpdated || 0));
    for (const origin of origins.slice(100)) delete probeLog[origin];
  };

  const latestPlaybookComparison = (entry) => {
    const weeks = entry && entry.playbook && entry.playbook.weeks;
    if (!weeks) return null;
    const keys = Object.keys(weeks).sort();
    if (keys.length === 0) return null;
    const latestKey = keys[keys.length - 1];
    const current = weeks[latestKey];
    const baseline = { total: 0, vectorCounts: {}, pathKindCounts: {}, idCounts: {} };
    for (const key of keys.slice(0, -1)) {
      const week = weeks[key] || {};
      baseline.total += week.total || 0;
      mergeCounts(baseline.vectorCounts, week.vectorCounts);
      mergeCounts(baseline.pathKindCounts, week.pathKindCounts);
      mergeCounts(baseline.idCounts, week.idCounts);
    }
    return { latestKey, current, baseline };
  };

  const latestPlaybookSnapshot = (entry) => {
    const comparison = latestPlaybookComparison(entry);
    if (!comparison) return null;
    const { latestKey, current } = comparison;
    return {
      ...idPressureFor(current.idCounts),
      pathKinds: sortedCountEntries(current.pathKindCounts, 5),
      total: current.total || 0,
      vectors: sortedCountEntries(current.vectorCounts, 5),
      week: latestKey,
    };
  };

  const knownPersonaIds = (config) => {
    const ids = new Set();
    for (const slotIds of Object.values((config && config.conflictSlots) || {})) {
      for (const id of slotIds) ids.add(id);
    }
    return ids;
  };

  const eligibilityKindFor = (id, count, knownIds, config) => {
    const chromeExtIdRe = /^[a-p]{32}$/;
    if (!chromeExtIdRe.test(id) || typeof count !== "number") return null;
    const known = knownIds.has(id);
    const min = known ? config.personaMinCount || 2 : config.unknownPersonaMinCount || 20;
    return count >= min ? (known ? "known" : "unknown") : null;
  };

  const personaDiagnosticsFor = (entry, selectedIds, noiseEnabled, config) => {
    const cfg = config || {};
    const target = cfg.personaSize || { min: 3, max: 8 };
    const knownIds = knownPersonaIds(cfg);
    const stats = idPressureFor(entry && entry.idCounts);
    let eligibleKnown = 0;
    let eligibleUnknown = 0;

    for (const [id, count] of Object.entries((entry && entry.idCounts) || {})) {
      const kind = eligibilityKindFor(id.toLowerCase(), count, knownIds, cfg);
      if (kind === "known") eligibleKnown++;
      if (kind === "unknown") eligibleUnknown++;
    }

    return {
      ...stats,
      armed: !!noiseEnabled && selectedIds.length > 0,
      eligibleKnown,
      eligibleTotal: eligibleKnown + eligibleUnknown,
      eligibleUnknown,
      minKnown: cfg.personaMinCount || 2,
      minUnknown: cfg.unknownPersonaMinCount || 20,
      noiseEnabled: !!noiseEnabled,
      rotationWeeks: cfg.personaRotationWeeks || 1,
      selectedCount: selectedIds.length,
      selectedIds,
      targetMax: target.max || 8,
      targetMin: target.min || 3,
    };
  };

  const distributionShift = (a, b) => {
    const totalA = sumCounts(a);
    const totalB = sumCounts(b);
    if (totalA === 0 || totalB === 0) return 0;
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    let sum = 0;
    for (const key of keys) {
      sum += Math.abs(((a && a[key]) || 0) / totalA - ((b && b[key]) || 0) / totalB);
    }
    return sum / 2;
  };

  const repeatedIdSet = (counts) =>
    new Set(
      Object.entries(counts || {})
        .filter(([, count]) => count >= 2)
        .map(([id]) => id)
    );

  const jaccardDistance = (a, b) => {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const value of a) {
      if (b.has(value)) intersection++;
    }
    return 1 - intersection / new Set([...a, ...b]).size;
  };

  const percent = (n) => Math.round(n * 100);

  const newKeys = (current, baseline, minCount) =>
    Object.entries(current || {})
      .filter(([key, count]) => count >= minCount && !baseline[key])
      .map(([key]) => key);

  const addShiftScore = (shift) => {
    const { state } = shift;
    if (shift.value >= shift.high) {
      state.score += shift.highScore;
      state.reasons.push(shift.reason);
    } else if (shift.value >= shift.medium) {
      state.score += shift.mediumScore;
      state.reasons.push(shift.reason);
    }
  };

  const addPlaybookDriftSignals = (state, current, baseline) => {
    const vectorShift = distributionShift(current.vectorCounts, baseline.vectorCounts);
    addShiftScore({
      state,
      value: vectorShift,
      high: 0.35,
      medium: 0.2,
      highScore: 3,
      mediumScore: 2,
      reason: `Probe vector mix changed by ${percent(vectorShift)}%.`,
    });
    const addedVectors = newKeys(current.vectorCounts, baseline.vectorCounts, 3);
    if (addedVectors.length > 0) {
      state.score += 2;
      state.reasons.push(`New probe vectors appeared: ${addedVectors.slice(0, 4).join(", ")}.`);
    }

    const pathShift = distributionShift(current.pathKindCounts, baseline.pathKindCounts);
    addShiftScore({
      state,
      value: pathShift,
      high: 0.35,
      medium: 0.2,
      highScore: 2,
      mediumScore: 1,
      reason: `Extension-resource path strategy changed by ${percent(pathShift)}%.`,
    });
    const addedPathKinds = newKeys(current.pathKindCounts, baseline.pathKindCounts, 3);
    if (addedPathKinds.length > 0) {
      state.score += 1;
      state.reasons.push(`New path kinds appeared: ${addedPathKinds.slice(0, 4).join(", ")}.`);
    }
  };

  const addIdDriftSignals = (state, current, baseline) => {
    const currentIds = repeatedIdSet(current.idCounts);
    const baselineIds = repeatedIdSet(baseline.idCounts);
    const idShift = jaccardDistance(currentIds, baselineIds);
    if (currentIds.size >= 5) {
      addShiftScore({
        state,
        value: idShift,
        high: 0.6,
        medium: 0.35,
        highScore: 2,
        mediumScore: 1,
        reason: `Repeated extension-ID dictionary changed by ${percent(idShift)}%.`,
      });
    }

    const uniqueIds = Object.keys(current.idCounts || {}).length;
    const singletonIds = Object.values(current.idCounts || {}).filter(
      (count) => count === 1
    ).length;
    const canaryPressure = uniqueIds ? singletonIds / uniqueIds : 0;
    if (uniqueIds >= 10 && canaryPressure >= 0.35) {
      state.score += 2;
      state.reasons.push(
        `One-shot ID pressure is high: ${percent(canaryPressure)}% of IDs were single-hit.`
      );
    }
  };

  const driftResultFor = (score, latestKey, reasons) => {
    if (score >= 5) return { level: "high", label: "High drift", week: latestKey, reasons };
    if (score >= 3) return { level: "changed", label: "Changed", week: latestKey, reasons };
    return {
      level: "stable",
      label: "Stable",
      week: latestKey,
      reasons: ["No meaningful change from this origin's previous probe behavior."],
    };
  };

  const playbookDriftForEntry = (entry) => {
    const comparison = latestPlaybookComparison(entry);
    if (!comparison) {
      return { level: "learning", label: "Learning", reasons: ["No playbook summary yet."] };
    }
    const { latestKey, current, baseline } = comparison;
    if ((current.total || 0) < 20 || (baseline.total || 0) < 20) {
      return {
        level: "learning",
        label: "Learning",
        week: latestKey,
        reasons: ["Needs at least 20 probes in the latest week and baseline before scoring drift."],
      };
    }

    const state = { score: 0, reasons: [] };
    addPlaybookDriftSignals(state, current, baseline);
    addIdDriftSignals(state, current, baseline);
    return driftResultFor(state.score, latestKey, state.reasons);
  };

  return {
    enforceCaps,
    ensurePlaybookWeek,
    latestPlaybookSnapshot,
    mergeCounts,
    personaDiagnosticsFor,
    playbookDriftForEntry,
    sumCounts,
    trimCountMap,
  };
})();
