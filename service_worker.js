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
//   6. Answer popup queries (`static_get_details`, `static_export_log`,
//      `static_set_noise`, `static_set_replay`) and bridge queries
//      (`static_get_persona`).

importScripts("lists.js");
const CFG = globalThis.__static_config__ || {};

// ─── In-memory per-tab state ──────────────────────────────────────────────
const perTabState = new Map(); // tabId -> { origin, frames: Map<frameId, {total, idCounts}> }

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

const weekKeyFor = (time) => {
  const d = new Date(time);
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const day = Math.floor((Date.UTC(year, d.getUTCMonth(), d.getUTCDate()) - yearStart) / 86400000);
  const week = Math.floor(day / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
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
  if (weekKeys.length > 10) {
    for (const key of weekKeys.slice(0, weekKeys.length - 10)) {
      delete entry.playbook.weeks[key];
    }
  }
};

const enforceCaps = (probeLog) => {
  for (const origin in probeLog) {
    const entry = probeLog[origin];
    entry.idCounts ||= {};
    const ids = Object.entries(entry.idCounts);
    if (ids.length > 2000) {
      ids.sort((a, b) => b[1] - a[1]);
      entry.idCounts = Object.fromEntries(ids.slice(0, 2000));
    }
    enforcePlaybookCaps(entry);
  }
  const origins = Object.keys(probeLog);
  if (origins.length > 100) {
    origins.sort((a, b) => (probeLog[b].lastUpdated || 0) - (probeLog[a].lastUpdated || 0));
    for (const o of origins.slice(100)) delete probeLog[o];
  }
};

const recordProbes = async (origin, batch) => {
  const { probe_log = {} } = await chrome.storage.local.get({ probe_log: {} });
  const entry = probe_log[origin] || { idCounts: {}, lastUpdated: 0 };
  entry.idCounts ||= {};
  const now = Date.now();
  const deltaIdCounts = batch && batch.deltaIdCounts ? batch.deltaIdCounts : {};
  const deltaVectorCounts = batch && batch.deltaVectorCounts ? batch.deltaVectorCounts : {};
  const deltaPathKindCounts = batch && batch.deltaPathKindCounts ? batch.deltaPathKindCounts : {};
  const deltaTotal =
    batch && typeof batch.delta === "number" && batch.delta > 0
      ? batch.delta
      : sumCounts(deltaVectorCounts);

  let changed = mergeCounts(entry.idCounts, deltaIdCounts);
  if (deltaTotal > 0 || sumCounts(deltaVectorCounts) > 0 || sumCounts(deltaPathKindCounts) > 0) {
    const week = ensurePlaybookWeek(entry, now);
    week.total += deltaTotal;
    changed = deltaTotal > 0 || changed;
    changed = mergeCounts(week.vectorCounts, deltaVectorCounts) || changed;
    changed = mergeCounts(week.pathKindCounts, deltaPathKindCounts) || changed;
    changed = mergeCounts(week.idCounts, deltaIdCounts) || changed;
  }
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
  const origins = Object.keys(replay_log);
  if (origins.length > 100) {
    origins.sort((a, b) => (replay_log[b].lastUpdated || 0) - (replay_log[a].lastUpdated || 0));
    for (const oldOrigin of origins.slice(100)) delete replay_log[oldOrigin];
  }
  await chrome.storage.local.set({ replay_log });
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

  const reasons = [];
  let score = 0;
  const vectorShift = distributionShift(current.vectorCounts, baseline.vectorCounts);
  const pathShift = distributionShift(current.pathKindCounts, baseline.pathKindCounts);
  const currentIds = repeatedIdSet(current.idCounts);
  const baselineIds = repeatedIdSet(baseline.idCounts);
  const idShift = jaccardDistance(currentIds, baselineIds);
  const uniqueIds = Object.keys(current.idCounts || {}).length;
  const singletonIds = Object.values(current.idCounts || {}).filter((count) => count === 1).length;
  const canaryPressure = uniqueIds ? singletonIds / uniqueIds : 0;
  const addedVectors = newKeys(current.vectorCounts, baseline.vectorCounts, 3);
  const addedPathKinds = newKeys(current.pathKindCounts, baseline.pathKindCounts, 3);

  if (vectorShift >= 0.35) {
    score += 3;
    reasons.push(`Probe vector mix changed by ${percent(vectorShift)}%.`);
  } else if (vectorShift >= 0.2) {
    score += 2;
    reasons.push(`Probe vector mix changed by ${percent(vectorShift)}%.`);
  }
  if (addedVectors.length > 0) {
    score += 2;
    reasons.push(`New probe vectors appeared: ${addedVectors.slice(0, 4).join(", ")}.`);
  }
  if (pathShift >= 0.35) {
    score += 2;
    reasons.push(`Extension-resource path strategy changed by ${percent(pathShift)}%.`);
  } else if (pathShift >= 0.2) {
    score += 1;
    reasons.push(`Extension-resource path strategy changed by ${percent(pathShift)}%.`);
  }
  if (addedPathKinds.length > 0) {
    score += 1;
    reasons.push(`New path kinds appeared: ${addedPathKinds.slice(0, 4).join(", ")}.`);
  }
  if (currentIds.size >= 5 && idShift >= 0.6) {
    score += 2;
    reasons.push(`Repeated extension-ID dictionary changed by ${percent(idShift)}%.`);
  } else if (currentIds.size >= 5 && idShift >= 0.35) {
    score += 1;
    reasons.push(`Repeated extension-ID dictionary changed by ${percent(idShift)}%.`);
  }
  if (uniqueIds >= 10 && canaryPressure >= 0.35) {
    score += 2;
    reasons.push(
      `One-shot ID pressure is high: ${percent(canaryPressure)}% of IDs were single-hit.`
    );
  }

  if (score >= 5) return { level: "high", label: "High drift", week: latestKey, reasons };
  if (score >= 3) return { level: "changed", label: "Changed", week: latestKey, reasons };
  return {
    level: "stable",
    label: "Stable",
    week: latestKey,
    reasons: ["No meaningful change from this origin's previous probe behavior."],
  };
};

// ─── Persona generation ───────────────────────────────────────────────────
let cachedSecret = null;
const getUserSecret = async () => {
  if (cachedSecret) return cachedSecret;
  const { user_secret } = await chrome.storage.local.get("user_secret");
  if (user_secret) {
    cachedSecret = user_secret;
    return cachedSecret;
  }
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  const hex = Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await chrome.storage.local.set({ user_secret: hex });
  cachedSecret = hex;
  return hex;
};

const mulberry32 = (seed) => {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const seedFor = async (secret, origin, week) => {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret + "|" + origin + "|" + week)
  );
  return new DataView(buf).getUint32(0, true);
};

