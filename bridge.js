// Static - MAIN-world modules to service-worker bridge (ISOLATED world).
(() => {
  const CHROME_EXT_ID_RE = /^[a-p]{32}$/;
  const CONFIG_EVENTS = [
    "__static_element_decoy_bridge_init__",
    "__static_noise_bridge_init__",
    "__static_replay_bridge_init__",
  ];
  const PROBE_EVENTS = [
    "__static_noise_bridge_init__",
    "__static_probe_bridge_init__",
    "__static_style_probe_bridge_init__",
  ];
  const configPorts = new Set();
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
    if (value.endsWith("-decoy")) return value.slice(0, -"-decoy".length);
    return value || "unknown";
  };

  const pathKindFor = (url) => {
    const pathname = pathnameFor(url);
    if (pathname === null) return "unknown";
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

  const pathnameFor = (url) => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return null;
    }
  };

  const extractProbeId = (url) => {
    try {
      const parsed = new URL(String(url || ""));
      const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
      const id = parsed.hostname.toLowerCase();
      if (
        (scheme === "chrome-extension" || scheme === "edge-extension") &&
        CHROME_EXT_ID_RE.test(id)
      ) {
        return id;
      }
    } catch {}
    return null;
  };

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

  const flushOnHidden = () => {
    if (document.visibilityState === "hidden") flush();
  };

  const handleProbeBlocked = (data) => {
    pendingDelta++;
    bumpMap(pendingVectorCounts, normalizeVector(data.where));
    bumpMap(pendingPathKindCounts, pathKindFor(data.url));
    const id = extractProbeId(data.url);
    if (id) {
      bumpMap(idCounts, id);
      bumpMap(pendingIdCounts, id);
    }
    if (!flushTimer) flushTimer = setTimeout(flush, 150);
  };

  const sendReplaySignal = (signal) => {
    try {
      chrome.runtime.sendMessage({
        type: "static_replay_detected",
        signal: String(signal || "unknown").slice(0, 96),
      });
    } catch {}
  };

  const sendAdaptiveSignal = (signal = {}) => {
    try {
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
  };

  const handlePortMessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "probe_blocked") handleProbeBlocked(data);
    if (data.type === "replay_detected") sendReplaySignal(data.signal);
    if (data.type === "adaptive_signal") sendAdaptiveSignal(data.signal);
  };

  const createPort = (eventName) => {
    const channel = new MessageChannel();
    const port = channel.port1;
    port.onmessage = handlePortMessage;
    try {
      port.start();
    } catch {}
    if (CONFIG_EVENTS.includes(eventName)) configPorts.add(port);
    try {
      document.dispatchEvent(new MessageEvent(eventName, { ports: [channel.port2] }));
    } catch {}
    return port;
  };

  const postConfig = (port, response) => {
    try {
      port.postMessage({
        type: "config_update",
        persona: Array.isArray(response.ids) ? response.ids : [],
        noiseEnabled: !!response.noiseEnabled,
        replayMode: typeof response.replayMode === "string" ? response.replayMode : "off",
      });
    } catch {
      configPorts.delete(port);
    }
  };

  const refreshPersona = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: "static_get_persona" });
      if (!response) return;
      for (const port of [...configPorts]) postConfig(port, response);
    } catch {}
  };

  for (const eventName of new Set([
    ...PROBE_EVENTS,
    ...CONFIG_EVENTS,
    "__static_adaptive_bridge_init__",
  ])) {
    createPort(eventName);
  }
  refreshPersona();

  addEventListener("beforeunload", flush, { capture: true });
  addEventListener("pagehide", flush, { capture: true });
  document.addEventListener("visibilitychange", flushOnHidden, { capture: true });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "static_persona_update") refreshPersona();
  });
})();
