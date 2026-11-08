/* eslint-disable max-lines, complexity -- service-worker routing, mode reconcilers and storage coordination are kept together */
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
  importScripts(
    "lists.js",
    "signals.js",
    "site_signals.js",
    "site_dnr.js",
    "service_worker_utils.js"
  );
}
const CFG = globalThis.__static_config__;
const SW_HELPERS = CFG.helpers;
const H = SW_HELPERS;
const SITE_SIGNALS = globalThis.__static_site_signals__;
const SITE_DNR = globalThis.__static_site_dnr__;
const {
  CONTENT_SCRIPT_SETTINGS,
  MAX_EVIDENCE_SITES,
  MAX_SITE_DECISIONS,
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
  protectionModeFor,
  siteDecisionsOn,
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

// ─── Protection mode, site decisions and local evidence ───────────────────
// A "site" is the registrable domain (or bare host for IP/localhost): one
// decision covers every scheme, port and subdomain. "always" is the 2.7
// behavior and keeps using origin-keyed pause entries.
const PROTECTION_MODE_KEY = "protection_mode";
const SITE_DECISIONS_KEY = "site_decisions";
const SITE_EVIDENCE_KEY = "site_evidence";
const RULESET_PREFS_KEY = "ruleset_prefs";
const TAB_SEEN_KEY = "tab_seen";
const ONBOARDING_DISMISSED_KEY = "onboarding_dismissed";
const DEFAULT_PROTECTION_MODE = "per_site";
const MAX_TAB_SEEN = 30;
const MAX_SEEN_IDS = 40;
const MAX_TAB_SEEN_IDS = 10;
const RUNTIME_SETTING_KEYS = new Set([
  "protection_mode",
  SITE_DECISIONS_KEY,
  RULESET_PREFS_KEY,
  "ruleset_prefs_captured",
  "disabled_origins",
]);

const modeOf = (value) => (value === "always" ? "always" : DEFAULT_PROTECTION_MODE);

const readProtectionMode = async () => {
  const { protection_mode } = await chrome.storage.local.get({
    protection_mode: DEFAULT_PROTECTION_MODE,
  });
  return modeOf(protection_mode);
};

const siteKeyForOrigin = (origin) => (origin ? H.siteKeyForOrigin(origin) || null : null);
const siteKeyForUrl = (url) => (url ? H.siteKeyForUrl(url) || null : null);

const siteDecisionFor = (siteKey, siteDecisions) => {
  const entry = (siteDecisions || {})[siteKey];
  if (!entry || typeof entry !== "object") return null;
  if (entry.state !== "on" && entry.state !== "off") return null;
  return entry;
};

const siteDecisionState = (siteKey, siteDecisions) => {
  const entry = siteDecisionFor(siteKey, siteDecisions);
  return entry ? entry.state : "undecided";
};

const pausedSiteKeys = (disabledOrigins) => {
  const keys = new Set();
  for (const [origin, paused] of Object.entries(disabledOrigins || {})) {
    if (!paused) continue;
    const siteKey = siteKeyForOrigin(origin);
    if (siteKey) keys.add(siteKey);
  }
  return keys;
};

// Masking applies when the mode says so. Explicit pause entries only exist in
// always mode; per-site decisions only exist in per-site mode.
const isOriginMasked = (origin, settings) => {
  if (!origin) return false;
  if (protectionModeFor(settings) === "always") {
    return !isOriginPaused(origin, settings.disabled_origins || {});
  }
  const siteKey = siteKeyForOrigin(origin);
  return !!siteKey && siteDecisionState(siteKey, settings.site_decisions) === "on";
};

const sanitizeRulesetPrefs = (prefs) => {
  const source = prefs && typeof prefs === "object" ? prefs : {};
  const out = {
    ...(SITE_DNR ? SITE_DNR.DEFAULT_PREFS : { captcha_vendors: false, fingerprint_vendors: true }),
  };
  for (const id of Object.keys(out)) {
    if (typeof source[id] === "boolean") out[id] = source[id];
  }
  return out;
};

const readRulesetPrefs = async () => {
  const stored = await chrome.storage.local.get({
    ruleset_prefs: null,
    ruleset_prefs_captured: false,
  });
  if (stored.ruleset_prefs && typeof stored.ruleset_prefs === "object") {
    return sanitizeRulesetPrefs(stored.ruleset_prefs);
  }
  // Capture the pre-2.8 choice once, so switching to "always" later keeps the
  // user's network lists instead of resetting them to manifest defaults.
  let prefs = null;
  try {
    prefs = SITE_DNR && SITE_DNR.capturePrefs ? await SITE_DNR.capturePrefs() : null;
  } catch (err) {
    safeLog(err, "ruleset prefs capture");
  }
  const resolved = sanitizeRulesetPrefs(prefs);
  try {
    await chrome.storage.local.set({
      [RULESET_PREFS_KEY]: resolved,
      ruleset_prefs_captured: true,
    });
  } catch (err) {
    safeLog(err, "ruleset prefs persist");
  }
  return resolved;
};

const trimSiteDecisions = (siteDecisions) => {
  const entries = Object.entries(siteDecisions || {});
  const next = {};
  for (const state of ["on", "off"]) {
    const sorted = entries
      .filter(([, entry]) => entry && entry.state === state)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    for (const [siteKey] of sorted.slice(0, MAX_SITE_DECISIONS)) {
      next[siteKey] = siteDecisions[siteKey];
    }
  }
  return next;
};

const trimEvidenceSites = (siteEvidence) => {
  const entries = Object.entries(siteEvidence || {});
  if (entries.length <= MAX_EVIDENCE_SITES) return siteEvidence || {};
  entries.sort((a, b) => ((b[1] && b[1].lastSeen) || 0) - ((a[1] && a[1].lastSeen) || 0));
  return Object.fromEntries(entries.slice(0, MAX_EVIDENCE_SITES));
};

// Per-tab scout counters live in memory for the badge and are mirrored into
// storage.local ("tab_seen") so a service-worker restart does not zero the
// number the popup is about to show.
const sumTabSeen = (tabId) => {
  const state = perTabState.get(tabId);
  if (!state || !state.seen) return 0;
  let total = 0;
  for (const frame of state.seen.frames.values()) total += frame.total;
  return total;
};

const topSeenIdsForTab = (tabId, n) => {
  const state = perTabState.get(tabId);
  if (!state || !state.seen) return [];
  const merged = new Map();
  for (const frame of state.seen.frames.values()) {
    for (const [id, count] of frame.idCounts) merged.set(id, (merged.get(id) || 0) + count);
  }
  return [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
};

const storedTabSeen = async (tabId) => {
  try {
    const { [TAB_SEEN_KEY]: seen = {} } = await chrome.storage.local.get({
      [TAB_SEEN_KEY]: {},
    });
    return seen[tabId] || null;
  } catch {
    return null;
  }
};

const seenCountForTab = async (tabId) => {
  const live = sumTabSeen(tabId);
  if (live > 0) return live;
  const stored = await storedTabSeen(tabId);
  return stored && typeof stored.total === "number" ? stored.total : 0;
};

const seenIdsForTab = async (tabId, n) => {
  const live = topSeenIdsForTab(tabId, n);
  if (live.length > 0) return live;
  const stored = await storedTabSeen(tabId);
  return Array.isArray(stored && stored.ids) ? stored.ids.slice(0, n) : [];
};

// ─── One-off evidence seeding from the 2.7 probe log ───────────────────────
// An upgrade into per-site mode starts with an empty evidence store, so the
// popup would have nothing to say about sites the user has visited for months.
// The probe log already holds the same local, capped id/count shape; fold it
// into site evidence once per site, leaving any live scout evidence untouched.
const seedEvidenceFromProbeLog = async () => {
  const mode = await readProtectionMode();
  if (mode !== "per_site") return 0;
  const stored = await chrome.storage.local.get({
    probe_log: {},
    [SITE_EVIDENCE_KEY]: {},
  });
  const probeLog = stored.probe_log || {};
  const evidence = stored.site_evidence || {};
  let seeded = 0;
  for (const [origin, entry] of Object.entries(probeLog)) {
    if (!entry || !entry.idCounts) continue;
    const siteKey = siteKeyForOrigin(origin);
    if (!siteKey) continue;
    const existing = SITE_SIGNALS.sanitizeEvidence(evidence[siteKey]);
    if (existing && existing.probes.total > 0) continue;
    const ids = {};
    let total = 0;
    for (const [id, count] of Object.entries(entry.idCounts)) {
      if (!H.isValidExtensionId(id)) continue;
      const safeCount = Math.min(1_000_000, Math.max(0, Math.round(count)));
      if (!safeCount) continue;
      ids[id.toLowerCase()] = (ids[id.toLowerCase()] || 0) + safeCount;
      total += safeCount;
    }
    if (total <= 0) continue;
    const lastSeen =
      typeof entry.lastUpdated === "number" && entry.lastUpdated > 0
        ? entry.lastUpdated
        : Date.now();
    evidence[siteKey] = SITE_SIGNALS.mergeEvidence(
      existing,
      { page: true, probes: { ids, pathKinds: {}, total, vectors: {} } },
      lastSeen
    );
    seeded += 1;
  }
  if (seeded > 0) {
    await chrome.storage.local.set({ [SITE_EVIDENCE_KEY]: trimEvidenceSites(evidence) });
  }
  return seeded;
};

// ─── Runtime reconciler ───────────────────────────────────────────────────
// One serialized path owns everything that depends on the protection mode:
// content-script registrations, scoped network rules, UA header rules and badge
// titles. Every mode/decision/ruleset change funnels through it, so two quick
// clicks cannot leave static rulesets half-enabled.
let protectionRuntimeChain = Promise.resolve();

const refreshProtectionRuntime = (reason) => {
  protectionRuntimeChain = protectionRuntimeChain
    .then(async () => {
      const settings = await chrome.storage.local.get({
        protection_mode: DEFAULT_PROTECTION_MODE,
        site_decisions: {},
        disabled_origins: {},
      });
      const mode = protectionModeFor(settings);
      const prefs = await readRulesetPrefs();
      const paused = mode === "always" ? settings.disabled_origins || {} : {};
      // 1. Pause exceptions only matter while the network lists are global.
      await reconcilePauseAllowRules(paused);
      // 2. Global lists in always mode, initiator-scoped copies in per-site.
      if (SITE_DNR && typeof SITE_DNR.apply === "function") {
        try {
          await SITE_DNR.apply({
            mode,
            prefs,
            sites: mode === "per_site" ? siteDecisionsOn(settings.site_decisions) : [],
          });
        } catch (err) {
          safeLog(err, `site dnr apply (${reason})`);
        }
      }
      // 3. UA/Client-Hints: one global rule or one origin rule set per site.
      if (typeof syncHeaderRulesForMode === "function") await syncHeaderRulesForMode();
      // 4. Registration set and badge text.
      await syncContentScripts();
      await refreshAllBadges();
    })
    .catch((err) => safeLog(err, `protection runtime (${reason})`));
  return protectionRuntimeChain;
};

const compatHistoryForSites = (compatLog) => {
  const out = new Map();
  for (const [origin, entry] of Object.entries(compatLog || {})) {
    if (!entry || !entry.total) continue;
    const siteKey = siteKeyForOrigin(origin);
    if (!siteKey) continue;
    const current = out.get(siteKey) || { kinds: {}, lastUpdated: 0, total: 0 };
    current.total += entry.total;
    for (const [kind, count] of Object.entries(entry.kinds || {})) {
      current.kinds[kind] = (current.kinds[kind] || 0) + count;
    }
    current.lastUpdated = Math.max(current.lastUpdated || 0, entry.lastUpdated || 0);
    out.set(siteKey, current);
  }
  const fresh = new Map();
  for (const [siteKey, entry] of out) {
    if (compatEntryIsFresh(entry)) {
      fresh.set(siteKey, {
        fresh: true,
        warning: {
          kinds: topCompatEntries(entry.kinds),
          lastUpdated: entry.lastUpdated,
          level: "high",
          total: entry.total,
        },
      });
    }
  }
  return fresh;
};

// ─── DNR header rules: always-on user-agent scrubbing ────────────────────
// Protected sites get a synthetic User-Agent and Client Hints, including the
// first navigation (global rule) and later visits (per-origin rules). Paused
// hosts are excluded. Device signal poisoning does not own these rules.
const UA_RULE_ID_BASE = 10_000;
const GLOBAL_UA_RULE_ID = 9_999;
const GLOBAL_UA_PRIORITY = 40;
const ORIGIN_UA_PRIORITY = 100;
const GLOBAL_UA_SEED = "static-ua";
const GLOBAL_HEADER_KEY = "*";
const BARE_OUTRANK_ID_BASE = 40_000;
const BARE_OUTRANK_ID_MAX = 40_999;
const isBareOutrankId = (id) => id >= BARE_OUTRANK_ID_BASE && id <= BARE_OUTRANK_ID_MAX;
const PAUSE_ALLOW_RULE_ID_BASE = 30_000;
const PAUSE_ALLOW_RULE_ID_MAX = 39_999;
const HEADER_RULE_ID_MAX = PAUSE_ALLOW_RULE_ID_BASE - 1;
const isHeaderRuleId = (id) => id >= UA_RULE_ID_BASE && id <= HEADER_RULE_ID_MAX;
const isPauseAllowRuleId = (id) => id >= PAUSE_ALLOW_RULE_ID_BASE && id <= PAUSE_ALLOW_RULE_ID_MAX;
const isBareHost = (hostname) =>
  hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);

// Tracks in-memory state: origin -> { requestRuleId, initiatorRuleId, uaString, lastUsed }
// Persisted to chrome.storage.local (key "header_rules") so rules survive
// service-worker restarts. The "*" entry is the global fallback, not an origin.
const originHeaderRules = new Map();
const HEADER_RULES_STORAGE_KEY = "header_rules";
const MAX_HEADER_RULE_ORIGINS = 300; // one rule set per protected site; DNR's budget is finite
let dnrNextRuleId = UA_RULE_ID_BASE;
let globalHeaderState = null;

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

const userAgentStringFor = (uaOs) =>
  `Mozilla/5.0 (${uaOs || "Windows NT 10.0; Win64; x64"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`;

const quoteHeader = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const clientHintHeadersFor = (persona) => {
  const platform = (persona && persona.uaDataPlatform) || "Windows";
  const platformVersion = persona && persona.os === "windows" ? "10.0.0" : "15.0.0";
  const uaOs = (persona && persona.uaOs) || "Windows NT 10.0; Win64; x64";
  return [
    { header: "User-Agent", operation: "set", value: userAgentStringFor(uaOs) },
    {
      header: "Sec-CH-UA",
      operation: "set",
      value: `"Chromium";v="152", "Google Chrome";v="152", "Not.A/Brand";v="24"`,
    },
    { header: "Sec-CH-UA-Mobile", operation: "set", value: "?0" },
    { header: "Sec-CH-UA-Platform", operation: "set", value: quoteHeader(platform) },
    { header: "Sec-CH-UA-Full-Version", operation: "set", value: quoteHeader("152.0.0.0") },
    {
      header: "Sec-CH-UA-Full-Version-List",
      operation: "set",
      value: `"Chromium";v="152.0.0.0", "Google Chrome";v="152.0.0.0", "Not.A/Brand";v="24.0.0.0"`,
    },
    {
      header: "Sec-CH-UA-Platform-Version",
      operation: "set",
      value: quoteHeader(platformVersion),
    },
    {
      header: "Sec-CH-UA-Arch",
      operation: "set",
      value: quoteHeader((persona && persona.architecture) || "x86"),
    },
    {
      header: "Sec-CH-UA-Bitness",
      operation: "set",
      value: quoteHeader((persona && persona.bitness) || "64"),
    },
    { header: "Sec-CH-UA-Model", operation: "set", value: quoteHeader("") },
    { header: "Sec-CH-UA-WoW64", operation: "set", value: "?0" },
  ];
};

const nextHeaderRuleId = () => {
  const id = dnrNextRuleId;
  dnrNextRuleId = id >= HEADER_RULE_ID_MAX ? UA_RULE_ID_BASE : id + 1;
  return id;
};

const ruleIdsOf = (entry) =>
  [entry && entry.requestRuleId, entry && entry.initiatorRuleId, entry && entry.ruleId].filter(
    (id) => typeof id === "number"
  );

// Build a DNR condition that matches requests to `hostname` without matching
// it as an arbitrary substring of a larger URL. requestDomains does not apply
// to bare IPs or localhost, so those get a regexFilter anchored to scheme+host.
const headerRuleConditionFor = (hostname) => {
  if (isBareHost(hostname)) {
    const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      regexFilter: `^https?://${escaped}([:/]|$)`,
      resourceTypes: ALL_RESOURCE_TYPES,
    };
  }
  return { requestDomains: [hostname], resourceTypes: ALL_RESOURCE_TYPES };
};

