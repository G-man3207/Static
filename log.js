/* eslint-disable max-lines -- this extension page keeps viewer helpers and export handlers together */
// Probe-log viewer. Loads the full log from the service worker and renders a
// searchable table of origins; each row expands to show per-ID probe counts
// for that origin. Also handles Export / Clear.
const fmt = (n) => n.toLocaleString();
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString() : "—");
const AD_SIGNALS = globalThis.__static_ad_signals__ || {};
const LOG_DIAGNOSTICS = globalThis.__static_log_diagnostics__ || {};
const SEVERITY_LEVELS = {
  high: { label: "High", rank: 3 },
  medium: { label: "Medium", rank: 2 },
  low: { label: "Low", rank: 1 },
  info: { label: "Info", rank: 0 },
};
const ADAPTIVE_REASON_INFO = {
  audio: {
    label: "Audio fingerprinting",
    description:
      "The site touched offline audio APIs that can reveal device and browser differences.",
  },
  canvas: {
    label: "Canvas readback",
    description: "The site read pixels from a canvas, a common browser fingerprinting surface.",
  },
  crypto: {
    label: "Crypto timing or setup",
    description:
      "The site used Web Crypto near other collection signals, often as part of bot or device checks.",
  },
  dom_observer: {
    label: "DOM observer",
    description:
      "The site watched broad page changes. Session replay and anti-bot scripts use this to reconstruct activity.",
  },
  environment: {
    label: "Environment snapshot",
    description:
      "The site read device, locale, screen, storage, or time-zone details that help identify the browser.",
  },
  input_hooks: {
    label: "Input hooks",
    description:
      "The site registered broad input, keyboard, pointer, or scroll listeners that can collect interaction patterns.",
  },
  "mutation.subtree": {
    label: "Whole-page mutation watch",
    description:
      "A MutationObserver watched a large page subtree, which can capture page content and UI changes.",
  },
  navigator: {
    label: "Navigator reads",
    description:
      "The site read browser and device properties exposed through navigator, used in fingerprinting profiles.",
  },
  "navigator.deviceMemory": {
    label: "Device memory read",
    description:
      "The site read approximate device memory, a coarse hardware signal used in browser fingerprinting.",
  },
  network: {
    label: "Network collection",
    description:
      "A collection endpoint was contacted near other fingerprinting or replay behavior.",
  },
  webgl: {
    label: "WebGL fingerprinting",
    description: "The site queried graphics APIs that can reveal GPU and driver characteristics.",
  },
};
const ADAPTIVE_REASON_PREFIXES = [
  {
    prefix: "listener.",
    label: (suffix) => `Global ${suffix} listener`,
    description: (suffix) =>
      `A page-wide ${suffix} listener was installed, which can observe user interaction timing or content changes.`,
  },
  {
    prefix: "navigator.",
    label: (suffix) => `Navigator ${suffix} read`,
    description: (suffix) =>
      `The site read navigator.${suffix}, a browser or device property used in fingerprinting profiles.`,
  },
  {
    prefix: "canvas.",
    label: () => "Canvas readback",
    description: () =>
      "The site used canvas readback APIs that can expose rendering differences between devices.",
  },
  {
    prefix: "webgl.",
    label: () => "WebGL query",
    description: () => "The site queried graphics state that can identify GPU and driver behavior.",
  },
  {
    prefix: "webgl2.",
    label: () => "WebGL 2 query",
    description: () => "The site queried graphics state that can identify GPU and driver behavior.",
  },
  {
    prefix: "audio.",
    label: () => "Audio fingerprinting",
    description: () =>
      "The site used audio APIs that can expose subtle hardware and browser differences.",
  },
  {
    prefix: "crypto.",
    label: (suffix) => `Crypto ${suffix}`,
    description: (suffix) =>
      `The site used crypto.${suffix} near other collection signals, often as part of bot or device checks.`,
  },
  {
    prefix: "screen.",
    label: (suffix) => `Screen ${suffix} read`,
    description: (suffix) =>
      `The site read screen.${suffix}, a display property that can contribute to a fingerprint.`,
  },
  {
    prefix: "vendor:",
    label: (suffix) => `${suffix} vendor signature`,
    description: (suffix) =>
      `Static recognized a client-side ${suffix} integration associated with anti-bot, replay, or fingerprinting workflows.`,
  },
  {
    prefix: "global:",
    label: (suffix) => `${suffix} global`,
    description: (suffix) =>
      `A page global named ${suffix} matched a known collector or anti-bot integration signal.`,
  },
  {
    prefix: "config:",
    label: (suffix) => `${suffix} configuration`,
    description: (suffix) =>
      `A configuration value named ${suffix} helped identify the local collector integration.`,
  },
  {
    prefix: "api:",
    label: (suffix) => `${suffix} API call`,
    description: (suffix) =>
      `A known collector API call named ${suffix} was observed in the page runtime.`,
  },
  {
    prefix: "queue:",
    label: (suffix) => `${suffix} queue call`,
    description: (suffix) =>
      `A queued collector command named ${suffix} was observed before the library fully loaded.`,
  },
  {
    prefix: "script:",
    label: (suffix) => `${suffix} script`,
    description: (suffix) =>
      `A script route or filename matched a known collector integration pattern for ${suffix}.`,
  },
];

const totalProbesFor = (entry) => {
  let sum = 0;
  for (const c of Object.values(entry.idCounts || {})) sum += c;
  return sum;
};

const sortedCountEntries = (counts) =>
  Object.entries(counts || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

const sumCounts = (counts) => {
  let total = 0;
  for (const value of Object.values(counts || {})) {
    if (typeof value === "number" && value > 0) total += value;
  }
  return total;
};

const mergeCounts = (target, source) => {
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === "number" && value > 0) target[key] = (target[key] || 0) + value;
  }
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
  const singletonIds = Object.values(current.idCounts || {}).filter((count) => count === 1).length;
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
  const currentTotal = current.total || 0;
  const baselineTotal = baseline.total || 0;
  if (currentTotal < 20 || baselineTotal < 20) {
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

const buildDriftPill = (drift) => {
  const span = document.createElement("span");
  span.className = `drift-pill ${drift.level || "learning"}`;
  span.textContent = drift.label || "Learning";
  return span;
};

const severityLevelForScore = (score) => {
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score >= 1) return "low";
  return "info";
};

const addSeverityReason = (state, points, reason) => {
  state.score += points;
  state.reasons.push(reason);
};

const addAdaptiveSeveritySignals = (state, adaptive) => {
  const scoreMax = adaptive && adaptive.scoreMax ? adaptive.scoreMax : 0;
  if (scoreMax >= 9) {
    addSeverityReason(state, 7, `Strong adaptive data-collection signal score ${fmt(scoreMax)}.`);
  } else if (scoreMax >= 7) {
    addSeverityReason(state, 4, `Adaptive signal threshold crossed with score ${fmt(scoreMax)}.`);
  }
};

