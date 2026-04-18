// Static — MAIN ↔ service-worker bridge (ISOLATED world).
//
// Two responsibilities:
//   1. Establish a per-document MessageChannel with block.js, then listen for
//      probe events on that private port. Batches them on a 150ms timer,
//      extracts the extension ID from the URL, and forwards a snapshot
//      (per-flush delta + cumulative per-frame total + cumulative per-frame ID
//      counts) to the service worker.
//   2. Ask the service worker for the current Noise-mode persona for this
//      origin at page load (and again whenever the user toggles Noise mode),
//      then relay it into the MAIN world over the MessageChannel so block.js can
//      decide fetch-by-fetch whether to reject the probe or return a decoy.
//      The same channel also forwards local replay-SDK detections and the
//      opt-in Replay poisoning mode, plus observe-only adaptive behavior
//      signals. All data stays in chrome.storage.local.
(() => {
  const EXT_ID_RE = /^(?:chrome|moz|ms-browser|safari-web|edge)-extension:\/\/([a-z0-9]+)/i;

  let pendingDelta = 0;
  let frameTotal = 0;
  let flushTimer = null;
  const idCounts = new Map();
  const pendingIdCounts = new Map();
  const pendingVectorCounts = new Map();
  const pendingPathKindCounts = new Map();

  const bumpMap = (map, key, amount = 1) => {
    const safeKey = key || "unknown";
    map.set(safeKey, (map.get(safeKey) || 0) + amount);
  };

  const mapToObject = (map) => {
    const out = {};
    for (const [key, value] of map) out[key] = value;
    return out;
  };

  const normalizeVector = (where) => {
    const value = typeof where === "string" ? where : "";
    if (value === "fetch-decoy") return "fetch";
    if (value === "xhr-decoy") return "xhr";
    return value || "unknown";
  };

  const pathKindFor = (url) => {
    let pathname = "";
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch {
      return "unknown";
    }
    if (pathname === "" || pathname === "/") return "root";
    if (pathname.endsWith("/manifest.json")) return "manifest";
    if (/\.(png|jpe?g|gif|webp|ico|bmp)$/i.test(pathname)) return "image";
    if (pathname.endsWith(".svg")) return "svg";
    if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) return "script";
    if (pathname.endsWith(".css")) return "style";
    if (pathname.endsWith(".html") || pathname.endsWith(".htm")) return "html";
    if (pathname.endsWith(".json")) return "json";
    return "other";
  };

  const channel = new MessageChannel();
  const bridgePort = channel.port1;

  const flush = () => {
    flushTimer = null;
    if (pendingDelta === 0) return;
    const delta = pendingDelta;
    frameTotal += pendingDelta;
    pendingDelta = 0;
    const snapshot = mapToObject(idCounts);
    const deltaSnapshot = mapToObject(pendingIdCounts);
    const vectorSnapshot = mapToObject(pendingVectorCounts);
    const pathKindSnapshot = mapToObject(pendingPathKindCounts);
    pendingIdCounts.clear();
    pendingVectorCounts.clear();
    pendingPathKindCounts.clear();
    try {
      chrome.runtime.sendMessage({
        type: "static_probe_blocked",
        delta,
        frameTotal,
        idCounts: snapshot,
        deltaIdCounts: deltaSnapshot,
        deltaVectorCounts: vectorSnapshot,
        deltaPathKindCounts: pathKindSnapshot,
      });
    } catch {}
  };

  bridgePort.onmessage = (event) => {
    const data = event.data;
    if (data && data.type === "probe_blocked") {
      pendingDelta++;
      bumpMap(pendingVectorCounts, normalizeVector(data.where));
      bumpMap(pendingPathKindCounts, pathKindFor(data.url));
      const m = EXT_ID_RE.exec(String(data.url || ""));
      if (m) {
        const id = m[1];
        bumpMap(idCounts, id);
        bumpMap(pendingIdCounts, id);
      }
      if (!flushTimer) flushTimer = setTimeout(flush, 150);
    } else if (data && data.type === "replay_detected") {
      try {
        chrome.runtime.sendMessage({
          type: "static_replay_detected",
          signal: String(data.signal || "unknown").slice(0, 96),
        });
      } catch {}
    } else if (data && data.type === "adaptive_signal") {
      try {
        const signal = data.signal || {};
        chrome.runtime.sendMessage({
          type: "static_adaptive_signal",
          signal: {
            category: String(signal.category || "unknown").slice(0, 48),
            score: Math.max(0, Math.min(100, Math.round(signal.score || 0))),
            source: String(signal.source || "unknown").slice(0, 160),
            endpoint: String(signal.endpoint || "").slice(0, 160),
            reasons: Array.isArray(signal.reasons)
              ? signal.reasons.map((reason) => String(reason).slice(0, 64)).slice(0, 12)
              : [],
          },
        });
      } catch {}
    }
  };
  try {
    bridgePort.start();
  } catch {}

  try {
    document.dispatchEvent(new MessageEvent("__static_bridge_init__", { ports: [channel.port2] }));
  } catch {}

  const refreshPersona = async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "static_get_persona" });
      if (!resp) return;
      bridgePort.postMessage({
        type: "config_update",
        persona: Array.isArray(resp.ids) ? resp.ids : [],
        noiseEnabled: !!resp.noiseEnabled,
        replayMode: typeof resp.replayMode === "string" ? resp.replayMode : "off",
      });
    } catch {}
  };
  refreshPersona();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "static_persona_update") refreshPersona();
  });
})();