const headerRulesSnapshot = () => {
  const out = Object.fromEntries(originHeaderRules);
  if (globalHeaderState) {
    out[GLOBAL_HEADER_KEY] = { ...globalHeaderState, ruleId: GLOBAL_UA_RULE_ID };
  }
  return out;
};

// Persist the in-memory rule map so a restarted service worker can reconcile
// against the live DNR rules instead of orphaning them.
const persistHeaderRules = () =>
  serialize(async () => {
    await chrome.storage.local.set({
      [HEADER_RULES_STORAGE_KEY]: headerRulesSnapshot(),
    });
  });

const removeDynamicRuleIds = async (ids) => {
  const removeRuleIds = [...new Set(ids.filter((id) => typeof id === "number"))];
  if (removeRuleIds.length === 0) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  } catch {
    // Rule may already be gone.
  }
};

const dropOriginHeaderRule = async (origin) => {
  const existing = originHeaderRules.get(origin);
  if (!existing) return;

  originHeaderRules.delete(origin);
  await persistHeaderRules();
  await removeDynamicRuleIds(ruleIdsOf(existing));
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
    removeRuleIds.push(...ruleIdsOf(entry));
  }
  if (removeRuleIds.length === 0) return;
  await persistHeaderRules();
  await removeDynamicRuleIds(removeRuleIds);
};

