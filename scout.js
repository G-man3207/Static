/* eslint-disable max-statements -- the bus, the caps and the lifecycle are one state machine and are easier to audit together */
// Static - MAIN-world observe-only page scout (orchestrator).
//
// Loaded at document_start after block_utils.js and signals.js, before
// scout_probes.js / scout_signals.js. It captures the two setup globals into a
// closure, deletes them, and exposes ONE temporary global for the two observer
// modules to read (__static_scout__). The last module calls ready(); this file
// then removes its own global too, so a scanned page ends up with Static's
// wrappers and no page-visible global.
//
// The scout is a hint engine, not a blocker: everything is try/catch, no page
// value is stored or forwarded (only counts, catalog ids and extension-URL
// pathnames), and no page-visible behavior may change. It never reads form
// values, cookies, storage values or text content.
//
// Wire shape (MAIN -> ISOLATED port, then forwarded by bridge.js as
// {type:"static_site_evidence", probes, overflow, signals}):
//   {
//     type: "site_evidence",
//     seq: <monotonic int, bridge dedupe>,
//     probes: [{ url: "<scheme>://<extid><sanitized path>", where: "<vector>", count }],
//     overflow: <probe events not enumerated>,
//     signals: { uaReads, vendors, device, replay, compat }, // deltas
//   }
(() => {
  const GLOBAL_NAME = "__static_scout__";
  const U = globalThis.__static_block_utils__;
  const SIGNALS = globalThis.__static_signals__;
  if (!U) return;
  try {
    if (globalThis[GLOBAL_NAME]) return;
  } catch {}

  // Captured before any page script runs: page monkey patches must not change
  // the scout's own scheduling, URL parsing or evidence encoding.
  const NativeURL = globalThis.URL;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeNow = Date.now;
  const nativeAddEventListener = EventTarget.prototype.addEventListener;
  const nativeJSONStringify = JSON.stringify;

  const BRIDGE_EVENT = "__perf_scout_bi__";
  const DRAIN_EVENT = "__static_scout_drain__";
  // Batching and volume caps (docs/site-protection.md "Cost ceilings").
  const FLUSH_DELAY_MS = 250;
  const IDLE_FLUSH_MS = 1500;
  // Burst budget: the first 60 batches may go out every 250 ms. After that a
  // page that keeps probing still reports one batch per MESSAGE_REFILL_MS, so a
  // long-lived SPA never freezes its evidence while a pathological loop stays
  // bounded to ~0.5 messages/s.
  const MAX_MESSAGES = 60;
  const MESSAGE_REFILL_MS = 2000;
  const MAX_PROBES_PER_PAGE = 200;
  const MAX_PROBE_IDS = 300;
  const MAX_VECTORS = 24;
  const MAX_VENDORS = 40;
  const MAX_DEVICE = 30;
  const MAX_REPLAY = 20;
  const MAX_COUNT = 1_000_000;
  const MAX_REPEATED_COMPAT = 3;
  const MAX_QUEUED = 2000;
  const SEAL_RETRY_MS = 10;
  const SEAL_RETRIES = 12;
  const REPEATED_COMPAT_IDS = new Set(["bot_challenge", "captcha", "cross_origin_frame"]);
  const EMPTY_CATALOG = { compat: [], device: [], replay: [], vectors: [], vendors: [] };

  const catalog = SIGNALS && typeof SIGNALS === "object" ? SIGNALS : EMPTY_CATALOG;
  const rowsOf = (rows) => (Array.isArray(rows) ? rows : []);
  // Catalog membership is a whitelist, not the evidence cap: the catalog can
  // hold more rows than the per-site counter caps (MAX_VENDORS etc.) because a
  // page only ever exercises a subset, and the service worker trims storage.
  const validIdSet = (rows) => {
    const ids = new Set();
    for (const row of rowsOf(rows)) {
      if (row && typeof row.id === "string" && row.id) ids.add(row.id);
    }
    return ids;
  };
  const vendorIds = validIdSet(catalog.vendors);
  const deviceIds = validIdSet(catalog.device);
  const replayIds = validIdSet(catalog.replay);
  const compatIds = validIdSet(catalog.compat);
  const vectorIds = new Set(rowsOf(catalog.vectors).filter((vector) => typeof vector === "string"));

  // ─── State ─────────────────────────────────────────────────────────────────
  let bridge = null;
  let sequence = 0;
  let messages = 0;
  let lastMessageAt = 0;
  let flushTimer = null;
  let idleTimer = null;
  let sealTimer = null;
  let sealAttempts = 0;
  let sealed = false;
  let stopped = false;
  let pageFinished = false;
  let probesReady = false;
  let signalsReady = false;
  let lastPayload = null;
  let pendingProbes = new Map();
  let overflowProbes = 0;
  let pendingSignals = null;
  const reportedProbes = new Set();
  const reportedIds = new Set();
  const reportedVectors = new Set();
  const seenVendors = new Set();
  const seenReplay = new Set();
  const compatCounts = {};
  const finalizeHandlers = [];

  const emptySignals = () => ({ compat: {}, device: {}, replay: {}, uaReads: 0, vendors: {} });
  pendingSignals = emptySignals();

  // ─── Small helpers ─────────────────────────────────────────────────────────
  const clampCount = (value, fallback) => {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(MAX_COUNT, number);
  };

  const normalizeWhere = (where) => {
    if (typeof where !== "string") return "unknown";
    const value = where.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) return "unknown";
    if (vectorIds.size > 0 && !vectorIds.has(value)) return "unknown";
    return value;
  };

  const extensionIdOf = (url) => {
    const start = url.indexOf("://");
    if (start === -1) return "";
    const hostStart = start + 3;
    const slash = url.indexOf("/", hostStart);
    return url.slice(hostStart, slash === -1 ? url.length : slash);
  };

  // Reduce an extension URL to scheme + lowercased ID + sanitized pathname.
  // Everything else (query, hash, unknown path characters, >96 chars) is
  // dropped, so the only page data the report carries is the probe target.
  const sanitizeProbeUrl = (value) => {
    if (typeof value !== "string" || value.indexOf("-extension:") === -1) return "";
    let parsed;
    try {
      parsed = new NativeURL(value);
    } catch {
      return "";
    }
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    const id = parsed.hostname.toLowerCase();
    const identityRe = U.EXT_ID_RE_BY_SCHEME[scheme];
    if (!identityRe || !identityRe.test(id)) return "";
    return `${scheme}://${id}${U.sanitizeExtensionPath(parsed.pathname)}`;
  };

  // ─── Batching ───────────────────────────────────────────────────────────────
  const hasPending = () =>
    pendingProbes.size > 0 ||
    overflowProbes > 0 ||
    pendingSignals.uaReads > 0 ||
    Object.keys(pendingSignals.vendors).length > 0 ||
    Object.keys(pendingSignals.device).length > 0 ||
    Object.keys(pendingSignals.replay).length > 0 ||
    Object.keys(pendingSignals.compat).length > 0;

  const dropGlobal = (name) => {
    try {
      delete globalThis[name];
    } catch {}
  };

  const seal = () => {
    if (sealed) return;
    sealed = true;
    try {
      if (sealTimer) nativeClearTimeout(sealTimer);
    } catch {}
    sealTimer = null;
    dropGlobal(GLOBAL_NAME);
  };

  const finish = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (flushTimer) nativeClearTimeout(flushTimer);
      if (idleTimer) nativeClearTimeout(idleTimer);
    } catch {}
    flushTimer = null;
    idleTimer = null;
    for (const handler of finalizeHandlers.splice(0)) {
      try {
        handler();
      } catch {}
    }
  };

  const buildPayload = () => {
    if (!hasPending()) return null;
    const probes = [];
    for (const entry of pendingProbes.values()) {
      probes.push({ count: entry.count, url: entry.url, where: entry.where });
    }
    sequence += 1;
    const payload = {
      overflow: overflowProbes,
      probes,
      seq: sequence,
      signals: pendingSignals,
      type: "site_evidence",
    };
    pendingProbes = new Map();
    overflowProbes = 0;
    pendingSignals = emptySignals();
    lastPayload = payload;
    return payload;
  };

  const postPayload = (payload) => {
    try {
      bridge.post("site_evidence", payload);
    } catch {}
  };

  const clearFlushTimer = () => {
    if (!flushTimer) return;
    try {
      nativeClearTimeout(flushTimer);
    } catch {}
    flushTimer = null;
  };

  const messageBudgetDelay = () => {
    if (messages < MAX_MESSAGES) return 0;
    return Math.max(0, MESSAGE_REFILL_MS - (nativeNow() - lastMessageAt));
  };

  const scheduleFlush = (delay) => {
    try {
      if (stopped || pageFinished || flushTimer) return;
      const spacing =
        typeof delay === "number"
          ? Math.max(0, delay)
          : Math.max(0, FLUSH_DELAY_MS - (nativeNow() - lastMessageAt));
      const wait = Math.max(spacing, messageBudgetDelay());
      flushTimer = nativeSetTimeout(onFlushTimer, wait);
    } catch {}
  };

  const flush = (force) => {
    try {
      if (stopped || pageFinished) return;
      clearFlushTimer();
      if (!hasPending()) return;
      const now = nativeNow();
      if (!force && now - lastMessageAt < FLUSH_DELAY_MS) {
        scheduleFlush(FLUSH_DELAY_MS - (now - lastMessageAt));
        return;
      }
      if (!force && messages >= MAX_MESSAGES && now - lastMessageAt < MESSAGE_REFILL_MS) {
        scheduleFlush(messageBudgetDelay());
        return;
      }
      const payload = buildPayload();
      if (!payload) return;
      messages += 1;
      lastMessageAt = now;
      postPayload(payload);
    } catch {}
  };

  const onFlushTimer = () => {
    flushTimer = null;
    flush(false);
  };

  // Final batch on pagehide. The payload is also kept in `lastPayload` so the
  // bridge's synchronous drain (CustomEvent from the ISOLATED world, before the
  // document is destroyed) can forward it without waiting for the port task.
  const finalize = () => {
    try {
      if (pageFinished) return;
      if (!stopped && hasPending()) {
        const payload = buildPayload();
        if (payload) {
          messages += 1;
          lastMessageAt = nativeNow();
          postPayload(payload);
        }
      }
      pageFinished = true;
    } catch {
      pageFinished = true;
    }
    finish();
  };

  // Called synchronously by the bridge's drain listener. Draining twice returns
  // the same batch, which the bridge drops by `seq` (never double-counted).
  const drain = () => {
    try {
      if (!stopped && !pageFinished && hasPending()) {
        const payload = buildPayload();
        if (payload) {
          messages += 1;
          lastMessageAt = nativeNow();
          postPayload(payload);
        }
      }
      return lastPayload ? nativeJSONStringify(lastPayload) : "";
    } catch {
      return "";
    }
  };

  // ─── Probe accounting ──────────────────────────────────────────────────────
  const addProbeEntry = (url, where, amount) => {
    const key = `${url}\n${where}`;
    const queued = pendingProbes.get(key);
    if (queued) {
      queued.count = Math.min(MAX_COUNT, queued.count + amount);
      scheduleFlush();
      return;
    }
    if (reportedProbes.size >= MAX_PROBES_PER_PAGE) {
      overflowProbes = Math.min(MAX_COUNT, overflowProbes + amount);
      scheduleFlush();
      return;
    }
    if (!reportedVectors.has(where)) {
      if (reportedVectors.size >= MAX_VECTORS) {
        overflowProbes = Math.min(MAX_COUNT, overflowProbes + amount);
        scheduleFlush();
        return;
      }
      reportedVectors.add(where);
    }
    const id = extensionIdOf(url);
    if (id && !reportedIds.has(id)) {
      if (reportedIds.size >= MAX_PROBE_IDS) {
        overflowProbes = Math.min(MAX_COUNT, overflowProbes + amount);
        scheduleFlush();
        return;
      }
      reportedIds.add(id);
    }
    reportedProbes.add(key);
    pendingProbes.set(key, { count: amount, url, where });
    scheduleFlush();
  };

  const probe = (value, where, count) => {
    try {
      if (stopped || pageFinished) return;
      const url = sanitizeProbeUrl(value);
      if (!url) return;
      bus.metrics.probes += 1;
      addProbeEntry(url, normalizeWhere(where), clampCount(count, 1));
    } catch {}
  };

  // ─── Signal accounting (deltas since the last message) ─────────────────────
  const acceptsId = (kindSet, id) =>
    typeof id === "string" && id.length > 0 && (kindSet.size === 0 || kindSet.has(id));

  const addDelta = (map, seen, id, { amount, maxKeys }) => {
    if (seen) {
      if (seen.has(id)) return;
      if (seen.size >= maxKeys) return;
      seen.add(id);
    } else if (
      !Object.prototype.hasOwnProperty.call(map, id) &&
      Object.keys(map).length >= maxKeys
    ) {
      return;
    }
    map[id] = Math.min(MAX_COUNT, (map[id] || 0) + amount);
    scheduleFlush();
  };

  const vendor = (id) => {
    try {
      if (stopped || pageFinished || !acceptsId(vendorIds, id)) return;
      addDelta(pendingSignals.vendors, seenVendors, id, { amount: 1, maxKeys: MAX_VENDORS });
    } catch {}
  };

  const device = (id, count) => {
    try {
      if (stopped || pageFinished || !acceptsId(deviceIds, id)) return;
      addDelta(pendingSignals.device, null, id, {
        amount: clampCount(count, 1),
        maxKeys: MAX_DEVICE,
      });
    } catch {}
  };

  const replay = (id) => {
    try {
      if (stopped || pageFinished || !acceptsId(replayIds, id)) return;
      addDelta(pendingSignals.replay, seenReplay, id, { amount: 1, maxKeys: MAX_REPLAY });
    } catch {}
  };

  const compat = (id) => {
    try {
      if (stopped || pageFinished || !acceptsId(compatIds, id)) return;
      const limit = REPEATED_COMPAT_IDS.has(id) ? MAX_REPEATED_COMPAT : 1;
      const seen = compatCounts[id] || 0;
      if (seen >= limit) return;
      compatCounts[id] = seen + 1;
      pendingSignals.compat[id] = (pendingSignals.compat[id] || 0) + 1;
      scheduleFlush();
    } catch {}
  };

  const uaRead = (count) => {
    try {
      if (stopped || pageFinished) return;
      pendingSignals.uaReads = Math.min(MAX_COUNT, pendingSignals.uaReads + clampCount(count, 1));
      scheduleFlush();
    } catch {}
  };

  const signal = (kind, id, count) => {
    if (kind === "vendor") vendor(id);
    else if (kind === "device") device(id, count);
    else if (kind === "replay") replay(id);
    else if (kind === "compat") compat(id);
  };

  const ready = (name) => {
    try {
      if (name === "probes") probesReady = true;
      else if (name === "signals") signalsReady = true;
      if (probesReady && signalsReady) seal();
    } catch {}
  };

  const sealWhenReady = () => {
    sealTimer = null;
    if (sealed) return;
    if ((probesReady && signalsReady) || sealAttempts >= SEAL_RETRIES) {
      seal();
      return;
    }
    sealAttempts += 1;
    sealTimer = nativeSetTimeout(sealWhenReady, SEAL_RETRY_MS);
  };

  const onFinalize = (handler) => {
    if (typeof handler !== "function") return;
    if (stopped) {
      try {
        handler();
      } catch {}
      return;
    }
    finalizeHandlers.push(handler);
  };

  // ─── Bridge port ─────────────────────────────────────────────────────────────
  try {
    bridge = U.setupBridge(BRIDGE_EVENT, MAX_QUEUED, () => {});
  } catch {}
  if (!bridge) bridge = { post() {}, probe() {} };

  const bus = {
    U,
    catalog,
    metrics: { probes: 0, resources: 0, vendorMatches: 0 },
    compat,
    device,
    drain,
    isStopped: () => stopped,
    now: nativeNow,
    onFinalize,
    page: () => flush(true),
    probe,
    ready,
    replay,
    report: () => flush(true),
    signal,
    uaRead,
    vendor,
    vectorIds,
  };

  // ─── Page-visible global, page lifecycle, synchronous drain ─────────────────
  try {
    Object.defineProperty(globalThis, GLOBAL_NAME, {
      configurable: true,
      enumerable: false,
      value: bus,
      writable: false,
    });
  } catch {
    globalThis[GLOBAL_NAME] = bus;
  }
  dropGlobal("__static_signals__");
  dropGlobal("__static_block_utils__");

  const listen = (target, type, handler, options) => {
    try {
      nativeAddEventListener.call(target, type, handler, options);
    } catch {}
  };

  listen(
    globalThis,
    "pagehide",
    () => {
      try {
        finalize();
      } catch {}
    },
    { capture: true }
  );
  listen(
    document,
    "visibilitychange",
    () => {
      try {
        if (document.visibilityState === "hidden") flush(true);
      } catch {}
    },
    { capture: true }
  );
  listen(
    document,
    DRAIN_EVENT,
    (event) => {
      try {
        const serialized = drain();
        if (serialized && event && event.detail && typeof event.detail === "object") {
          event.detail.payload = serialized;
        }
      } catch {}
    },
    { capture: true }
  );
  listen(
    globalThis,
    "load",
    () => {
      try {
        flush(true);
      } catch {}
    },
    { capture: true }
  );

  // One idle sweep, one safety net for pages that never fire load.
  try {
    idleTimer = nativeSetTimeout(() => {
      idleTimer = null;
      flush(true);
    }, IDLE_FLUSH_MS);
  } catch {}

  nativeSetTimeout(sealWhenReady, 0);
})();
