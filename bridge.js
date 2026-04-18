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
(() => {
  const EXT_ID_RE = /^(?:chrome|moz|ms-browser|safari-web|edge)-extension:\/\/([a-z0-9]+)/i;

  let pendingDelta = 0;
  let frameTotal = 0;
  let flushTimer = null;
  const idCounts = new Map();
  const pendingIdCounts = new Map();

  const channel = new MessageChannel();
  const bridgePort = channel.port1;

  const flush = () => {
    flushTimer = null;
    if (pendingDelta === 0) return;
    const delta = pendingDelta;
    frameTotal += pendingDelta;
    pendingDelta = 0;
    const snapshot = {};
    for (const [id, c] of idCounts) snapshot[id] = c;
    const deltaSnapshot = {};
    for (const [id, c] of pendingIdCounts) deltaSnapshot[id] = c;
    pendingIdCounts.clear();
    try {
      chrome.runtime.sendMessage({
        type: "static_probe_blocked",
        delta,
        frameTotal,
        idCounts: snapshot,
        deltaIdCounts: deltaSnapshot,
      });
    } catch {}
  };

  bridgePort.onmessage = (event) => {
    const data = event.data;
    if (data && data.type === "probe_blocked") {
      pendingDelta++;
      const m = EXT_ID_RE.exec(String(data.url || ""));
      if (m) {
        const id = m[1];
        idCounts.set(id, (idCounts.get(id) || 0) + 1);
        pendingIdCounts.set(id, (pendingIdCounts.get(id) || 0) + 1);
      }
      if (!flushTimer) flushTimer = setTimeout(flush, 150);
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
      });
    } catch {}
  };
  refreshPersona();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "static_persona_update") refreshPersona();
  });
})();