const hostnameForHeaderKey = (key) => {
  if (typeof key !== "string") return "";
  try {
    return new URL(key).hostname.toLowerCase();
  } catch {
    return key.trim().toLowerCase();
  }
};

// The rule writer assumes it is already inside the header-rule queue. `key` is
// an origin in always mode and a site key in per-site mode; `siteScoped` tells
// it which. Both shapes need the request rule (requests *to* the site) and the
// initiator rule (requests the site makes to third parties), but bare hosts
// cannot use requestDomains.
const applyHeaderRule = async (key, persona, siteScoped) => {
  if (!key || !persona || !persona.uaOs) return;
  const hostname = siteScoped ? String(key).toLowerCase() : hostnameForHeaderKey(key);
  if (!hostname) return;
  if (siteScoped && typeof H.sitePatternsFor === "function") {
    const patterns = H.sitePatternsFor(hostname);
    if (!patterns) return;
  }
  const uaString = userAgentStringFor(persona.uaOs);
  if (hostname === GLOBAL_HEADER_KEY || key === GLOBAL_HEADER_KEY) return;
  const existing = originHeaderRules.get(key);
  const wantsInitiator = siteScoped || !isBareHost(hostname);
  const wantedIds = ruleIdsOf(existing);
  let liveIds = null;
  try {
    liveIds = new Set(
      (await chrome.declarativeNetRequest.getDynamicRules()).map((rule) => rule.id)
    );
  } catch {
    liveIds = null;
  }
  const expectedIds = wantsInitiator ? 2 : 1;
  const live =
    liveIds && wantedIds.length === expectedIds && wantedIds.every((id) => liveIds.has(id));
  if (existing && existing.uaString === uaString && live) {
    existing.lastUsed = Date.now();
    return;
  }

  await dropOriginHeaderRule(key);

  const requestHeaders = clientHintHeadersFor(persona);
  const requestRuleId = nextHeaderRuleId();
  const rules = [
    {
      id: requestRuleId,
      priority: ORIGIN_UA_PRIORITY,
      action: { type: "modifyHeaders", requestHeaders },
      condition: headerRuleConditionFor(hostname),
    },
  ];
  let initiatorRuleId = null;
  if (wantsInitiator) {
    initiatorRuleId = nextHeaderRuleId();
    rules.push({
      id: initiatorRuleId,
      priority: ORIGIN_UA_PRIORITY,
      action: { type: "modifyHeaders", requestHeaders },
      condition: { initiatorDomains: [hostname], resourceTypes: ALL_RESOURCE_TYPES },
    });
  }
  const added = [];
  for (const rule of rules) {
    const ok = await addDynamicRule(rule);
    if (!ok) {
      safeLog(new Error(`rejected UA rule ${rule.id} for ${key}`), "header rule change");
      await removeDynamicRuleIds(added);
      return;
    }
    added.push(rule.id);
  }
  originHeaderRules.set(key, {
    initiatorRuleId,
    lastUsed: Date.now(),
    requestRuleId,
    uaString,
  });
  await evictExcessHeaderRules();
  await persistHeaderRules();
};

const ensureHeaderRuleFor = (key, persona, siteScoped) =>
  queueHeaderRuleChange(() => applyHeaderRule(key, persona, siteScoped));
const ensureOriginHeaderRule = (origin, persona) => ensureHeaderRuleFor(origin, persona, false);
const ensureSiteHeaderRule = (siteKey, persona) => ensureHeaderRuleFor(siteKey, persona, true);

const pausedHostnamesFrom = (disabledOrigins) => {
  const hosts = new Set();
  for (const [origin, disabled] of Object.entries(disabledOrigins || {})) {
    if (!disabled) continue;
    try {
      const hostname = new URL(origin).hostname;
      if (hostname) hosts.add(hostname);
    } catch {
      // Ignore malformed pause entries.
    }
  }
  return [...hosts].sort();
};

// Assumes the caller is already inside the header-rule queue.
// A priority-1000 allow outranks modifyHeaders, so paused localhost/IP hosts
// stay real without removing the global rule other sites still need.
const syncBareOutrankRules = async (bareHosts) => {
  let live;
  try {
    live = await chrome.declarativeNetRequest.getDynamicRules();
  } catch (err) {
    safeLog(err, "read bare outrank rules");
    return {};
  }
  await removeDynamicRuleIds(
    live.filter((rule) => isBareOutrankId(rule.id)).map((rule) => rule.id)
  );
  const bareRules = {};
  let nextId = BARE_OUTRANK_ID_BASE;
  for (const host of bareHosts) {
    const framesId = nextId++;
    const allowId = nextId++;
    if (allowId > BARE_OUTRANK_ID_MAX) break;
    const regexFilter = headerRuleConditionFor(host).regexFilter;
    const framesOk = await addDynamicRule({
      id: framesId,
      priority: 1000,
      action: { type: "allowAllRequests" },
      condition: { regexFilter, resourceTypes: ["main_frame", "sub_frame"] },
    });
    const allowOk = await addDynamicRule({
      id: allowId,
      priority: 1000,
      action: { type: "allow" },
      condition: { regexFilter, resourceTypes: ALL_RESOURCE_TYPES },
    });
    if (!framesOk || !allowOk) {
      await removeDynamicRuleIds([framesId, allowId]);
      safeLog(new Error(`rejected bare outrank rules for ${host}`), "header rule change");
      continue;
    }
    bareRules[host] = { framesId, allowId };
  }
  return bareRules;
};

const removeGlobalHeaderRules = async () => {
  const previous = globalHeaderState;
  globalHeaderState = null;
  const ids = [GLOBAL_UA_RULE_ID];
  for (const entry of Object.values((previous && previous.bareRules) || {})) {
    if (entry && entry.framesId != null) ids.push(entry.framesId);
    if (entry && entry.allowId != null) ids.push(entry.allowId);
  }
  await removeDynamicRuleIds(ids);
  await syncBareOutrankRules([]);
};

