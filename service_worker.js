// Static — background service worker.
//
// Responsibilities:
//   1. Track per-tab / per-frame probe-block state, drive the toolbar badge.
//   2. Accumulate a since-install counter in chrome.storage.local.
//   3. Record per-origin probe logs (which extension IDs each site probes for).
//   4. Generate per-origin decoy personas on demand for Noise mode (stable
//      deterministic subset of observed IDs, rotated on a weekly cadence, seeded
//      from a per-user secret so different users claim different sets).
//   5. Answer popup queries (`static_get_details`, `static_export_log`,
//      `static_set_noise`) and bridge queries (`static_get_persona`).

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

const enforceCaps = (probeLog) => {
  for (const origin in probeLog) {
    const entry = probeLog[origin];
    const ids = Object.entries(entry.idCounts);
    if (ids.length > 2000) {
      ids.sort((a, b) => b[1] - a[1]);
      entry.idCounts = Object.fromEntries(ids.slice(0, 2000));
    }
  }
  const origins = Object.keys(probeLog);
  if (origins.length > 100) {
    origins.sort((a, b) => (probeLog[b].lastUpdated || 0) - (probeLog[a].lastUpdated || 0));
    for (const o of origins.slice(100)) delete probeLog[o];
  }
};

const recordProbes = async (origin, idCounts) => {
  const { probe_log = {} } = await chrome.storage.local.get({ probe_log: {} });
  const entry = probe_log[origin] || { idCounts: {}, lastUpdated: 0 };
  let changed = false;
  for (const [id, c] of Object.entries(idCounts)) {
    const cur = entry.idCounts[id] || 0;
    if (c > cur) {
      entry.idCounts[id] = c;
      changed = true;
    }
  }
  if (!changed) return;
  entry.lastUpdated = Date.now();
  probe_log[origin] = entry;
  enforceCaps(probe_log);
  await chrome.storage.local.set({ probe_log });
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
  const hex = Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
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
    if (origin && msg.idCounts) serialize(() => recordProbes(origin, msg.idCounts));
    return;
  }

  if (msg.type === "static_get_details" && typeof msg.tabId === "number") {
    (async () => {
      const stored = await chrome.storage.local.get({
        cumulative: 0,
        noise_enabled: false,
        probe_log: {},
      });
      const state = perTabState.get(msg.tabId);
      sendResponse({
        total: sumTabTotal(msg.tabId),
        topIds: topIdsForTab(msg.tabId, 5),
        cumulative: stored.cumulative,
        noiseEnabled: stored.noise_enabled,
        origin: state ? state.origin : null,
        originsLogged: Object.keys(stored.probe_log).length,
      });
    })();
    return true;
  }

  if (msg.type === "static_get_persona") {
    (async () => {
      const { noise_enabled = false } = await chrome.storage.local.get({ noise_enabled: false });
      const origin = originFromUrl(sender.url);
      if (!noise_enabled || !origin) {
        sendResponse({ ids: [], noiseEnabled: noise_enabled, origin });
        return;
      }
      const ids = await personaFor(origin);
      sendResponse({ ids, noiseEnabled: true, origin });
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

  if (msg.type === "static_export_log") {
    (async () => {
      const { probe_log = {}, cumulative = 0 } = await chrome.storage.local.get({
        probe_log: {},
        cumulative: 0,
      });
      sendResponse({
        schema: "static.probe-log.v1",
        exportedAt: new Date().toISOString(),
        cumulative,
        origins: probe_log,
      });
    })();
    return true;
  }

  if (msg.type === "static_clear_log") {
    (async () => {
      await chrome.storage.local.set({ probe_log: {}, cumulative: 0 });
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
