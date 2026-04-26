/* eslint-disable max-lines -- service-worker routing and storage coordination are kept together */
// Static — background service worker.
//
// Responsibilities:
//   1. Track per-tab / per-frame probe-block state, drive the toolbar badge.
//   2. Accumulate a since-install counter in chrome.storage.local.
//   3. Record per-origin probe logs (which extension IDs each site probes for).
//   4. Generate per-origin decoy personas on demand for Noise mode (stable
//      deterministic subset of observed IDs, rotated on a weekly cadence, seeded
//      from a per-user secret so different users claim different sets).
//   5. Record local session-replay detector sightings for Replay poisoning.
//   6. Record observe-only adaptive behavior signals for local calibration.
//   7. Generate stable per-origin device personas for opt-in signal poisoning.
//   8. Answer popup queries (`static_get_details`, `static_export_log`,
//      `static_set_noise`, `static_set_replay`, `static_set_fingerprint`,
//      `static_set_diagnostics`) and bridge queries (`static_get_persona`).

importScripts("lists.js", "ad_signals.js", "service_worker_utils.js");
const CFG = globalThis.__static_config__ || {};
const AD_SIGNALS = globalThis.__static_ad_signals__ || {};
const {
  enforceCaps,
  ensurePlaybookWeek,
  latestPlaybookSnapshot,
  mergeCounts,
  personaDiagnosticsFor,
  playbookDriftForEntry,
  sumCounts,
  trimCountMap,
} = globalThis.__static_sw_utils__;

// ─── In-memory per-tab state ──────────────────────────────────────────────
const perTabState = new Map(); // tabId -> { origin, frames: Map<frameId, {total, idCounts}> }
const CHROME_EXT_ID_RE = /^[a-p]{32}$/;
const MAX_CAPTURED_IDS = 2000;
const MAX_DIAGNOSTIC_EVENTS_PER_ORIGIN = 120;
const MAX_DIAGNOSTIC_ORIGINS = 25;
const AD_LOG_CAPS = AD_SIGNALS.caps || {
  endpoints: 50,
  origins: 100,
  reasons: 50,
  sources: 50,
};
const AD_PLAYBOOK_CONFIG = AD_SIGNALS.playbooks || {};
const AD_PLAYBOOK_CAPS = AD_PLAYBOOK_CONFIG.caps || {
  cosmetic: 24,
  network: 24,
  origins: AD_LOG_CAPS.origins,
  scripts: 16,
};
const AD_PLAYBOOK_MIN_HITS = AD_PLAYBOOK_CONFIG.minHits || {
  cosmetic: 2,
  network: 2,
  scripts: 2,
};
const AD_PLAYBOOK_VERSION = AD_PLAYBOOK_CONFIG.version || 1;
const AD_PLAYBOOK_STALE_MS = AD_PLAYBOOK_CONFIG.staleMs || 30 * 24 * 60 * 60 * 1000;
const AD_PLAYBOOK_EXPIRE_MS = AD_PLAYBOOK_CONFIG.expireMs || 90 * 24 * 60 * 60 * 1000;
const AD_CLEANUP_MODES = new Set(["off", "diagnostic", "cosmetic"]);
const AD_BROWSER_SESSION_STORAGE_KEY = "ad_browser_session_id";
const AD_SESSION_RULE_ID_MIN = 8000000;
const AD_SESSION_RULE_ID_MAX = 8999999;
const AD_SESSION_RULE_CAP = 64;
const AD_DYNAMIC_RULE_ID_MIN = 9000000;
const AD_DYNAMIC_RULE_ID_MAX = 9099999;
const AD_DYNAMIC_RULE_CAP = 32;
const AD_DYNAMIC_METADATA_CAP = AD_DYNAMIC_RULE_CAP * 2;
const AD_DYNAMIC_PROMOTION_MIN_SESSIONS = 2;
const AD_PLAYBOOK_RESOURCE_TYPES = new Set([
  "image",
  "other",
  "ping",
  "script",
  "sub_frame",
  "xmlhttprequest",
]);
const AD_PLAYBOOK_BROAD_SELECTOR_TOKENS = new Set([
  "ad",
  "ads",
  "advert",
  "advertisement",
  "banner",
  "promoted",
  "sponsor",
  "sponsored",
]);
const AD_PLAYBOOK_ENDPOINT_RE =
  /(?:^|[/:_.-])(?:ad|ads|adserver|auction|beacon|bid|creative|impression|pixel|viewability|viewable)(?:$|[/:_.-])/i;
const AD_PLAYBOOK_UNSAFE_ENDPOINT_RE =
  /(?:^|[/:_.-])(?:account|api|auth|checkout|graphql|login|order|payment|profile|search|settings|signin|signup|user)(?:$|[/:_.-])/i;
const AD_SESSION_COSMETIC_PENDING_MS = 10 * 60 * 1000;
const AD_DYNAMIC_DISABLE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const AD_DYNAMIC_PROMOTION_MIN_HITS = Math.max(4, (AD_PLAYBOOK_MIN_HITS.network || 2) * 2);
const ADAPTIVE_ENDPOINT_DIAGNOSTIC_CAP = 6;
const ADAPTIVE_ENDPOINT_MIN_HITS = 2;
const ADAPTIVE_ENDPOINT_MIN_SCORE = 9;
const ADAPTIVE_ENDPOINT_COLLECTOR_RE =
  /(?:^|[/:_.-])(?:abr|bot|challenge|collect|collector|datadome|fingerprint|fp|fraud|px|sensor|sift|telemetry|trace)(?:$|[/:_.-])/i;
const ADAPTIVE_ENDPOINT_UNSAFE_RE =
  /(?:^|[/:_.-])(?:account|api|auth|cart|checkout|graphql|login|order|payment|profile|search|settings|signin|signup|user)(?:$|[/:_.-])/i;
const ADAPTIVE_ENDPOINT_BROAD_SEGMENTS = new Set([
  "asset",
  "assets",
  "cdn",
  "js",
  "script",
  "scripts",
  "static",
  "tag",
  "tags",
]);

const adSessionState = new Map(); // origin -> same-browser-session cosmetic candidates
const serviceWorkerAdSessionId = (() => {
  try {
    const parts = new Uint32Array(2);
    crypto.getRandomValues(parts);
    return `worker-${Array.from(parts)
      .map((part) => part.toString(36))
      .join("-")}`;
  } catch {
    return `worker-${Date.now().toString(36)}`;
  }
})();

const getOrInitTab = (tabId) => {
  let s = perTabState.get(tabId);
  if (!s) {
    s = { origin: null, frames: new Map() };
    perTabState.set(tabId, s);
  }
  return s;
};

const sumTabTotal = (tabId) => {
  const s = perTabState.get(tabId);
  if (!s) return 0;
  let sum = 0;
  for (const f of s.frames.values()) sum += f.total;
  return sum;
};

const topIdsForTab = (tabId, n) => {
  const s = perTabState.get(tabId);
  if (!s) return [];
  const merged = new Map();
  for (const f of s.frames.values()) {
    for (const [id, c] of f.idCounts) merged.set(id, (merged.get(id) || 0) + c);
  }
  return [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
};

const updateBadge = (tabId, total) => {
  const text = total === 0 ? "" : total > 99 ? "99+" : String(total);
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#c93131" }).catch(() => {});
};

const clearTabStateAndBadges = async () => {
  perTabState.clear();
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) => {
        if (tab.id == null) return null;
        return chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
      })
    );
  } catch {}
};

// ─── Persistent storage (serialized writes) ───────────────────────────────
let writeChain = Promise.resolve();
const serialize = (fn) => {
  writeChain = writeChain.then(fn).catch(() => {});
  return writeChain;
};

const addToCumulative = async (delta) => {
  const { cumulative = 0 } = await chrome.storage.local.get({ cumulative: 0 });
  await chrome.storage.local.set({ cumulative: cumulative + delta });
};

const trimLogOrigins = (log, maxOrigins) => {
  const origins = Object.keys(log);
  if (origins.length <= maxOrigins) return;
  origins.sort((a, b) => (log[b].lastUpdated || 0) - (log[a].lastUpdated || 0));
  for (const oldOrigin of origins.slice(maxOrigins)) delete log[oldOrigin];
};

const sanitizeExtensionIdCounts = (counts) => {
  const sanitized = {};
  for (const [id, count] of Object.entries(counts || {})) {
    const safeId = id.toLowerCase();
    if (CHROME_EXT_ID_RE.test(safeId) && typeof count === "number" && count > 0) {
      sanitized[safeId] = (sanitized[safeId] || 0) + count;
    }
  }
  return trimCountMap(sanitized, MAX_CAPTURED_IDS);
};

const normalizedProbeBatch = (batch) => {
  const deltaVectorCounts = batch && batch.deltaVectorCounts ? batch.deltaVectorCounts : {};
  return {
    deltaIdCounts:
      batch && batch.deltaIdCounts ? sanitizeExtensionIdCounts(batch.deltaIdCounts) : {},
    deltaPathKindCounts: batch && batch.deltaPathKindCounts ? batch.deltaPathKindCounts : {},
    deltaTotal:
      batch && typeof batch.delta === "number" && batch.delta > 0
        ? batch.delta
        : sumCounts(deltaVectorCounts),
    deltaVectorCounts,
  };
};

const mergeProbeWeek = (entry, batch, now) => {
  if (
    batch.deltaTotal <= 0 &&
    sumCounts(batch.deltaVectorCounts) === 0 &&
    sumCounts(batch.deltaPathKindCounts) === 0
  ) {
    return false;
  }
  const week = ensurePlaybookWeek(entry, now);
  week.total += batch.deltaTotal;
  const vectorChanged = mergeCounts(week.vectorCounts, batch.deltaVectorCounts);
  const pathChanged = mergeCounts(week.pathKindCounts, batch.deltaPathKindCounts);
  const idChanged = mergeCounts(week.idCounts, batch.deltaIdCounts);
  return batch.deltaTotal > 0 || vectorChanged || pathChanged || idChanged;
};

const recordProbes = async (origin, batch) => {
  const { probe_log = {} } = await chrome.storage.local.get({ probe_log: {} });
  const entry = probe_log[origin] || { idCounts: {}, lastUpdated: 0 };
  entry.idCounts ||= {};
  const now = Date.now();
  const normalized = normalizedProbeBatch(batch);
  const countChanged = mergeCounts(entry.idCounts, normalized.deltaIdCounts);
  const weekChanged = mergeProbeWeek(entry, normalized, now);
  const changed = countChanged || weekChanged;
  if (!changed) return;
  entry.lastUpdated = now;
  probe_log[origin] = entry;
  enforceCaps(probe_log);
  await chrome.storage.local.set({ probe_log });
};

const recordReplayDetection = async (origin, signal) => {
  if (!origin) return;
  const { replay_log = {} } = await chrome.storage.local.get({ replay_log: {} });
  const entry = replay_log[origin] || { signals: {}, total: 0, lastUpdated: 0 };
  const safeSignal = signal || "unknown";
  entry.signals[safeSignal] = (entry.signals[safeSignal] || 0) + 1;
  entry.total = (entry.total || 0) + 1;
  entry.lastUpdated = Date.now();
  const signals = Object.entries(entry.signals);
  if (signals.length > 50) {
    signals.sort((a, b) => b[1] - a[1]);
    entry.signals = Object.fromEntries(signals.slice(0, 50));
  }
  replay_log[origin] = entry;
  trimLogOrigins(replay_log, 100);
  await chrome.storage.local.set({ replay_log });
};

const normalizeAdaptiveSignal = (signal) => ({
  category: String(signal.category || "unknown").slice(0, 48),
  endpoint: String(signal.endpoint || "").slice(0, 160),
  reasons: Array.isArray(signal.reasons)
    ? signal.reasons.map((reason) => String(reason).slice(0, 64)).slice(0, 12)
    : [],
  score: Math.max(0, Math.min(100, Math.round(signal.score || 0))),
  source: String(signal.source || "unknown").slice(0, 160),
});

const bumpCount = (counts, key) => {
  if (key) counts[key] = (counts[key] || 0) + 1;
};

const normalizeAdSignal = (signal) => ({
  confidence: String(signal.confidence || "learning").slice(0, 16),
  cosmetic: Array.isArray(signal.cosmetic)
    ? signal.cosmetic.map(normalizeAdCosmeticCandidate).filter(Boolean).slice(0, 4)
    : [],
  endpoint: String(signal.endpoint || "").slice(0, 160),
  pageId: String(signal.pageId || "").slice(0, 64),
  reasons: Array.isArray(signal.reasons)
    ? signal.reasons.map((reason) => String(reason).slice(0, 64)).slice(0, 12)
    : [],
  resourceType: normalizeAdResourceType(signal.resourceType),
  score: Math.max(0, Math.min(100, Math.round(signal.score || 0))),
  source: String(signal.source || "unknown").slice(0, 160),
});

const safePlaybookText = (value, maxLength = 160) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

const normalizeAdResourceType = (resourceType) => {
  const safeType = String(resourceType || "").slice(0, 32);
  return AD_PLAYBOOK_RESOURCE_TYPES.has(safeType) ? safeType : "";
};