const addAdSeveritySignals = (state, ad) => {
  if (!ad) return;
  const confidence = adConfidenceForEntry(ad);
  const score = typeof ad.score === "number" ? ad.score : adScoreForReasons(ad.reasons || {});
  if (confidence === "high") {
    addSeverityReason(state, 4, `High-confidence ad behavior observed with score ${fmt(score)}.`);
  } else if (confidence === "likely") {
    addSeverityReason(state, 2, `Likely ad behavior observed with score ${fmt(score)}.`);
  } else if (sumCounts(ad.reasons) > 0) {
    addSeverityReason(state, 1, `Ad behavior signals are still in learning state.`);
  }
};

const addProbeSeveritySignals = (state, entry, drift) => {
  const total = totalProbesFor(entry);
  const unique = Object.keys(entry.idCounts || {}).length;
  if (drift.level === "high") {
    addSeverityReason(state, 7, "Probe behavior changed sharply from the previous baseline.");
  } else if (drift.level === "changed") {
    addSeverityReason(state, 4, "Probe behavior changed from the previous baseline.");
  }
  if (unique >= 20) {
    addSeverityReason(state, 2, `${fmt(unique)} unique extension IDs were probed.`);
  } else if (unique >= 5) {
    addSeverityReason(state, 1, `${fmt(unique)} unique extension IDs were probed.`);
  }
  if (total >= 100) {
    addSeverityReason(state, 2, `${fmt(total)} total extension probes were recorded.`);
  } else if (total > 0) {
    addSeverityReason(
      state,
      1,
      `${fmt(total)} total extension probe${total === 1 ? "" : "s"} recorded.`
    );
  }
};

const addDiagnosticSeveritySignals = (state, diagnostics) => {
  const count = diagnostics && Array.isArray(diagnostics.events) ? diagnostics.events.length : 0;
  if (count > 0) {
    addSeverityReason(state, 1, `${fmt(count)} QA diagnostic event${count === 1 ? "" : "s"}.`);
  }
};

const severityForEntry = (entry, drift) => {
  const state = { score: 0, reasons: [] };
  addAdaptiveSeveritySignals(state, entry.__adaptive);
  addAdSeveritySignals(state, entry.__ad);
  addDiagnosticSeveritySignals(state, entry.__diagnostics);
  addProbeSeveritySignals(state, entry, drift);
  const level = severityLevelForScore(state.score);
  return {
    ...SEVERITY_LEVELS[level],
    level,
    reasons:
      state.reasons.length > 0
        ? state.reasons
        : ["No elevated probe or adaptive behavior signals were recorded."],
    score: state.score,
  };
};

const buildSeverityPill = (severity) => {
  const span = document.createElement("span");
  span.className = `severity-pill ${severity.level}`;
  span.textContent = severity.label;
  span.title = `Severity score ${fmt(severity.score)}`;
  return span;
};

const buildAdaptivePill = (adaptive) => {
  if (!adaptive) return null;
  const span = document.createElement("span");
  span.className = "drift-pill changed";
  span.textContent = "Adaptive signals";
  return span;
};

const adUiConfidence = (confidence) =>
  confidence === "high" || confidence === "likely" ? confidence : "learning";

const adConfidenceLabel = (confidence) => {
  if (confidence === "high") return "High";
  if (confidence === "likely") return "Likely";
  return "Learning";
};

const adScoreForReasons = (reasons) => {
  if (typeof AD_SIGNALS.scoreForReasons === "function") return AD_SIGNALS.scoreForReasons(reasons);
  return 0;
};

const adReasonScore = (reason) => {
  const weights = AD_SIGNALS.weights || {};
  const score = weights[reason];
  return typeof score === "number" && score > 0 ? score : 0;
};

const adConfidenceForEntry = (ad) => {
  if (!ad) return "learning";
  if (ad.confidence) return adUiConfidence(ad.confidence);
  if (typeof AD_SIGNALS.confidenceForReasons === "function") {
    return adUiConfidence(AD_SIGNALS.confidenceForReasons(ad.reasons || {}));
  }
  return "learning";
};

const buildAdPill = (ad) => {
  if (!ad) return null;
  const confidence = adConfidenceForEntry(ad);
  const span = document.createElement("span");
  span.className = `ad-pill ${confidence}`;
  span.textContent = adConfidenceLabel(confidence);
  return span;
};

const buildDiagnosticPill = (diagnostics) => {
  if (!(diagnostics && Array.isArray(diagnostics.events) && diagnostics.events.length > 0)) {
    return null;
  }
  const span = document.createElement("span");
  span.className = "drift-pill low";
  span.textContent = "QA diagnostics";
  return span;
};

const buildDriftDetail = (drift) => {
  const box = document.createElement("div");
  box.className = "drift-detail";
  const title = document.createElement("div");
  title.className = "drift-detail-title";
  title.textContent = `Probe behavior: ${drift.label || "Learning"}`;
  box.appendChild(title);
  const list = document.createElement("ul");
  list.className = "drift-reasons";
  for (const reason of drift.reasons || []) {
    const li = document.createElement("li");
    li.textContent = reason;
    list.appendChild(li);
  }
  box.appendChild(list);
  return box;
};

const buildSeverityDetail = (severity, rank) => {
  const box = document.createElement("div");
  box.className = "drift-detail";
  const title = document.createElement("div");
  title.className = "drift-detail-title";
  title.textContent = `Severity rank: #${fmt(rank)} (${severity.label})`;
  box.appendChild(title);
  const list = document.createElement("ul");
  list.className = "drift-reasons";
  for (const reason of severity.reasons || []) {
    const li = document.createElement("li");
    li.textContent = reason;
    list.appendChild(li);
  }
  box.appendChild(list);
  return box;
};