const installGlobalHeaderRule = async () => {
  const protectionMode = await readProtectionMode();
  if (protectionMode !== "always") {
    await removeGlobalHeaderRules();
    await persistHeaderRules();
    return;
  }
  const previous = globalHeaderState;
  const { disabled_origins = {} } = await chrome.storage.local.get({ disabled_origins: {} });
  const hosts = pausedHostnamesFrom(disabled_origins);
  const bare = hosts.filter(isBareHost);
  const normal = hosts.filter((hostname) => !isBareHost(hostname));
  const persona = await fingerprintPersonaFor(GLOBAL_UA_SEED);
  const uaString = userAgentStringFor(persona.uaOs);
  const excludedKey = JSON.stringify({ bare, normal });
  if (
    previous &&
    previous.uaString === uaString &&
    previous.excludedKey === excludedKey &&
    previous.installed
  ) {
    return;
  }

  await removeDynamicRuleIds([GLOBAL_UA_RULE_ID]);
  const condition = { resourceTypes: ALL_RESOURCE_TYPES };
  if (normal.length > 0) {
    condition.excludedRequestDomains = normal;
    condition.excludedInitiatorDomains = normal;
  }
  const added = await addDynamicRule({
    id: GLOBAL_UA_RULE_ID,
    priority: GLOBAL_UA_PRIORITY,
    action: { type: "modifyHeaders", requestHeaders: clientHintHeadersFor(persona) },
    condition,
  });
  if (!added) safeLog(new Error("rejected global UA rule"), "header rule change");
  const bareRules = await syncBareOutrankRules(bare);
  rememberGlobalHeader({ uaString, excludedKey, installed: added, bareRules });
  await persistHeaderRules();
};

const rememberGlobalHeader = (state) => {
  globalHeaderState = state;
};

const restoreStoredHeaderEntry = (origin, entry, liveRuleIds, orphanIds) => {
  if (origin === GLOBAL_HEADER_KEY || !entry || typeof entry !== "object") return 0;
  if (typeof entry.ruleId === "number" && typeof entry.requestRuleId !== "number") {
    orphanIds.add(entry.ruleId);
    return 0;
  }
  const ids = [entry.requestRuleId, entry.initiatorRuleId].filter((id) => typeof id === "number");
  if (ids.length === 0 || ids.some((id) => !liveRuleIds.has(id))) {
    for (const id of ids) {
      if (liveRuleIds.has(id)) orphanIds.add(id);
    }
    return 0;
  }
  originHeaderRules.set(origin, entry);
  for (const id of ids) orphanIds.delete(id);
  return Math.max(...ids);
};

// Drop every persisted header rule (origin- or site-keyed) before a mode switch
// rebuilds the map: the two modes key the same storage object differently.
const resetHeaderRules = async () => {
  let live = [];
  try {
    live = await chrome.declarativeNetRequest.getDynamicRules();
  } catch (err) {
    safeLog(err, "read dynamic rules for reset");
  }
  const ids = live
    .map((rule) => rule.id)
    .filter((id) => isHeaderRuleId(id) || isBareOutrankId(id) || id === GLOBAL_UA_RULE_ID);
  await removeDynamicRuleIds(ids);
  originHeaderRules.clear();
  globalHeaderState = null;
  dnrNextRuleId = UA_RULE_ID_BASE;
  await persistHeaderRules();
};

// Owns the UA/Client-Hints rules for the current mode. Always mode is today's
// behavior (global fallback plus lazily added per-origin rules); per-site mode
// has no global rule and exactly one request+initiator rule set per protected
// site, keyed by the site so www.example.com and example.com share a UA.
// Per-site rebuilds are batched: a few hundred sites would otherwise mean a
// few hundred dynamic-rule round trips after every decision.
const buildSiteHeaderRules = (sites, personas) => {
  const rules = [];
  const entries = {};
  for (const site of sites) {
    const persona = personas.get(site);
    if (!persona || !persona.uaOs) continue;
    if (H.sitePatternsFor && !H.sitePatternsFor(site)) continue;
    const hostname = site.toLowerCase();
    const requestHeaders = clientHintHeadersFor(persona);
    const requestRuleId = nextHeaderRuleId();
    const initiatorRuleId = nextHeaderRuleId();
    rules.push(
      {
        id: requestRuleId,
        priority: ORIGIN_UA_PRIORITY,
        action: { type: "modifyHeaders", requestHeaders },
        condition: headerRuleConditionFor(hostname),
      },
      {
        id: initiatorRuleId,
        priority: ORIGIN_UA_PRIORITY,
        action: { type: "modifyHeaders", requestHeaders },
        condition: { initiatorDomains: [hostname], resourceTypes: ALL_RESOURCE_TYPES },
      }
    );
    entries[site] = {
      initiatorRuleId,
      lastUsed: Date.now(),
      requestRuleId,
      uaString: userAgentStringFor(persona.uaOs),
    };
  }
  return { entries, rules };
};

const applyHeaderRulesForMode = async (mode) => {
  if (mode === "always") {
    await installGlobalHeaderRule();
    await chrome.storage.local.set({ header_rules_mode: mode });
    return;
  }
  const stored = await chrome.storage.local.get({
    site_decisions: {},
    header_rules_mode: null,
  });
  const sites = siteDecisionsOn(stored.site_decisions);
  const personas = new Map();
  for (const site of sites) personas.set(site, await fingerprintPersonaFor(site));
  const built = buildSiteHeaderRules(sites, personas);

  // Remove every Dynamic-rule id that can belong to the header layer before
  // adding the fresh set: mode switches and re-decisions both land here.
  let live = [];
  try {
    live = await chrome.declarativeNetRequest.getDynamicRules();
  } catch (err) {
    safeLog(err, "read dynamic rules for site headers");
  }
  const staleIds = new Set([GLOBAL_UA_RULE_ID]);
  for (const rule of live) {
    if (isHeaderRuleId(rule.id) || isBareOutrankId(rule.id)) staleIds.add(rule.id);
  }
  for (const entry of originHeaderRules.values()) {
    for (const id of ruleIdsOf(entry)) staleIds.add(id);
  }
  const removeRuleIds = [...staleIds];
  let installed = built.rules.length;
  if (built.rules.length > 0) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules: built.rules,
      });
    } catch (err) {
      safeLog(err, "batch site header rules");
      installed = 0;
    }
  } else if (removeRuleIds.length > 0) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    } catch (err) {
      safeLog(err, "clear site header rules");
    }
  }
  globalHeaderState = null;
  originHeaderRules.clear();
  if (installed > 0) {
    for (const [site, entry] of Object.entries(built.entries)) originHeaderRules.set(site, entry);
  }
  if (originHeaderRules.size > MAX_HEADER_RULE_ORIGINS) await evictExcessHeaderRules();
  await persistHeaderRules();
  await chrome.storage.local.set({ header_rules_mode: mode });
};

const syncHeaderRulesForMode = () =>
  queueHeaderRuleChange(async () => {
    const mode = await readProtectionMode();
    // Mode switches key the same persisted map differently, so rebuild from
    // scratch when the marker and the current mode disagree. Both branches of
    // applyHeaderRulesForMode write the marker back afterwards.
    const stored = await chrome.storage.local.get({ header_rules_mode: null });
    if (stored.header_rules_mode !== mode) await resetHeaderRules();
    await applyHeaderRulesForMode(mode);
  });

// Called when the mode or a decision changed: keeps open tabs honest without
// waiting for a reload. Full-stack pages on unchecked sites pass through; a
// scout page that got opted in needs its reload (the popup triggers it).
const notifyProtectionChange = async () => {
  try {
    await broadcastConfigUpdate();
  } catch (err) {
    safeLog(err, "protection change broadcast");
  }
};