const selectorTokenFor = (selector) => {
  const value = String(selector || "");
  const idMatch = value.match(/^#([^#.[\]\s>+~,]+)/);
  if (idMatch) return idMatch[1].replace(/\\/g, "");
  const classMatch = value.match(/^[a-z0-9_-]+\.([^#.[\]\s>+~,]+)/i);
  return classMatch ? classMatch[1].replace(/\\/g, "") : "";
};

const selectorTokenIsUnstable = (token) => {
  const value = String(token || "");
  if (/^[0-9a-f]{12,}$/i.test(value)) return true;
  if (/\d{5,}/.test(value)) return true;
  return value.length >= 24 && /[a-z]/i.test(value) && /\d/.test(value);
};

const selectorDiagnosticReasonFor = (selector) => {
  const value = String(selector || "");
  if (!value || /[,>+~]|\s/.test(value)) return "complex-selector";
  const token = selectorTokenFor(value).toLowerCase();
  if (!token) return "unsupported-selector";
  if (AD_PLAYBOOK_BROAD_SELECTOR_TOKENS.has(token)) return "broad-selector";
  if (selectorTokenIsUnstable(token)) return "unstable-selector";
  return "";
};

const structureDiagnosticReasonFor = (value) => {
  const safeValue = String(value || "");
  return safeValue.startsWith("iframe:") ? "" : "weak-structure";
};

const cosmeticDiagnosticReasonFor = (kind, value, incomingReason) => {
  if (kind === "selector") return selectorDiagnosticReasonFor(value) || incomingReason;
  if (kind === "structure") return structureDiagnosticReasonFor(value) || incomingReason;
  return "unsupported-candidate";
};

const normalizeAdCosmeticCandidate = (candidate) => {
  const kind = String((candidate && candidate.kind) || "").slice(0, 32);
  if (kind !== "selector" && kind !== "structure") return null;
  const value = safePlaybookText(candidate && candidate.value);
  if (!value) return null;
  const incomingReason = safePlaybookText(candidate.reason, 64);
  const reason = cosmeticDiagnosticReasonFor(kind, value, incomingReason);
  return {
    diagnosticOnly: !!(candidate.diagnosticOnly || reason),
    kind,
    reason,
    value,
  };
};

const adClassificationFor = (reasons) => {
  if (typeof AD_SIGNALS.classifyReasons === "function") {
    return AD_SIGNALS.classifyReasons(reasons);
  }
  const score = Math.min(100, Object.keys(reasons || {}).length * 2);
  return {
    confidence: score > 0 ? "low" : "learning",
    score,
    scoreReasons: [],
  };
};

const adUiConfidence = (confidence) =>
  confidence === "high" || confidence === "likely" ? confidence : "learning";

const normalizeOrigin = (origin) => {
  try {
    const parsed = new URL(origin);
    if (parsed.origin === "null") return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

const randomAdBrowserSessionId = () => {
  try {
    const parts = new Uint32Array(3);
    crypto.getRandomValues(parts);
    return `session-${Array.from(parts)
      .map((part) => part.toString(36))
      .join("-")}`;
  } catch {
    return `session-${Date.now().toString(36)}`;
  }
};

const adBrowserSessionStorage = () =>
  chrome.storage && chrome.storage.session ? chrome.storage.session : null;

const currentAdBrowserSessionId = async () => {
  const storage = adBrowserSessionStorage();
  if (!storage) return serviceWorkerAdSessionId;
  try {
    const stored = await storage.get({ [AD_BROWSER_SESSION_STORAGE_KEY]: "" });
    const existing = stored[AD_BROWSER_SESSION_STORAGE_KEY];
    if (typeof existing === "string" && existing) return existing.slice(0, 80);
    const next = randomAdBrowserSessionId();
    await storage.set({ [AD_BROWSER_SESSION_STORAGE_KEY]: next });
    return next;
  } catch {
    return serviceWorkerAdSessionId;
  }
};

const countEntries = (counts, limit = 8) =>
  Object.entries(counts || {})
    .filter(([, count]) => typeof count === "number" && count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);

const adReasonScore = (reason) => {
  const weights = AD_SIGNALS.weights || {};
  const score = weights[reason];
  return typeof score === "number" && score > 0 ? score : 0;
};

const adReasonSummaries = (reasons, limit = 8) =>
  countEntries(reasons, limit).map(([token, count]) => ({
    count,
    score: adReasonScore(token),
    token,
  }));

const sanitizePlaybookResourceTypes = (entry) => {
  if (!Array.isArray(entry.resourceTypes)) return [];
  return entry.resourceTypes.map((type) => String(type).slice(0, 32)).slice(0, 6);
};

const safeAdEntryCount = (value) => Math.max(0, Math.round(value || 0));

const safeAdEntryText = (value, fallback = "", maxLength = 160) =>
  String(value || fallback).slice(0, maxLength);

const sanitizeAdPlaybookEntry = (entry) => {
  const safeEntry = entry || {};
  return {
    breakageCount: safeAdEntryCount(safeEntry.breakageCount),
    demotedUntil: safeEntry.demotedUntil || 0,
    diagnosticOnly: !!safeEntry.diagnosticOnly,
    firstSeen: safeEntry.firstSeen || 0,
    hits: safeAdEntryCount(safeEntry.hits),
    kind: safeAdEntryText(safeEntry.kind, "entry", 32),
    lastBreakageAt: safeEntry.lastBreakageAt || 0,
    lastSeen: safeEntry.lastSeen || 0,
    origin: safeAdEntryText(safeEntry.origin),
    path: safeAdEntryText(safeEntry.path),
    promotedAt: safeEntry.promotedAt || 0,
    reason: safeAdEntryText(safeEntry.reason, "", 64),
    resourceTypes: sanitizePlaybookResourceTypes(safeEntry),
    ruleId: Number.isInteger(safeEntry.ruleId) ? safeEntry.ruleId : 0,
    score: Math.min(100, safeAdEntryCount(safeEntry.score)),
    sessionCount: safeAdEntryCount(safeEntry.sessionCount),
    status: safeAdEntryText(safeEntry.status, "", 32),
    value: safeAdEntryText(safeEntry.value),
  };
};

const sortedPlaybookEntries = (entries, limit = 6) =>
  (Array.isArray(entries) ? entries : [])
    .map(sanitizeAdPlaybookEntry)
    .sort((a, b) => b.score - a.score || b.hits - a.hits)
    .slice(0, limit);

const adSitePrefsFor = (origin, adPrefs = {}) => {
  const sites = adPrefs.sites || adPrefs.site || {};
  const site = (origin && sites[origin]) || {};
  return {
    cleanupDisabled: !!(site.cleanupDisabled || site.disabled),
    lastDisabledAt: site.lastDisabledAt || site.disabledAt || 0,
    lastUpdated: site.lastUpdated || 0,
    networkDemotedUntil: site.networkDemotedUntil || 0,
  };
};

const adCleanupModeFor = (adPrefs = {}) =>
  AD_CLEANUP_MODES.has(adPrefs.mode) ? adPrefs.mode : "off";

const adPlaybookFor = (origin, adPlaybooks = {}) => {
  const playbook = origin ? adPlaybooks[origin] : null;
  if (!playbook) {
    return {
      cosmeticSafe: false,
      confidence: "learning",
      cosmetic: [],
      disabled: false,
      lastUpdated: 0,
      network: [],
      scripts: [],
      version: AD_PLAYBOOK_VERSION,
    };
  }
  return {
    cosmeticSafe: !!playbook.cosmeticSafe,
    confidence: adUiConfidence(playbook.confidence),
    cosmetic: sortedPlaybookEntries(playbook.cosmetic),
    disabled: !!playbook.disabled,
    lastUpdated: playbook.lastUpdated || 0,
    network: sortedPlaybookEntries(playbook.network),
    scripts: sortedPlaybookEntries(playbook.scripts),
    version: playbook.version || AD_PLAYBOOK_VERSION,
  };
};

const adScoreReasonsFor = (entry, classification) => {
  if (!entry) return [];
  if (Array.isArray(entry.scoreReasons)) return entry.scoreReasons.slice(0, 16);
  return Array.from(classification.scoreReasons || []).slice(0, 16);
};

const adEntryDiagnosticsFor = (entry, classification) => {
  if (!entry) {
    return {
      confidence: "learning",
      endpoints: [],
      firstSeen: 0,
      observed: false,
      reasons: [],
      score: 0,
      scoreReasons: [],
      sources: [],
      total: 0,
      updatedAt: 0,
    };
  }
  return {
    confidence: adUiConfidence(entry.confidence || classification.confidence),
    endpoints: countEntries(entry.endpoints, 6),
    firstSeen: entry.firstSeen || 0,
    observed: true,
    reasons: adReasonSummaries(entry.reasons, 8),
    score: entry.score || classification.score || 0,
    scoreReasons: adScoreReasonsFor(entry, classification),
    sources: countEntries(entry.sources, 4),
    total: entry.total || 0,
    updatedAt: entry.lastUpdated || 0,
  };
};

const playbookScoreFor = ({ baseScore, diagnosticOnly, hits, minHits }) => {
  const repeatBonus = Math.max(0, hits - minHits + 1) * 5;
  const score = Math.min(100, Math.max(0, baseScore + Math.min(20, repeatBonus)));
  if (!diagnosticOnly) return Math.round(score);
  const likelyThreshold = (AD_SIGNALS.thresholds && AD_SIGNALS.thresholds.likely) || 50;
  return Math.min(Math.round(score), likelyThreshold - 1);
};

const entryListFor = (playbook, key) => {
  if (!Array.isArray(playbook[key])) playbook[key] = [];
  return playbook[key];
};

const findPlaybookEntry = (entries, key, value, kind) =>
  entries.find((entry) => entry && entry[key] === value && entry.kind === kind);

const mergeResourceType = (entry, resourceType) => {
  if (!resourceType) return;
  const types = new Set(Array.isArray(entry.resourceTypes) ? entry.resourceTypes : []);
  types.add(resourceType);
  entry.resourceTypes = Array.from(types).sort().slice(0, 6);
};

const upsertPlaybookEntry = ({ baseScore, candidate, entries, minHits, now, valueKey }) => {
  const kind = candidate.kind || "candidate";
  const value = candidate[valueKey];
  let entry = findPlaybookEntry(entries, valueKey, value, kind);
  if (!entry) {
    entry = {
      firstSeen: now,
      hits: 0,
      kind,
      lastSeen: 0,
      score: 0,
      [valueKey]: value,
    };
    entries.push(entry);
  }
  const hits = Math.max(0, Math.round(entry.hits || 0)) + 1;
  const needsMoreEvidence = hits < minHits;
  const diagnosticOnly = !!(candidate.diagnosticOnly || needsMoreEvidence);
  const wasActive = playbookEntryIsActive(entry, minHits);
  if (wasActive && diagnosticOnly && candidate.reason === "low-confidence") {
    entry.firstSeen ||= now;
    entry.hits = hits;
    entry.lastSeen = now;
    entry.score = Math.max(entry.score || 0, baseScore);
    mergeResourceType(entry, candidate.resourceType);
    return;
  }
  entry.diagnosticOnly = diagnosticOnly;
  entry.firstSeen ||= now;
  entry.hits = hits;
  entry.lastSeen = now;
  entry.reason = candidate.reason || (needsMoreEvidence ? "needs-repeat-observation" : "");
  entry.score = playbookScoreFor({ baseScore, diagnosticOnly, hits, minHits });
  entry.status = diagnosticOnly && entry.reason ? "diagnostic" : "";
  mergeResourceType(entry, candidate.resourceType);
};

const decayPlaybookEntries = ({ entries, now, valueKey }) =>
  (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const sanitized = sanitizeAdPlaybookEntry(entry);
      const value = safePlaybookText(sanitized[valueKey]);
      if (!value) return null;
      const lastSeen = sanitized.lastSeen || sanitized.firstSeen || entry.lastUpdated || 0;
      if (lastSeen && now - lastSeen > AD_PLAYBOOK_EXPIRE_MS) return null;
      sanitized[valueKey] = value;
      if (lastSeen && now - lastSeen > AD_PLAYBOOK_STALE_MS) {
        sanitized.diagnosticOnly = true;
        sanitized.hits = Math.max(1, Math.floor((sanitized.hits || 1) / 2));
        sanitized.reason = "stale";
        sanitized.score = Math.min(sanitized.score, 49);
        sanitized.status = "stale";
      }
      return sanitized;
    })
    .filter(Boolean);

const trimPlaybookEntries = ({ entries, limit }) => {
  entries.sort(
    (a, b) =>
      Number(!!a.diagnosticOnly) - Number(!!b.diagnosticOnly) ||
      (b.score || 0) - (a.score || 0) ||
      (b.hits || 0) - (a.hits || 0) ||
      String(a.value || a.path || "").localeCompare(String(b.value || b.path || ""))
  );
  if (entries.length > limit) entries.splice(limit);
};

const playbookEntryIsActive = (entry, minHits) =>
  !!entry && !entry.diagnosticOnly && (entry.hits || 0) >= minHits && (entry.score || 0) >= 50;

const recomputeAdPlaybookState = (playbook) => {
  const activeCosmetic = (playbook.cosmetic || []).filter((entry) =>
    playbookEntryIsActive(entry, AD_PLAYBOOK_MIN_HITS.cosmetic)
  );
  const activeNetwork = (playbook.network || []).filter((entry) =>
    playbookEntryIsActive(entry, AD_PLAYBOOK_MIN_HITS.network)
  );
  const activeScripts = (playbook.scripts || []).filter((entry) =>
    playbookEntryIsActive(entry, AD_PLAYBOOK_MIN_HITS.scripts)
  );
  const activeEntries = [...activeCosmetic, ...activeNetwork, ...activeScripts];
  const highThreshold = (AD_SIGNALS.thresholds && AD_SIGNALS.thresholds.high) || 80;
  const maxScore = activeEntries.reduce((max, entry) => Math.max(max, entry.score || 0), 0);
  playbook.cosmeticSafe = activeCosmetic.some((entry) => entry.score >= highThreshold);
  if (activeCosmetic.length > 0 && activeNetwork.length > 0 && maxScore >= highThreshold) {
    playbook.confidence = "high";
  } else if (activeEntries.length > 0) {
    playbook.confidence = "likely";
  } else {
    playbook.confidence = "learning";
  }
};

const trimAdSessionOrigins = () => {
  if (adSessionState.size <= (AD_PLAYBOOK_CAPS.origins || AD_LOG_CAPS.origins)) return;
  const entries = Array.from(adSessionState.entries()).sort(
    (a, b) => (b[1].lastUpdated || 0) - (a[1].lastUpdated || 0)
  );
  for (const [origin] of entries.slice(AD_PLAYBOOK_CAPS.origins || AD_LOG_CAPS.origins)) {
    adSessionState.delete(origin);
  }
};

const adSessionStateFor = (origin) => {
  let state = adSessionState.get(origin);
  if (!state) {
    state = {
      cosmetic: [],
      lastUpdated: 0,
      pendingCosmetic: new Map(),
    };
    adSessionState.set(origin, state);
  }
  return state;
};

const clearAdSessionStateForOrigin = (origin) => adSessionState.delete(origin);

const clearAllAdSessionState = () => {
  adSessionState.clear();
};

const adSessionCosmeticKeyFor = (entry) => `${entry.kind}\n${entry.value}`;

const adSessionPendingKeyFor = (pageId, entry) =>
  `${pageId || "origin"}\n${entry.kind}\n${entry.value}`;

const cleanPendingAdSessionCosmetic = (state, now) => {
  for (const [key, candidate] of state.pendingCosmetic.entries()) {
    if ((candidate.lastSeen || 0) && now - candidate.lastSeen > AD_SESSION_COSMETIC_PENDING_MS) {
      state.pendingCosmetic.delete(key);
    }
  }
};

const rememberAdSessionCosmeticCandidates = ({ normalized, now, origin }) => {
  if (!normalized.cosmetic.length) return;
  const state = adSessionStateFor(origin);
  cleanPendingAdSessionCosmetic(state, now);
  const pageId = normalized.pageId || "origin";
  for (const candidate of normalized.cosmetic) {
    if (candidate.diagnosticOnly) continue;
    const key = adSessionPendingKeyFor(pageId, candidate);
    const pending = state.pendingCosmetic.get(key) || {
      diagnosticOnly: false,
      firstSeen: now,
      hits: 0,
      kind: candidate.kind,
      pageId,
      reason: "",
      value: candidate.value,
    };
    pending.hits = Math.max(0, pending.hits || 0) + 1;
    pending.lastSeen = now;
    pending.reason = candidate.reason || "";
    state.pendingCosmetic.set(key, pending);
  }
  state.lastUpdated = now;
  trimAdSessionOrigins();
};

const adSignalIsCurrentPageHigh = (normalized) => {
  const highThreshold = (AD_SIGNALS.thresholds && AD_SIGNALS.thresholds.high) || 80;
  return normalized.confidence === "high" && (normalized.score || 0) >= highThreshold;
};

const sessionCosmeticCandidateIsSafe = (candidate) =>
  !!candidate &&
  !candidate.diagnosticOnly &&
  (candidate.kind === "selector" || candidate.kind === "structure") &&
  !!candidate.value;

const upsertAdSessionCosmeticEntry = ({ candidate, now, score, state }) => {
  const existing = findPlaybookEntry(state.cosmetic, "value", candidate.value, candidate.kind);
  const entry = existing || {
    firstSeen: candidate.firstSeen || now,
    hits: 0,
    kind: candidate.kind,
    lastSeen: 0,
    value: candidate.value,
  };
  const nextHits = Math.max(entry.hits || 0, candidate.hits || 0, AD_PLAYBOOK_MIN_HITS.cosmetic);
  const nextScore = Math.max(entry.score || 0, score || 0);
  const changed =
    !existing ||
    entry.diagnosticOnly ||
    entry.hits !== nextHits ||
    entry.score !== nextScore ||
    entry.lastSeen !== now;
  entry.diagnosticOnly = false;
  entry.hits = nextHits;
  entry.lastSeen = now;
  entry.reason = "";
  entry.score = nextScore;
  entry.status = "session";
  if (!existing) state.cosmetic.push(entry);
  return changed;
};

const promoteAdSessionCosmeticEntries = ({ normalized, now, origin }) => {
  if (!adSignalIsCurrentPageHigh(normalized)) return false;
  const state = adSessionStateFor(origin);
  cleanPendingAdSessionCosmetic(state, now);
  const score = Math.max(
    normalized.score || 0,
    (AD_SIGNALS.thresholds && AD_SIGNALS.thresholds.high) || 80
  );
  let changed = false;
  const pageId = normalized.pageId || "origin";
  for (const candidate of state.pendingCosmetic.values()) {
    if (candidate.pageId !== pageId) continue;
    if (!sessionCosmeticCandidateIsSafe(candidate)) continue;
    changed = upsertAdSessionCosmeticEntry({ candidate, now, score, state }) || changed;
  }
  trimPlaybookEntries({ entries: state.cosmetic, limit: AD_PLAYBOOK_CAPS.cosmetic });
  state.lastUpdated = now;
  trimAdSessionOrigins();
  return changed;
};

const activeAdCosmeticEntryForConfig = (entry) =>
  !!entry &&
  !entry.diagnosticOnly &&
  (entry.kind === "selector" || entry.kind === "structure") &&
  (entry.hits || 0) >= AD_PLAYBOOK_MIN_HITS.cosmetic &&
  (entry.score || 0) >= ((AD_SIGNALS.thresholds && AD_SIGNALS.thresholds.high) || 80);

const adSessionCosmeticEntriesFor = (origin) => {
  const state = origin ? adSessionState.get(origin) : null;
  if (!state) return [];
  return sortedPlaybookEntries(state.cosmetic, AD_PLAYBOOK_CAPS.cosmetic);
};

const mergeAdCosmeticConfigEntries = (...entryLists) => {
  const byKey = new Map();
  for (const entries of entryLists) {
    for (const rawEntry of Array.isArray(entries) ? entries : []) {
      const entry = sanitizeAdPlaybookEntry(rawEntry);
      const key = adSessionCosmeticKeyFor(entry);
      const existing = byKey.get(key);
      if (
        !existing ||
        entry.score > existing.score ||
        (entry.score === existing.score && entry.hits > existing.hits)
      ) {
        byKey.set(key, entry);
      }
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.score - a.score || b.hits - a.hits || a.value.localeCompare(b.value))
    .slice(0, AD_PLAYBOOK_CAPS.cosmetic);
};

const adHighScoreThreshold = () => (AD_SIGNALS.thresholds && AD_SIGNALS.thresholds.high) || 80;

const adSessionRuleIdIsManaged = (id) =>
  Number.isInteger(id) && id >= AD_SESSION_RULE_ID_MIN && id <= AD_SESSION_RULE_ID_MAX;

const adSessionRuleIsManaged = (rule) => !!rule && adSessionRuleIdIsManaged(rule.id);

const dnrDomainForOrigin = (origin) => {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return "";
  }
};

const safeDnrResourceTypesFor = (entry) =>
  Array.from(
    new Set(
      (Array.isArray(entry && entry.resourceTypes) ? entry.resourceTypes : [])
        .map((type) => normalizeAdResourceType(type))
        .filter(Boolean)
    )
  ).sort();

const sameOriginEndpointPath = (endpoint) => {
  const path = safePlaybookText(endpoint);
  return path.startsWith("same-origin:/") ? path.slice("same-origin:".length) : "";
};

const redactedPathHasPlaceholder = (segment) => String(segment || "").startsWith(":");

const dnrPathFilterForEndpoint = (path) => {
  if (!path || !path.startsWith("/") || path === "/" || /[\s|^*]/.test(path)) return null;
  const segments = path.split("/").slice(1).filter(Boolean);
  if (segments.length === 0) return null;
  const placeholderIndex = segments.findIndex(redactedPathHasPlaceholder);
  const staticSegments = placeholderIndex >= 0 ? segments.slice(0, placeholderIndex) : segments;
  if (staticSegments.length === 0) return null;
  if (placeholderIndex >= 0 && staticSegments.length < 2) return null;
  if (staticSegments.some((segment) => redactedPathHasPlaceholder(segment))) return null;
  return {
    exact: placeholderIndex < 0,
    path: `/${staticSegments.join("/")}${placeholderIndex >= 0 ? "/" : ""}`,
  };
};

const adSessionUrlFilterFor = (origin, pathSpec) =>
  `|${origin}${pathSpec.path}${pathSpec.exact ? "^" : ""}`;

const adSessionRuleKeyForCondition = (condition = {}) =>
  [
    condition.urlFilter || "",
    (condition.initiatorDomains || []).slice().sort().join(","),
    (condition.requestDomains || []).slice().sort().join(","),
    (condition.resourceTypes || []).slice().sort().join(","),
  ].join("\n");

const adSessionRuleKeyForRule = (rule) => adSessionRuleKeyForCondition(rule && rule.condition);

const adSessionRuleKeyForCandidate = (rule) => adSessionRuleKeyForCondition(rule.condition);

const adaptiveEndpointPathSegments = (path) =>
  String(path || "")
    .split("/")
    .filter(Boolean);

const adaptiveEndpointIsBroadCommonPath = (pathSpec) => {
  const segments = adaptiveEndpointPathSegments(pathSpec && pathSpec.path);
  return (
    pathSpec &&
    pathSpec.exact &&
    segments.length <= 1 &&
    ADAPTIVE_ENDPOINT_BROAD_SEGMENTS.has((segments[0] || "").toLowerCase())
  );
};

const adaptiveEndpointDiagnosticFor = ({ count, endpoint, scoreMax }) => {
  const safeEndpoint = String(endpoint || "").slice(0, 160);
  const base = {
    count: Math.max(0, Math.round(count || 0)),
    endpoint: safeEndpoint,
    path: "",
    reason: "",
    status: "rejected",
  };
  let parsed;
  try {
    parsed = new URL(safeEndpoint);
  } catch {
    return {
      ...base,
      reason: "unparseable endpoint label",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ...base,
      reason: "unsupported protocol for adaptive DNR calibration",
    };
  }

  if (ADAPTIVE_ENDPOINT_UNSAFE_RE.test(parsed.pathname)) {
    return {
      ...base,
      reason: "unsafe path token; diagnostics-only",
    };
  }

  const pathSpec = dnrPathFilterForEndpoint(parsed.pathname);
  if (!pathSpec || adaptiveEndpointIsBroadCommonPath(pathSpec)) {
    return {
      ...base,
      reason: "path is too broad for a narrow adaptive rule",
    };
  }

  const path = `${pathSpec.path}${pathSpec.exact ? "" : "*"}`;
  if (!ADAPTIVE_ENDPOINT_COLLECTOR_RE.test(parsed.pathname)) {
    return {
      ...base,
      path,
      reason: "no collector-like path token",
    };
  }

  if (scoreMax < ADAPTIVE_ENDPOINT_MIN_SCORE) {
    return {
      ...base,
      path,
      reason: "needs a stronger local adaptive score",
      status: "learning",
    };
  }

  if (base.count < ADAPTIVE_ENDPOINT_MIN_HITS) {
    return {
      ...base,
      path,
      reason: "needs repeated endpoint evidence",
      status: "learning",
    };
  }

  return {
    ...base,
    path,
    reason: "narrow redacted collector path; observe-only until adaptive recovery controls exist",
    status: "candidate",
  };
};

const adaptiveEndpointDiagnosticsForEntry = (entry) =>
  countEntries(entry && entry.endpoints, ADAPTIVE_ENDPOINT_DIAGNOSTIC_CAP).map(
    ([endpoint, count]) =>
      adaptiveEndpointDiagnosticFor({
        count,
        endpoint,
        scoreMax: entry && entry.scoreMax ? entry.scoreMax : 0,
      })
  );

const adNetworkEntryIsSessionEligible = (entry) =>
  !!entry &&
  entry.kind === "endpoint" &&
  !entry.diagnosticOnly &&
  (entry.hits || 0) >= AD_PLAYBOOK_MIN_HITS.network &&
  (entry.score || 0) >= adHighScoreThreshold();

const adSessionRuleCandidateForEntry = (origin, entry) => {
  if (!adNetworkEntryIsSessionEligible(entry)) return null;
  const host = dnrDomainForOrigin(origin);
  const endpointPath = sameOriginEndpointPath(entry.path);
  const resourceTypes = safeDnrResourceTypesFor(entry);
  if (!host || resourceTypes.length === 0 || !endpointPath) return null;
  if (AD_PLAYBOOK_UNSAFE_ENDPOINT_RE.test(endpointPath)) return null;
  if (!AD_PLAYBOOK_ENDPOINT_RE.test(endpointPath)) return null;
  const pathSpec = dnrPathFilterForEndpoint(endpointPath);
  if (!pathSpec) return null;
  const rule = {
    action: { type: "block" },
    condition: {
      initiatorDomains: [host],
      requestDomains: [host],
      resourceTypes,
      urlFilter: adSessionUrlFilterFor(origin, pathSpec),
    },
    priority: 1,
  };
  return {
    key: adSessionRuleKeyForCandidate(rule),
    rule,
  };
};

const adNetworkRuleCandidateRecordsForPlaybook = (origin, playbook) =>
  (Array.isArray(playbook && playbook.network) ? playbook.network : [])
    .map((entry) => sanitizeAdPlaybookEntry(entry))
    .map((entry) => {
      const candidate = adSessionRuleCandidateForEntry(origin, entry);
      return candidate ? { ...candidate, entry } : null;
    })
    .filter(Boolean)
    .slice(0, AD_PLAYBOOK_CAPS.network);

const adSessionRuleCandidatesForPlaybook = (origin, playbook) =>
  adNetworkRuleCandidateRecordsForPlaybook(origin, playbook).map(({ key, rule }) => ({
    key,
    rule,
  }));

const nextAdSessionRuleId = ({ addRules, removeRuleIds, sessionRules }) => {
  const used = new Set(
    sessionRules.filter((rule) => !removeRuleIds.has(rule.id)).map((rule) => rule.id)
  );
  for (const rule of addRules) used.add(rule.id);
  const maxUsed = Math.max(AD_SESSION_RULE_ID_MIN - 1, ...used);
  const start = Math.min(Math.max(maxUsed + 1, AD_SESSION_RULE_ID_MIN), AD_SESSION_RULE_ID_MAX);
  for (let id = start; id <= AD_SESSION_RULE_ID_MAX; id++) {
    if (!used.has(id)) return id;
  }
  for (let id = AD_SESSION_RULE_ID_MIN; id < start; id++) {
    if (!used.has(id)) return id;
  }
  return null;
};

const evictAdSessionRules = ({ addRules, candidates, removeRuleIds, sessionRules }) => {
  const candidateKeys = new Set(candidates.map((candidate) => candidate.key));
  let overLimit = sessionRules.length - removeRuleIds.size + addRules.length - AD_SESSION_RULE_CAP;
  if (overLimit <= 0) return;
  const sortedRules = sessionRules
    .filter((rule) => !removeRuleIds.has(rule.id))
    .sort((a, b) => a.id - b.id);
  for (const rule of sortedRules) {
    if (overLimit <= 0) return;
    if (candidateKeys.has(adSessionRuleKeyForRule(rule))) continue;
    removeRuleIds.add(rule.id);
    overLimit--;
  }
  for (const rule of sortedRules) {
    if (overLimit <= 0) return;
    if (removeRuleIds.has(rule.id)) continue;
    removeRuleIds.add(rule.id);
    overLimit--;
  }
};

const applyAdSessionRuleCandidates = async (candidates) => {
  if (candidates.length === 0) return 0;
  try {
    const allRules = await chrome.declarativeNetRequest.getSessionRules();
    const sessionRules = allRules.filter(adSessionRuleIsManaged);
    const existingKeys = new Set(sessionRules.map(adSessionRuleKeyForRule));
    const removeRuleIds = new Set();
    const addRules = [];
    for (const candidate of candidates) {
      if (existingKeys.has(candidate.key)) continue;
      const id = nextAdSessionRuleId({ addRules, removeRuleIds, sessionRules });
      if (!id) break;
      addRules.push({ ...candidate.rule, id });
    }
    evictAdSessionRules({ addRules, candidates, removeRuleIds, sessionRules });
    if (addRules.length === 0 && removeRuleIds.size === 0) return 0;
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules,
      removeRuleIds: Array.from(removeRuleIds),
    });
    return addRules.length;
  } catch {
    return 0;
  }
};

const adSessionRulesActiveForOrigin = ({ adPrefs, origin, playbook }) =>
  adCleanupModeFor(adPrefs) === "cosmetic" &&
  !adSitePrefsFor(origin, adPrefs).cleanupDisabled &&
  !(playbook && playbook.disabled);

const syncAdSessionRulesForOrigin = async ({ adPrefs, origin, playbook }) => {
  if (!origin) return 0;
  if (!adSessionRulesActiveForOrigin({ adPrefs, origin, playbook })) {
    return clearAdSessionRulesForOrigin(origin);
  }
  const candidates = adSessionRuleCandidatesForPlaybook(origin, playbook);
  if (candidates.length === 0) return clearAdSessionRulesForOrigin(origin);
  return applyAdSessionRuleCandidates(candidates);
};

const adSessionUrlFilterParts = (urlFilter) => {
  const exact = String(urlFilter || "").endsWith("^");
  const withoutStart = String(urlFilter || "").replace(/^\|/, "");
  const urlText = exact ? withoutStart.slice(0, -1) : withoutStart;
  try {
    const parsed = new URL(urlText);
    return {
      exact,
      origin: parsed.origin,
      path: `same-origin:${parsed.pathname}${exact ? "" : "*"}`,
    };
  } catch {
    return null;
  }
};

const adSessionRuleSummaryForRule = (rule) => {
  const condition = (rule && rule.condition) || {};
  const parts = adSessionUrlFilterParts(condition.urlFilter);
  if (!parts) return null;
  return {
    diagnosticOnly: false,
    firstSeen: 0,
    hits: 0,
    kind: "session-rule",
    lastSeen: 0,
    origin: parts.origin,
    path: parts.path,
    resourceTypes: safeDnrResourceTypesFor(condition),
    ruleId: rule.id,
    score: adHighScoreThreshold(),
    status: "session",
  };
};

const adSessionRuleSummariesForOrigin = async (origin) => {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return rules
      .filter(adSessionRuleIsManaged)
      .map(adSessionRuleSummaryForRule)
      .filter((summary) => summary && (!origin || summary.origin === origin))
      .sort((a, b) => b.ruleId - a.ruleId)
      .slice(0, AD_SESSION_RULE_CAP);
  } catch {
    return [];
  }
};

const adDynamicRuleIdIsManaged = (id) =>
  Number.isInteger(id) && id >= AD_DYNAMIC_RULE_ID_MIN && id <= AD_DYNAMIC_RULE_ID_MAX;

const adDynamicRuleIsManaged = (rule) => !!rule && adDynamicRuleIdIsManaged(rule.id);

const adDynamicRuleMapFor = (adDynamicState) => {
  if (!(adDynamicState && typeof adDynamicState === "object")) return {};
  return adDynamicState.rules && typeof adDynamicState.rules === "object"
    ? adDynamicState.rules
    : {};
};

const ensureAdDynamicState = (adDynamicState) => {
  const state = adDynamicState && typeof adDynamicState === "object" ? adDynamicState : {};
  state.version = AD_PLAYBOOK_VERSION;
  if (!(state.rules && typeof state.rules === "object")) state.rules = {};
  return state;
};

const adDynamicOriginsForState = (adDynamicState) =>
  Object.values(adDynamicRuleMapFor(adDynamicState))
    .map((meta) => normalizeOrigin(meta && meta.origin))
    .filter(Boolean);

const adRecentDisableFor = (origin, adPrefs, now) => {
  const prefs = adSitePrefsFor(origin, adPrefs);
  if (prefs.networkDemotedUntil && prefs.networkDemotedUntil > now) return true;
  return !!(
    prefs.lastDisabledAt &&
    now - prefs.lastDisabledAt >= 0 &&
    now - prefs.lastDisabledAt < AD_DYNAMIC_DISABLE_COOLDOWN_MS
  );
};

const adDynamicRulesActiveForOrigin = ({ adPrefs, now, origin, playbook }) =>
  adCleanupModeFor(adPrefs) === "cosmetic" &&
  !adSitePrefsFor(origin, adPrefs).cleanupDisabled &&
  !(playbook && playbook.disabled) &&
  !adRecentDisableFor(origin, adPrefs, now);

const adDynamicMetaIsBlocked = (meta, now) =>
  !!(
    (meta.demotedUntil && meta.demotedUntil > now) ||
    (meta.breakageUntil && meta.breakageUntil > now)
  );

const adDynamicMetaIsEligible = (meta, now) =>
  !!meta &&
  !adDynamicMetaIsBlocked(meta, now) &&
  (meta.sessionCount || 0) >= AD_DYNAMIC_PROMOTION_MIN_SESSIONS &&
  (meta.hits || 0) >= AD_DYNAMIC_PROMOTION_MIN_HITS &&
  (meta.score || 0) >= adHighScoreThreshold() &&
  (!meta.lastSeen || now - meta.lastSeen <= AD_PLAYBOOK_STALE_MS);

const adDynamicRuleCandidateForMeta = (_key, meta) => {
  const origin = normalizeOrigin(meta && meta.origin);
  const host = dnrDomainForOrigin(origin);
  const endpointPath = sameOriginEndpointPath(meta && meta.path);
  const resourceTypes = safeDnrResourceTypesFor(meta);
  if (!origin || !host || !endpointPath || resourceTypes.length === 0) return null;
  if (AD_PLAYBOOK_UNSAFE_ENDPOINT_RE.test(endpointPath)) return null;
  if (!AD_PLAYBOOK_ENDPOINT_RE.test(endpointPath)) return null;
  const pathSpec = dnrPathFilterForEndpoint(endpointPath);
  if (!pathSpec) return null;
  const rule = {
    action: { type: "block" },
    condition: {
      initiatorDomains: [host],
      requestDomains: [host],
      resourceTypes,
      urlFilter: adSessionUrlFilterFor(origin, pathSpec),
    },
    priority: 1,
  };
  return {
    key: adSessionRuleKeyForCandidate(rule),
    meta,
    rule,
  };
};

const compareAdDynamicCandidates = (a, b) =>
  (b.meta.lastSeen || 0) - (a.meta.lastSeen || 0) ||
  (b.meta.sessionCount || 0) - (a.meta.sessionCount || 0) ||
  (b.meta.hits || 0) - (a.meta.hits || 0) ||
  (b.meta.score || 0) - (a.meta.score || 0) ||
  a.key.localeCompare(b.key);

const adDynamicRuleCandidatesForState = ({ adDynamicState, adPlaybooks, adPrefs, now }) =>
  Object.entries(adDynamicRuleMapFor(adDynamicState))
    .map(([key, meta]) => {
      const origin = normalizeOrigin(meta && meta.origin);
      const playbook = origin ? adPlaybooks[origin] : null;
      if (!adDynamicRulesActiveForOrigin({ adPrefs, now, origin, playbook })) return null;
      if (!adDynamicMetaIsEligible(meta, now)) return null;
      return adDynamicRuleCandidateForMeta(key, meta);
    })
    .filter(Boolean)
    .sort(compareAdDynamicCandidates)
    .slice(0, AD_DYNAMIC_RULE_CAP);

const nextAdDynamicRuleId = ({ addRules, dynamicRules, removeRuleIds }) => {
  const used = new Set(
    dynamicRules.filter((rule) => !removeRuleIds.has(rule.id)).map((rule) => rule.id)
  );
  for (const rule of addRules) used.add(rule.id);
  for (let id = AD_DYNAMIC_RULE_ID_MIN; id <= AD_DYNAMIC_RULE_ID_MAX; id++) {
    if (!used.has(id)) return id;
  }
  return null;
};

const markAdDynamicMetadataStatuses = ({ candidates, dynamicRules, state }) => {
  const desiredKeys = new Set(candidates.map((candidate) => candidate.key));
  const rules = adDynamicRuleMapFor(state);
  let changed = false;
  for (const [key, meta] of Object.entries(rules)) {
    if (desiredKeys.has(key)) continue;
    if (meta.status === "persistent" || meta.ruleId) {
      delete meta.ruleId;
      meta.status = "candidate";
      changed = true;
    }
  }
  const activeByKey = new Map(dynamicRules.map((rule) => [adSessionRuleKeyForRule(rule), rule]));
  for (const candidate of candidates) {
    const active = activeByKey.get(candidate.key);
    if (!active) continue;
    const promotedAt = candidate.meta.promotedAt || Date.now();
    if (
      candidate.meta.promotedAt !== promotedAt ||
      candidate.meta.ruleId !== active.id ||
      candidate.meta.status !== "persistent"
    ) {
      changed = true;
    }
    candidate.meta.promotedAt = promotedAt;
    candidate.meta.ruleId = active.id;
    candidate.meta.status = "persistent";
  }
  return changed;
};

const applyAdDynamicRuleCandidates = async ({ candidates, state }) => {
  try {
    const allRules = await chrome.declarativeNetRequest.getDynamicRules();
    const dynamicRules = allRules.filter(adDynamicRuleIsManaged);
    const existingByKey = new Map(
      dynamicRules.map((rule) => [adSessionRuleKeyForRule(rule), rule])
    );
    const desiredKeys = new Set(candidates.map((candidate) => candidate.key));
    const removeRuleIds = new Set(
      dynamicRules
        .filter((rule) => !desiredKeys.has(adSessionRuleKeyForRule(rule)))
        .map((rule) => rule.id)
    );
    const addRules = [];
    for (const candidate of candidates) {
      const existing = existingByKey.get(candidate.key);
      if (existing && !removeRuleIds.has(existing.id)) continue;
      const id = nextAdDynamicRuleId({ addRules, dynamicRules, removeRuleIds });
      if (!id) break;
      addRules.push({ ...candidate.rule, id });
    }
    if (addRules.length > 0 || removeRuleIds.size > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules,
        removeRuleIds: Array.from(removeRuleIds),
      });
    }
    const updatedRules =
      addRules.length > 0 || removeRuleIds.size > 0
        ? await chrome.declarativeNetRequest.getDynamicRules()
        : allRules;
    const statusChanged = markAdDynamicMetadataStatuses({
      candidates,
      dynamicRules: updatedRules.filter(adDynamicRuleIsManaged),
      state,
    });
    return addRules.length > 0 || removeRuleIds.size > 0 || statusChanged;
  } catch {
    return false;
  }
};