const humanizeReason = (reason) =>
  String(reason || "unknown")
    .replace(/[._:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const reasonInfoFor = (reason) => {
  if (ADAPTIVE_REASON_INFO[reason]) return ADAPTIVE_REASON_INFO[reason];
  for (const info of ADAPTIVE_REASON_PREFIXES) {
    if (reason.startsWith(info.prefix)) {
      const suffix = reason.slice(info.prefix.length) || "signal";
      return {
        label: info.label(suffix),
        description: info.description(suffix),
      };
    }
  }
  if (/^(fetch|xhr|sendBeacon):/.test(reason)) {
    return {
      label: "Network API call",
      description:
        "A network API was used near other collection signals; the suffix is a coarse request-size bucket.",
    };
  }
  return {
    label: humanizeReason(reason) || "Observed signal",
    description: "This token was observed as part of the local adaptive signal bundle.",
  };
};

const isDeviceSignalReason = (reason) =>
  ["audio", "canvas", "environment", "navigator", "webgl"].includes(reason) ||
  /^(audio|canvas|screen|webgl|webgl2|navigator)\./.test(reason) ||
  ["date.getTimezoneOffset", "intl.resolvedOptions", "storage.estimate"].includes(reason);

const isReplaySurfaceReason = (reason) =>
  ["dom_observer", "input_hooks", "mutation.subtree"].includes(reason) ||
  reason.startsWith("listener.");

const isNetworkReason = (reason) => reason === "network" || /^(fetch|xhr|sendBeacon):/.test(reason);

const protectionTextForReason = (reason) => {
  if (isDeviceSignalReason(reason)) {
    return fullData && fullData.fingerprintMode === "mask"
      ? "Device signal poisoning is on for this browser surface."
      : "Device signal poisoning can weaken this surface without blocking the read.";
  }
  if (isReplaySurfaceReason(reason)) {
    return "Replay poisoning can mask detected recorder listeners; generic page listeners stay unblocked for compatibility.";
  }
  if (isNetworkReason(reason)) {
    return "Known vendor traffic is handled by rulesets; generic adaptive network blocking remains observe-only.";
  }
  if (reason === "crypto" || reason.startsWith("crypto.")) {
    return "Crypto output stays unmodified because poisoning it would break normal site behavior.";
  }
  return "";
};

const buildAdaptiveReasonGuide = (reasons) => {
  if (reasons.length === 0) return null;
  const guide = document.createElement("div");
  guide.className = "reason-guide";
  const title = document.createElement("div");
  title.className = "drift-detail-title";
  title.textContent = "Signal guide";
  guide.appendChild(title);
  const list = document.createElement("dl");
  list.className = "reason-list";
  for (const [reason, count] of reasons.slice(0, 10)) {
    const info = reasonInfoFor(reason);
    const item = document.createElement("div");
    item.className = "reason-item";
    const term = document.createElement("dt");
    term.textContent = info.label;
    const token = document.createElement("span");
    token.className = "reason-token";
    token.textContent = reason;
    term.appendChild(token);
    const description = document.createElement("dd");
    const protectionText = protectionTextForReason(reason);
    description.textContent = `${info.description} Seen ${fmt(count)} time${
      count === 1 ? "" : "s"
    }.${protectionText ? ` ${protectionText}` : ""}`;
    item.appendChild(term);
    item.appendChild(description);
    list.appendChild(item);
  }
  guide.appendChild(list);
  return guide;
};

const adaptiveEndpointStatusLabel = (status) => {
  if (status === "candidate") return "narrow candidate";
  if (status === "learning") return "learning";
  return "rejected";
};

const buildAdaptiveEndpointDiagnostics = (items) => {
  const box = document.createElement("div");
  box.className = "reason-guide";
  const title = document.createElement("div");
  title.className = "drift-detail-title";
  title.textContent = "Adaptive endpoint guardrails";
  box.appendChild(title);
  const list = document.createElement("ul");
  list.className = "drift-reasons";
  const entries = Array.isArray(items) ? items : [];
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No endpoint candidates were derived from the observed adaptive signals.";
    list.appendChild(li);
  } else {
    for (const item of entries.slice(0, 8)) {
      const li = document.createElement("li");
      const label = item.path || item.endpoint || "endpoint";
      const count = item.count ? `, ${fmt(item.count)} hit${item.count === 1 ? "" : "s"}` : "";
      const reason = item.reason ? `, ${item.reason}` : "";
      li.textContent = `${label} (${adaptiveEndpointStatusLabel(item.status)}${count}${reason})`;
      list.appendChild(li);
    }
  }
  box.appendChild(list);
  return box;
};

const adaptiveCalibrationLines = (calibration) => {
  if (!calibration) {
    return ["Adaptive calibration metadata was not available for this origin."];
  }
  const lines = [
    calibration.summary || "Adaptive signals remain diagnostics-only.",
    `${fmt(calibration.scoreMax || 0)} max score; calibration thresholds are ${fmt(
      calibration.minScore || 0
    )} score and ${fmt(calibration.minHits || 0)} endpoint hits.`,
  ];
  if (calibration.siteRecoverySummary) lines.push(calibration.siteRecoverySummary);
  if (calibration.nextStep) lines.push(calibration.nextStep);
  if (calibration.recoveryRequired) {
    lines.push("Generic adaptive blocking stays observe-only until recovery controls exist.");
  }
  return lines;
};

const buildAdaptiveCalibration = (calibration) => {
  const box = document.createElement("div");
  box.className = "reason-guide";
  const title = document.createElement("div");
  title.className = "drift-detail-title";
  title.textContent = "Adaptive calibration";
  box.appendChild(title);
  const list = document.createElement("ul");
  list.className = "drift-reasons";
  for (const line of adaptiveCalibrationLines(calibration)) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
  const reasons = Array.isArray(calibration && calibration.reasons) ? calibration.reasons : [];
  if (reasons.length > 0) {
    const li = document.createElement("li");
    li.textContent = `Calibration reasons: ${reasons.slice(0, 6).join(", ")}.`;
    list.appendChild(li);
  }
  box.appendChild(list);
  return box;
};

const adaptiveRuleLabel = (rule) => {
  if (!rule) return "tracked adaptive rule";
  const id = rule.ruleId ? ` #${fmt(rule.ruleId)}` : "";
  const kind = rule.ruleKind && rule.ruleKind !== "rule" ? `${rule.ruleKind} ` : "";
  const score = typeof rule.score === "number" ? `, score ${fmt(rule.score)}` : "";
  const breakage = rule.breakageCount
    ? `, ${fmt(rule.breakageCount)} breakage mark${rule.breakageCount === 1 ? "" : "s"}`
    : "";
  const reason = rule.lastBreakageReason ? `, ${rule.lastBreakageReason}` : "";
  return `${kind}rule${id}: ${rule.endpoint || "collector endpoint"} (${
    rule.status || "candidate"
  }${score}${breakage}${reason})`;
};

const buildAdaptiveRecovery = (recovery) => {
  const box = document.createElement("div");
  box.className = "reason-guide";
  const title = document.createElement("div");
  title.className = "drift-detail-title";
  title.textContent = "Adaptive recovery";
  box.appendChild(title);
  const list = document.createElement("ul");
  list.className = "drift-reasons";
  const rules = Array.isArray(recovery && recovery.recentRules) ? recovery.recentRules : [];
  const summary = document.createElement("li");
  summary.textContent = rules.length
    ? `${fmt(rules.length)} tracked adaptive rule${rules.length === 1 ? "" : "s"}; ${
        recovery.demotedRuleCount ? `${fmt(recovery.demotedRuleCount)} demoted.` : "none demoted."
      }`
    : "No tracked adaptive rules for this origin.";
  list.appendChild(summary);
  if (recovery && recovery.likelyBreakageRule) {
    const li = document.createElement("li");
    li.textContent = `Likely recovery target: ${adaptiveRuleLabel(recovery.likelyBreakageRule)}.`;
    list.appendChild(li);
  }
  for (const rule of rules.slice(0, 4)) {
    const li = document.createElement("li");
    li.textContent = adaptiveRuleLabel(rule);
    list.appendChild(li);
  }
  box.appendChild(list);
  return box;
};

const appendAdaptiveClearControl = (box, origin) => {
  if (!origin) return;
  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const clear = document.createElement("button");
  clear.className = "btn btn-danger";
  clear.type = "button";
  clear.textContent = "Clear adaptive signals for this origin";
  clear.addEventListener("click", async () => {
    clear.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        origin,
        type: "static_clear_adaptive_site_data",
      });
      await reload();
    } catch {
      clear.disabled = false;
    }
  });
  actions.appendChild(clear);
  box.appendChild(actions);
};