const cleanupStaleHeaderRules = async () => {
  // Called on service-worker init. Reconcile the persisted rule map against
  // the live DNR rules: keep the new per-origin shape, drop old single-id
  // entries so they are not left spoofing, and reset the next-rule-id counter.
  try {
    const { [HEADER_RULES_STORAGE_KEY]: stored = {} } =
      await chrome.storage.local.get(HEADER_RULES_STORAGE_KEY);
    const liveRuleIds = new Set();
    try {
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      for (const rule of existingRules) {
        if (isHeaderRuleId(rule.id)) liveRuleIds.add(rule.id);
      }
    } catch (err) {
      safeLog(err, "read dynamic rules");
    }

    originHeaderRules.clear();
    const orphanIds = new Set(liveRuleIds);
    let maxId = UA_RULE_ID_BASE - 1;
    for (const [origin, entry] of Object.entries(stored || {})) {
      maxId = Math.max(maxId, restoreStoredHeaderEntry(origin, entry, liveRuleIds, orphanIds));
    }

    if (orphanIds.size > 0) await removeDynamicRuleIds([...orphanIds]);
    dnrNextRuleId = Math.min(Math.max(maxId + 1, UA_RULE_ID_BASE), HEADER_RULE_ID_MAX);
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

const BADGE_AMBER = "#d88030";
const BADGE_GRAY = "#888";

const setBadge = (tabId, text, color, title) => {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  if (title) chrome.action.setTitle({ tabId, title }).catch(() => {});
};

const pausedBadge = (tabId) => setBadge(tabId, "OFF", BADGE_GRAY, "Static is paused here");
const clearBadge = (tabId, title) => setBadge(tabId, "", null, title || "Static");
const compatBadge = (tabId, title) => setBadge(tabId, "!", BADGE_AMBER, title);

const updateBadgeForTab = async (tabId, tabUrl) => {
  let origin = null;
  try {
    origin = originFromUrl(tabUrl || (await chrome.tabs.get(tabId)).url);
  } catch {
    // tab may have been removed
  }
  if (!origin) {
    clearBadge(tabId);
    return;
  }
  let settings;
  try {
    settings = await chrome.storage.local.get({
      [PROTECTION_MODE_KEY]: DEFAULT_PROTECTION_MODE,
      [SITE_DECISIONS_KEY]: {},
      compat_log: {},
      disabled_origins: {},
    });
  } catch (err) {
    safeLog(err, "badge settings");
    return;
  }
  const mode = protectionModeFor(settings);
  const paused = isOriginPaused(origin, settings.disabled_origins || {});
  const siteKey = siteKeyForOrigin(origin);
  const decision = siteDecisionState(siteKey, settings.site_decisions);
  const compat = compatEntryIsFresh((settings.compat_log || {})[origin]);

  if (mode === "always" && paused) {
    pausedBadge(tabId);
    return;
  }
  if (mode === "always") {
    if (compat) {
      compatBadge(tabId, "Static: protection broke a request here — click to review");
      return;
    }
    const blockedTotal = sumTabTotal(tabId);
    updateBadge(tabId, blockedTotal);
    chrome.action
      .setTitle({
        tabId,
        title:
          blockedTotal > 0
            ? `Static: ${blockedTotal.toLocaleString("en-US")} probes blocked here`
            : "Static",
      })
      .catch(() => {});
    return;
  }

  const protectedHere = decision === "on";
  if (!protectedHere) {
    if (compat) {
      compatBadge(
        tabId,
        "Static is off here; masking interrupted a request before — click to review"
      );
      return;
    }
    const seen = await seenCountForTab(tabId);
    if (seen > 0 && decision !== "off") {
      setBadge(
        tabId,
        seen > 99 ? "99+" : String(seen),
        BADGE_AMBER,
        `Static: ${seen.toLocaleString("en-US")} extension checks seen here — click to decide`
      );
      return;
    }
    if (decision === "off") {
      clearBadge(tabId, "Static is off here (your choice)");
      return;
    }
    clearBadge(tabId, "Static is off here — click to decide");
    return;
  }

  if (compat) {
    compatBadge(tabId, "Static: protection broke a request here — click to review");
    return;
  }
  const total = sumTabTotal(tabId);
  updateBadge(tabId, total);
  chrome.action.setTitle({ tabId, title: "Static: protection on here" }).catch(() => {});
};

const clearTabStateAndBadges = async () => {
  perTabState.clear();
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) => {
        if (tab.id == null) return null;
        chrome.action.setTitle({ tabId: tab.id, title: "Static" }).catch(() => {});
        return chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
      })
    );
    await chrome.storage.local.remove(TAB_SEEN_KEY);
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

const siteRecommendationFor = (siteKey, stored) => {
  const empty = {
    decision: "undecided",
    decisionAt: null,
    evidence: null,
    history: { compatWarning: false, pausedBefore: false },
    recommendation: null,
    seenSinceDecision: 0,
  };
  if (!siteKey) return empty;
  const raw = (stored.site_evidence || {})[siteKey];
  const decision = siteDecisionState(siteKey, stored.site_decisions);
  const compat = compatHistoryForSites(stored.compat_log).get(siteKey) || null;
  const pausedBefore = pausedSiteKeys(stored.disabled_origins).has(siteKey);
  const summary = SITE_SIGNALS.evidenceSummaryFor(raw);
  const recommendation = summary
    ? SITE_SIGNALS.recommendationFor(raw, {
        compatWarning: compat ? compat.warning : null,
        decision,
        fingerprintMode: stored.fingerprint_mode === "mask" ? "mask" : "off",
        mode: protectionModeFor(stored),
        now: Date.now(),
        pausedBefore,
        replayMode: stored.replay_mode || "off",
        rulesetPrefs: sanitizeRulesetPrefs(stored.ruleset_prefs),
      })
    : null;
  const entry = siteDecisionFor(siteKey, stored.site_decisions);
  const seenSinceDecision =
    decision === "off" && entry && typeof entry.probesAt === "number" && summary
      ? Math.max(0, summary.probeTotal - entry.probesAt)
      : 0;
  return {
    decision,
    decisionAt: entry && typeof entry.at === "number" ? entry.at : null,
    evidence: summary,
    history: {
      compatWarning: !!(compat && compat.warning),
      pausedBefore,
    },
    recommendation,
    recommendationHeadline: recommendation ? recommendation.headline : null,
    seenSinceDecision,
  };
};

const sitesSummaryFor = (stored) => {
  const decisions = stored.site_decisions || {};
  const pausedKeys = pausedSiteKeys(stored.disabled_origins);
  const summary = { off: 0, on: 0, paused: pausedKeys.size, seen: 0 };
  for (const entry of Object.values(decisions)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.state === "on") summary.on += 1;
    if (entry.state === "off") summary.off += 1;
  }
  for (const siteKey of Object.keys(stored.site_evidence || {})) {
    if (siteDecisionState(siteKey, decisions) === "undecided" && !pausedKeys.has(siteKey)) {
      summary.seen += 1;
    }
  }
  return summary;
};