const syncAdDynamicRules = async ({ adDynamicState, adPlaybooks, adPrefs }) => {
  const state = ensureAdDynamicState(adDynamicState);
  const now = Date.now();
  const candidates = adDynamicRuleCandidatesForState({
    adDynamicState: state,
    adPlaybooks,
    adPrefs,
    now,
  });
  const changed = await applyAdDynamicRuleCandidates({ candidates, state });
  if (changed) state.lastUpdated = now;
  return changed;
};

const adDynamicRuleSummaryForRule = (rule, state) => {
  const condition = (rule && rule.condition) || {};
  const parts = adSessionUrlFilterParts(condition.urlFilter);
  if (!parts) return null;
  const meta = adDynamicRuleMapFor(state)[adSessionRuleKeyForRule(rule)] || {};
  return {
    diagnosticOnly: false,
    firstSeen: meta.firstSeen || 0,
    hits: meta.hits || 0,
    kind: "dynamic-rule",
    lastSeen: meta.lastSeen || 0,
    origin: parts.origin,
    path: parts.path,
    promotedAt: meta.promotedAt || 0,
    resourceTypes: safeDnrResourceTypesFor(condition),
    ruleId: rule.id,
    score: meta.score || adHighScoreThreshold(),
    sessionCount: meta.sessionCount || 0,
    status: "persistent",
  };
};

