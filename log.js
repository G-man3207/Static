/* eslint-disable max-lines -- this extension page keeps viewer helpers and export handlers together */
// Probe-log viewer. Loads the full log from the service worker and renders a
// searchable table of origins; each row expands to show per-ID probe counts
// for that origin. Also handles Export / Clear.
const fmt = (n) => n.toLocaleString();
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString() : "—");
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

const severityForEntry = (entry, drift) => {
  const state = { score: 0, reasons: [] };
  addAdaptiveSeveritySignals(state, entry.__adaptive);
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
    description.textContent = `${info.description} Seen ${fmt(count)} time${count === 1 ? "" : "s"}.`;
    item.appendChild(term);
    item.appendChild(description);
    list.appendChild(item);
  }
  guide.appendChild(list);
  return guide;
};

const buildAdaptiveDetail = (adaptive) => {
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

const buildOriginDetail = (entry, drift, severity, rank) => {
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
  const adaptive = buildAdaptiveDetail(entry.__adaptive);
  if (adaptive) box.appendChild(adaptive);
  const ids = buildIdList(entry);
  ids.classList.add("open");
  box.appendChild(ids);
  return box;
};

const originMatches = (origin, entry, filter) => {
  if (!filter) return true;
  const f = filter.toLowerCase();
  if (origin.toLowerCase().includes(f)) return true;
  if (Object.keys(entry.idCounts || {}).some((id) => id.toLowerCase().includes(f))) return true;
  const adaptive = entry.__adaptive || {};
  return [
    ...Object.keys(adaptive.categories || {}),
    ...Object.keys(adaptive.reasons || {}),
    ...Object.keys(adaptive.endpoints || {}),
  ].some((value) => value.toLowerCase().includes(f));
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

const render = (filter) => {
  const content = document.getElementById("content");
  content.innerHTML = "";
  if (!fullData) return;

  const origins = fullData.origins || {};
  const adaptiveSignals = fullData.adaptiveSignals || {};
  const originNames = new Set([...Object.keys(origins), ...Object.keys(adaptiveSignals)]);
  const allEntries = [...originNames].map((origin) => {
    const entry = origins[origin] || { idCounts: {}, lastUpdated: 0 };
    const adaptive = adaptiveSignals[origin];
    return rankedEntryFor(origin, {
      ...entry,
      lastUpdated: entry.lastUpdated || (adaptive && adaptive.lastUpdated) || 0,
      __adaptive: adaptive,
    });
  });

  if (allEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML =
      '<p class="big">No probes logged yet.</p>' +
      "<p>Visit a site that fingerprints browser extensions " +
      "(LinkedIn, X, major e-commerce) and the log will populate here.</p>";
    content.appendChild(empty);
    document.getElementById("summary").textContent = "";
    return;
  }

  const filtered = allEntries
    .filter(({ entry, origin }) => originMatches(origin, entry, filter))
    .sort(compareRankedEntries);

  let grand = 0;
  for (const { entry } of allEntries) grand += totalProbesFor(entry);
  const adaptiveCount = Object.keys(adaptiveSignals).length;

  document.getElementById("summary").textContent = `${fmt(filtered.length)} of ${fmt(
    allEntries.length
  )} origin${allEntries.length === 1 ? "" : "s"} ranked by severity  ·  ${fmt(
    grand
  )} total probes recorded  ·  ${fmt(adaptiveCount)} adaptive origin${
    adaptiveCount === 1 ? "" : "s"
  } observed  ·  ${fmt(fullData.cumulative || 0)} probes blocked since install`;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = '<p class="big">No matches.</p>';
    content.appendChild(empty);
    return;
  }

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
    "<th>Last seen</th>" +
    "</tr></thead>";
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  for (const [index, { drift, entry, origin, severity }] of filtered.entries()) {
    const rank = index + 1;
    const unique = Object.keys(entry.idCounts || {}).length;
    const total = totalProbesFor(entry);
    const adaptivePill = buildAdaptivePill(entry.__adaptive);

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
      `<td>${fmtDate(entry.lastUpdated)}</td>`;
    tr.querySelector(".severity-cell").appendChild(buildSeverityPill(severity));
    tr.querySelector(".drift-cell").appendChild(buildDriftPill(drift));
    if (adaptivePill) {
      tr.querySelector(".drift-cell").appendChild(document.createTextNode(" "));
      tr.querySelector(".drift-cell").appendChild(adaptivePill);
    }
    tbody.appendChild(tr);

    const detailTr = document.createElement("tr");
    detailTr.className = "detail-row";
    const detailTd = document.createElement("td");
    detailTd.colSpan = 7;
    detailTr.appendChild(detailTd);
    tbody.appendChild(detailTr);

    tr.addEventListener("click", () => {
      if (!detailTd.firstChild) {
        detailTd.appendChild(buildOriginDetail(entry, drift, severity, rank));
      }
      const list = detailTd.firstChild;
      const open = list.classList.toggle("open");
      tr.classList.toggle("open", open);
    });
  }

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

document.getElementById("clear").addEventListener("click", async () => {
  const ok = confirm(
    "Clear all probe logs? This also resets the since-install counter and Noise-mode identity."
  );
  if (!ok) return;
  try {
    await chrome.runtime.sendMessage({ type: "static_clear_log" });
    await reload();
  } catch {}
});

reload();