const buildAdaptiveDetail = (adaptive, origin) => {
  if (!adaptive) return null;
  const box = document.createElement("div");
  box.className = "drift-detail";
  const title = document.createElement("div");
  title.className = "drift-detail-title";
  title.textContent = "Adaptive behavior: observe-only";
  box.appendChild(title);
  const list = document.createElement("ul");
  list.className = "drift-reasons";
  const categories = sortedCountEntries(adaptive.categories);
  const endpoints = sortedCountEntries(adaptive.endpoints);
  const reasons = sortedCountEntries(adaptive.reasons);
  const lines = [
    `Max local score: ${fmt(adaptive.scoreMax || 0)}.`,
    categories.length
      ? `Categories observed: ${categories
          .map(([category]) => category)
          .slice(0, 4)
          .join(", ")}.`
      : "",
    reasons.length
      ? `Top signals: ${reasons
          .map(([reason, count]) => `${reason} (${fmt(count)})`)
          .slice(0, 8)
          .join(", ")}.`
      : "",
    endpoints.length
      ? `Top endpoint: ${endpoints[0][0]}.`
      : "No endpoint was associated with the local signal.",
  ].filter(Boolean);
  for (const line of lines) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
  box.appendChild(list);
  const reasonGuide = buildAdaptiveReasonGuide(reasons);
  if (reasonGuide) box.appendChild(reasonGuide);
  box.appendChild(buildAdaptiveEndpointDiagnostics(adaptive.endpointDiagnostics));
  box.appendChild(buildAdaptiveCalibration(adaptive.calibration));
  box.appendChild(buildAdaptiveRecovery(adaptive.recovery));
  appendAdaptiveClearControl(box, origin);
  return box;
};

const topAdReasonText = (reasons) => {
  const entries = sortedCountEntries(reasons);
  if (entries.length === 0) return "No ad reason tokens recorded yet.";
  return entries
    .slice(0, 8)
    .map(([reason, count]) => {
      const score = adReasonScore(reason);
      return `${reason} (${fmt(count)}${score ? `, score ${fmt(score)}` : ""})`;
    })
    .join(", ");
};

const playbookEntryLabel = (entry, valueKey) => {
  const value = entry[valueKey] || entry.value || "entry";
  const score = typeof entry.score === "number" ? entry.score : 0;
  const hits = entry.hits ? `, ${fmt(entry.hits)} hit${entry.hits === 1 ? "" : "s"}` : "";
  const sessions = entry.sessionCount
    ? `, ${fmt(entry.sessionCount)} session${entry.sessionCount === 1 ? "" : "s"}`
    : "";
  const diagnostic = entry.diagnosticOnly ? ", diagnostics-only" : "";
  const status = entry.status ? `, ${entry.status}` : "";
  return `${value} (${entry.kind || "candidate"}, score ${fmt(
    score
  )}${hits}${sessions}${diagnostic}${status})`;
};

const sortedAdPlaybookEntries = (entries) =>
  (Array.isArray(entries) ? entries : [])
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.hits || 0) - (a.hits || 0));

const adPrefsForOrigin = (origin, prefs = {}) => {
  const sites = prefs.sites || prefs.site || {};
  const site = (origin && sites[origin]) || {};
  return {
    cleanupDisabled: !!(site.cleanupDisabled || site.disabled),
  };
};

const buildAdPlaybookList = (titleText, entries, valueKey) => {
  const box = document.createElement("div");
  box.className = "reason-guide";
  const title = document.createElement("div");
  title.className = "drift-detail-title";
  title.textContent = titleText;
  box.appendChild(title);
  const list = document.createElement("ul");
  list.className = "drift-reasons";
  const sorted = sortedAdPlaybookEntries(entries);
  if (sorted.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No learned entries for this origin yet.";
    list.appendChild(li);
  } else {
    for (const entry of sorted.slice(0, 8)) {
      const li = document.createElement("li");
      li.textContent = playbookEntryLabel(entry, valueKey);
      list.appendChild(li);
    }
  }
  box.appendChild(list);
  return box;
};

const adScoreValue = (ad) =>
  ad && typeof ad.score === "number" ? ad.score : adScoreForReasons(ad && ad.reasons);

const adEndpointEvidenceText = (endpoints) => {
  if (endpoints.length === 0) return "No endpoint evidence recorded yet.";
  return `Learned endpoint evidence: ${endpoints
    .slice(0, 5)
    .map(([endpoint, count]) => `${endpoint} (${fmt(count)})`)
    .join(", ")}.`;
};

const adSourceText = (sources) => (sources.length ? `Top source label: ${sources[0][0]}.` : "");

const adCleanupText = (origin, playbook, prefs) => {
  const sitePrefs = adPrefsForOrigin(origin, prefs);
  return sitePrefs.cleanupDisabled || (playbook && playbook.disabled)
    ? "Ad cleanup is disabled for this origin."
    : "Ad cleanup is not disabled for this origin.";
};

const adSessionNetworkText = (sessionNetwork) => {
  const count = Array.isArray(sessionNetwork) ? sessionNetwork.length : 0;
  return count > 0
    ? `${fmt(count)} learned network block${count === 1 ? "" : "s"} active for this browser session.`
    : "No learned network blocks active for this browser session.";
};

const adPersistentNetworkText = (persistentNetwork) => {
  const count = Array.isArray(persistentNetwork) ? persistentNetwork.length : 0;
  return count > 0
    ? `${fmt(count)} persistent learned network block${count === 1 ? "" : "s"} active locally.`
    : "No persistent learned network blocks active for this origin.";
};

const adRecoveryNetworkText = (recoveryNetwork) => {
  const count = Array.isArray(recoveryNetwork) ? recoveryNetwork.length : 0;
  return count > 0
    ? `${fmt(count)} persistent learned network candidate${
        count === 1 ? " was" : "s were"
      } recently demoted after site recovery.`
    : "";
};

const adDetailLines = ({
  ad,
  endpoints,
  origin,
  playbook,
  persistentNetwork,
  prefs,
  recoveryNetwork,
  score,
  sessionNetwork,
  sources,
}) =>
  [
    `Local score: ${fmt(score || 0)}.`,
    `Top reason tokens: ${topAdReasonText(ad && ad.reasons)}`,
    adEndpointEvidenceText(endpoints),
    adSessionNetworkText(sessionNetwork),
    adPersistentNetworkText(persistentNetwork),
    adRecoveryNetworkText(recoveryNetwork),
    adSourceText(sources),
    adCleanupText(origin, playbook, prefs),
  ].filter(Boolean);