const onboardingVisibleFor = (stored) =>
  protectionModeFor(stored) === "per_site" &&
  !stored.onboarding_dismissed &&
  Object.keys(stored.site_decisions || {}).length === 0;

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
  const mode = protectionModeFor(stored);
  const siteKey = siteKeyForOrigin(origin);
  const paused = isOriginPaused(origin, stored.disabled_origins || {});
  const decision = siteDecisionState(siteKey, stored.site_decisions);
  const maskedHere = mode === "always" ? !paused : decision === "on";
  const fingerprintMode = stored.fingerprint_mode === "mask" ? "mask" : "off";
  // The persona is keyed by the site in per-site mode so www.example.com and
  // example.com present one browser, and by the origin in always mode (today's
  // behavior).
  const personaScope = mode === "always" ? origin : siteKey;
  const fingerprintPersona =
    maskedHere && personaScope ? await fingerprintPersonaFor(personaScope) : null;
  if (maskedHere && personaScope && fingerprintPersona) {
    if (mode === "always") await ensureOriginHeaderRule(origin, fingerprintPersona);
    else await ensureSiteHeaderRule(siteKey, fingerprintPersona);
  } else if (personaScope && originHeaderRules.has(personaScope)) {
    await removeOriginHeaderRule(personaScope);
  }

  const site = siteKey ? siteRecommendationFor(siteKey, stored) : null;
  return {
    adaptiveCategories: adaptiveEntry ? adaptiveEntry.categories || {} : {},
    adaptiveDetected: !!adaptiveEntry,
    adaptiveScore: adaptiveEntry ? adaptiveEntry.scoreMax || 0 : 0,
    compatWarning: compatWarningForEntry(compatEntry),
    cumulative: stored.cumulative,
    decision,
    diagnosticEvents: diagnosticEventCountFor(diagnosticEntry),
    diagnosticOrigins: Object.keys(stored.diagnostic_log).length,
    diagnosticsMode: stored.diagnostics_mode,
    disabled: !maskedHere,
    drift: originProbeEntry ? playbookDriftForEntry(originProbeEntry) : null,
    fingerprintMode,
    fingerprintPersona,
    mode,
    noiseDiagnostics: originProbeEntry
      ? personaDiagnosticsFor(originProbeEntry, selectedPersonaIds, stored.noise_enabled, CFG)
      : null,
    noiseEnabled: stored.noise_enabled,
    onboarding: { visible: onboardingVisibleFor(stored) },
    origin,
    originsLogged: loggedOrigins.size,
    paused,
    playbook: originProbeEntry ? latestPlaybookSnapshot(originProbeEntry) : null,
    protectedHere: maskedHere,
    replayDetected: !!(origin && stored.replay_log[origin]),
    replayMode: stored.replay_mode,
    researchLogging: !!stored.research_logging,
    rulesetPrefs: sanitizeRulesetPrefs(stored.ruleset_prefs),
    rulesetsApply: maskedHere,
    seen: await seenCountForTab(tabId),
    seenIds: await seenIdsForTab(tabId, 5),
    site: siteKey
      ? {
          ...site,
          history: {
            ...site.history,
            compatWarning: site.history.compatWarning || !!compatWarningForEntry(compatEntry),
          },
          key: siteKey,
          paused,
          protectedHere: maskedHere,
          state: maskedHere ? "on" : decision === "off" ? "off" : "undecided",
        }
      : null,
    siteKey,
    sitesSummary: sitesSummaryFor(stored),
    topIds: topIdsForTab(tabId, 5),
    total: sumTabTotal(tabId),
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
      protection_mode: DEFAULT_PROTECTION_MODE,
      site_decisions: {},
      site_evidence: {},
      ruleset_prefs: null,
      ruleset_prefs_captured: false,
      onboarding_dismissed: false,
      tab_seen: {},
    });
    sendResponse(await detailsResponseFor(msg.tabId, stored));
  })();
  return true;
};

const removeHeaderRuleIfPresent = (key) => {
  if (!key || !originHeaderRules.has(key)) return;
  removeOriginHeaderRule(key);
};

