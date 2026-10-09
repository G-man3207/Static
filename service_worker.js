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
//      `static_set_diagnostics`, `static_set_research_logging`) and bridge
//      queries (`static_get_persona`).
//   9. When a site is paused, install initiator-scoped DNR allow rules so
//      global fingerprint/CAPTCHA lists do not keep blocking that origin.
//  10. Register the content scripts: paused sites and switched-off features
//      get none of Static's page code.

// In the event-page fallback path (Firefox background.scripts), the deps
// are loaded as sequential <script> tags before this file, so importScripts
// is unnecessary — and undefined.  Guard so both paths work cleanly.
if (typeof importScripts === "function") {
  importScripts("lists.js", "service_worker_utils.js");
}
const CFG = globalThis.__static_config__;
const SW_HELPERS = CFG.helpers;
const {
  CONTENT_SCRIPT_SETTINGS,
  contentScriptRegistrationsFor,
  contentScriptsInSync,
  enforceCaps,
  isOriginPaused,
  pausedOriginsLike,
  ensurePlaybookWeek,
  latestPlaybookSnapshot,
  mergeCounts,
  personaDiagnosticsFor,
  playbookDriftForEntry,
  sumCounts,
  trimCountMap,
  trimLogOrigins,
} = globalThis.__static_sw_utils__;

// Whether diagnostics logging is active (mirrors the `diagnostics_mode` storage
// flag). safeLog only emits when this is true, so error swallows stay silent
// in normal use but surface during QA.
let diagnosticsEnabled = false;
const safeLog = (err, label) => {
  if (diagnosticsEnabled) console.error(`[Static] ${label}:`, err);
};

// ─── DNR header-rule management for network-layer fingerprint spoofing ────
const UA_RULE_ID_BASE = 10_000;
const PAUSE_ALLOW_RULE_ID_BASE = 30_000;
const PAUSE_ALLOW_RULE_ID_MAX = 39_999;
const HEADER_RULE_ID_MAX = PAUSE_ALLOW_RULE_ID_BASE - 1;
const isHeaderRuleId = (id) => id >= UA_RULE_ID_BASE && id <= HEADER_RULE_ID_MAX;
const isPauseAllowRuleId = (id) => id >= PAUSE_ALLOW_RULE_ID_BASE && id <= PAUSE_ALLOW_RULE_ID_MAX;
const SEC_CH_UA_HEADERS = [
  "Sec-CH-UA",
  "Sec-CH-UA-Arch",
  "Sec-CH-UA-Bitness",
  "Sec-CH-UA-Full-Version",
  "Sec-CH-UA-Full-Version-List",
  "Sec-CH-UA-Mobile",
  "Sec-CH-UA-Model",
  "Sec-CH-UA-Platform",
  "Sec-CH-UA-Platform-Version",
  "Sec-CH-UA-WoW64",
];

// Tracks in-memory state: origin -> { ruleId, uaString, lastUsed }
// Persisted to chrome.storage.local (key "header_rules") so rules survive
// service-worker restarts instead of leaking as orphans or being recreated
// with ever-increasing IDs.
const originHeaderRules = new Map();
const HEADER_RULES_STORAGE_KEY = "header_rules";
const MAX_HEADER_RULE_ORIGINS = 150; // LRU cap (DNR dynamic-rule budget is finite)
let dnrNextRuleId = UA_RULE_ID_BASE;

// Every frame of a page asks for its persona as it starts, so header-rule
// changes for one origin arrive together. They run one at a time: run
// concurrently, each would add its own rule, and the untracked ones would keep
// spoofing the site after it is paused.
let headerRuleChain = Promise.resolve();
const queueHeaderRuleChange = (fn) => {
  headerRuleChain = headerRuleChain.then(fn).catch((err) => safeLog(err, "header rule change"));
  return headerRuleChain;
};

const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
];

const userAgentStringFor = (uaOs) => {
  // Build the same UA string format as block_fingerprint.js's maskedUa()
  const realUA = globalThis.navigator && globalThis.navigator.userAgent;
  if (typeof realUA === "string" && realUA.includes("(") && realUA.includes(")")) {
    return realUA.replace(/\([^)]*\)/, `(${uaOs})`);
  }
  return `Mozilla/5.0 (${uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`;
};

const ensureOriginHeaderRule = (origin, fingerprintMode, persona) =>
  queueHeaderRuleChange(async () => {
    if (!origin || fingerprintMode !== "mask" || !persona || !persona.uaOs) return;

    const uaString = userAgentStringFor(persona.uaOs);
    const existing = originHeaderRules.get(origin);
    if (existing && existing.uaString === uaString) {
      existing.lastUsed = Date.now();
      return;
    }

    // Remove stale rule for this origin first
    await dropOriginHeaderRule(origin);

    const hostname = new URL(origin).hostname;

    // Build a single modifyHeaders rule that sets User-Agent AND strips Sec-CH-UA
    const requestHeaders = [{ header: "User-Agent", operation: "set", value: uaString }];
    for (const header of SEC_CH_UA_HEADERS) {
      requestHeaders.push({ header, operation: "remove" });
    }

    const ruleId = dnrNextRuleId++;
    if (dnrNextRuleId > HEADER_RULE_ID_MAX) dnrNextRuleId = UA_RULE_ID_BASE;
    const rule = {
      id: ruleId,
      priority: 100,
      action: { type: "modifyHeaders", requestHeaders },
      condition: headerRuleConditionFor(hostname),
    };

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
    } catch (_err) {
      // If adding fails (e.g. rule limit exceeded), silently skip
      return;
    }

    originHeaderRules.set(origin, { ruleId, uaString, lastUsed: Date.now() });
    evictExcessHeaderRules();
    await persistHeaderRules();
  });