const hasAdDetailContent = ({
  ad,
  persistentNetwork = [],
  playbook,
  recoveryNetwork = [],
  sessionNetwork = [],
}) =>
  !!(ad || playbook || sessionNetwork.length || persistentNetwork.length || recoveryNetwork.length);

const buildAdDetail = ({
  ad,
  origin,
  persistentNetwork = [],
  playbook,
  prefs,
  recoveryNetwork = [],
  sessionNetwork = [],
}) => {
  if (!hasAdDetailContent({ ad, persistentNetwork, playbook, recoveryNetwork, sessionNetwork })) {
    return null;
  }
  const box = document.createElement("div");
  box.className = "drift-detail";
  const confidence = adConfidenceForEntry(ad || playbook);
  const title = document.createElement("div");
  title.className = "drift-detail-title";
  title.textContent = `Ad behavior observed: ${adConfidenceLabel(confidence)}`;
  box.appendChild(title);

  const list = document.createElement("ul");
  list.className = "drift-reasons";
  const endpoints = sortedCountEntries(ad && ad.endpoints);
  const sources = sortedCountEntries(ad && ad.sources);
  const score = adScoreValue(ad);
  const lines = adDetailLines({
    ad,
    endpoints,
    origin,
    playbook,
    persistentNetwork,
    prefs,
    recoveryNetwork,
    score,
    sessionNetwork,
    sources,
  });
  for (const line of lines) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
  box.appendChild(list);
  box.appendChild(
    buildAdPlaybookList("Learned cosmetic entries", playbook && playbook.cosmetic, "value")
  );
  box.appendChild(
    buildAdPlaybookList("Learned endpoint entries", playbook && playbook.network, "path")
  );
  box.appendChild(buildAdPlaybookList("Session network blocks", sessionNetwork, "path"));
  box.appendChild(buildAdPlaybookList("Persistent network blocks", persistentNetwork, "path"));
  box.appendChild(buildAdPlaybookList("Recovery network candidates", recoveryNetwork, "path"));
  box.appendChild(
    buildAdPlaybookList("Learned script labels", playbook && playbook.scripts, "value")
  );
  return box;
};

const eventTime = (event) => (event && event.at ? new Date(event.at).toLocaleTimeString() : "—");

const textOr = (value, fallback) => (value ? value : fallback);

const diagnosticProbeText = (event) => {
  const path = event.extensionPath ? ` ${event.extensionPath}` : "";
  return `${eventTime(event)} · probe blocked · ${textOr(event.vector, "unknown")} · ${textOr(
    event.pathKind,
    "unknown"
  )} · ${textOr(event.extensionId, "unknown")}${path}`;
};

const diagnosticReplayText = (event) =>
  `${eventTime(event)} · replay detected · ${textOr(event.signal, "unknown")}`;

const diagnosticAdaptiveText = (event) => {
  const reason = Array.isArray(event.reasons) && event.reasons.length ? event.reasons[0] : "";
  const suffix = reason ? ` · ${reason}` : "";
  return `${eventTime(event)} · adaptive signal · ${textOr(event.category, "unknown")} · score ${textOr(
    event.score,
    0
  )}${suffix}`;
};

const diagnosticFallbackText = (event) =>
  `${eventTime(event)} · ${textOr(event.type, "event")} · ${textOr(event.action, "observed")}`;

const DIAGNOSTIC_TEXT_BUILDERS = {
  adaptive: diagnosticAdaptiveText,
  probe: diagnosticProbeText,
  replay: diagnosticReplayText,
};

const diagnosticEventText = (event) => {
  if (!event) return "Unknown diagnostic event.";
  const builder = DIAGNOSTIC_TEXT_BUILDERS[event.type] || diagnosticFallbackText;
  return builder(event);
};