const handleGetPersona = (_msg, sender, sendResponse) => {
  (async () => {
    const stored = await chrome.storage.local.get({
      diagnostics_mode: false,
      disabled_origins: {},
      fingerprint_mode: "off",
      noise_enabled: false,
      protection_mode: DEFAULT_PROTECTION_MODE,
      probe_log: {},
      replay_mode: "off",
      site_decisions: {},
    });
    const origin = rememberSenderOrigin(sender);
    const mode = protectionModeFor(stored);
    const siteKey = siteKeyForOrigin(origin);
    const maskedHere = isOriginMasked(origin, {
      disabled_origins: stored.disabled_origins,
      protection_mode: mode,
      site_decisions: stored.site_decisions,
    });
    const scope = mode === "always" ? origin : siteKey;
    const fingerprintMode = stored.fingerprint_mode === "mask" ? "mask" : "off";
    const fingerprintPersona = maskedHere && scope ? await fingerprintPersonaFor(scope) : null;

    if (maskedHere && scope && fingerprintPersona) {
      if (mode === "always") await ensureOriginHeaderRule(scope, fingerprintPersona);
      else await ensureSiteHeaderRule(scope, fingerprintPersona);
    } else if (scope) {
      removeHeaderRuleIfPresent(scope);
    }

    const ids = stored.noise_enabled && maskedHere && origin ? await personaFor(origin) : [];
    const { probe_log = stored.probe_log || {} } = ids.length
      ? await chrome.storage.local.get({ probe_log: {} })
      : {};
    sendResponse({
      diagnosticsMode: stored.diagnostics_mode,
      disabled: !maskedHere,
      fingerprintMode,
      fingerprintPersona,
      ids,
      mode,
      origin,
      paths: personaPathsFor(probe_log[origin], ids),
      noiseEnabled: stored.noise_enabled,
      replayMode: stored.replay_mode,
      siteKey,
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
    await broadcastConfigUpdate();
    sendResponse({ ok: true, mode });
  })();
  return true;
};

// ─── Site decisions (per-site mode) ───────────────────────────────────────
const commitSiteDecision = async (siteKey, state, source) => {
  const stored = await chrome.storage.local.get({
    [SITE_DECISIONS_KEY]: {},
    [SITE_EVIDENCE_KEY]: {},
  });
  const decisions = { ...(stored.site_decisions || {}) };
  if (state === "clear") {
    delete decisions[siteKey];
  } else {
    const entry = { at: Date.now(), source: source || "popup", state };
    if (state === "off") {
      const summary = SITE_SIGNALS.evidenceSummaryFor((stored.site_evidence || {})[siteKey]);
      entry.probesAt = summary ? summary.probeTotal : 0;
    }
    decisions[siteKey] = entry;
  }
  const trimmed = trimSiteDecisions(decisions);
  await chrome.storage.local.set({ [SITE_DECISIONS_KEY]: trimmed });
  return trimmed;
};

const handleSetSiteDecision = (msg, _sender, sendResponse) => {
  (async () => {
    const siteKey = H.siteKeyForOrigin(msg.origin) || H.siteKeyFor(msg.site);
    if (!siteKey) {
      sendResponse({ ok: false, error: "unknown site" });
      return;
    }
    const state = ["on", "off", "clear"].includes(msg.state) ? msg.state : null;
    if (!state) {
      sendResponse({ ok: false, error: "bad state" });
      return;
    }
    // The sites page names its surface; the popup is identified by sending an
    // origin. Keep the inference so a caller that only knows the site (or only
    // the origin) still records where the decision came from.
    const source =
      msg.source === "sites-page" || (msg.site && !msg.origin) ? "sites-page" : "popup";
    const decisions = await commitSiteDecision(siteKey, state, source);
    await refreshProtectionRuntime(`site:${siteKey}:${state}`);
    await notifyProtectionChange();
    const resolvedState = state === "clear" ? "undecided" : state;
    sendResponse({
      decision: resolvedState,
      mode: protectionModeFor({
        protection_mode: (
          await chrome.storage.local.get({ protection_mode: DEFAULT_PROTECTION_MODE })
        ).protection_mode,
      }),
      ok: true,
      site: siteKey,
      siteDecisions: decisions,
      state: resolvedState,
    });
  })();
  return true;
};

const handleSetProtectionMode = (msg, _sender, sendResponse) => {
  (async () => {
    if (!["per_site", "always"].includes(msg.mode)) {
      sendResponse({ ok: false, error: "bad mode" });
      return;
    }
    const before = await readProtectionMode();
    if (before !== msg.mode) {
      await chrome.storage.local.set({ [PROTECTION_MODE_KEY]: msg.mode });
    }
    if (msg.mode === "per_site") await seedEvidenceFromProbeLog();
    await refreshProtectionRuntime(`mode:${msg.mode}`);
    await notifyProtectionChange();
    sendResponse({ mode: await readProtectionMode(), ok: true, unchanged: before === msg.mode });
  })();
  return true;
};

const handleDismissOnboarding = (_msg, _sender, sendResponse) => {
  (async () => {
    await chrome.storage.local.set({ [ONBOARDING_DISMISSED_KEY]: true });
    sendResponse({ dismissed: true, ok: true });
  })();
  return true;
};

const handleSetRulesetEnabled = (msg, _sender, sendResponse) => {
  (async () => {
    if (!SITE_DNR || !SITE_DNR.RULESET_IDS.includes(msg.id)) {
      sendResponse({ ok: false, error: "unknown ruleset" });
      return;
    }
    const prefs = { ...(await readRulesetPrefs()), [msg.id]: !!msg.enabled };
    await chrome.storage.local.set({
      [RULESET_PREFS_KEY]: prefs,
      ruleset_prefs_captured: true,
    });
    await refreshProtectionRuntime(`ruleset:${msg.id}`);
    sendResponse({ enabled: prefs[msg.id], id: msg.id, ok: true, prefs });
  })();
  return true;
};

const handleGetSitesOverview = (_msg, _sender, sendResponse) => {
  (async () => {
    const stored = await chrome.storage.local.get({
      [PROTECTION_MODE_KEY]: DEFAULT_PROTECTION_MODE,
      [SITE_DECISIONS_KEY]: {},
      [SITE_EVIDENCE_KEY]: {},
      [ONBOARDING_DISMISSED_KEY]: false,
      [RULESET_PREFS_KEY]: null,
      compat_log: {},
      disabled_origins: {},
      fingerprint_mode: "off",
      replay_mode: "off",
    });
    const mode = protectionModeFor(stored);
    const prefs = sanitizeRulesetPrefs(stored.ruleset_prefs);
    const pausedKeys = pausedSiteKeys(stored.disabled_origins);
    const decisions = stored.site_decisions || {};
    const evidence = stored.site_evidence || {};
    const rowFor = (siteKey, verdictState) => {
      const data = siteRecommendationFor(siteKey, stored);
      return {
        at: data.decisionAt,
        evidence: data.evidence,
        history: data.history,
        lastSeen: data.evidence ? data.evidence.lastSeen : 0,
        recommendationHeadline: data.recommendationHeadline,
        recommendation: data.recommendation
          ? {
              caution: data.recommendation.caution,
              confidence: data.recommendation.confidence,
              headline: data.recommendation.headline,
              summary: data.recommendation.summary,
              verdict: data.recommendation.verdict,
            }
          : null,
        site: siteKey,
        state: verdictState,
      };
    };
    const protectedRows = siteDecisionsOn(decisions)
      .map((siteKey) => rowFor(siteKey, "on"))
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    const declinedRows = Object.keys(decisions)
      .filter((siteKey) => siteDecisionState(siteKey, decisions) === "off")
      .map((siteKey) => rowFor(siteKey, "off"))
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    const seenRows = Object.keys(evidence)
      .filter(
        (siteKey) =>
          siteDecisionState(siteKey, decisions) === "undecided" && !pausedKeys.has(siteKey)
      )
      .map((siteKey) => rowFor(siteKey, "seen"))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .slice(0, 50);
    const paused = Object.entries(stored.disabled_origins || {})
      .filter(([, active]) => active)
      .map(([origin]) => origin)
      .sort();
    sendResponse({
      caps: {
        evidence: MAX_EVIDENCE_SITES,
        maxEvidenceSites: MAX_EVIDENCE_SITES,
        maxSiteDecisions: MAX_SITE_DECISIONS,
        paused: paused.length,
        protected: MAX_SITE_DECISIONS,
        seen: 50,
      },
      declined: declinedRows,
      mode,
      onboardingDismissed: !!stored.onboarding_dismissed,
      paused,
      prefs,
      protected: protectedRows,
      seen: seenRows,
    });
  })();
  return true;
};

const handleClearSiteDecisions = (msg, _sender, sendResponse) => {
  (async () => {
    if (msg.scope === "seen") {
      const stored = await chrome.storage.local.get({
        [SITE_EVIDENCE_KEY]: {},
        [SITE_DECISIONS_KEY]: {},
      });
      const decisions = stored.site_decisions || {};
      const evidence = stored.site_evidence || {};
      let cleared = 0;
      for (const siteKey of Object.keys(evidence)) {
        if (siteDecisionState(siteKey, decisions) !== "undecided") continue;
        delete evidence[siteKey];
        cleared += 1;
      }
      await chrome.storage.local.set({
        [SITE_EVIDENCE_KEY]: evidence,
        [TAB_SEEN_KEY]: {},
      });
      await refreshProtectionRuntime("clear-seen");
      sendResponse({ cleared, ok: true, scope: "seen" });
      return;
    }
    await chrome.storage.local.set({
      [SITE_DECISIONS_KEY]: {},
      [TAB_SEEN_KEY]: {},
    });
    await refreshProtectionRuntime("clear-all");
    await notifyProtectionChange();
    sendResponse({ cleared: true, ok: true, scope: "all" });
  })();
  return true;
};

// ─── Scout evidence ────────────────────────────────────────────────────────
const tabSeenSnapshotFor = (tabId) => {
  const state = perTabState.get(tabId);
  if (!state || !state.seen) return null;
  const total = sumTabSeen(tabId);
  if (total <= 0) return null;
  return {
    at: Date.now(),
    ids: topSeenIdsForTab(tabId, MAX_TAB_SEEN_IDS),
    total,
  };
};

const persistTabSeen = async (tabId) => {
  const snapshot = tabSeenSnapshotFor(tabId);
  if (!snapshot) return;
  const { [TAB_SEEN_KEY]: seen = {} } = await chrome.storage.local.get({ [TAB_SEEN_KEY]: {} });
  seen[tabId] = snapshot;
  const entries = Object.entries(seen).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  await chrome.storage.local.set({
    [TAB_SEEN_KEY]: Object.fromEntries(entries.slice(0, MAX_TAB_SEEN)),
  });
};

const forgetTabSeen = async (tabId) => {
  try {
    const { [TAB_SEEN_KEY]: seen = {} } = await chrome.storage.local.get({ [TAB_SEEN_KEY]: {} });
    if (seen && seen[tabId]) {
      delete seen[tabId];
      await chrome.storage.local.set({ [TAB_SEEN_KEY]: seen });
    }
  } catch {
    // best effort
  }
};

const badgeRefreshTimers = new Map();
const scheduleBadgeRefresh = (tabId, url) => {
  if (badgeRefreshTimers.has(tabId)) return;
  badgeRefreshTimers.set(
    tabId,
    setTimeout(() => {
      badgeRefreshTimers.delete(tabId);
      updateBadgeForTab(tabId, url).catch(() => {});
    }, 250)
  );
};

const SCOUT_LIMITS = (SITE_SIGNALS && SITE_SIGNALS.LIMITS) || {
  maxProbesPerMessage: 200,
  maxProbeIds: 300,
  maxProbeTotal: 1_000_000_000,
};

const scoutProbePatchFor = (msg) => {
  // A page that exhausted its 200-entry enumeration budget keeps reporting
  // {probes: [], overflow: N}. Those batches carry the only remaining signal
  // about volume, so an empty list must still flow through the overflow path.
  const probes = Array.isArray(msg.probes)
    ? msg.probes.slice(0, 2 * SCOUT_LIMITS.maxProbesPerMessage)
    : [];
  const patch = SITE_SIGNALS.probePatchFor(probes, msg.overflow);
  return patch.total > 0 ? patch : null;
};

const handleSiteEvidence = (msg, sender) => {
  if (!sender || !sender.tab || sender.tab.id == null) return;
  const tabId = sender.tab.id;
  const senderUrl = sender.tab.url || sender.url || "";
  const siteKey = siteKeyForUrl(senderUrl) || siteKeyForOrigin(sender.origin);
  if (!siteKey) return;
  const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
  const probePatch = scoutProbePatchFor(msg);
  const signalPatch = SITE_SIGNALS.signalPatchFor(msg.signals);
  const signalsPresent =
    signalPatch.uaReads > 0 ||
    Object.keys(signalPatch.vendors).length > 0 ||
    Object.keys(signalPatch.device).length > 0 ||
    Object.keys(signalPatch.replay).length > 0 ||
    Object.keys(signalPatch.compat).length > 0;
  if (!probePatch && !signalsPresent) return;
  if (!signalsPresent && probePatch && probePatch.total <= 0) return;

  // Per-tab counters are synchronous so the popup and badge see them even while
  // the storage write is queued behind another frame's batch.
  const tabState = getOrInitTab(tabId);
  if (!tabState.origin) tabState.origin = originFromUrl(senderUrl);
  if (!tabState.seen) tabState.seen = { frames: new Map(), pageCounted: false };
  const frameSeen = tabState.seen.frames.get(frameId) || { idCounts: new Map(), total: 0 };
  if (probePatch) {
    frameSeen.total = Math.min(
      SITE_SIGNALS.LIMITS.maxProbeTotal,
      frameSeen.total + probePatch.total
    );
    for (const [id, count] of Object.entries(probePatch.ids)) {
      frameSeen.idCounts.set(id, (frameSeen.idCounts.get(id) || 0) + count);
    }
    if (frameSeen.idCounts.size > MAX_SEEN_IDS) {
      const kept = [...frameSeen.idCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_SEEN_IDS);
      frameSeen.idCounts = new Map(kept);
    }
  }
  tabState.seen.frames.set(frameId, frameSeen);
  const page = frameId === 0 && !tabState.seen.pageCounted;
  if (page) tabState.seen.pageCounted = true;

  serialize(async () => {
    try {
      const stored = await chrome.storage.local.get({
        [SITE_EVIDENCE_KEY]: {},
        [TAB_SEEN_KEY]: {},
      });
      const log = stored.site_evidence || {};
      const patch = {
        compat: signalPatch.compat,
        device: signalPatch.device,
        page,
        replay: signalPatch.replay,
        uaReads: signalPatch.uaReads,
        vendors: signalPatch.vendors,
      };
      if (probePatch) patch.probes = probePatch;
      log[siteKey] = SITE_SIGNALS.mergeEvidence(log[siteKey], patch, Date.now());
      const trimmed = trimEvidenceSites(log);
      await persistTabSeen(tabId);
      await chrome.storage.local.set({ [SITE_EVIDENCE_KEY]: trimmed });
    } catch (err) {
      safeLog(err, "site evidence merge");
    }
    scheduleBadgeRefresh(tabId, senderUrl);
  });
};

const handleSetSiteDisabled = (msg, _sender, sendResponse) => {
  (async () => {
    const origin = msg.origin;
    const disabled = !!msg.disabled;
    if (!origin) {
      sendResponse({ ok: false, error: "no origin" });
      return;
    }
    const mode = await readProtectionMode();
    if (mode === "per_site") {
      // The old pause endpoint still exists for callers that predate the mode
      // switch; in per-site mode pausing one origin means leaving its site off.
      const siteKey = siteKeyForOrigin(origin);
      if (!siteKey) {
        sendResponse({ ok: false, error: "unknown site" });
        return;
      }
      await commitSiteDecision(siteKey, disabled ? "off" : "clear", "popup");
      await refreshProtectionRuntime(`site-disabled:${siteKey}`);
      await notifyProtectionChange();
      sendResponse({ mode: "per_site", ok: true, site: siteKey });
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
    if (disabled) await removeOriginHeaderRule(origin);
    await refreshProtectionRuntime("always-pause");
    // Notify tabs on this host (any port) so content scripts update immediately.
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) => {
        if (tab.id == null) return null;
        if (!isOriginPaused(origin, { [origin]: origin })) return null;
        const tabOrigin = originFromUrl(tab.url);
        if (
          !isOriginPaused(
            tabOrigin,
            pausedOriginsLike(origin, disabled_origins).length
              ? Object.fromEntries(
                  pausedOriginsLike(origin, disabled_origins).map((key) => [key, true])
                )
              : { [origin]: true }
          )
        ) {
          return null;
        }
        return Promise.all([
          chrome.tabs
            .sendMessage(tab.id, { type: "static_disabled_update", disabled })
            .catch(() => {}),
          chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {}),
        ]);
      })
    );
    sendResponse({ mode: "always", ok: true });
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
      protection_mode: DEFAULT_PROTECTION_MODE,
      site_decisions: {},
      site_evidence: {},
      ruleset_prefs: null,
    });
    const mode = protectionModeFor(stored);
    const payload = {
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
    };
    if (mode === "per_site") {
      payload.protectionMode = "per_site";
      payload.rulesetPrefs = sanitizeRulesetPrefs(stored.ruleset_prefs);
      payload.siteDecisions = stored.site_decisions;
      payload.siteEvidence = stored.site_evidence;
    }
    sendResponse(payload);
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
        // The per-site evidence is the same local research data in another
        // shape; "Clear log" means all of it. Decisions and mode stay.
        SITE_EVIDENCE_KEY,
        TAB_SEEN_KEY,
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
  static_clear_site_decisions: handleClearSiteDecisions,
  static_compat_signal: handleCompatSignal,
  static_dismiss_onboarding: handleDismissOnboarding,
  static_export_log: handleExportLog,
  static_get_details: handleGetDetails,
  static_get_persona: handleGetPersona,
  static_get_sites_overview: handleGetSitesOverview,
  static_probe_blocked: handleProbeBlocked,
  static_replay_detected: handleReplayDetected,
  static_set_diagnostics: handleSetDiagnostics,
  static_set_fingerprint: handleSetFingerprint,
  static_set_noise: handleSetNoise,
  static_set_protection_mode: handleSetProtectionMode,
  static_set_replay: handleSetReplay,
  static_set_research_logging: handleSetResearchLogging,
  static_set_ruleset_enabled: handleSetRulesetEnabled,
  static_set_site_decision: handleSetSiteDecision,
  static_set_site_disabled: handleSetSiteDisabled,
  static_site_evidence: handleSiteEvidence,
};

