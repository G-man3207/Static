// Static - MAIN-world observe-only adaptive behavior logger.
(() => {
  const BRIDGE_EVENT = "__static_adaptive_bridge_init__";
  const ADAPTIVE_WINDOW_MS = 4000;
  const ADAPTIVE_COOLDOWN_MS = 7000;
  const ADAPTIVE_TRIGGER_SCORE = 7;
  const ADAPTIVE_WEIGHTS = {
    canvas: 2,
    webgl: 2,
    audio: 2,
    navigator: 1,
    crypto: 3,
    dom_observer: 3,
    input_hooks: 2,
    network: 2,
  };
  const ADAPTIVE_INPUT_EVENTS = new Set([
    "input",
    "keydown",
    "keyup",
    "keypress",
    "mousemove",
    "pointermove",
    "scroll",
    "touchmove",
  ]);
  const adaptiveWindows = new Map();
  const queuedSignals = [];
  const MAX_QUEUED_SIGNALS = 50;
  let bridgePort = null;

  const stealthFns = new WeakMap();
  const origFnToString = Function.prototype.toString;
  const patchedFnToString = {
    toString() {
      if (stealthFns.has(this)) return stealthFns.get(this);
      return origFnToString.call(this);
    },
  }.toString;
  stealthFns.set(patchedFnToString, "function toString() { [native code] }");
  try {
    Object.defineProperty(patchedFnToString, "name", { value: "toString", configurable: true });
    Object.defineProperty(patchedFnToString, "length", { value: 0, configurable: true });
  } catch {}
  Function.prototype.toString = patchedFnToString;

  const stealth = (fn, nativeName, opts = {}) => {
    stealthFns.set(fn, opts.source || `function ${nativeName}() { [native code] }`);
    try {
      Object.defineProperty(fn, "name", { value: nativeName, configurable: true });
    } catch {}
    if (typeof opts.length === "number") {
      try {
        Object.defineProperty(fn, "length", { value: opts.length, configurable: true });
      } catch {}
    }
    return fn;
  };

  const alignPrototypeConstructor = (wrapped, original) => {
    try {
      const proto = original && original.prototype;
      if (!proto) return;
      const desc = Object.getOwnPropertyDescriptor(proto, "constructor") || {
        writable: true,
        configurable: true,
        enumerable: false,
      };
      Object.defineProperty(proto, "constructor", {
        ...desc,
        value: wrapped,
      });
    } catch {}
  };

  const sanitizeSignal = (signal) => ({
    category: String((signal && signal.category) || "unknown").slice(0, 48),
    score: Math.max(0, Math.min(100, Math.round((signal && signal.score) || 0))),
    source: String((signal && signal.source) || "unknown").slice(0, 160),
    endpoint: String((signal && signal.endpoint) || "").slice(0, 160),
    reasons: Array.isArray(signal && signal.reasons)
      ? signal.reasons.map((reason) => String(reason).slice(0, 64)).slice(0, 12)
      : [],
  });

  const postAdaptiveSignal = (signal) => {
    const safeSignal = sanitizeSignal(signal);
    if (bridgePort) {
      try {
        bridgePort.postMessage({ type: "adaptive_signal", signal: safeSignal });
        return;
      } catch {
        bridgePort = null;
      }
    }
    if (queuedSignals.length < MAX_QUEUED_SIGNALS) {
      queuedSignals.push(safeSignal);
    }
  };

  const flushQueuedSignals = () => {
    if (!bridgePort) return;
    const batch = queuedSignals.splice(0, queuedSignals.length);
    for (const signal of batch) {
      try {
        bridgePort.postMessage({ type: "adaptive_signal", signal });
      } catch {
        bridgePort = null;
        return;
      }
    }
  };

  const onBridgeInit = (event) => {
    if (bridgePort) return;
    const port = event && event.ports && event.ports[0];
    if (!port || typeof port.postMessage !== "function") return;

    try {
      event.stopImmediatePropagation();
    } catch {}
    bridgePort = port;
    try {
      bridgePort.start();
    } catch {}
    flushQueuedSignals();
    document.removeEventListener(BRIDGE_EVENT, onBridgeInit);
  };
  document.addEventListener(BRIDGE_EVENT, onBridgeInit);

  const currentAdaptiveSource = () => {
    try {
      if (document.currentScript && document.currentScript.src) {
        return stableUrlLabelFor(document.currentScript.src);
      }
    } catch {}
    return "inline-or-runtime";
  };

  const redactPathSegment = (segment) => {
    if (!segment) return segment;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) {
      return ":uuid";
    }
    if (/^[0-9a-f]{16,}$/i.test(segment)) return ":hex";
    if (/^\d{5,}$/.test(segment)) return ":num";
    if (segment.length >= 24 && /[a-z]/i.test(segment) && /\d/.test(segment)) {
      const ext = segment.match(/\.[a-z0-9]{1,8}$/i);
      return ext ? `:token${ext[0].toLowerCase()}` : ":token";
    }
    return segment;
  };

  const redactedPathnameFor = (pathname) =>
    String(pathname || "")
      .split("/")
      .map(redactPathSegment)
      .join("/");

  const stableUrlLabelFor = (url) => {
    try {
      const parsed = new URL(String(url), location.href);
      return parsed.origin + redactedPathnameFor(parsed.pathname);
    } catch {
      try {
        return String(url || "")
          .split(/[?#]/)[0]
          .slice(0, 160);
      } catch {
        return "";
      }
    }
  };

  const stableEndpointFor = (url) => {
    try {
      const parsed = new URL(String(url), location.href);
      return parsed.origin + redactedPathnameFor(parsed.pathname);
    } catch {
      return "";
    }
  };

  const sizeBucketFor = (value) => {
    const size = bodySizeFor(value);
    if (size === 0) return "0";
    if (size < 1024) return "<1k";
    if (size < 10 * 1024) return "1k-10k";
    if (size < 100 * 1024) return "10k-100k";
    return "100k+";
  };

  const bodySizeFor = (value) => {
    if (value == null) return 0;
    try {
      if (typeof value === "string") return value.length;
      if (value instanceof Blob) return value.size;
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (value instanceof URLSearchParams) return String(value).length;
      if (value instanceof FormData) return 1024;
      return String(value).length;
    } catch {
      return 0;
    }
  };

  const adaptiveCategoryFor = (kinds) => {
    if (kinds.has("dom_observer") && kinds.has("input_hooks")) return "session-replay";
    if (kinds.has("crypto") && kinds.has("network")) return "anti-bot";
    const hasReadback = kinds.has("canvas") || kinds.has("webgl") || kinds.has("audio");
    const hasCorroboration = kinds.has("navigator") || kinds.has("network");
    return hasReadback && hasCorroboration ? "fingerprinting" : "mixed";
  };

  const getAdaptiveEntry = (now) => {
    const key = "page-window";
    let entry = adaptiveWindows.get(key);
    if (entry && now - entry.startedAt <= ADAPTIVE_WINDOW_MS) return entry;
    entry = {
      startedAt: now,
      lastReportedAt: 0,
      kinds: {},
      endpoints: {},
      sources: {},
      details: {},
    };
    adaptiveWindows.set(key, entry);
    return entry;
  };

  const bumpEntry = (entry, kind, detail, source) => {
    const safeKind = String(kind || "unknown").slice(0, 48);
    entry.kinds[safeKind] = (entry.kinds[safeKind] || 0) + 1;
    if (source) entry.sources[source] = (entry.sources[source] || 0) + 1;
    if (detail.endpoint) {
      const endpoint = String(detail.endpoint).slice(0, 160);
      entry.endpoints[endpoint] = (entry.endpoints[endpoint] || 0) + 1;
    }
    if (detail.detail) {
      const safeDetail = String(detail.detail).slice(0, 64);
      entry.details[safeDetail] = (entry.details[safeDetail] || 0) + 1;
    }
  };

  const scoreForKinds = (kinds) =>
    [...kinds].reduce((sum, name) => sum + (ADAPTIVE_WEIGHTS[name] || 1), 0);

  const shouldReportEntry = (entry, kinds, score, now) => {
    const hasNetwork = kinds.has("network");
    const nonNetworkKinds = [...kinds].filter((name) => name !== "network").length;
    const strongReplay = kinds.has("dom_observer") && kinds.has("input_hooks");
    return (
      score >= ADAPTIVE_TRIGGER_SCORE &&
      (strongReplay || (hasNetwork && nonNetworkKinds >= 2)) &&
      now - entry.lastReportedAt > ADAPTIVE_COOLDOWN_MS
    );
  };

  const recordAdaptiveSignal = (kind, detail = {}) => {
    const now = Date.now();
    const source = String(detail.source || currentAdaptiveSource()).slice(0, 160);
    const entry = getAdaptiveEntry(now);
    bumpEntry(entry, kind, detail, source);

    const kinds = new Set(Object.keys(entry.kinds));
    const score = scoreForKinds(kinds);
    if (!shouldReportEntry(entry, kinds, score, now)) return;

    entry.lastReportedAt = now;
    const endpointEntries = Object.entries(entry.endpoints).sort((a, b) => b[1] - a[1]);
    const sourceEntries = Object.entries(entry.sources).sort((a, b) => b[1] - a[1]);
    postAdaptiveSignal({
      category: adaptiveCategoryFor(kinds),
      score,
      source: sourceEntries.length ? sourceEntries[0][0] : source,
      endpoint: endpointEntries.length ? endpointEntries[0][0] : "",
      reasons: [...kinds, ...Object.keys(entry.details).slice(0, 8)],
    });
  };

  const recordAdaptiveNetwork = (where, url, body) => {
    const endpoint = stableEndpointFor(url);
    if (!endpoint) return;
    recordAdaptiveSignal("network", {
      endpoint,
      detail: `${where}:${sizeBucketFor(body)}`,
    });
  };

  const patchMethod = ({ owner, name, label, recorder, length }) => {
    if (!owner || typeof owner[name] !== "function") return;
    const orig = owner[name];
    const wrapped = {
      [name](...args) {
        try {
          if (recorder) recorder.apply(this, args);
        } catch {}
        return orig.apply(this, args);
      },
    }[name];
    owner[name] = stealth(wrapped, label || name, { length: length ?? orig.length });
  };

  const patchNavigatorGetter = (prop) => {
    try {
      const proto = Navigator.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || typeof desc.get !== "function") return;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: stealth(
          function get() {
            try {
              recordAdaptiveSignal("navigator", { detail: `navigator.${prop}` });
            } catch {}
            return desc.get.call(this);
          },
          `get ${prop}`,
          { length: 0 }
        ),
      });
    } catch {}
  };

  const patchReadbackApis = () => {
    patchMethod({
      owner: HTMLCanvasElement.prototype,
      name: "toDataURL",
      recorder: () => recordAdaptiveSignal("canvas", { detail: "canvas.toDataURL" }),
    });
    patchMethod({
      owner: HTMLCanvasElement.prototype,
      name: "toBlob",
      recorder: () => recordAdaptiveSignal("canvas", { detail: "canvas.toBlob" }),
    });
    if (typeof CanvasRenderingContext2D !== "undefined") {
      patchMethod({
        owner: CanvasRenderingContext2D.prototype,
        name: "getImageData",
        recorder: () => recordAdaptiveSignal("canvas", { detail: "canvas.getImageData" }),
      });
    }
  };

  const patchGpuApis = () => {
    if (typeof WebGLRenderingContext !== "undefined") {
      patchMethod({
        owner: WebGLRenderingContext.prototype,
        name: "getParameter",
        recorder: () => recordAdaptiveSignal("webgl", { detail: "webgl.getParameter" }),
      });
    }
    if (typeof WebGL2RenderingContext !== "undefined") {
      patchMethod({
        owner: WebGL2RenderingContext.prototype,
        name: "getParameter",
        recorder: () => recordAdaptiveSignal("webgl", { detail: "webgl2.getParameter" }),
      });
    }
  };

  const patchCryptoApis = () => {
    if (typeof SubtleCrypto === "undefined") return;
    for (const name of ["digest", "encrypt", "importKey"]) {
      patchMethod({
        owner: SubtleCrypto.prototype,
        name,
        recorder: () => recordAdaptiveSignal("crypto", { detail: `crypto.${name}` }),
      });
    }
  };

  const patchAudioApis = () => {
    if (typeof OfflineAudioContext !== "undefined") {
      patchMethod({
        owner: OfflineAudioContext.prototype,
        name: "startRendering",
        recorder: () => recordAdaptiveSignal("audio", { detail: "audio.startRendering" }),
      });
    }
    if (typeof AudioBuffer !== "undefined") {
      patchMethod({
        owner: AudioBuffer.prototype,
        name: "getChannelData",
        recorder: () => recordAdaptiveSignal("audio", { detail: "audio.getChannelData" }),
      });
    }
  };

  const patchMutationObserver = () => {
    if (typeof MutationObserver !== "function") return;
    const OrigMutationObserver = MutationObserver;
    const WrappedMutationObserver = function MutationObserver(callback) {
      const observer = new OrigMutationObserver(callback);
      const origObserve = observer.observe;
      observer.observe = stealth(
        function observe(target, options) {
          try {
            const globalTarget =
              target === document ||
              target === document.documentElement ||
              target === document.body;
            if (globalTarget && options && options.subtree) {
              recordAdaptiveSignal("dom_observer", { detail: "mutation.subtree" });
            }
          } catch {}
          return origObserve.apply(this, arguments);
        },
        "observe",
        { length: 2 }
      );
      return observer;
    };
    WrappedMutationObserver.prototype = OrigMutationObserver.prototype;
    alignPrototypeConstructor(WrappedMutationObserver, OrigMutationObserver);
    window.MutationObserver = stealth(WrappedMutationObserver, "MutationObserver", { length: 1 });
  };

  const patchNetworkApis = () => {
    patchMethod({
      owner: window,
      name: "fetch",
      recorder(input) {
        recordAdaptiveNetwork(
          "fetch",
          input && input.url ? input.url : input,
          arguments[1] && Object.prototype.hasOwnProperty.call(arguments[1], "body")
            ? arguments[1].body
            : null
        );
      },
      length: 1,
    });
    patchXhrNetwork();
    patchBeaconNetwork();
  };

  const patchXhrNetwork = () => {
    const xhrUrls = new WeakMap();
    patchMethod({
      owner: XMLHttpRequest.prototype,
      name: "open",
      recorder(_method, url) {
        xhrUrls.set(this, url);
      },
    });
    patchMethod({
      owner: XMLHttpRequest.prototype,
      name: "send",
      recorder(body) {
        if (xhrUrls.has(this)) {
          recordAdaptiveNetwork("xhr", xhrUrls.get(this), body);
        }
      },
    });
  };

  const patchBeaconNetwork = () => {
    try {
      const navProto = Object.getPrototypeOf(navigator);
      const beaconDesc = navProto && Object.getOwnPropertyDescriptor(navProto, "sendBeacon");
      const origBeacon = beaconDesc && beaconDesc.value;
      if (typeof origBeacon !== "function") return;
      const wrappedBeacon = {
        sendBeacon(url) {
          recordAdaptiveNetwork("sendBeacon", url, arguments[1]);
          return origBeacon.apply(this, arguments);
        },
      }.sendBeacon;
      Object.defineProperty(navProto, "sendBeacon", {
        ...beaconDesc,
        value: stealth(wrappedBeacon, "sendBeacon", { length: 1 }),
      });
    } catch {}
  };

  const patchInputHooks = () => {
    if (typeof EventTarget === "undefined" || !EventTarget.prototype) return;
    const origAddEventListener = EventTarget.prototype.addEventListener;
    const wrappedAddEventListener = {
      addEventListener(type) {
        try {
          const eventType = String(type);
          const globalTarget =
            this === window ||
            this === document ||
            this === document.documentElement ||
            this === document.body;
          if (globalTarget && ADAPTIVE_INPUT_EVENTS.has(eventType)) {
            recordAdaptiveSignal("input_hooks", { detail: `listener.${eventType}` });
          }
        } catch {}
        return origAddEventListener.apply(this, arguments);
      },
    }.addEventListener;
    EventTarget.prototype.addEventListener = stealth(wrappedAddEventListener, "addEventListener", {
      length: 2,
    });
  };

  try {
    patchReadbackApis();
    patchGpuApis();
    patchCryptoApis();
    patchAudioApis();
    patchMutationObserver();
    patchNetworkApis();
    patchInputHooks();
    for (const prop of [
      "hardwareConcurrency",
      "deviceMemory",
      "platform",
      "plugins",
      "languages",
    ]) {
      patchNavigatorGetter(prop);
    }
  } catch {}
})();