const adDynamicRuleSummariesForOrigin = async (origin, state) => {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules
      .filter(adDynamicRuleIsManaged)
      .map((rule) => adDynamicRuleSummaryForRule(rule, state))
      .filter((summary) => summary && (!origin || summary.origin === origin))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || b.ruleId - a.ruleId)
      .slice(0, AD_DYNAMIC_RULE_CAP);
  } catch {
    return [];
  }
};

const adDynamicRecoverySummariesForOrigin = (origin, state, now = Date.now()) =>
  Object.values(adDynamicRuleMapFor(state))
    .map((entry) => {
      const summary = sanitizeAdPlaybookEntry(entry);
      if (summary.demotedUntil > now) summary.status = "demoted";
      return summary;
    })
    .filter((entry) => {
      if (origin && normalizeOrigin(entry.origin) !== origin) return false;
      const recentBreakage =
        entry.lastBreakageAt &&
        now - entry.lastBreakageAt >= 0 &&
        now - entry.lastBreakageAt < AD_DYNAMIC_DISABLE_COOLDOWN_MS;
      return (
        entry.kind === "endpoint" &&
        entry.breakageCount > 0 &&
        (entry.demotedUntil > now || recentBreakage)
      );
    })
    .sort(
      (a, b) =>
        (b.lastBreakageAt || 0) - (a.lastBreakageAt || 0) ||
        (b.demotedUntil || 0) - (a.demotedUntil || 0) ||
        (b.score || 0) - (a.score || 0)
    )
    .slice(0, AD_DYNAMIC_RULE_CAP);