// ─── Message router ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && messageHandlers[msg.type];
  return handler ? handler(msg, sender, sendResponse) : undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  perTabState.delete(tabId);
  forgetTabSeen(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading") {
    perTabState.delete(tabId);
    forgetTabSeen(tabId).catch(() => {});
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

// ─── Storage change listener ──────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);
  // Mode, decisions, ruleset intent and pause entries all change what is
  // registered, blocked at the network layer and badged. One reconciler owns
  // the ordering; content-script-only settings just resync.
  if (
    keys.some(
      (key) =>
        RUNTIME_SETTING_KEYS.has(key) ||
        key === RULESET_PREFS_KEY ||
        key === "ruleset_prefs_captured"
    )
  ) {
    refreshProtectionRuntime("storage");
    return;
  }
  if (keys.includes("compat_log")) refreshAllBadges();
  if (keys.some((key) => Object.prototype.hasOwnProperty.call(CONTENT_SCRIPT_SETTINGS, key))) {
    syncContentScripts();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  refreshProtectionRuntime("installed");
});
chrome.runtime.onStartup.addListener(() => {
  refreshProtectionRuntime("startup");
});

// Startup reconcile. The header-rule map is restored first because the mode
// reconciler reuses it; then registrations, scoped network rules and badges.
queueHeaderRuleChange(async () => {
  const mode = await readProtectionMode();
  const stored = await chrome.storage.local.get({ header_rules_mode: null });
  if (stored.header_rules_mode !== mode) await resetHeaderRules();
  await cleanupStaleHeaderRules();
  await applyHeaderRulesForMode(mode);
  await chrome.storage.local.set({ header_rules_mode: mode });
})
  .catch((err) => safeLog(err, "startup DNR reconcile"))
  .then(() => seedEvidenceFromProbeLog())
  .catch((err) => safeLog(err, "probe-log evidence seeding"))
  .finally(() => refreshProtectionRuntime("startup"));

// Mirror the persisted diagnostics flag into the in-memory gate so safeLog is
// active immediately after a service-worker restart.
chrome.storage.local.get({ diagnostics_mode: false }, ({ diagnostics_mode }) => {
  diagnosticsEnabled = !!diagnostics_mode;
});