const buildDiagnosticDetail = (diagnostics) => {
  if (!(diagnostics && Array.isArray(diagnostics.events) && diagnostics.events.length > 0)) {
    return null;
  }
  const box = document.createElement("div");
  box.className = "drift-detail";
  const title = document.createElement("div");
  title.className = "drift-detail-title";
  title.textContent = "QA diagnostics";
  box.appendChild(title);
  const list = document.createElement("ul");
  list.className = "drift-reasons";
  const totals = diagnostics.totals || {};
  const totalLine = Object.entries(totals)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type} ${fmt(count)}`)
    .join(", ");
  const summary = document.createElement("li");
  summary.textContent = totalLine
    ? `Captured locally: ${totalLine}.`
    : `${fmt(diagnostics.events.length)} local diagnostic events captured.`;
  list.appendChild(summary);
  for (const event of diagnostics.events.slice(-20).reverse()) {
    const li = document.createElement("li");
    li.textContent = diagnosticEventText(event);
    list.appendChild(li);
  }
  box.appendChild(list);
  return box;
};

const buildIdList = (entry) => {
  const box = document.createElement("div");
  box.className = "id-list";
  const ids = sortedCountEntries(entry.idCounts);
  for (const [id, count] of ids) {
    const row = document.createElement("div");
    row.className = "id-entry";
    const idSpan = document.createElement("span");
    idSpan.textContent = id;
    const cSpan = document.createElement("span");
    cSpan.className = "c";
    cSpan.textContent = fmt(count);
    row.appendChild(idSpan);
    row.appendChild(cSpan);
    box.appendChild(row);
  }
  return box;
};

const buildOriginDetail = ({ drift, entry, origin, rank, severity }) => {
  const box = document.createElement("div");
  box.className = "id-list";
  box.appendChild(buildSeverityDetail(severity, rank));
  box.appendChild(buildDriftDetail(drift));
  const playbook = LOG_DIAGNOSTICS.buildPlaybookDetail
    ? LOG_DIAGNOSTICS.buildPlaybookDetail(entry, latestPlaybookComparison(entry))
    : null;
  if (playbook) box.appendChild(playbook);
  if (LOG_DIAGNOSTICS.buildNoiseReadinessDetail) {
    box.appendChild(LOG_DIAGNOSTICS.buildNoiseReadinessDetail(entry));
  }
  const adaptive = buildAdaptiveDetail(entry.__adaptive, origin);
  if (adaptive) box.appendChild(adaptive);
  const ad = buildAdDetail({
    ad: entry.__ad,
    origin,
    persistentNetwork: entry.__adDynamicRules,
    playbook: entry.__adPlaybook,
    prefs: entry.__adPrefs,
    recoveryNetwork: entry.__adRecoveryRules,
    sessionNetwork: entry.__adSessionRules,
  });
  if (ad) box.appendChild(ad);
  const diagnostics = buildDiagnosticDetail(entry.__diagnostics);
  if (diagnostics) box.appendChild(diagnostics);
  const ids = buildIdList(entry);
  ids.classList.add("open");
  box.appendChild(ids);
  return box;
};

const diagnosticMatchesFilter = (diagnostics, filter) =>
  (diagnostics.events || []).some((event) =>
    [
      event.type,
      event.action,
      event.vector,
      event.pathKind,
      event.extensionId,
      event.extensionPath,
      event.signal,
      event.category,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(filter))
  );

const adPlaybookFilterValues = (adPlaybook) => [
  ...sortedAdPlaybookEntries(adPlaybook.cosmetic).map((entry) => entry.value || ""),
  ...sortedAdPlaybookEntries(adPlaybook.network).map((entry) => entry.path || ""),
  ...sortedAdPlaybookEntries(adPlaybook.scripts).map((entry) => entry.value || ""),
];

const entryFilterValues = (entry) => {
  const adaptive = entry.__adaptive || {};
  const ad = entry.__ad || {};
  const adPlaybook = entry.__adPlaybook || {};
  const adDynamicRules = entry.__adDynamicRules || [];
  const adSessionRules = entry.__adSessionRules || [];
  return [
    ...Object.keys(adaptive.categories || {}),
    ...Object.keys(adaptive.reasons || {}),
    ...Object.keys(adaptive.endpoints || {}),
    ...Object.keys(ad.reasons || {}),
    ...Object.keys(ad.endpoints || {}),
    ...Object.keys(ad.sources || {}),
    ...adPlaybookFilterValues(adPlaybook),
    ...adDynamicRules.map((rule) => rule.path || ""),
    ...adSessionRules.map((rule) => rule.path || ""),
  ];
};

const originMatches = (origin, entry, filter) => {
  if (!filter) return true;
  const f = filter.toLowerCase();
  if (origin.toLowerCase().includes(f)) return true;
  if (Object.keys(entry.idCounts || {}).some((id) => id.toLowerCase().includes(f))) return true;
  const diagnostics = entry.__diagnostics || {};
  if (diagnosticMatchesFilter(diagnostics, f)) return true;
  return entryFilterValues(entry).some((value) => value.toLowerCase().includes(f));
};

let fullData = null;

const rankedEntryFor = (origin, entry) => {
  const drift = playbookDriftForEntry(entry);
  const severity = severityForEntry(entry, drift);
  return { drift, entry, origin, severity };
};

const compareRankedEntries = (a, b) =>
  b.severity.rank - a.severity.rank ||
  b.severity.score - a.severity.score ||
  totalProbesFor(b.entry) - totalProbesFor(a.entry) ||
  (b.entry.lastUpdated || 0) - (a.entry.lastUpdated || 0) ||
  a.origin.localeCompare(b.origin);

const originNamesForData = (data) =>
  new Set([
    ...Object.keys(data.origins || {}),
    ...Object.keys(data.adaptiveSignals || {}),
    ...(data.adaptiveRules || []).map((rule) => rule.origin).filter(Boolean),
    ...Object.keys(data.adBehavior || {}),
    ...Object.keys(data.adPlaybooks || {}),
    ...Object.keys(data.diagnostics || {}),
    ...(data.adDynamicRecovery || []).map((rule) => rule.origin).filter(Boolean),
    ...(data.adDynamicRules || []).map((rule) => rule.origin).filter(Boolean),
    ...(data.adSessionRules || []).map((rule) => rule.origin).filter(Boolean),
  ]);

const lastUpdatedForEntry = ({ adaptive, ad, adPlaybook, diagnostic, entry }) =>
  entry.lastUpdated ||
  (adaptive && adaptive.lastUpdated) ||
  (ad && ad.lastUpdated) ||
  (adPlaybook && adPlaybook.lastUpdated) ||
  (diagnostic && diagnostic.lastUpdated) ||
  0;

const rankedEntriesForData = (data) => {
  const origins = data.origins || {};
  const adaptiveSignals = data.adaptiveSignals || {};
  const adBehavior = data.adBehavior || {};
  const adDynamicRecovery = data.adDynamicRecovery || [];
  const adDynamicRules = data.adDynamicRules || [];
  const adPlaybooks = data.adPlaybooks || {};
  const diagnostics = data.diagnostics || {};
  const adPrefs = data.adPrefs || {};
  const adSessionRules = data.adSessionRules || [];
  return [...originNamesForData(data)].map((origin) => {
    const entry = origins[origin] || { idCounts: {}, lastUpdated: 0 };
    const adaptive = adaptiveSignals[origin];
    const ad = adBehavior[origin];
    const adPlaybook = adPlaybooks[origin];
    const recoveryRules = adDynamicRecovery.filter((rule) => rule && rule.origin === origin);
    const dynamicRules = adDynamicRules.filter((rule) => rule && rule.origin === origin);
    const diagnostic = diagnostics[origin];
    const sessionRules = adSessionRules.filter((rule) => rule && rule.origin === origin);
    return rankedEntryFor(origin, {
      ...entry,
      lastUpdated: lastUpdatedForEntry({ adaptive, ad, adPlaybook, diagnostic, entry }),
      __adaptive: adaptive,
      __ad: ad,
      __adDynamicRules: dynamicRules,
      __adPlaybook: adPlaybook,
      __adPrefs: adPrefs,
      __adRecoveryRules: recoveryRules,
      __adSessionRules: sessionRules,
      __diagnostics: diagnostic,
    });
  });
};

const renderEmptyState = (content, html) => {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.innerHTML = html;
  content.appendChild(empty);
};

const diagnosticEventCountForLog = (diagnostics) =>
  Object.values(diagnostics || {}).reduce(
    (sum, entry) => sum + ((entry && entry.events && entry.events.length) || 0),
    0
  );

const totalProbeCountForEntries = (entries) => {
  let total = 0;
  for (const { entry } of entries) total += totalProbesFor(entry);
  return total;
};

const renderSummary = ({
  adaptiveCount,
  adCount,
  allEntries,
  cumulative,
  diagnosticEventCount,
  filtered,
}) => {
  const grand = totalProbeCountForEntries(allEntries);
  document.getElementById("summary").textContent = `${fmt(filtered.length)} of ${fmt(
    allEntries.length
  )} origin${allEntries.length === 1 ? "" : "s"} ranked by severity  ·  ${fmt(
    grand
  )} total probes recorded  ·  ${fmt(adaptiveCount)} adaptive origin${
    adaptiveCount === 1 ? "" : "s"
  } observed  ·  ${fmt(adCount)} ad behavior origin${
    adCount === 1 ? "" : "s"
  } observed  ·  ${fmt(diagnosticEventCount)} QA diagnostic event${
    diagnosticEventCount === 1 ? "" : "s"
  }  ·  ${fmt(cumulative || 0)} probes blocked since install`;
};

const createLogTable = () => {
  const table = document.createElement("table");
  table.className = "log-table";
  table.innerHTML =
    "<thead><tr>" +
    "<th class='num'>Rank</th>" +
    "<th>Origin</th>" +
    "<th>Severity</th>" +
    "<th class='num'>Unique IDs</th>" +
    "<th class='num'>Total probes</th>" +
    "<th>Probe behavior</th>" +
    "<th>Ad behavior</th>" +
    "<th>Last seen</th>" +
    "</tr></thead>";
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  return { table, tbody };
};

const appendOptionalPill = (cell, pill) => {
  if (!pill) return;
  cell.appendChild(document.createTextNode(" "));
  cell.appendChild(pill);
};

const appendRankedEntryRow = (tbody, rankedEntry, index) => {
  const { drift, entry, origin, severity } = rankedEntry;
  const rank = index + 1;
  const unique = Object.keys(entry.idCounts || {}).length;
  const total = totalProbesFor(entry);

  const tr = document.createElement("tr");
  tr.className = "origin-row";
  const caret = '<span class="caret">›</span> ';
  tr.innerHTML =
    `<td class='num rank-cell'>${fmt(rank)}</td>` +
    `<td>${caret}${origin.replace(/</g, "&lt;")}</td>` +
    `<td class='severity-cell'></td>` +
    `<td class='num'>${fmt(unique)}</td>` +
    `<td class='num'>${fmt(total)}</td>` +
    `<td class='drift-cell'></td>` +
    `<td class='ad-cell'></td>` +
    `<td>${fmtDate(entry.lastUpdated)}</td>`;
  tr.querySelector(".severity-cell").appendChild(buildSeverityPill(severity));
  const driftCell = tr.querySelector(".drift-cell");
  driftCell.appendChild(buildDriftPill(drift));
  appendOptionalPill(driftCell, buildAdaptivePill(entry.__adaptive));
  appendOptionalPill(driftCell, buildDiagnosticPill(entry.__diagnostics));
  const adCell = tr.querySelector(".ad-cell");
  const adPill = buildAdPill(entry.__ad || entry.__adPlaybook);
  if (adPill) adCell.appendChild(adPill);
  else adCell.textContent = "—";
  tbody.appendChild(tr);

  const detailTr = document.createElement("tr");
  detailTr.className = "detail-row";
  const detailTd = document.createElement("td");
  detailTd.colSpan = 8;
  detailTr.appendChild(detailTd);
  tbody.appendChild(detailTr);

  tr.addEventListener("click", () => {
    if (!detailTd.firstChild) {
      detailTd.appendChild(buildOriginDetail({ drift, entry, origin, rank, severity }));
    }
    const list = detailTd.firstChild;
    const open = list.classList.toggle("open");
    tr.classList.toggle("open", open);
  });
};

const render = (filter) => {
  const content = document.getElementById("content");
  content.innerHTML = "";
  if (!fullData) return;

  const allEntries = rankedEntriesForData(fullData);

  if (allEntries.length === 0) {
    renderEmptyState(
      content,
      '<p class="big">No probes logged yet.</p>' +
        "<p>Visit a site that fingerprints browser extensions " +
        "(LinkedIn, X, major e-commerce) and the log will populate here.</p>"
    );
    document.getElementById("summary").textContent = "";
    return;
  }

  const filtered = allEntries
    .filter(({ entry, origin }) => originMatches(origin, entry, filter))
    .sort(compareRankedEntries);

  renderSummary({
    adaptiveCount: Object.keys(fullData.adaptiveSignals || {}).length,
    adCount: Object.keys(fullData.adBehavior || {}).length,
    allEntries,
    cumulative: fullData.cumulative,
    diagnosticEventCount: diagnosticEventCountForLog(fullData.diagnostics),
    filtered,
  });

  if (filtered.length === 0) {
    renderEmptyState(content, '<p class="big">No matches.</p>');
    return;
  }

  const { table, tbody } = createLogTable();
  filtered.forEach((entry, index) => appendRankedEntryRow(tbody, entry, index));

  content.appendChild(table);
};

const reload = async () => {
  try {
    fullData = await chrome.runtime.sendMessage({ type: "static_export_log" });
  } catch {
    fullData = null;
  }
  render(document.getElementById("search").value);
};

document.getElementById("search").addEventListener("input", (e) => render(e.target.value));

const bucketCount = (n) => {
  if (n < 2) return null; // drop: canary filter
  if (n < 6) return "2-5";
  if (n < 21) return "6-20";
  if (n < 101) return "21-100";
  if (n < 1001) return "101-1000";
  return "1000+";
};

const randomSalt = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const hashLabel = async (salt, value) => {
  const data = new TextEncoder().encode(`${salt}|${value}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