const endpointCandidateFor = (endpoint, resourceType) => {
  const path = safePlaybookText(endpoint);
  if (!path || !path.startsWith("same-origin:/")) return null;
  if (AD_PLAYBOOK_UNSAFE_ENDPOINT_RE.test(path) || !AD_PLAYBOOK_ENDPOINT_RE.test(path)) return null;
  return {
    kind: "endpoint",
    path,
    resourceType,
  };
};

const scriptCandidateFor = (source) => {
  const value = safePlaybookText(source);
  if (!value || !value.startsWith("script:")) return null;
  return {
    kind: "source",
    value,
  };
};

const adDynamicCandidateRecordForSignal = ({ normalized, origin, playbook }) => {
  const endpoint = endpointCandidateFor(normalized.endpoint, normalized.resourceType);
  if (!endpoint) return null;
  const entries = Array.isArray(playbook && playbook.network) ? playbook.network : [];
  const entry = entries
    .map((candidate) => sanitizeAdPlaybookEntry(candidate))
    .find(
      (candidate) =>
        candidate.kind === "endpoint" &&
        candidate.path === endpoint.path &&
        safeDnrResourceTypesFor(candidate).includes(endpoint.resourceType)
    );
  if (!entry) return null;
  const ruleCandidate = adSessionRuleCandidateForEntry(origin, entry);
  return ruleCandidate ? { ...ruleCandidate, entry } : null;
};

const upsertAdDynamicEvidenceMeta = ({ candidate, now, origin, sessionId, state }) => {
  const rules = adDynamicRuleMapFor(state);
  const existing = rules[candidate.key] || {};
  const meta = {
    ...existing,
    firstSeen: existing.firstSeen || now,
    key: candidate.key,
    kind: "endpoint",
    lastSeen: now,
    origin,
    path: candidate.entry.path,
    resourceTypes: safeDnrResourceTypesFor(candidate.entry),
    score: Math.max(existing.score || 0, candidate.entry.score || 0),
    version: AD_PLAYBOOK_VERSION,
  };
  meta.hits = Math.max(existing.hits || 0, candidate.entry.hits || 0);
  if (existing.lastSessionId !== sessionId) {
    meta.sessionCount = Math.max(0, Math.round(existing.sessionCount || 0)) + 1;
    meta.lastSessionId = sessionId;
  } else {
    meta.sessionCount = Math.max(1, Math.round(existing.sessionCount || 1));
  }
  if (!meta.promotedAt) meta.status = "candidate";
  rules[candidate.key] = meta;
};

const trimAdDynamicMetadata = (state, now) => {
  const rules = adDynamicRuleMapFor(state);
  for (const [key, meta] of Object.entries(rules)) {
    const lastSeen = meta.lastSeen || meta.firstSeen || 0;
    if (lastSeen && now - lastSeen > AD_PLAYBOOK_EXPIRE_MS) delete rules[key];
  }
  const entries = Object.entries(rules).sort(
    (a, b) =>
      Number(!!b[1].promotedAt) - Number(!!a[1].promotedAt) ||
      (b[1].lastSeen || 0) - (a[1].lastSeen || 0) ||
      (b[1].hits || 0) - (a[1].hits || 0)
  );
  for (const [key] of entries.slice(AD_DYNAMIC_METADATA_CAP)) delete rules[key];
};

const updateAdDynamicPromotionState = ({
  adDynamicState,
  adPrefs,
  classification,
  normalized,
  now,
  origin,
  playbook,
  sessionId,
}) => {
  if (
    adUiConfidence(classification && classification.confidence) !== "high" ||
    ((classification && classification.score) || 0) < adHighScoreThreshold()
  ) {
    return false;
  }
  if (!adSessionRulesActiveForOrigin({ adPrefs, origin, playbook })) return false;
  const state = ensureAdDynamicState(adDynamicState);
  const candidate = adDynamicCandidateRecordForSignal({ normalized, origin, playbook });
  if (!candidate) return false;
  upsertAdDynamicEvidenceMeta({ candidate, now, origin, sessionId, state });
  trimAdDynamicMetadata(state, now);
  state.lastUpdated = now;
  return true;
};

const mergeAdPlaybookCandidates = ({ classification, normalized, now, playbook }) => {
  const confidence = adUiConfidence(classification.confidence);
  const correlated = confidence === "likely" || confidence === "high";
  const baseScore = Math.max(classification.score || 0, correlated ? 50 : 0);
  const cosmetic = entryListFor(playbook, "cosmetic");
  for (const candidate of normalized.cosmetic) {
    upsertPlaybookEntry({
      baseScore,
      candidate: {
        ...candidate,
        diagnosticOnly: candidate.diagnosticOnly || !correlated,
        reason: candidate.reason || (correlated ? "" : "low-confidence"),
      },
      entries: cosmetic,
      minHits: AD_PLAYBOOK_MIN_HITS.cosmetic,
      now,
      valueKey: "value",
    });
  }

  const script = correlated ? scriptCandidateFor(normalized.source) : null;
  if (script) {
    upsertPlaybookEntry({
      baseScore,
      candidate: script,
      entries: entryListFor(playbook, "scripts"),
      minHits: AD_PLAYBOOK_MIN_HITS.scripts,
      now,
      valueKey: "value",
    });
  }

  const endpoint = correlated
    ? endpointCandidateFor(normalized.endpoint, normalized.resourceType)
    : null;
  if (endpoint) {
    upsertPlaybookEntry({
      baseScore,
      candidate: endpoint,
      entries: entryListFor(playbook, "network"),
      minHits: AD_PLAYBOOK_MIN_HITS.network,
      now,
      valueKey: "path",
    });
  }
};

const prepareAdPlaybook = (existing, now) => {
  const playbook = existing && typeof existing === "object" ? { ...existing } : {};
  playbook.version = AD_PLAYBOOK_VERSION;
  playbook.cosmetic = decayPlaybookEntries({
    entries: playbook.cosmetic,
    now,
    valueKey: "value",
  });
  playbook.network = decayPlaybookEntries({
    entries: playbook.network,
    now,
    valueKey: "path",
  });
  playbook.scripts = decayPlaybookEntries({
    entries: playbook.scripts,
    now,
    valueKey: "value",
  });
  return playbook;
};

const updateAdPlaybook = ({ adPlaybooks, classification, disabled, normalized, now, origin }) => {
  const existing = adPlaybooks[origin];
  const correlated = adUiConfidence(classification.confidence) !== "learning";
  const hasIncomingCandidate =
    normalized.cosmetic.length > 0 ||
    (correlated && !!scriptCandidateFor(normalized.source)) ||
    (correlated && !!endpointCandidateFor(normalized.endpoint, normalized.resourceType));
  if (!existing && (disabled || !hasIncomingCandidate)) return false;
  const playbook = prepareAdPlaybook(existing, now);
  playbook.disabled = !!disabled;
  if (!disabled) {
    mergeAdPlaybookCandidates({ classification, normalized, now, playbook });
  }
  trimPlaybookEntries({ entries: playbook.cosmetic, limit: AD_PLAYBOOK_CAPS.cosmetic });
  trimPlaybookEntries({ entries: playbook.network, limit: AD_PLAYBOOK_CAPS.network });
  trimPlaybookEntries({ entries: playbook.scripts, limit: AD_PLAYBOOK_CAPS.scripts });
  recomputeAdPlaybookState(playbook);
  playbook.lastUpdated = now;
  adPlaybooks[origin] = playbook;
  trimLogOrigins(adPlaybooks, AD_PLAYBOOK_CAPS.origins || AD_LOG_CAPS.origins);
  return true;
};

const adDiagnosticsFor = ({
  adLog = {},
  adPlaybooks = {},
  adPrefs = {},
  dynamicNetwork = [],
  origin,
  recoveryNetwork = [],
  sessionNetwork = [],
}) => {
  const entry = storedEntryForOrigin(origin, adLog);
  const classification = adClassificationFor((entry && entry.reasons) || {});
  const entryDiagnostics = adEntryDiagnosticsFor(entry, classification);
  const playbook = adPlaybookFor(origin, adPlaybooks);
  const prefs = adSitePrefsFor(origin, adPrefs);
  return {
    ...entryDiagnostics,
    cleanupMode: adCleanupModeFor(adPrefs),
    cleanupDisabled: !!(prefs.cleanupDisabled || playbook.disabled),
    lastUpdated: Math.max(entryDiagnostics.updatedAt, playbook.lastUpdated || 0),
    playbook,
    prefs,
    persistentNetwork: dynamicNetwork,
    recoveryNetwork,
    sessionNetwork,
  };
};

const adCosmeticConfigFor = ({ adPlaybooks = {}, adPrefs = {}, origin }) => {
  const playbook = origin && adPlaybooks[origin] ? adPlaybooks[origin] : {};
  const prefs = adSitePrefsFor(origin, adPrefs);
  const disabled = !!(prefs.cleanupDisabled || playbook.disabled);
  const sessionEntries = disabled ? [] : adSessionCosmeticEntriesFor(origin);
  const sessionSafe = sessionEntries.some(activeAdCosmeticEntryForConfig);
  const persistentHigh = playbook.confidence === "high" || !!playbook.cosmeticSafe;
  const active =
    adCleanupModeFor(adPrefs) === "cosmetic" && !disabled && (persistentHigh || sessionSafe);
  const entries = active
    ? mergeAdCosmeticConfigEntries(sessionEntries, playbook.cosmetic).filter(
        activeAdCosmeticEntryForConfig
      )
    : [];
  return {
    active,
    entries,
    origin,
    session: sessionEntries.filter(activeAdCosmeticEntryForConfig).length,
  };
};

const updateAdSessionCosmeticState = ({ disabled, normalized, now, origin }) => {
  if (disabled) return clearAdSessionStateForOrigin(origin);
  rememberAdSessionCosmeticCandidates({ normalized, now, origin });
  return promoteAdSessionCosmeticEntries({ normalized, now, origin });
};

const updateAdLogEntry = ({ entry, normalized, now }) => {
  entry.version = 1;
  entry.total = (entry.total || 0) + 1;
  entry.firstSeen ||= now;
  entry.lastUpdated = now;
  entry.reasons ||= {};
  entry.endpoints ||= {};
  entry.sources ||= {};
  bumpCount(entry.endpoints, normalized.endpoint);
  bumpCount(entry.sources, normalized.source);
  for (const reason of normalized.reasons) bumpCount(entry.reasons, reason);

  entry.reasons = trimCountMap(entry.reasons, AD_LOG_CAPS.reasons);
  entry.endpoints = trimCountMap(entry.endpoints, AD_LOG_CAPS.endpoints);
  entry.sources = trimCountMap(entry.sources, AD_LOG_CAPS.sources);
  const classification = adClassificationFor(entry.reasons);
  entry.score = classification.score;
  entry.confidence = classification.confidence;
  entry.scoreReasons = Array.from(classification.scoreReasons || []).slice(0, 16);
  return classification;
};