// Build a DNR condition that matches requests to `hostname` without matching
// it as an arbitrary substring of a larger URL. requestDomains does not apply
// to bare IPs or localhost, so those get a regexFilter anchored to scheme+host.
const headerRuleConditionFor = (hostname) => {
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname === "localhost";
  if (isIp) {
    const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      regexFilter: `^https?://${escaped}([:/]|$)`,
      resourceTypes: ALL_RESOURCE_TYPES,
    };
  }
  return { requestDomains: [hostname], resourceTypes: ALL_RESOURCE_TYPES };
};

const dropOriginHeaderRule = async (origin) => {
  const existing = originHeaderRules.get(origin);
  if (!existing) return;

  originHeaderRules.delete(origin);
  await persistHeaderRules();

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [existing.ruleId] });
  } catch {
    // Ignore removal errors — rule may already be gone
  }
};

const removeOriginHeaderRule = (origin) =>
  queueHeaderRuleChange(() => dropOriginHeaderRule(origin));

// LRU eviction: if the map exceeds the cap, drop the least-recently-used
// origins (smallest lastUsed) until under the limit.
const evictExcessHeaderRules = async () => {
  if (originHeaderRules.size <= MAX_HEADER_RULE_ORIGINS) return;
  const entries = [...originHeaderRules.entries()].sort(
    (a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0)
  );
  const removeRuleIds = [];
  while (originHeaderRules.size > MAX_HEADER_RULE_ORIGINS && entries.length > 0) {
    const [origin, entry] = entries.shift();
    originHeaderRules.delete(origin);
    removeRuleIds.push(entry.ruleId);
  }
  if (removeRuleIds.length === 0) return;
  await persistHeaderRules();
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  } catch {
    // Ignore removal errors
  }
};

// Persist the in-memory rule map so a restarted service worker can reconcile
// against the live DNR rules instead of orphaning them.
const persistHeaderRules = () =>
  serialize(async () => {
    await chrome.storage.local.set({
      [HEADER_RULES_STORAGE_KEY]: Object.fromEntries(originHeaderRules),
    });
  });

const clearAllHeaderRules = () =>
  queueHeaderRuleChange(async () => {
    const ruleIds = new Set([...originHeaderRules.values()].map((entry) => entry.ruleId));
    originHeaderRules.clear();
    await persistHeaderRules();

    // Always sweep our whole ID range to catch any orphaned rules from a prior
    // session, even if the in-memory map was already empty.
    try {
      for (const rule of await chrome.declarativeNetRequest.getDynamicRules()) {
        if (isHeaderRuleId(rule.id)) ruleIds.add(rule.id);
      }
    } catch {}

    if (ruleIds.size === 0) return;

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [...ruleIds] });
    } catch {}
  });

const cleanupStaleHeaderRules = async () => {
  // Called on service-worker init. Reconcile the persisted rule map against
  // the live DNR rules: keep rules that still exist, drop orphans, and reset
  // the next-rule-id counter above the highest known id.
  try {
    const { [HEADER_RULES_STORAGE_KEY]: stored = {} } =
      await chrome.storage.local.get(HEADER_RULES_STORAGE_KEY);
    const liveRuleIds = new Set();
    try {
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      for (const r of existingRules) {
        if (isHeaderRuleId(r.id)) liveRuleIds.add(r.id);
      }
    } catch (err) {
      safeLog(err, "read dynamic rules");
    }

    originHeaderRules.clear();
    let maxId = UA_RULE_ID_BASE - 1;
    for (const [origin, entry] of Object.entries(stored || {})) {
      if (entry && typeof entry.ruleId === "number" && liveRuleIds.has(entry.ruleId)) {
        originHeaderRules.set(origin, entry);
        if (entry.ruleId > maxId) maxId = entry.ruleId;
      }
    }

    // Remove orphan DNR rules in our range that have no persisted entry.
    const knownIds = new Set([...originHeaderRules.values()].map((e) => e.ruleId));
    const orphanIds = [...liveRuleIds].filter((id) => !knownIds.has(id));
    if (orphanIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: orphanIds });
    }

    dnrNextRuleId = Math.min(maxId + 1, HEADER_RULE_ID_MAX);
    await persistHeaderRules();
  } catch {
    dnrNextRuleId = UA_RULE_ID_BASE;
  }
};

