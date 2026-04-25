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

importScripts("lists.js", "service_worker_utils.js");
const CFG = globalThis.__static_config__ || {};
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

const storedEntryForOrigin = (origin, log) => (origin ? log[origin] : null);

const loggedOriginsFor = (stored) =>
  new Set([
    ...Object.keys(stored.probe_log),
    ...Object.keys(stored.replay_log),
    ...Object.keys(stored.adaptive_log),
    ...Object.keys(stored.diagnostic_log),
  ]);

const diagnosticEventCountFor = (entry) => (entry ? (entry.events || []).length : 0);

const detailsResponseFor = async (tabId, stored) => {
  const state = perTabState.get(tabId);
  const origin = state ? state.origin : null;
  const originProbeEntry = storedEntryForOrigin(origin, stored.probe_log);
  const adaptiveEntry = storedEntryForOrigin(origin, stored.adaptive_log);
  const diagnosticEntry = storedEntryForOrigin(origin, stored.diagnostic_log);
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
    adaptiveDetected: !!adaptiveEntry,
    adaptiveScore: adaptiveEntry ? adaptiveEntry.scoreMax || 0 : 0,
    adaptiveCategories: adaptiveEntry ? adaptiveEntry.categories || {} : {},
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

const handleExportLog = (_msg, _sender, sendResponse) => {
  (async () => {
    const {
      probe_log = {},
      replay_log = {},
      adaptive_log = {},
      diagnostic_log = {},
      diagnostics_mode = false,
      fingerprint_mode = "off",
      cumulative = 0,
    } = await chrome.storage.local.get({
      probe_log: {},
      replay_log: {},
      adaptive_log: {},
      diagnostic_log: {},
      diagnostics_mode: false,
      fingerprint_mode: "off",
      cumulative: 0,
    });
    sendResponse({
      schema: "static.probe-log.v1",
      exportedAt: new Date().toISOString(),
      cumulative,
      diagnostics: diagnostic_log,
      diagnosticsMode: diagnostics_mode,
      fingerprintMode: fingerprint_mode,
      origins: probe_log,
      replayDetections: replay_log,
      adaptiveSignals: adaptive_log,
    });
  })();
  return true;
};

const handleClearLog = (_msg, _sender, sendResponse) => {
  (async () => {
    cachedSecretPromise = null;
    await serialize(() =>
      chrome.storage.local.remove([
        "probe_log",
        "replay_log",
        "adaptive_log",
        "diagnostic_log",
        "cumulative",
        "user_secret",
      ])
    );
    await clearTabStateAndBadges();
    await broadcastConfigUpdate({ resetProbeState: true });
    sendResponse({ ok: true });
  })();
  return true;
};

const messageHandlers = {
  static_adaptive_signal: handleAdaptiveSignal,
  static_clear_log: handleClearLog,
  static_export_log: handleExportLog,
  static_get_details: handleGetDetails,
  static_get_persona: handleGetPersona,
  static_probe_blocked: handleProbeBlocked,
  static_replay_detected: handleReplayDetected,
  static_set_diagnostics: handleSetDiagnostics,
  static_set_fingerprint: handleSetFingerprint,
  static_set_noise: handleSetNoise,
  static_set_replay: handleSetReplay,
};

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