const recordAdSignal = async (origin, signal) => {
  if (!origin || !signal || typeof signal !== "object") return;
  const {
    ad_dynamic_rules = {},
    ad_log = {},
    ad_playbooks = {},
    ad_prefs = {},
  } = await chrome.storage.local.get({
    ad_dynamic_rules: {},
    ad_log: {},
    ad_playbooks: {},
    ad_prefs: {},
  });
  const now = Date.now();
  const entry = ad_log[origin] || {
    confidence: "learning",
    endpoints: {},
    firstSeen: now,
    lastUpdated: 0,
    reasons: {},
    score: 0,
    sources: {},
    total: 0,
    version: 1,
  };
  const normalized = normalizeAdSignal(signal);
  const disabled = adSitePrefsFor(origin, ad_prefs).cleanupDisabled;
  const sessionChanged = updateAdSessionCosmeticState({ disabled, normalized, now, origin });
  const classification = updateAdLogEntry({ entry, normalized, now });
  ad_log[origin] = entry;
  trimLogOrigins(ad_log, AD_LOG_CAPS.origins);
  updateAdPlaybook({
    adPlaybooks: ad_playbooks,
    classification,
    disabled,
    normalized,
    now,
    origin,
  });
  const sessionId = await currentAdBrowserSessionId();
  updateAdDynamicPromotionState({
    adDynamicState: ad_dynamic_rules,
    adPrefs: ad_prefs,
    classification,
    normalized,
    now,
    origin,
    playbook: ad_playbooks[origin],
    sessionId,
  });
  await chrome.storage.local.set({ ad_dynamic_rules, ad_log, ad_playbooks });
  await syncAdSessionRulesForOrigin({
    adPrefs: ad_prefs,
    origin,
    playbook: ad_playbooks[origin],
  });
  if (
    await syncAdDynamicRules({
      adDynamicState: ad_dynamic_rules,
      adPlaybooks: ad_playbooks,
      adPrefs: ad_prefs,
    })
  ) {
    await chrome.storage.local.set({ ad_dynamic_rules });
  }
  if (sessionChanged) await broadcastAdCosmeticUpdate(origin);
};

const recordAdaptiveSignal = async (origin, signal) => {
  if (!origin || !signal || typeof signal !== "object") return;
  const { adaptive_log = {} } = await chrome.storage.local.get({ adaptive_log: {} });
  const now = Date.now();
  const entry = adaptive_log[origin] || {
    total: 0,
    scoreMax: 0,
    categories: {},
    reasons: {},
    endpoints: {},
    sources: {},
    lastUpdated: 0,
  };
  const normalized = normalizeAdaptiveSignal(signal);

  entry.total = (entry.total || 0) + 1;
  entry.scoreMax = Math.max(entry.scoreMax || 0, normalized.score);
  entry.lastUpdated = now;
  entry.categories ||= {};
  entry.reasons ||= {};
  entry.endpoints ||= {};
  entry.sources ||= {};
  bumpCount(entry.categories, normalized.category);
  bumpCount(entry.endpoints, normalized.endpoint);
  bumpCount(entry.sources, normalized.source);
  for (const reason of normalized.reasons) bumpCount(entry.reasons, reason);

  entry.reasons = trimCountMap(entry.reasons, 50);
  entry.endpoints = trimCountMap(entry.endpoints, 50);
  entry.sources = trimCountMap(entry.sources, 50);
  adaptive_log[origin] = entry;
  trimLogOrigins(adaptive_log, 100);
  await chrome.storage.local.set({ adaptive_log });
};

const safeDiagnosticText = (value, fallback, maxLength) => {
  const text = String(value || fallback || "unknown")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLength);
};

const normalizeDiagnosticEvent = (event, now) => {
  const type = safeDiagnosticText(event && event.type, "unknown", 24);
  const base = { at: now, type };
  if (type === "probe") {
    const extensionId = safeDiagnosticText(event.extensionId, "", 32).toLowerCase();
    return {
      ...base,
      action: "blocked",
      extensionId: CHROME_EXT_ID_RE.test(extensionId) ? extensionId : null,
      extensionPath: safeDiagnosticText(event.extensionPath, "", 96),
      pathKind: safeDiagnosticText(event.pathKind, "unknown", 32),
      vector: safeDiagnosticText(event.vector, "unknown", 48),
    };
  }
  if (type === "replay") {
    return {
      ...base,
      action: "detected",
      signal: safeDiagnosticText(event.signal, "unknown", 160),
    };
  }
  if (type === "adaptive") {
    return {
      ...base,
      action: "observed",
      category: safeDiagnosticText(event.category, "unknown", 48),
      endpoint: safeDiagnosticText(event.endpoint, "", 160),
      reasons: Array.isArray(event.reasons)
        ? event.reasons.map((reason) => safeDiagnosticText(reason, "unknown", 64)).slice(0, 12)
        : [],
      score: Math.max(0, Math.min(100, Math.round(event.score || 0))),
      source: safeDiagnosticText(event.source, "unknown", 160),
    };
  }
  return {
    ...base,
    action: safeDiagnosticText(event && event.action, "observed", 48),
  };
};

const bumpDiagnosticTotal = (entry, type) => {
  entry.totals ||= {};
  entry.totals[type] = (entry.totals[type] || 0) + 1;
};

const recordDiagnosticEvents = async (origin, events) => {
  if (!origin || !Array.isArray(events) || events.length === 0) return;
  const { diagnostics_mode = false, diagnostic_log = {} } = await chrome.storage.local.get({
    diagnostic_log: {},
    diagnostics_mode: false,
  });
  if (!diagnostics_mode) return;

  const now = Date.now();
  const entry = diagnostic_log[origin] || { events: [], lastUpdated: 0, totals: {} };
  entry.events ||= [];
  entry.totals ||= {};
  for (const rawEvent of events.slice(0, 80)) {
    const event = normalizeDiagnosticEvent(rawEvent, now);
    entry.events.push(event);
    bumpDiagnosticTotal(entry, event.type);
  }
  if (entry.events.length > MAX_DIAGNOSTIC_EVENTS_PER_ORIGIN) {
    entry.events = entry.events.slice(-MAX_DIAGNOSTIC_EVENTS_PER_ORIGIN);
  }
  entry.lastUpdated = now;
  diagnostic_log[origin] = entry;
  trimLogOrigins(diagnostic_log, MAX_DIAGNOSTIC_ORIGINS);
  await chrome.storage.local.set({ diagnostic_log });
};

// ─── Persona generation ───────────────────────────────────────────────────
let cachedSecretPromise = null;
const loadUserSecret = async () => {
  const { user_secret } = await chrome.storage.local.get("user_secret");
  if (user_secret) return user_secret;
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  const hex = Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await chrome.storage.local.set({ user_secret: hex });
  return hex;
};

const getUserSecret = () => {
  cachedSecretPromise ||= loadUserSecret();
  return cachedSecretPromise;
};