// ─── DNR allow rules for paused origins ──────────────────────────────────
// Static's fingerprint/CAPTCHA rulesets are global. Pausing a site must also
// let that origin's requests through those lists, otherwise "pause and reload"
// would not fix login/checkout breakage caused by vendor blocking.
// Each paused host gets two rules: "initiator" lets through requests the site
// starts itself (including from its workers); "frames" lets through everything
// inside its pages, because bot-check iframes it embeds (Turnstile, Arkose…)
// make their own requests with their own origin as the initiator.
const PAUSE_ALLOW_KINDS = ["initiator", "frames"];
const originPauseAllowRules = new Map(); // "<kind>:<hostname>" -> ruleId
let pauseAllowNextRuleId = PAUSE_ALLOW_RULE_ID_BASE;

const hostnameForPauseAllow = (origin) => {
  try {
    const hostname = new URL(origin).hostname;
    if (!hostname) return null;
    if (hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
    return hostname;
  } catch {
    return null;
  }
};

const nextPauseAllowRuleId = (usedIds) => {
  const take = (id) => {
    if (usedIds.has(id)) return null;
    pauseAllowNextRuleId = id >= PAUSE_ALLOW_RULE_ID_MAX ? PAUSE_ALLOW_RULE_ID_BASE : id + 1;
    return id;
  };
  for (let id = pauseAllowNextRuleId; id <= PAUSE_ALLOW_RULE_ID_MAX; id++) {
    const chosen = take(id);
    if (chosen != null) return chosen;
  }
  for (let id = PAUSE_ALLOW_RULE_ID_BASE; id < pauseAllowNextRuleId; id++) {
    const chosen = take(id);
    if (chosen != null) return chosen;
  }
  return null;
};

const pauseAllowRuleFor = (ruleId, key) => {
  const kind = key.slice(0, key.indexOf(":"));
  const hostname = key.slice(key.indexOf(":") + 1);
  if (kind === "frames") {
    return {
      action: { type: "allowAllRequests" },
      condition: { requestDomains: [hostname], resourceTypes: ["main_frame", "sub_frame"] },
      id: ruleId,
      priority: 1000,
    };
  }
  return {
    action: { type: "allow" },
    condition: { initiatorDomains: [hostname], resourceTypes: ALL_RESOURCE_TYPES },
    id: ruleId,
    priority: 1000,
  };
};

const addDynamicRule = async (rule) => {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
    return true;
  } catch {
    const types = (rule.condition && rule.condition.resourceTypes) || [];
    const filtered = types.filter(
      (typeName) => typeName === "websocket" || !typeName.startsWith("web")
    );
    if (filtered.length === types.length) return false;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{ ...rule, condition: { ...rule.condition, resourceTypes: filtered } }],
      });
      return true;
    } catch {
      return false;
    }
  }
};

const wantedPauseAllowKeys = (disabledOrigins) => {
  const wanted = new Set();
  for (const [origin, disabled] of Object.entries(disabledOrigins || {})) {
    if (!disabled) continue;
    const hostname = hostnameForPauseAllow(origin);
    if (!hostname) continue;
    for (const kind of PAUSE_ALLOW_KINDS) wanted.add(`${kind}:${hostname}`);
  }
  return wanted;
};

const pauseAllowKeyFromRule = (rule) => {
  const condition = rule.condition || {};
  if (rule.action && rule.action.type === "allowAllRequests") {
    return Array.isArray(condition.requestDomains) ? `frames:${condition.requestDomains[0]}` : null;
  }
  return Array.isArray(condition.initiatorDomains)
    ? `initiator:${condition.initiatorDomains[0]}`
    : null;
};

const keepOrDropLivePauseAllowRule = (rule, wanted, state) => {
  const key = pauseAllowKeyFromRule(rule);
  if (!key || !wanted.has(key) || state.seenKeys.has(key)) {
    state.removeRuleIds.push(rule.id);
    state.usedIds.delete(rule.id);
    return;
  }
  state.seenKeys.add(key);
  originPauseAllowRules.set(key, rule.id);
  if (rule.id >= pauseAllowNextRuleId) {
    pauseAllowNextRuleId =
      rule.id >= PAUSE_ALLOW_RULE_ID_MAX ? PAUSE_ALLOW_RULE_ID_BASE : rule.id + 1;
  }
};

const addMissingPauseAllowRules = async (wanted, usedIds) => {
  for (const key of wanted) {
    if (originPauseAllowRules.has(key)) continue;
    const ruleId = nextPauseAllowRuleId(usedIds);
    if (ruleId == null) break;
    const added = await addDynamicRule(pauseAllowRuleFor(ruleId, key));
    if (!added) continue;
    usedIds.add(ruleId);
    originPauseAllowRules.set(key, ruleId);
  }
};