// Anonymize the raw log for public sharing. Removes per-user timing signal
// (timestamps, cumulative counter), coarsens counts into log-scale buckets,
// drops single-occurrence IDs (canaries), drops origins with too few surviving
// IDs, and hashes origin/ID labels with a per-export salt that is not retained.
const buildShareableExport = async (raw) => {
  const salt = randomSalt();
  const out = {
    schema: "static.probe-log.shareable.v1",
    anonymization: "per-export salted SHA-256 labels; salt is not retained",
    exportMonth: new Date().toISOString().slice(0, 7),
    origins: {},
  };
  const originsIn = raw.origins || {};
  for (const origin of Object.keys(originsIn)) {
    const entry = originsIn[origin] || {};
    const ids = entry.idCounts || {};
    const buckets = {};
    for (const [id, count] of Object.entries(ids)) {
      const b = bucketCount(count);
      if (b) buckets[await hashLabel(salt, `id:${id}`)] = b;
    }
    const surviving = Object.keys(buckets).length;
    if (surviving >= 3) {
      out.origins[await hashLabel(salt, `origin:${origin}`)] = { idBuckets: buckets };
    }
  }
  return out;
};

const countEntriesForReport = (counts, limit = 8) =>
  Object.entries(counts || {})
    .filter(([, count]) => typeof count === "number" && count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);

const latestWeekForReport = (entry) => {
  const weeks = entry && entry.playbook && entry.playbook.weeks;
  const keys = Object.keys(weeks || {}).sort();
  if (keys.length === 0) return null;
  const key = keys[keys.length - 1];
  const week = weeks[key] || {};
  return {
    pathKinds: countEntriesForReport(week.pathKindCounts),
    total: week.total || 0,
    vectors: countEntriesForReport(week.vectorCounts),
    week: key,
  };
};

const hashIdBucketsForReport = async (salt, idCounts) => {
  const buckets = {};
  for (const [id, count] of countEntriesForReport(idCounts, 40)) {
    const bucket = bucketCount(count);
    if (bucket) buckets[await hashLabel(salt, `id:${id}`)] = bucket;
  }
  return buckets;
};

const diagnosticTotalsFor = (events) => {
  const totals = {};
  for (const event of events || []) {
    const type = event && event.type ? event.type : "unknown";
    totals[type] = (totals[type] || 0) + 1;
  }
  return totals;
};

const signalKindForReport = (signal) => {
  const kind = String(signal || "unknown")
    .split(":")[0]
    .slice(0, 48);
  return /^[a-z0-9._-]+$/i.test(kind) ? kind : "signal";
};