const mulberry32 = (seed) => {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const seedFor = async (secret, origin, week) => {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}|${origin}|${week}`)
  );
  return new DataView(buf).getUint32(0, true);
};

const shuffleInPlace = (arr, rng) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
};

const knownPersonaIds = () => {
  const ids = new Set();
  for (const slotIds of Object.values(CFG.conflictSlots || {})) {
    for (const id of slotIds) ids.add(id);
  }
  return ids;
};

const eligiblePersonaIds = (entry) => {
  const minCount = CFG.personaMinCount || 2;
  const unknownMinCount = CFG.unknownPersonaMinCount || 20;
  const knownIds = knownPersonaIds();
  return Object.entries(entry.idCounts)
    .filter(([id, c]) => {
      const safeId = id.toLowerCase();
      const threshold = knownIds.has(safeId) ? minCount : unknownMinCount;
      return CHROME_EXT_ID_RE.test(safeId) && typeof c === "number" && c >= threshold;
    })
    .map(([id]) => id.toLowerCase());
};

const buildConflictSlotMap = () => {
  const idToSlot = new Map();
  for (const [slotName, ids] of Object.entries(CFG.conflictSlots || {})) {
    for (const id of ids) idToSlot.set(id, slotName);
  }
  return idToSlot;
};

const splitIdsBySlot = (ids, idToSlot) => {
  const bySlot = {};
  const unslotted = [];
  for (const id of ids) {
    const slot = idToSlot.get(id);
    if (slot) (bySlot[slot] ||= []).push(id);
    else unslotted.push(id);
  }
  return { bySlot, unslotted };
};

const personaTargetSize = (rng) => {
  const sizeRange = CFG.personaSize || { min: 3, max: 8 };
  return sizeRange.min + Math.floor(rng() * (sizeRange.max - sizeRange.min + 1));
};

const selectPersonaIds = ({ bySlot, rng, target, unslotted }) => {
  const selected = [];
  const slotNames = Object.keys(bySlot).sort();
  shuffleInPlace(slotNames, rng);
  for (const slotName of slotNames) {
    if (selected.length >= target) break;
    const opts = bySlot[slotName];
    shuffleInPlace(opts, rng);
    selected.push(opts[0]);
  }
  shuffleInPlace(unslotted, rng);
  for (const id of unslotted) {
    if (selected.length >= target) break;
    selected.push(id);
  }
  return selected;
};

const personaFor = async (origin) => {
  const { probe_log = {} } = await chrome.storage.local.get({ probe_log: {} });
  const entry = probe_log[origin];
  if (!entry || !entry.idCounts) return [];

  const eligible = eligiblePersonaIds(entry);
  if (eligible.length === 0) return [];

  const secret = await getUserSecret();
  const rotWeeks = CFG.personaRotationWeeks || 1;
  const rotationMs = rotWeeks * 7 * 24 * 60 * 60 * 1000;
  const phase = (await seedFor(secret, origin, "phase")) % rotationMs;
  const week = Math.floor((Date.now() + phase) / rotationMs);
  const seed = await seedFor(secret, origin, week);
  const rng = mulberry32(seed);
  const { bySlot, unslotted } = splitIdsBySlot(eligible, buildConflictSlotMap());
  return selectPersonaIds({ bySlot, rng, target: personaTargetSize(rng), unslotted });
};

const pick = (items, rng) => items[Math.floor(rng() * items.length)];

const FINGERPRINT_PROFILES = [
  {
    architecture: "x86",
    bitness: "64",
    os: "windows",
    platform: "Win32",
    uaDataPlatform: "Windows",
    uaOs: "Windows NT 10.0; Win64; x64",
    webglRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webglVendor: "Google Inc. (Intel)",
  },
  {
    architecture: "x86",
    bitness: "64",
    os: "macos",
    platform: "MacIntel",
    uaDataPlatform: "macOS",
    uaOs: "Macintosh; Intel Mac OS X 10_15_7",
    webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
    webglVendor: "Google Inc. (Apple)",
  },
  {
    architecture: "x86",
    bitness: "64",
    os: "linux",
    platform: "Linux x86_64",
    uaDataPlatform: "Linux",
    uaOs: "X11; Linux x86_64",
    webglRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620, OpenGL 4.6)",
    webglVendor: "Google Inc. (Intel)",
  },
];

const FINGERPRINT_SCREENS = [
  { width: 1366, height: 768, devicePixelRatio: 1 },
  { width: 1440, height: 900, devicePixelRatio: 1 },
  { width: 1536, height: 864, devicePixelRatio: 1.25 },
  { width: 1920, height: 1080, devicePixelRatio: 1 },
  { width: 2560, height: 1440, devicePixelRatio: 1 },
];

const FINGERPRINT_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
];

const FINGERPRINT_LANGUAGES_BY_TIMEZONE = {
  "America/Chicago": [["en-US", "en"]],
  "America/Denver": [["en-US", "en"]],
  "America/Los_Angeles": [["en-US", "en"]],
  "America/New_York": [["en-US", "en"]],
  "Europe/Berlin": [
    ["de-DE", "de", "en-US", "en"],
    ["en-US", "en"],
  ],
  "Europe/London": [["en-GB", "en"]],
};

const FINGERPRINT_CONNECTIONS = [
  { downlink: 5, effectiveType: "4g", rtt: 75, saveData: false, type: "wifi" },
  { downlink: 10, effectiveType: "4g", rtt: 50, saveData: false, type: "wifi" },
  { downlink: 20, effectiveType: "4g", rtt: 25, saveData: false, type: "ethernet" },
];

const screenPersonaFor = (rng) => {
  const screen = pick(FINGERPRINT_SCREENS, rng);
  const taskbar = screen.height >= 900 ? 40 : 32;
  return {
    ...screen,
    availHeight: screen.height - taskbar,
    availWidth: screen.width,
    colorDepth: 24,
    pixelDepth: 24,
  };
};

const fingerprintPersonaFor = async (origin) => {
  const secret = await getUserSecret();
  const seed = await seedFor(secret, origin || "global", "fingerprint-v1");
  const rng = mulberry32(seed);
  const profile = pick(FINGERPRINT_PROFILES, rng);
  const hardwareConcurrency = pick([4, 8, 8, 12, 16], rng);
  const deviceMemory = hardwareConcurrency >= 12 ? pick([8, 16], rng) : pick([4, 8], rng);
  const timeZone = pick(FINGERPRINT_TIMEZONES, rng);
  return {
    ...profile,
    audioSeed: Math.floor(rng() * 0xffffffff),
    canvasSeed: Math.floor(rng() * 0xffffffff),
    connection: pick(FINGERPRINT_CONNECTIONS, rng),
    deviceMemory,
    hardwareConcurrency,
    languages: pick(FINGERPRINT_LANGUAGES_BY_TIMEZONE[timeZone] || [["en-US", "en"]], rng),
    maxTouchPoints: 0,
    pdfViewerEnabled: true,
    screen: screenPersonaFor(rng),
    storageQuota: pick([64, 128, 256], rng) * 1024 * 1024 * 1024,
    timeZone,
    vendor: "Google Inc.",
  };
};

const originFromUrl = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const originFromSender = (sender) => {
  const senderOrigin = originFromUrl(sender && sender.origin);
  if (senderOrigin && senderOrigin !== "null") return senderOrigin;
  const senderUrlOrigin = originFromUrl(sender && sender.url);
  return senderUrlOrigin && senderUrlOrigin !== "null" ? senderUrlOrigin : null;
};

const mapIdCounts = (idCounts) => {
  return new Map(Object.entries(sanitizeExtensionIdCounts(idCounts)));
};

const rememberSenderOrigin = (sender) => {
  const origin = originFromSender(sender);
  if (origin && sender.tab) getOrInitTab(sender.tab.id).origin = origin;
  return origin;
};

const handleProbeBlocked = (msg, sender) => {
  if (!sender.tab) return;
  const tabId = sender.tab.id;
  const origin = rememberSenderOrigin(sender);
  getOrInitTab(tabId).frames.set(sender.frameId || 0, {
    total: msg.frameTotal || 0,
    idCounts: mapIdCounts(msg.idCounts),
  });
  updateBadge(tabId, sumTabTotal(tabId));

  const delta = typeof msg.delta === "number" ? msg.delta : 0;
  if (delta > 0) serialize(() => addToCumulative(delta));
  if (origin && delta > 0) {
    serialize(() =>
      recordProbes(origin, {
        delta,
        deltaIdCounts: msg.deltaIdCounts || {},
        deltaPathKindCounts: msg.deltaPathKindCounts || {},
        deltaVectorCounts: msg.deltaVectorCounts || {},
      })
    );
  }
  if (origin && Array.isArray(msg.diagnosticEvents) && msg.diagnosticEvents.length > 0) {
    serialize(() => recordDiagnosticEvents(origin, msg.diagnosticEvents));
  }
};

const handleReplayDetected = (msg, sender) => {
  if (!sender.tab) return;
  const origin = rememberSenderOrigin(sender);
  const signal = typeof msg.signal === "string" ? msg.signal : "unknown";
  if (origin) serialize(() => recordReplayDetection(origin, signal));
  if (origin) serialize(() => recordDiagnosticEvents(origin, [{ signal, type: "replay" }]));
};

const handleAdaptiveSignal = (msg, sender) => {
  if (!sender.tab) return;
  const origin = rememberSenderOrigin(sender);
  if (origin) serialize(() => recordAdaptiveSignal(origin, msg.signal));
  if (origin && msg.signal && typeof msg.signal === "object") {
    serialize(() =>
      recordDiagnosticEvents(origin, [
        {
          ...normalizeAdaptiveSignal(msg.signal),
          type: "adaptive",
        },
      ])
    );
  }
};

const handleAdSignal = (msg, sender) => {
  if (!sender.tab) return;
  const origin = rememberSenderOrigin(sender);
  if (origin) serialize(() => recordAdSignal(origin, msg.signal));
};

const storedEntryForOrigin = (origin, log) => (origin ? log[origin] : null);

const adaptiveDiagnosticsFor = (entry) => ({
  adaptiveCategories: entry ? entry.categories || {} : {},
  adaptiveDetected: !!entry,
  adaptiveEndpointDiagnostics: entry ? adaptiveEndpointDiagnosticsForEntry(entry) : [],
  adaptiveEndpoints: entry ? countEntries(entry.endpoints, 4) : [],
  adaptiveReasons: entry ? countEntries(entry.reasons, 8) : [],
  adaptiveScore: entry ? entry.scoreMax || 0 : 0,
  adaptiveSources: entry ? countEntries(entry.sources, 4) : [],
});

const adaptiveLogWithDiagnostics = (adaptiveLog = {}) =>
  Object.fromEntries(
    Object.entries(adaptiveLog || {}).map(([origin, entry]) => [
      origin,
      {
        ...entry,
        endpointDiagnostics: adaptiveEndpointDiagnosticsForEntry(entry),
      },
    ])
  );

const tabOriginFor = async (tabId) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const origin = originFromUrl(tab && tab.url);
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
};

const loggedOriginsFor = (stored) =>
  new Set([
    ...Object.keys(stored.probe_log),
    ...Object.keys(stored.replay_log),
    ...Object.keys(stored.adaptive_log),
    ...Object.keys(stored.ad_log),
    ...Object.keys(stored.ad_playbooks),
    ...adDynamicOriginsForState(stored.ad_dynamic_rules),
    ...Object.keys(stored.diagnostic_log),
  ]);

const diagnosticEventCountFor = (entry) => (entry ? (entry.events || []).length : 0);

const detailsResponseFor = async (tabId, stored) => {
  const state = perTabState.get(tabId);
  const origin = (state && state.origin) || (await tabOriginFor(tabId));
  if (state && origin) state.origin = origin;
  const originProbeEntry = storedEntryForOrigin(origin, stored.probe_log);
  const adaptiveEntry = storedEntryForOrigin(origin, stored.adaptive_log);
  const diagnosticEntry = storedEntryForOrigin(origin, stored.diagnostic_log);
  const adSessionNetwork = await adSessionRuleSummariesForOrigin(origin);
  const adDynamicNetwork = await adDynamicRuleSummariesForOrigin(origin, stored.ad_dynamic_rules);
  const adRecoveryNetwork = adDynamicRecoverySummariesForOrigin(origin, stored.ad_dynamic_rules);
  const selectedPersonaIds =
    originProbeEntry && stored.noise_enabled ? await personaFor(origin) : [];
  const loggedOrigins = loggedOriginsFor(stored);
  return {
    total: sumTabTotal(tabId),
    topIds: topIdsForTab(tabId, 5),
    cumulative: stored.cumulative,
    fingerprintMode: stored.fingerprint_mode,
    noiseEnabled: stored.noise_enabled,
    replayMode: stored.replay_mode,
    replayDetected: !!(origin && stored.replay_log[origin]),
    ...adaptiveDiagnosticsFor(adaptiveEntry),
    adCleanupMode: adCleanupModeFor(stored.ad_prefs),
    ad: adDiagnosticsFor({
      adLog: stored.ad_log,
      adPlaybooks: stored.ad_playbooks,
      adPrefs: stored.ad_prefs,
      dynamicNetwork: adDynamicNetwork,
      origin,
      recoveryNetwork: adRecoveryNetwork,
      sessionNetwork: adSessionNetwork,
    }),
    diagnosticEvents: diagnosticEventCountFor(diagnosticEntry),
    diagnosticOrigins: Object.keys(stored.diagnostic_log).length,
    diagnosticsMode: stored.diagnostics_mode,
    origin,
    drift: originProbeEntry ? playbookDriftForEntry(originProbeEntry) : null,
    noiseDiagnostics: originProbeEntry
      ? personaDiagnosticsFor(originProbeEntry, selectedPersonaIds, stored.noise_enabled, CFG)
      : null,
    originsLogged: loggedOrigins.size,
    playbook: originProbeEntry ? latestPlaybookSnapshot(originProbeEntry) : null,
  };
};

const handleGetDetails = (msg, _sender, sendResponse) => {
  if (typeof msg.tabId !== "number") return false;
  (async () => {
    const stored = await chrome.storage.local.get({
      cumulative: 0,
      diagnostic_log: {},
      diagnostics_mode: false,
      fingerprint_mode: "off",
      noise_enabled: false,
      probe_log: {},
      replay_log: {},
      adaptive_log: {},
      ad_dynamic_rules: {},
      ad_log: {},
      ad_playbooks: {},
      ad_prefs: {},
      replay_mode: "off",
    });
    sendResponse(await detailsResponseFor(msg.tabId, stored));
  })();
  return true;
};

const handleGetPersona = (_msg, sender, sendResponse) => {
  (async () => {
    const {
      diagnostics_mode = false,
      fingerprint_mode = "off",
      noise_enabled = false,
      replay_mode = "off",
    } = await chrome.storage.local.get({
      diagnostics_mode: false,
      fingerprint_mode: "off",
      noise_enabled: false,
      replay_mode: "off",
    });
    const origin = originFromSender(sender);
    const fingerprintMode = fingerprint_mode === "mask" ? "mask" : "off";
    const fingerprintPersona =
      fingerprintMode === "mask" ? await fingerprintPersonaFor(origin) : null;
    if (!noise_enabled || !origin) {
      sendResponse({
        diagnosticsMode: diagnostics_mode,
        fingerprintMode,
        fingerprintPersona,
        ids: [],
        noiseEnabled: noise_enabled,
        origin,
        replayMode: replay_mode,
      });
      return;
    }
    const ids = await personaFor(origin);
    sendResponse({
      diagnosticsMode: diagnostics_mode,
      fingerprintMode,
      fingerprintPersona,
      ids,
      noiseEnabled: true,
      origin,
      replayMode: replay_mode,
    });
  })();
  return true;
};

const handleGetAdCosmeticConfig = (_msg, sender, sendResponse) => {
  (async () => {
    const origin = originFromSender(sender);
    const { ad_playbooks = {}, ad_prefs = {} } = await chrome.storage.local.get({
      ad_playbooks: {},
      ad_prefs: {},
    });
    sendResponse({
      ok: true,
      ...adCosmeticConfigFor({
        adPlaybooks: ad_playbooks,
        adPrefs: ad_prefs,
        origin,
      }),
    });
  })();
  return true;
};

const broadcastConfigUpdate = async (options = {}) => {
  try {
    const resetProbeState = !!options.resetProbeState;
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) => {
        if (tab.id == null) return null;
        return chrome.tabs
          .sendMessage(tab.id, { resetProbeState, type: "static_persona_update" })
          .catch(() => {});
      })
    );
  } catch {}
};

const broadcastAdCosmeticUpdate = async (origin) => {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) => {
        if (tab.id == null) return null;
        return chrome.tabs
          .sendMessage(tab.id, { origin, type: "static_ad_cosmetic_update" })
          .catch(() => {});
      })
    );
  } catch {}
};

const handleSetNoise = (msg, _sender, sendResponse) => {
  (async () => {
    await chrome.storage.local.set({ noise_enabled: !!msg.enabled });
    await broadcastConfigUpdate();
    sendResponse({ ok: true });
  })();
  return true;
};

const handleSetReplay = (msg, _sender, sendResponse) => {
  (async () => {
    const allowed = new Set(["off", "mask", "noise", "chaos"]);
    const mode = allowed.has(msg.mode) ? msg.mode : "off";
    await chrome.storage.local.set({ replay_mode: mode });
    await broadcastConfigUpdate();
    sendResponse({ ok: true, mode });
  })();
  return true;
};

const handleSetFingerprint = (msg, _sender, sendResponse) => {
  (async () => {
    const allowed = new Set(["off", "mask"]);
    const mode = allowed.has(msg.mode) ? msg.mode : "off";
    await chrome.storage.local.set({ fingerprint_mode: mode });
    await broadcastConfigUpdate();
    sendResponse({ ok: true, mode });
  })();
  return true;
};

const handleSetDiagnostics = (msg, _sender, sendResponse) => {
  (async () => {
    const enabled = !!msg.enabled;
    await chrome.storage.local.set({ diagnostics_mode: enabled });
    await broadcastConfigUpdate();
    sendResponse({ enabled, ok: true });
  })();
  return true;
};

const handleSetAdCleanupMode = (msg, _sender, sendResponse) => {
  (async () => {
    const mode = AD_CLEANUP_MODES.has(msg.mode) ? msg.mode : "off";
    const {
      ad_dynamic_rules = {},
      ad_playbooks = {},
      ad_prefs = {},
    } = await chrome.storage.local.get({
      ad_dynamic_rules: {},
      ad_playbooks: {},
      ad_prefs: {},
    });
    const nextPrefs = {
      ...ad_prefs,
      lastUpdated: Date.now(),
      mode,
      version: AD_PLAYBOOK_VERSION,
    };
    await chrome.storage.local.set({ ad_prefs: nextPrefs });
    if (mode !== "cosmetic") {
      await clearAllAdSessionRules();
      await clearAllAdDynamicRules();
      if (
        await syncAdDynamicRules({
          adDynamicState: ad_dynamic_rules,
          adPlaybooks: ad_playbooks,
          adPrefs: nextPrefs,
        })
      ) {
        await chrome.storage.local.set({ ad_dynamic_rules });
      }
    } else if (
      await syncAdDynamicRules({
        adDynamicState: ad_dynamic_rules,
        adPlaybooks: ad_playbooks,
        adPrefs: nextPrefs,
      })
    ) {
      await chrome.storage.local.set({ ad_dynamic_rules });
    }
    await broadcastConfigUpdate();
    sendResponse({ mode, ok: true });
  })();
  return true;
};

const adSitesForCleanupDisabled = ({ adPrefs, disabled, now, origin }) => {
  const sites = { ...(adPrefs.sites || adPrefs.site || {}) };
  if (disabled) {
    sites[origin] = {
      ...(sites[origin] || {}),
      cleanupDisabled: true,
      lastDisabledAt: now,
      lastUpdated: now,
      networkDemotedUntil: now + AD_DYNAMIC_DISABLE_COOLDOWN_MS,
    };
    return sites;
  }
  const existing = { ...(sites[origin] || {}) };
  delete existing.cleanupDisabled;
  delete existing.disabled;
  if (existing.lastDisabledAt && !existing.networkDemotedUntil) {
    existing.networkDemotedUntil = existing.lastDisabledAt + AD_DYNAMIC_DISABLE_COOLDOWN_MS;
  }
  if (Object.keys(existing).length > 0) {
    sites[origin] = { ...existing, lastUpdated: now };
  } else {
    delete sites[origin];
  }
  return sites;
};

const markAdPlaybookCleanupDisabled = ({ adPlaybooks, disabled, now, origin }) => {
  if (!adPlaybooks[origin]) return;
  adPlaybooks[origin] = {
    ...adPlaybooks[origin],
    disabled: !!disabled,
    lastUpdated: now,
    version: AD_PLAYBOOK_VERSION,
  };
};

const syncAdDynamicRulesAfterCleanupToggle = async ({
  adDynamicState,
  adPlaybooks,
  adPrefs,
  disabled,
  now,
  origin,
}) => {
  if (disabled) {
    clearAdSessionStateForOrigin(origin);
    await clearAdSessionRulesForOrigin(origin);
    await clearAdDynamicRulesForOrigin(origin, {
      adDynamicState,
      markDemoted: true,
      now,
    });
    return;
  }
  await syncAdDynamicRules({ adDynamicState, adPlaybooks, adPrefs });
};

const setAdCleanupDisabled = async (origin, disabled) => {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return null;
  const {
    ad_dynamic_rules = {},
    ad_prefs = {},
    ad_playbooks = {},
  } = await chrome.storage.local.get({
    ad_dynamic_rules: {},
    ad_playbooks: {},
    ad_prefs: {},
  });
  const now = Date.now();
  const sites = adSitesForCleanupDisabled({ adPrefs: ad_prefs, disabled, now, origin: normalized });
  markAdPlaybookCleanupDisabled({
    adPlaybooks: ad_playbooks,
    disabled,
    now,
    origin: normalized,
  });
  const nextPrefs = {
    ...ad_prefs,
    lastUpdated: now,
    sites,
    version: AD_PLAYBOOK_VERSION,
  };
  delete nextPrefs.site;
  await syncAdDynamicRulesAfterCleanupToggle({
    adDynamicState: ad_dynamic_rules,
    adPlaybooks: ad_playbooks,
    adPrefs: nextPrefs,
    disabled,
    now,
    origin: normalized,
  });
  await chrome.storage.local.set({ ad_dynamic_rules, ad_playbooks, ad_prefs: nextPrefs });
  await broadcastAdCosmeticUpdate(normalized);
  return adSitePrefsFor(normalized, nextPrefs);
};

const handleSetAdCleanupDisabled = (msg, _sender, sendResponse) => {
  (async () => {
    const prefs = await setAdCleanupDisabled(msg.origin, !!msg.disabled);
    sendResponse({ ok: !!prefs, prefs });
  })();
  return true;
};

const dnrRuleMatchesOrigin = (rule, origin, managedRule) => {
  if (!managedRule(rule)) return false;
  const condition = rule.condition || {};
  const domains = [
    ...(condition.initiatorDomains || []),
    ...(condition.excludedInitiatorDomains || []),
  ];
  if (domains.length === 0) return false;
  const host = dnrDomainForOrigin(origin);
  return !!host && domains.some((domain) => domain === host);
};

const sessionRuleMatchesOrigin = (rule, origin) =>
  dnrRuleMatchesOrigin(rule, origin, adSessionRuleIsManaged);

const clearAdSessionRulesForOrigin = async (origin) => {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = rules
      .filter((rule) => sessionRuleMatchesOrigin(rule, origin))
      .map((rule) => rule.id);
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
    }
    return removeRuleIds.length;
  } catch {
    return 0;
  }
};

const dynamicRuleMatchesOrigin = (rule, origin) =>
  dnrRuleMatchesOrigin(rule, origin, adDynamicRuleIsManaged);

const markAdDynamicMetadataForOrigin = ({ deleteMetadata, markDemoted, now, origin, state }) => {
  const rules = adDynamicRuleMapFor(state);
  let changed = false;
  for (const [key, meta] of Object.entries(rules)) {
    if (normalizeOrigin(meta && meta.origin) !== origin) continue;
    changed = true;
    if (deleteMetadata) {
      delete rules[key];
      continue;
    }
    delete meta.ruleId;
    meta.status = "candidate";
    if (markDemoted) {
      meta.breakageCount = Math.max(0, Math.round(meta.breakageCount || 0)) + 1;
      meta.demotedUntil = now + AD_DYNAMIC_DISABLE_COOLDOWN_MS;
      meta.lastBreakageAt = now;
      meta.status = "demoted";
    }
  }
  if (changed) state.lastUpdated = now;
  return changed;
};

const clearAdDynamicRulesForOrigin = async (
  origin,
  { adDynamicState = null, deleteMetadata = false, markDemoted = false, now = Date.now() } = {}
) => {
  const state = adDynamicState ? ensureAdDynamicState(adDynamicState) : null;
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = rules
      .filter((rule) => dynamicRuleMatchesOrigin(rule, origin))
      .map((rule) => rule.id);
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    }
    if (state) {
      markAdDynamicMetadataForOrigin({ deleteMetadata, markDemoted, now, origin, state });
    }
    return removeRuleIds.length;
  } catch {
    return 0;
  }
};

const clearAllAdDynamicRules = async () => {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = rules.filter(adDynamicRuleIsManaged).map((rule) => rule.id);
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    }
    return removeRuleIds.length;
  } catch {
    return 0;
  }
};

const clearAllAdSessionRules = async () => {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = rules.filter(adSessionRuleIsManaged).map((rule) => rule.id);
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
    }
    return removeRuleIds.length;
  } catch {
    return 0;
  }
};

const clearAdDataForOrigin = async (origin) => {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    return { cleared: false, origin: null, removedDynamicRules: 0, removedSessionRules: 0 };
  }
  const {
    ad_dynamic_rules = {},
    ad_log = {},
    ad_playbooks = {},
  } = await chrome.storage.local.get({
    ad_dynamic_rules: {},
    ad_log: {},
    ad_playbooks: {},
  });
  const hadLog = !!ad_log[normalized];
  const hadPlaybook = !!ad_playbooks[normalized];
  const hadDynamicMetadata = adDynamicOriginsForState(ad_dynamic_rules).includes(normalized);
  delete ad_log[normalized];
  delete ad_playbooks[normalized];
  const hadSessionState = clearAdSessionStateForOrigin(normalized);
  markAdDynamicMetadataForOrigin({
    deleteMetadata: true,
    now: Date.now(),
    origin: normalized,
    state: ensureAdDynamicState(ad_dynamic_rules),
  });
  await chrome.storage.local.set({ ad_log, ad_playbooks });
  const removedSessionRules = await clearAdSessionRulesForOrigin(normalized);
  const removedDynamicRules = await clearAdDynamicRulesForOrigin(normalized);
  await chrome.storage.local.set({ ad_dynamic_rules });
  await broadcastAdCosmeticUpdate(normalized);
  return {
    cleared:
      hadLog ||
      hadPlaybook ||
      hadDynamicMetadata ||
      hadSessionState ||
      removedSessionRules > 0 ||
      removedDynamicRules > 0,
    origin: normalized,
    removedDynamicRules,
    removedSessionRules,
  };
};

const handleClearAdSiteData = (msg, _sender, sendResponse) => {
  (async () => {
    const result = await serialize(() => clearAdDataForOrigin(msg.origin));
    sendResponse({ ok: !!(result && result.origin), ...result });
  })();
  return true;
};

const clearAdPersistentNetworkForOrigin = async (origin) => {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return { cleared: false, origin: null, removedDynamicRules: 0 };
  const { ad_dynamic_rules = {} } = await chrome.storage.local.get({ ad_dynamic_rules: {} });
  const hadDynamicMetadata = adDynamicOriginsForState(ad_dynamic_rules).includes(normalized);
  markAdDynamicMetadataForOrigin({
    deleteMetadata: true,
    now: Date.now(),
    origin: normalized,
    state: ensureAdDynamicState(ad_dynamic_rules),
  });
  const removedDynamicRules = await clearAdDynamicRulesForOrigin(normalized);
  await chrome.storage.local.set({ ad_dynamic_rules });
  return {
    cleared: hadDynamicMetadata || removedDynamicRules > 0,
    origin: normalized,
    removedDynamicRules,
  };
};

const handleClearAdPersistentNetwork = (msg, _sender, sendResponse) => {
  (async () => {
    const result = await serialize(() => clearAdPersistentNetworkForOrigin(msg.origin));
    sendResponse({ ok: !!(result && result.origin), ...result });
  })();
  return true;
};

const diagnosticTotalsForEvents = (events) => {
  const totals = {};
  for (const event of events || []) {
    const type = event && event.type ? event.type : "unknown";
    totals[type] = (totals[type] || 0) + 1;
  }
  return totals;
};

const removeDiagnosticEventsForOriginType = (diagnosticLog, origin, type) => {
  const entry = diagnosticLog[origin];
  if (!(entry && Array.isArray(entry.events))) return 0;
  const kept = entry.events.filter((event) => event && event.type !== type);
  const removed = entry.events.length - kept.length;
  if (removed <= 0) return 0;
  if (kept.length === 0) {
    delete diagnosticLog[origin];
    return removed;
  }
  entry.events = kept;
  entry.totals = diagnosticTotalsForEvents(kept);
  entry.lastUpdated = Date.now();
  diagnosticLog[origin] = entry;
  return removed;
};

const clearAdaptiveDataForOrigin = async (origin) => {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return { cleared: false, origin: null, removedDiagnosticEvents: 0 };
  const { adaptive_log = {}, diagnostic_log = {} } = await chrome.storage.local.get({
    adaptive_log: {},
    diagnostic_log: {},
  });
  const hadAdaptiveLog = !!adaptive_log[normalized];
  delete adaptive_log[normalized];
  const removedDiagnosticEvents = removeDiagnosticEventsForOriginType(
    diagnostic_log,
    normalized,
    "adaptive"
  );
  await chrome.storage.local.set({ adaptive_log, diagnostic_log });
  return {
    cleared: hadAdaptiveLog || removedDiagnosticEvents > 0,
    origin: normalized,
    removedDiagnosticEvents,
  };
};

const handleClearAdaptiveSiteData = (msg, _sender, sendResponse) => {
  (async () => {
    const result = await serialize(() => clearAdaptiveDataForOrigin(msg.origin));
    sendResponse({ ok: !!(result && result.origin), ...result });
  })();
  return true;
};

const handleExportLog = (_msg, _sender, sendResponse) => {
  (async () => {
    const {
      probe_log = {},
      replay_log = {},
      adaptive_log = {},
      ad_dynamic_rules = {},
      ad_log = {},
      ad_playbooks = {},
      ad_prefs = {},
      diagnostic_log = {},
      diagnostics_mode = false,
      fingerprint_mode = "off",
      cumulative = 0,
    } = await chrome.storage.local.get({
      probe_log: {},
      replay_log: {},
      adaptive_log: {},
      ad_dynamic_rules: {},
      ad_log: {},
      ad_playbooks: {},
      ad_prefs: {},
      diagnostic_log: {},
      diagnostics_mode: false,
      fingerprint_mode: "off",
      cumulative: 0,
    });
    const adSessionRules = await adSessionRuleSummariesForOrigin(null);
    const adDynamicRules = await adDynamicRuleSummariesForOrigin(null, ad_dynamic_rules);
    const adDynamicRecovery = adDynamicRecoverySummariesForOrigin(null, ad_dynamic_rules);
    sendResponse({
      schema: "static.probe-log.v1",
      exportedAt: new Date().toISOString(),
      cumulative,
      diagnostics: diagnostic_log,
      diagnosticsMode: diagnostics_mode,
      fingerprintMode: fingerprint_mode,
      origins: probe_log,
      replayDetections: replay_log,
      adaptiveSignals: adaptiveLogWithDiagnostics(adaptive_log),
      adBehavior: ad_log,
      adDynamicRecovery,
      adDynamicRules,
      adPlaybooks: ad_playbooks,
      adPrefs: ad_prefs,
      adSessionRules,
    });
  })();
  return true;
};

const handleClearLog = (_msg, _sender, sendResponse) => {
  (async () => {
    cachedSecretPromise = null;
    clearAllAdSessionState();
    await clearAllAdSessionRules();
    await clearAllAdDynamicRules();
    await serialize(() =>
      chrome.storage.local.remove([
        "probe_log",
        "replay_log",
        "adaptive_log",
        "ad_dynamic_rules",
        "ad_log",
        "ad_playbooks",
        "diagnostic_log",
        "cumulative",
        "user_secret",
      ])
    );
    await clearTabStateAndBadges();
    await broadcastConfigUpdate({ resetProbeState: true });
    await broadcastAdCosmeticUpdate(null);
    sendResponse({ ok: true });
  })();
  return true;
};

const messageHandlers = {
  static_ad_signal: handleAdSignal,
  static_adaptive_signal: handleAdaptiveSignal,
  static_clear_adaptive_site_data: handleClearAdaptiveSiteData,
  static_clear_ad_persistent_network: handleClearAdPersistentNetwork,
  static_clear_ad_site_data: handleClearAdSiteData,
  static_clear_log: handleClearLog,
  static_export_log: handleExportLog,
  static_get_ad_cosmetic_config: handleGetAdCosmeticConfig,
  static_get_details: handleGetDetails,
  static_get_persona: handleGetPersona,
  static_probe_blocked: handleProbeBlocked,
  static_replay_detected: handleReplayDetected,
  static_set_diagnostics: handleSetDiagnostics,
  static_set_ad_cleanup_mode: handleSetAdCleanupMode,
  static_set_ad_cleanup_disabled: handleSetAdCleanupDisabled,
  static_set_fingerprint: handleSetFingerprint,
  static_set_noise: handleSetNoise,
  static_set_replay: handleSetReplay,
};

const syncStoredAdDynamicRules = async () => {
  const {
    ad_dynamic_rules = {},
    ad_playbooks = {},
    ad_prefs = {},
  } = await chrome.storage.local.get({
    ad_dynamic_rules: {},
    ad_playbooks: {},
    ad_prefs: {},
  });
  if (
    await syncAdDynamicRules({
      adDynamicState: ad_dynamic_rules,
      adPlaybooks: ad_playbooks,
      adPrefs: ad_prefs,
    })
  ) {
    await chrome.storage.local.set({ ad_dynamic_rules });
  }
};

syncStoredAdDynamicRules().catch(() => {});
chrome.runtime.onStartup.addListener(() => {
  serialize(syncStoredAdDynamicRules);
});
chrome.runtime.onInstalled.addListener(() => {
  serialize(syncStoredAdDynamicRules);
});

// ─── Message router ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && messageHandlers[msg.type];
  return handler ? handler(msg, sender, sendResponse) : undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  perTabState.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    perTabState.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }
});