const reconcilePauseAllowRules = async (disabledOrigins) => {
  const wanted = wantedPauseAllowKeys(disabledOrigins);
  let live;
  try {
    live = await chrome.declarativeNetRequest.getDynamicRules();
  } catch (err) {
    safeLog(err, "read pause-allow rules");
    return;
  }

  const state = {
    removeRuleIds: [],
    seenKeys: new Set(),
    usedIds: new Set(live.map((rule) => rule.id)),
  };
  originPauseAllowRules.clear();
  for (const rule of live.filter((entry) => isPauseAllowRuleId(entry.id))) {
    keepOrDropLivePauseAllowRule(rule, wanted, state);
  }

  if (state.removeRuleIds.length > 0) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: state.removeRuleIds });
    } catch (err) {
      safeLog(err, "remove pause-allow rules");
    }
  }

  await addMissingPauseAllowRules(wanted, state.usedIds);
};

const reconcilePauseAllowRulesFromStorage = () =>
  serialize(async () => {
    const { disabled_origins = {} } = await chrome.storage.local.get({ disabled_origins: {} });
    await reconcilePauseAllowRules(disabled_origins);
  });

// ─── In-memory per-tab state ──────────────────────────────────────────────
const perTabState = new Map(); // tabId -> { origin, frames: Map<frameId, {total, idCounts}> }
const isValidExtensionId = (id) => SW_HELPERS.isValidExtensionId(id);
const MAX_CAPTURED_IDS = 2000;
const MAX_COMPAT_ORIGINS = 50;
const MAX_DIAGNOSTIC_EVENTS_PER_ORIGIN = 120;
const MAX_DIAGNOSTIC_ORIGINS = 25;
const COMPAT_WARNING_TTL_MS = 30 * 60 * 1000;
const compatEntryIsFresh = (entry) =>
  !!(entry && entry.lastUpdated && Date.now() - entry.lastUpdated <= COMPAT_WARNING_TTL_MS);

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

const DISABLED_BADGE_COLOR = "#888";
const COMPAT_BADGE_COLOR = "#d88030";

const updateBadgeForTab = async (tabId, tabUrl) => {
  let origin = null;
  try {
    origin = originFromUrl(tabUrl || (await chrome.tabs.get(tabId)).url);
  } catch {
    // tab may have been removed
  }
  if (!origin) {
    // No origin available — clear badge
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    return;
  }
  try {
    const { compat_log = {}, disabled_origins = {} } = await chrome.storage.local.get({
      compat_log: {},
      disabled_origins: {},
    });
    if (isOriginPaused(origin, disabled_origins)) {
      chrome.action.setBadgeText({ tabId, text: "OFF" }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: DISABLED_BADGE_COLOR }).catch(() => {});
      return;
    }
    if (compatEntryIsFresh(compat_log[origin])) {
      chrome.action.setBadgeText({ tabId, text: "!" }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: COMPAT_BADGE_COLOR }).catch(() => {});
      return;
    }
  } catch {
    // storage read failed
  }
  // Fall through to normal probe-count badge
  const total = sumTabTotal(tabId);
  updateBadge(tabId, total);
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
  } catch (err) {
    safeLog(err, "clear tab state");
  }
};

// ─── Persistent storage (serialized writes) ───────────────────────────────
let writeChain = Promise.resolve();
const serialize = (fn) => {
  writeChain = writeChain.then(fn).catch(() => {});
  return writeChain;
};

// ─── On-demand content scripts ────────────────────────────────────────────
// Registered here instead of in the manifest so paused sites get no Static
// code at all and switched-off features stay unloaded. Browsers drop these
// registrations on every extension update, so they are re-checked on worker
// start, install/update, browser startup, and relevant setting changes.
let contentScriptChain = Promise.resolve();

const applyContentScriptRegistrations = async () => {
  const settings = await chrome.storage.local.get(CONTENT_SCRIPT_SETTINGS);
  const desired = contentScriptRegistrationsFor(settings);
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (contentScriptsInSync(registered, desired)) return;
  const registeredIds = registered.map((script) => script.id);
  const sameIds =
    registeredIds.length === desired.length &&
    desired.every((script) => registeredIds.includes(script.id));
  if (sameIds) {
    await chrome.scripting.updateContentScripts(desired);
    return;
  }
  // Fresh install, update, or leftovers: register both in one call so Chrome
  // keeps ID order (page world first).
  if (registeredIds.length) await chrome.scripting.unregisterContentScripts();
  await chrome.scripting.registerContentScripts(desired);
};

// Overlapping register/update calls fail, so runs are queued. Each run
// re-reads storage and does nothing when the registrations already match.
const syncContentScripts = () => {
  contentScriptChain = contentScriptChain
    .then(applyContentScriptRegistrations)
    .catch((err) => safeLog(err, "content script sync"));
  return contentScriptChain;
};

const addToCumulative = async (delta) => {
  const { cumulative = 0 } = await chrome.storage.local.get({ cumulative: 0 });
  await chrome.storage.local.set({ cumulative: cumulative + delta });
};

