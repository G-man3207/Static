// Local-only power-user diagnostics for the probe log viewer.
globalThis.__static_log_diagnostics__ = (() => {
  const CFG = globalThis.__static_config__ || {};
  const CHROME_EXT_ID_RE = /^[a-p]{32}$/;
  const fmt = (n) => n.toLocaleString();

  const sortedCountEntries = (counts, limit = 6) =>
    Object.entries(counts || {})
      .filter(([, count]) => typeof count === "number" && count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit);

  const formatCountEntries = (counts) => {
    const entries = sortedCountEntries(counts);
    return entries.length
      ? entries.map(([key, count]) => `${key} ${fmt(count)}`).join(", ")
      : "none";
  };

  const countIdPressure = (counts) => {
    const entries = Object.entries(counts || {}).filter(([, count]) => count > 0);
    const unique = entries.length;
    const repeated = entries.filter(([, count]) => count >= 2).length;
    const oneShot = entries.filter(([, count]) => count === 1).length;
    return {
      oneShot,
      oneShotPct: unique ? Math.round((oneShot / unique) * 100) : 0,
      repeated,
      unique,
    };
  };

  const knownNoiseIds = () => {
    const ids = new Set();
    for (const slotIds of Object.values(CFG.conflictSlots || {})) {
      for (const id of slotIds) ids.add(id);
    }
    return ids;
  };

  const noiseReadinessFor = (entry) => {
    const knownIds = knownNoiseIds();
    const minKnown = CFG.personaMinCount || 2;
    const minUnknown = CFG.unknownPersonaMinCount || 20;
    let knownEligible = 0;
    let unknownEligible = 0;
    const eligibleIds = [];
    for (const [id, count] of Object.entries((entry && entry.idCounts) || {})) {
      const safeId = id.toLowerCase();
      const known = knownIds.has(safeId);
      const minCount = known ? minKnown : minUnknown;
      if (CHROME_EXT_ID_RE.test(safeId) && typeof count === "number" && count >= minCount) {
        knownEligible += known ? 1 : 0;
        unknownEligible += known ? 0 : 1;
        eligibleIds.push(safeId);
      }
    }
    return { eligibleIds, knownEligible, minKnown, minUnknown, unknownEligible };
  };

  const buildMetricDetail = (titleText, rows) => {
    const box = document.createElement("div");
    box.className = "drift-detail";
    const title = document.createElement("div");
    title.className = "drift-detail-title";
    title.textContent = titleText;
    box.appendChild(title);
    const list = document.createElement("ul");
    list.className = "metric-list";
    for (const [key, value] of rows.filter(([, rowValue]) => rowValue)) {
      const li = document.createElement("li");
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = key;
      const v = document.createElement("span");
      v.className = "v";
      v.textContent = value;
      li.appendChild(k);
      li.appendChild(v);
      list.appendChild(li);
    }
    box.appendChild(list);
    return box;
  };

  const buildPlaybookDetail = (entry, comparison) => {
    if (!comparison) return null;
    const { latestKey, current, baseline } = comparison;
    const latestIds = countIdPressure(current.idCounts);
    const weekCount = Object.keys((entry.playbook && entry.playbook.weeks) || {}).length;
    const priorWeeks = Math.max(0, weekCount - 1);
    return buildMetricDetail("Probe playbook", [
      ["Latest week", `${latestKey}; ${fmt(current.total || 0)} probes`],
      [
        "Baseline",
        `${fmt(baseline.total || 0)} probes across ${fmt(priorWeeks)} prior week${
          priorWeeks === 1 ? "" : "s"
        }`,
      ],
      ["Latest vectors", formatCountEntries(current.vectorCounts)],
      ["Latest path kinds", formatCountEntries(current.pathKindCounts)],
      [
        "Latest ID pressure",
        `${fmt(latestIds.unique)} unique, ${fmt(latestIds.repeated)} repeated, ${
          latestIds.oneShotPct
        }% one-shot`,
      ],
    ]);
  };

  const buildNoiseReadinessDetail = (entry) => {
    const readiness = noiseReadinessFor(entry);
    const target = CFG.personaSize || { min: 3, max: 8 };
    const pressure = countIdPressure(entry.idCounts);
    const rotationWeeks = CFG.personaRotationWeeks || 1;
    return buildMetricDetail("Noise readiness", [
      [
        "Eligible pool",
        `${fmt(readiness.knownEligible + readiness.unknownEligible)} IDs (${fmt(
          readiness.knownEligible
        )} known-list, ${fmt(readiness.unknownEligible)} repeated unknown)`,
      ],
      [
        "Persona target",
        `${fmt(target.min || 3)}-${fmt(target.max || 8)} IDs; rotates every ${fmt(
          rotationWeeks
        )} week${rotationWeeks === 1 ? "" : "s"}`,
      ],
      [
        "Thresholds",
        `known IDs need ${fmt(readiness.minKnown)} probes; unknown IDs need ${fmt(
          readiness.minUnknown
        )} probes`,
      ],
      [
        "Canary pressure",
        `${fmt(pressure.oneShot)} one-shot IDs out of ${fmt(pressure.unique)} unique (${
          pressure.oneShotPct
        }%)`,
      ],
      ["Eligible IDs", readiness.eligibleIds.slice(0, 12).join(", ") || "none yet"],
    ]);
  };

  return { buildNoiseReadinessDetail, buildPlaybookDetail };
})();