const signalKindCountsForReport = (signals) => {
  const counts = {};
  for (const [signal, count] of countEntriesForReport(signals, 20)) {
    const kind = signalKindForReport(signal);
    counts[kind] = (counts[kind] || 0) + count;
  }
  return counts;
};

const issueProbeEventForReport = async (salt, event) => ({
  type: "probe",
  action: textOr(event.action, "blocked"),
  extensionIdHash: event.extensionId ? await hashLabel(salt, `id:${event.extensionId}`) : null,
  extensionPath: textOr(event.extensionPath, ""),
  pathKind: textOr(event.pathKind, "unknown"),
  vector: textOr(event.vector, "unknown"),
});

const issueReplayEventForReport = async (salt, event) => ({
  type: "replay",
  action: textOr(event.action, "detected"),
  signalHash: await hashLabel(salt, `signal:${textOr(event.signal, "unknown")}`),
  signalKind: signalKindForReport(event.signal),
});

const issueAdaptiveEventForReport = (event) => ({
  type: "adaptive",
  action: textOr(event.action, "observed"),
  category: textOr(event.category, "unknown"),
  reasons: Array.isArray(event.reasons) ? event.reasons.slice(0, 8) : [],
  score: textOr(event.score, 0),
});

const issueFallbackEventForReport = (event) => ({
  action: textOr(event.action, "observed"),
  type: textOr(event.type, "unknown"),
});

const ISSUE_EVENT_BUILDERS = {
  adaptive: (_salt, event) => issueAdaptiveEventForReport(event),
  probe: issueProbeEventForReport,
  replay: issueReplayEventForReport,
};

const issueEventForReport = async (salt, event) => {
  const builder = ISSUE_EVENT_BUILDERS[event.type];
  return builder ? builder(salt, event) : issueFallbackEventForReport(event);
};

const issueOriginNames = ({
  adaptiveSignals = {},
  diagnostics = {},
  origins = {},
  replayDetections = {},
}) =>
  [
    ...new Set([
      ...Object.keys(origins),
      ...Object.keys(replayDetections),
      ...Object.keys(adaptiveSignals),
      ...Object.keys(diagnostics),
    ]),
  ].sort();

const issueReportSummary = ({ adaptiveSignals, diagnostics, originNames, origins }) => ({
  adaptiveOrigins: Object.keys(adaptiveSignals).length,
  diagnosticEvents: diagnosticEventCountForLog(diagnostics),
  origins: originNames.length,
  totalProbes: Object.values(origins).reduce((sum, entry) => sum + totalProbesFor(entry), 0),
});

const issueOriginReport = async ({
  adaptiveEntry,
  diagnosticEntry,
  events,
  origin,
  probeEntry,
  replayEntry,
  salt,
}) => {
  const originReport = {
    originHash: await hashLabel(salt, `origin:${origin}`),
    probes: {
      idBuckets: await hashIdBucketsForReport(salt, probeEntry.idCounts),
      latestWeek: latestWeekForReport(probeEntry),
      total: totalProbesFor(probeEntry),
      uniqueIds: Object.keys(probeEntry.idCounts || {}).length,
    },
    replay: {
      signalKinds: signalKindCountsForReport(replayEntry.signals),
      total: replayEntry.total || 0,
    },
    adaptive: {
      categories: Object.fromEntries(countEntriesForReport(adaptiveEntry.categories)),
      reasons: Object.fromEntries(countEntriesForReport(adaptiveEntry.reasons)),
      scoreMax: adaptiveEntry.scoreMax || 0,
      total: adaptiveEntry.total || 0,
    },
    diagnostics: {
      events: [],
      totals: diagnosticEntry.totals || diagnosticTotalsFor(events),
    },
  };
  for (const event of events) {
    originReport.diagnostics.events.push(await issueEventForReport(salt, event));
  }
  return originReport;
};

const buildIssueReport = async (raw) => {
  const salt = randomSalt();
  const origins = raw.origins || {};
  const replayDetections = raw.replayDetections || {};
  const adaptiveSignals = raw.adaptiveSignals || {};
  const diagnostics = raw.diagnostics || {};
  const originNames = issueOriginNames({ adaptiveSignals, diagnostics, origins, replayDetections });
  const report = {
    schema: "static.issue-diagnostics.v1",
    anonymization:
      "per-copy salted SHA-256 labels; site origins, extension IDs, and replay signals are hashed; salt is not retained",
    exportMonth: new Date().toISOString().slice(0, 7),
    diagnosticsMode: !!raw.diagnosticsMode,
    summary: issueReportSummary({ adaptiveSignals, diagnostics, originNames, origins }),
    origins: [],
  };

  for (const origin of originNames) {
    const probeEntry = origins[origin] || { idCounts: {} };
    const replayEntry = replayDetections[origin] || {};
    const adaptiveEntry = adaptiveSignals[origin] || {};
    const diagnosticEntry = diagnostics[origin] || {};
    const events = Array.isArray(diagnosticEntry.events) ? diagnosticEntry.events.slice(-25) : [];
    report.origins.push(
      await issueOriginReport({
        adaptiveEntry,
        diagnosticEntry,
        events,
        origin,
        probeEntry,
        replayEntry,
        salt,
      })
    );
  }
  return report;
};

const downloadJson = (obj, filename) => {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
};

const copyText = async (text) => {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
};

document.getElementById("export-raw").addEventListener("click", () => {
  if (!fullData) return;
  downloadJson(fullData, `static-probe-log-${new Date().toISOString().slice(0, 10)}.json`);
});

document.getElementById("export-shareable").addEventListener("click", async () => {
  if (!fullData) return;
  const shareable = await buildShareableExport(fullData);
  const originCount = Object.keys(shareable.origins).length;
  if (originCount === 0) {
    alert(
      "Nothing to export yet — no origins have ≥3 IDs probed ≥2 times. " +
        "Visit a few sites that fingerprint extensions and try again."
    );
    return;
  }
  downloadJson(
    shareable,
    `static-probe-log-shareable-${new Date().toISOString().slice(0, 7)}.json`
  );
});

document.getElementById("copy-issue-report").addEventListener("click", async () => {
  const status = document.getElementById("copy-status");
  if (!fullData) return;
  try {
    const report = await buildIssueReport(fullData);
    await copyText(JSON.stringify(report, null, 2));
    status.textContent = "Copied";
    setTimeout(() => {
      if (status.textContent === "Copied") status.textContent = "";
    }, 1800);
  } catch {
    status.textContent = "Copy failed";
  }
});

document.getElementById("clear").addEventListener("click", async () => {
  const ok = confirm(
    "Clear all probe and diagnostic logs? This also resets the since-install counter and Noise-mode identity."
  );
  if (!ok) return;
  try {
    await chrome.runtime.sendMessage({ type: "static_clear_log" });
    await reload();
  } catch {}
});

reload();