const sanitizeExtensionIdCounts = (counts) => {
  const sanitized = {};
  for (const [id, count] of Object.entries(counts || {})) {
    const safeId = id.toLowerCase();
    if (isValidExtensionId(safeId) && typeof count === "number" && count > 0) {
      sanitized[safeId] = (sanitized[safeId] || 0) + count;
    }
  }
  return trimCountMap(sanitized, MAX_CAPTURED_IDS, SW_HELPERS.knownPersonaIds());
};

const sanitizeExtensionIdPaths = (idPaths) => {
  const out = {};
  for (const [id, paths] of Object.entries(idPaths || {})) {
    const safeId = id.toLowerCase();
    if (!isValidExtensionId(safeId) || !paths || typeof paths !== "object") continue;
    const sanitized = {};
    for (const [path, count] of Object.entries(paths)) {
      const safePath = SW_HELPERS.sanitizeExtensionPath(path);
      if (!safePath || typeof count !== "number" || count <= 0) continue;
      sanitized[safePath] = (sanitized[safePath] || 0) + count;
    }
    if (Object.keys(sanitized).length) out[safeId] = trimCountMap(sanitized, CFG.maxPathsPerId);
  }
  return out;
};

const mergeIdPaths = (target, source) => {
  let changed = false;
  for (const [id, paths] of Object.entries(source || {})) {
    target[id] ||= {};
    if (mergeCounts(target[id], paths)) changed = true;
    target[id] = trimCountMap(target[id], CFG.maxPathsPerId);
  }
  return changed;
};

const personaPathsFor = (entry, ids) => {
  const minCount = CFG.personaMinPathCount || 2;
  const out = {};
  if (!entry || !entry.idPaths) return out;
  for (const id of ids) {
    const eligible = SW_HELPERS.eligiblePathsForId(entry.idPaths[id], minCount);
    if (eligible.length) out[id] = eligible;
  }
  return out;
};