const shuffleInPlace = (arr, rng) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
};

const personaFor = async (origin) => {
  const { probe_log = {} } = await chrome.storage.local.get({ probe_log: {} });
  const entry = probe_log[origin];
  if (!entry || !entry.idCounts) return [];

  const minCount = CFG.personaMinCount || 2;
  const eligible = Object.entries(entry.idCounts)
    .filter(([, c]) => c >= minCount)
    .map(([id]) => id);
  if (eligible.length === 0) return [];

  const secret = await getUserSecret();
  const rotWeeks = CFG.personaRotationWeeks || 1;
  const week = Math.floor(Date.now() / (rotWeeks * 7 * 24 * 60 * 60 * 1000));
  const seed = await seedFor(secret, origin, week);
  const rng = mulberry32(seed);

  const idToSlot = new Map();
  for (const [slotName, ids] of Object.entries(CFG.conflictSlots || {})) {
    for (const id of ids) idToSlot.set(id, slotName);
  }

  const bySlot = {};
  const unslotted = [];
  for (const id of eligible) {
    const slot = idToSlot.get(id);
    if (slot) (bySlot[slot] ||= []).push(id);
    else unslotted.push(id);
  }

  const sizeRange = CFG.personaSize || { min: 3, max: 8 };
  const target = sizeRange.min + Math.floor(rng() * (sizeRange.max - sizeRange.min + 1));

  const selected = [];
  for (const slotName of Object.keys(bySlot).sort()) {
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

const originFromUrl = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

// ─── Message router ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "static_probe_blocked" && sender.tab) {
    const tabId = sender.tab.id;
    const frameId = sender.frameId || 0;
    const origin = originFromUrl(sender.url);
    const s = getOrInitTab(tabId);
    if (origin) s.origin = origin;

    const idMap = new Map();
    if (msg.idCounts && typeof msg.idCounts === "object") {
      for (const [id, c] of Object.entries(msg.idCounts)) {
        if (typeof c === "number" && c > 0) idMap.set(id, c);
      }
    }
    s.frames.set(frameId, { total: msg.frameTotal || 0, idCounts: idMap });
    updateBadge(tabId, sumTabTotal(tabId));

    const delta = typeof msg.delta === "number" ? msg.delta : 0;
    if (delta > 0) serialize(() => addToCumulative(delta));
    if (origin && delta > 0) {
      serialize(() =>
        recordProbes(origin, {
          delta,
          deltaIdCounts: msg.deltaIdCounts || {},
          deltaVectorCounts: msg.deltaVectorCounts || {},
          deltaPathKindCounts: msg.deltaPathKindCounts || {},
        })
      );
    }
    return;
  }

  if (msg.type === "static_replay_detected" && sender.tab) {
    const origin = originFromUrl(sender.url);
    const signal = typeof msg.signal === "string" ? msg.signal : "unknown";
    if (origin) serialize(() => recordReplayDetection(origin, signal));
    return;
  }

  if (msg.type === "static_get_details" && typeof msg.tabId === "number") {
    (async () => {
      const stored = await chrome.storage.local.get({
        cumulative: 0,
        noise_enabled: false,
        probe_log: {},
        replay_log: {},
        replay_mode: "off",
      });
      const state = perTabState.get(msg.tabId);
      const origin = state ? state.origin : null;
      sendResponse({
        total: sumTabTotal(msg.tabId),
        topIds: topIdsForTab(msg.tabId, 5),
        cumulative: stored.cumulative,
        noiseEnabled: stored.noise_enabled,
        replayMode: stored.replay_mode,
        replayDetected: !!(origin && stored.replay_log[origin]),
        origin,
        drift:
          origin && stored.probe_log[origin]
            ? playbookDriftForEntry(stored.probe_log[origin])
            : null,
        originsLogged: Object.keys(stored.probe_log).length,
      });
    })();
    return true;
  }

  if (msg.type === "static_get_persona") {
    (async () => {
      const { noise_enabled = false, replay_mode = "off" } = await chrome.storage.local.get({
        noise_enabled: false,
        replay_mode: "off",
      });
      const origin = originFromUrl(sender.url);
      if (!noise_enabled || !origin) {
        sendResponse({
          ids: [],
          noiseEnabled: noise_enabled,
          replayMode: replay_mode,
          origin,
        });
        return;
      }
      const ids = await personaFor(origin);
      sendResponse({ ids, noiseEnabled: true, replayMode: replay_mode, origin });
    })();
    return true;
  }

  if (msg.type === "static_set_noise") {
    (async () => {
      await chrome.storage.local.set({ noise_enabled: !!msg.enabled });
      // Popup pushes `static_persona_update` to the active tab itself via its
      // activeTab grant; no global broadcast here (would require `tabs`
      // permission). Other tabs pick up the new state on their next navigation.
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "static_set_replay") {
    (async () => {
      const allowed = new Set(["off", "mask", "noise", "chaos"]);
      const mode = allowed.has(msg.mode) ? msg.mode : "off";
      await chrome.storage.local.set({ replay_mode: mode });
      sendResponse({ ok: true, mode });
    })();
    return true;
  }

  if (msg.type === "static_export_log") {
    (async () => {
      const {
        probe_log = {},
        replay_log = {},
        cumulative = 0,
      } = await chrome.storage.local.get({
        probe_log: {},
        replay_log: {},
        cumulative: 0,
      });
      sendResponse({
        schema: "static.probe-log.v1",
        exportedAt: new Date().toISOString(),
        cumulative,
        origins: probe_log,
        replayDetections: replay_log,
      });
    })();
    return true;
  }

  if (msg.type === "static_clear_log") {
    (async () => {
      cachedSecret = null;
      await chrome.storage.local.remove(["probe_log", "replay_log", "cumulative", "user_secret"]);
      sendResponse({ ok: true });
    })();
    return true;
  }
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