const normalizedProbeBatch = (batch) => {
  const deltaVectorCounts = batch && batch.deltaVectorCounts ? batch.deltaVectorCounts : {};
  return {
    deltaIdCounts:
      batch && batch.deltaIdCounts ? sanitizeExtensionIdCounts(batch.deltaIdCounts) : {},
    deltaIdPaths: batch && batch.deltaIdPaths ? sanitizeExtensionIdPaths(batch.deltaIdPaths) : {},
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
  entry.idPaths ||= {};
  const now = Date.now();
  const normalized = normalizedProbeBatch(batch);
  const countChanged = mergeCounts(entry.idCounts, normalized.deltaIdCounts);
  const pathChanged = mergeIdPaths(entry.idPaths, normalized.deltaIdPaths);
  const weekChanged = mergeProbeWeek(entry, normalized, now);
  const changed = countChanged || pathChanged || weekChanged;
  if (!changed) return;
  entry.lastUpdated = now;
  probe_log[origin] = entry;
  enforceCaps(probe_log);
  await chrome.storage.local.set({ probe_log });
};

const recordReplayDetection = async (origin, signal) => {
  if (!origin) return;
  const replay_log = await chrome.storage.local
    .get({ replay_log: {} })
    .then((r) => r.replay_log || {});
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
  const adaptive_log = await chrome.storage.local
    .get({ adaptive_log: {} })
    .then((r) => r.adaptive_log || {});
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

const normalizeCompatSignal = (signal) => ({
  kind: String((signal && signal.kind) || "unknown").slice(0, 64),
  pathKind: String((signal && signal.pathKind) || "unknown").slice(0, 32),
  vector: String((signal && signal.vector) || "unknown").slice(0, 48),
});

const recordCompatSignal = async (origin, signal) => {
  if (!origin || !signal || typeof signal !== "object") return;
  const compat_log = await chrome.storage.local
    .get({ compat_log: {} })
    .then((r) => r.compat_log || {});
  const now = Date.now();
  const entry = compat_log[origin] || {
    kinds: {},
    lastUpdated: 0,
    pathKinds: {},
    total: 0,
    vectors: {},
  };
  const normalized = normalizeCompatSignal(signal);
  entry.kinds ||= {};
  entry.pathKinds ||= {};
  entry.vectors ||= {};
  entry.total = (entry.total || 0) + 1;
  entry.lastUpdated = now;
  bumpCount(entry.kinds, normalized.kind);
  bumpCount(entry.pathKinds, normalized.pathKind);
  bumpCount(entry.vectors, normalized.vector);
  entry.kinds = trimCountMap(entry.kinds, 20);
  entry.pathKinds = trimCountMap(entry.pathKinds, 20);
  entry.vectors = trimCountMap(entry.vectors, 20);
  compat_log[origin] = entry;
  trimLogOrigins(compat_log, MAX_COMPAT_ORIGINS);
  await chrome.storage.local.set({ compat_log });
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
      extensionId: isValidExtensionId(extensionId) ? extensionId : null,
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
  if (type === "compat") {
    return {
      ...base,
      action: "warned",
      kind: safeDiagnosticText(event.kind, "unknown", 64),
      pathKind: safeDiagnosticText(event.pathKind, "unknown", 32),
      vector: safeDiagnosticText(event.vector, "unknown", 48),
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
  const { diagnostics_mode = false } = await chrome.storage.local.get({
    diagnostics_mode: false,
  });
  if (!diagnostics_mode) return;
  const diagnostic_log = await chrome.storage.local
    .get({ diagnostic_log: {} })
    .then((r) => r.diagnostic_log || {});

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

const eligiblePersonaIds = (entry) => {
  const minCount = CFG.personaMinCount || 2;
  const unknownMinCount = CFG.unknownPersonaMinCount || 20;
  const knownIds = SW_HELPERS.knownPersonaIds();
  return Object.entries(entry.idCounts)
    .filter(([id, c]) => {
      const safeId = id.toLowerCase();
      const threshold = knownIds.has(safeId) ? minCount : unknownMinCount;
      return isValidExtensionId(safeId) && typeof c === "number" && c >= threshold;
    })
    .map(([id]) => id.toLowerCase());
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
  const { bySlot, unslotted } = splitIdsBySlot(eligible, SW_HELPERS.buildConflictSlotMap());
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

const rememberSenderOrigin = (sender) => {
  const origin = originFromUrl(sender && sender.tab && sender.tab.url);
  if (origin && sender.tab) getOrInitTab(sender.tab.id).origin = origin;
  return origin;
};

const handleProbeBlocked = (msg, sender) => {
  if (!sender.tab) return;
  const tabId = sender.tab.id;
  const origin = rememberSenderOrigin(sender);
  getOrInitTab(tabId).frames.set(sender.frameId || 0, {
    total: msg.frameTotal || 0,
    idCounts: new Map(Object.entries(sanitizeExtensionIdCounts(msg.idCounts))),
  });
  updateBadgeForTab(tabId, sender.tab && sender.tab.url);

  const delta = typeof msg.delta === "number" ? msg.delta : 0;
  if (delta > 0) serialize(() => addToCumulative(delta));
  if (origin && delta > 0) {
    serialize(() =>
      recordProbes(origin, {
        delta,
        deltaIdCounts: msg.deltaIdCounts || {},
        deltaPathKindCounts: msg.deltaPathKindCounts || {},
        deltaIdPaths: msg.deltaIdPaths || {},
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

const handleCompatSignal = (msg, sender) => {
  if (!sender.tab) return;
  const origin = rememberSenderOrigin(sender);
  if (!origin || !msg.signal || typeof msg.signal !== "object") return;
  const normalized = normalizeCompatSignal(msg.signal);
  serialize(() => recordCompatSignal(origin, normalized));
  serialize(() => recordDiagnosticEvents(origin, [{ ...normalized, type: "compat" }]));
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

const topCompatEntries = (counts) =>
  Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

const compatWarningForEntry = (entry) => {
  if (!compatEntryIsFresh(entry)) {
    return null;
  }
  return {
    kinds: topCompatEntries(entry.kinds),
    lastUpdated: entry.lastUpdated,
    level: "high",
    pathKinds: topCompatEntries(entry.pathKinds),
    total: entry.total || 0,
    vectors: topCompatEntries(entry.vectors),
  };
};

const selectedNoisePersonaIdsForDetails = async (origin, entry, noiseEnabled) => {
  if (!entry || !noiseEnabled) return [];
  return personaFor(origin);
};

const fingerprintPersonaForDetails = async (origin, mode, disabled) => {
  if (!origin || mode !== "mask" || disabled) return null;
  return fingerprintPersonaFor(origin);
};

const resolveTabOrigin = async (tabId) => {
  const state = perTabState.get(tabId);
  if (state && state.origin) return state.origin;
  // Fall back to tab URL when the in-memory state doesn't have the origin.
  // This happens when a site is disabled — content scripts stop sending
  // probe messages, so rememberSenderOrigin never populates the origin.
  try {
    const tab = await chrome.tabs.get(tabId);
    const origin = originFromUrl(tab && tab.url);
    // Store origin so subsequent popup opens find it without another lookup
    const s = getOrInitTab(tabId);
    if (origin) s.origin = origin;
    return origin || null;
  } catch {
    return null;
  }
};

const detailsResponseFor = async (tabId, stored) => {
  const origin = await resolveTabOrigin(tabId);
  const originProbeEntry = storedEntryForOrigin(origin, stored.probe_log);
  const adaptiveEntry = storedEntryForOrigin(origin, stored.adaptive_log);
  const compatEntry = storedEntryForOrigin(origin, stored.compat_log);
  const diagnosticEntry = storedEntryForOrigin(origin, stored.diagnostic_log);
  const selectedPersonaIds = await selectedNoisePersonaIdsForDetails(
    origin,
    originProbeEntry,
    stored.noise_enabled
  );
  const loggedOrigins = loggedOriginsFor(stored);
  const disabledOrigins = stored.disabled_origins || {};
  const disabled = isOriginPaused(origin, disabledOrigins);
  const fingerprintMode = stored.fingerprint_mode === "mask" ? "mask" : "off";
  const fingerprintPersona = await fingerprintPersonaForDetails(origin, fingerprintMode, disabled);

  // Ensure DNR header rule matches the persona for this origin
  if (origin && !disabled) {
    await ensureOriginHeaderRule(origin, fingerprintMode, fingerprintPersona);
  }

  return {
    disabled,
    total: sumTabTotal(tabId),
    topIds: topIdsForTab(tabId, 5),
    cumulative: stored.cumulative,
    fingerprintMode,
    fingerprintPersona,
    noiseEnabled: stored.noise_enabled,
    replayMode: stored.replay_mode,
    replayDetected: !!(origin && stored.replay_log[origin]),
    adaptiveDetected: !!adaptiveEntry,
    adaptiveScore: adaptiveEntry ? adaptiveEntry.scoreMax || 0 : 0,
    adaptiveCategories: adaptiveEntry ? adaptiveEntry.categories || {} : {},
    compatWarning: compatWarningForEntry(compatEntry),
    diagnosticEvents: diagnosticEventCountFor(diagnosticEntry),
    diagnosticOrigins: Object.keys(stored.diagnostic_log).length,
    diagnosticsMode: stored.diagnostics_mode,
    researchLogging: !!stored.research_logging,
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
      disabled_origins: {},
      fingerprint_mode: "off",
      noise_enabled: false,
      probe_log: {},
      replay_log: {},
      adaptive_log: {},
      compat_log: {},
      replay_mode: "off",
      research_logging: false,
    });
    sendResponse(await detailsResponseFor(msg.tabId, stored));
  })();
  return true;
};

const handleGetPersona = (_msg, sender, sendResponse) => {
  (async () => {
    const stored = await chrome.storage.local.get({
      diagnostics_mode: false,
      disabled_origins: {},
      fingerprint_mode: "off",
      noise_enabled: false,
      replay_mode: "off",
    });
    const origin = rememberSenderOrigin(sender);
    const disabled = isOriginPaused(origin, stored.disabled_origins);
    const fingerprintMode = stored.fingerprint_mode === "mask" ? "mask" : "off";
    const fingerprintPersona =
      fingerprintMode === "mask" ? await fingerprintPersonaFor(origin) : null;

    // Ensure DNR header rule matches the persona for this origin
    if (origin && !disabled) {
      await ensureOriginHeaderRule(origin, fingerprintMode, fingerprintPersona);
    } else if (origin) {
      await removeOriginHeaderRule(origin);
    }

    const ids = stored.noise_enabled && origin ? await personaFor(origin) : [];
    const { probe_log = {} } = ids.length ? await chrome.storage.local.get({ probe_log: {} }) : {};
    sendResponse({
      diagnosticsMode: stored.diagnostics_mode,
      disabled,
      fingerprintMode,
      fingerprintPersona,
      ids,
      paths: personaPathsFor(probe_log[origin], ids),
      noiseEnabled: stored.noise_enabled,
      origin,
      replayMode: stored.replay_mode,
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
  } catch (err) {
    safeLog(err, "broadcast config update");
  }
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
    await syncContentScripts();
    await broadcastConfigUpdate();
    sendResponse({ ok: true, mode });
  })();
  return true;
};

const handleSetResearchLogging = (msg, _sender, sendResponse) => {
  (async () => {
    const enabled = !!msg.enabled;
    await chrome.storage.local.set({ research_logging: enabled });
    await syncContentScripts();
    sendResponse({ enabled, ok: true });
  })();
  return true;
};

const handleSetFingerprint = (msg, _sender, sendResponse) => {
  (async () => {
    const allowed = new Set(["off", "mask"]);
    const mode = allowed.has(msg.mode) ? msg.mode : "off";
    await chrome.storage.local.set({ fingerprint_mode: mode });
    await syncContentScripts();
    if (mode !== "mask") {
      await clearAllHeaderRules();
    }
    await broadcastConfigUpdate();
    sendResponse({ ok: true, mode });
  })();
  return true;
};

const handleSetSiteDisabled = (msg, _sender, sendResponse) => {
  (async () => {
    const origin = msg.origin;
    const disabled = !!msg.disabled;
    if (!origin) {
      sendResponse({ ok: false, error: "no origin" });
      return;
    }
    const { disabled_origins = {} } = await chrome.storage.local.get({ disabled_origins: {} });
    if (disabled) {
      disabled_origins[origin] = true;
    } else {
      // Pausing works per host, so resuming clears every entry for this host.
      for (const key of pausedOriginsLike(origin, disabled_origins)) delete disabled_origins[key];
    }
    await chrome.storage.local.set({ disabled_origins });
    // Both must be in place before the popup reloads the tab.
    await syncContentScripts();
    await reconcilePauseAllowRulesFromStorage();
    if (disabled) {
      await removeOriginHeaderRule(origin);
    }
    // Notify tabs on this host (any port) so content scripts update immediately
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) => {
        if (tab.id == null) return null;
        updateBadgeForTab(tab.id, tab.url).catch(() => {});
        if (isOriginPaused(originFromUrl(tab.url), { [origin]: true })) {
          // Send direct disabled update to MAIN world scripts AND persona update to bridge
          return Promise.all([
            chrome.tabs
              .sendMessage(tab.id, { type: "static_disabled_update", disabled })
              .catch(() => {}),
            chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {}),
          ]);
        }
        return null;
      })
    );
    sendResponse({ ok: true });
  })();
  return true;
};

const handleSetDiagnostics = (msg, _sender, sendResponse) => {
  (async () => {
    const enabled = !!msg.enabled;
    diagnosticsEnabled = enabled;
    await chrome.storage.local.set({ diagnostics_mode: enabled });
    await broadcastConfigUpdate();
    sendResponse({ enabled, ok: true });
  })();
  return true;
};

const handleExportLog = (_msg, _sender, sendResponse) => {
  (async () => {
    const stored = await chrome.storage.local.get({
      probe_log: {},
      replay_log: {},
      adaptive_log: {},
      compat_log: {},
      diagnostic_log: {},
      diagnostics_mode: false,
      fingerprint_mode: "off",
      cumulative: 0,
    });
    sendResponse({
      schema: "static.probe-log.v1",
      exportedAt: new Date().toISOString(),
      cumulative: stored.cumulative,
      compatibilityWarnings: stored.compat_log,
      diagnostics: stored.diagnostic_log,
      diagnosticsMode: stored.diagnostics_mode,
      fingerprintMode: stored.fingerprint_mode,
      origins: stored.probe_log,
      replayDetections: stored.replay_log,
      adaptiveSignals: stored.adaptive_log,
    });
  })();
  return true;
};

const handleClearLog = (_msg, _sender, sendResponse) => {
  (async () => {
    cachedSecretPromise = null;
    await broadcastConfigUpdate({ resetProbeState: true });
    await serialize(() =>
      chrome.storage.local.remove([
        "probe_log",
        "replay_log",
        "adaptive_log",
        "diagnostic_log",
        "compat_log",
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
  static_compat_signal: handleCompatSignal,
  static_export_log: handleExportLog,
  static_get_details: handleGetDetails,
  static_get_persona: handleGetPersona,
  static_probe_blocked: handleProbeBlocked,
  static_replay_detected: handleReplayDetected,
  static_set_diagnostics: handleSetDiagnostics,
  static_set_fingerprint: handleSetFingerprint,
  static_set_noise: handleSetNoise,
  static_set_replay: handleSetReplay,
  static_set_research_logging: handleSetResearchLogging,
  static_set_site_disabled: handleSetSiteDisabled,
};

// ─── Message router ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && messageHandlers[msg.type];
  return handler ? handler(msg, sender, sendResponse) : undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  perTabState.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading") {
    perTabState.delete(tabId);
  }
  if (info.status === "loading" || info.status === "complete") {
    updateBadgeForTab(tabId, tab && tab.url).catch(() => {});
  }
});

const refreshAllBadges = () =>
  chrome.tabs
    .query({})
    .then((tabs) => {
      for (const tab of tabs) {
        if (tab.id != null) updateBadgeForTab(tab.id, tab.url).catch(() => {});
      }
    })
    .catch(() => {});

// ─── Storage change listener: react to fingerprint_mode changes ───────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.fingerprint_mode) {
    const newMode = changes.fingerprint_mode.newValue;
    if (newMode !== "mask") {
      clearAllHeaderRules();
    }
  }
  // If an origin was just disabled, drop its header rule promptly.
  if (changes.disabled_origins) {
    const next = changes.disabled_origins.newValue || {};
    const prev = changes.disabled_origins.oldValue || {};
    for (const origin of Object.keys(next)) {
      if (next[origin] && !prev[origin]) removeOriginHeaderRule(origin);
    }
    reconcilePauseAllowRulesFromStorage();
  }
  if (changes.disabled_origins || changes.compat_log) refreshAllBadges();
  if (Object.keys(CONTENT_SCRIPT_SETTINGS).some((key) => changes[key])) syncContentScripts();
});

chrome.runtime.onInstalled.addListener(() => {
  syncContentScripts();
});
chrome.runtime.onStartup.addListener(() => {
  syncContentScripts();
});
syncContentScripts();

// ─── Startup: reconcile persisted DNR header rules against live state ────
// Queued first so later header-rule changes see the restored map.
queueHeaderRuleChange(cleanupStaleHeaderRules)
  .then(() => reconcilePauseAllowRulesFromStorage())
  .catch((err) => safeLog(err, "startup DNR reconcile"));
// Mirror the persisted diagnostics flag into the in-memory gate so safeLog is
// active immediately after a service-worker restart.
chrome.storage.local.get({ diagnostics_mode: false }, ({ diagnostics_mode }) => {
  diagnosticsEnabled = !!diagnostics_mode;
});

// Sweep existing tabs on startup to set badges for disabled origins
chrome.storage.local.get({ disabled_origins: {} }, ({ disabled_origins }) => {
  if (Object.keys(disabled_origins).length > 0) refreshAllBadges();
});
