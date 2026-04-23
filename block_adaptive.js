/* eslint-disable max-lines, max-statements, complexity -- adaptive and vendor-runtime shims are safer kept contiguous */
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
  const reportedVendorSignals = new Set();
  const instrumentedFingerprintGlobals = new WeakSet();
  const instrumentedSiftQueues = new WeakSet();
  const MAX_QUEUED_SIGNALS = 50;
  const VENDOR_SIGNAL_SCORE = 9;
  const vendorState = {
    datadome: { ddjskey: false, ddoptions: false, scriptUrl: "", source: "" },
    fingerprint: {
      apiKey: false,
      endpoint: "",
      loadCalled: false,
      scriptUrlPattern: "",
      source: "",
    },
    human: { appId: false, hostUrl: "", jsClientSrc: "", source: "" },
    sift: { account: false, scriptUrl: "", source: "", trackPageview: false },
  };
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

  const nativeSourceFor = (fn, fallbackName) => {
    try {
      return origFnToString.call(fn);
    } catch {
      return `function ${fallbackName}() { [native code] }`;
    }
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
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)
    ) {
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

  const firstStringEntry = (value) => {
    if (typeof value === "string") return value;
    if (typeof URL !== "undefined" && value instanceof URL) return value.href;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = firstStringEntry(item);
        if (found) return found;
      }
    }
    return "";
  };

  const parsedUrlFor = (value) => {
    const candidate = firstStringEntry(value);
    if (!candidate) return null;
    try {
      return new URL(candidate, location.href);
    } catch {
      return null;
    }
  };

  const rememberVendorSource = (state, source) => {
    const safeSource = String(source || "").slice(0, 160);
    if (!safeSource) return;
    if (!state.source || state.source === "inline-or-runtime") state.source = safeSource;
  };

  const emitVendorSignal = (vendor, category, detail = {}) => {
    const key = `${category}:${vendor}`;
    if (reportedVendorSignals.has(key)) return;
    reportedVendorSignals.add(key);
    const reasons = [`vendor:${vendor}`, ...(detail.reasons || [])]
      .filter(Boolean)
      .map((reason) => String(reason).slice(0, 64))
      .slice(0, 12);
    postAdaptiveSignal({
      category,
      score: VENDOR_SIGNAL_SCORE,
      source: String(detail.source || "inline-or-runtime").slice(0, 160),
      endpoint: stableEndpointFor(detail.endpoint),
      reasons,
    });
  };

  const maybeEmitDatadomeSignal = () => {
    const state = vendorState.datadome;
    if (!state.ddjskey || !state.scriptUrl) return;
    emitVendorSignal("DataDome", "anti-bot", {
      source: state.source || stableUrlLabelFor(state.scriptUrl),
      endpoint: state.scriptUrl,
      reasons: [
        "global:ddjskey",
        state.ddoptions ? "global:ddoptions" : "",
        "script:tags.js",
      ],
    });
  };

  const maybeEmitFingerprintSignal = () => {
    const state = vendorState.fingerprint;
    if (!state.loadCalled) return;
    emitVendorSignal("FingerprintJS", "fingerprinting", {
      source: state.source || "inline-or-runtime",
      endpoint: state.endpoint || state.scriptUrlPattern,
      reasons: [
        "api:load",
        state.apiKey ? "config:apiKey" : "",
        state.endpoint ? "config:endpoint" : "",
        state.scriptUrlPattern ? "config:scriptUrlPattern" : "",
      ],
    });
  };

  const maybeEmitHumanSignal = () => {
    const state = vendorState.human;
    if (!state.appId || !(state.hostUrl || state.jsClientSrc)) return;
    emitVendorSignal("HUMAN", "anti-bot", {
      source: state.source || stableUrlLabelFor(state.jsClientSrc || state.hostUrl),
      endpoint: state.hostUrl || state.jsClientSrc,
      reasons: [
        "global:_pxAppId",
        state.hostUrl ? "global:_pxHostUrl" : "",
        state.jsClientSrc ? "global:_pxJsClientSrc" : "",
      ],
    });
  };

  const maybeEmitSiftSignal = () => {
    const state = vendorState.sift;
    if (!state.account) return;
    emitVendorSignal("Sift", "fingerprinting", {
      source: state.source || stableUrlLabelFor(state.scriptUrl),
      endpoint: state.scriptUrl,
      reasons: [
        "queue:_setAccount",
        state.trackPageview ? "queue:_trackPageview" : "",
        state.scriptUrl ? "script:sift" : "",
      ],
    });
  };

  const patchObjectMethod = (target, key, wrap) => {
    const orig = target && target[key];
    if (typeof orig !== "function") return;
    const wrapped = wrap(orig);
    if (typeof wrapped !== "function") return;
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: Object.prototype.propertyIsEnumerable.call(target, key),
        writable: true,
        value: stealth(wrapped, key, {
          length: orig.length,
          source: nativeSourceFor(orig, key),
        }),
      });
    } catch {
      try {
        target[key] = stealth(wrapped, key, {
          length: orig.length,
          source: nativeSourceFor(orig, key),
        });
      } catch {}
    }
  };

  const observeSiftQueueCommand = (entry, source) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return;
    const state = vendorState.sift;
    const command = entry[0];
    rememberVendorSource(state, source);
    if (command === "_setAccount") state.account = true;
    if (command === "_trackPageview") state.trackPageview = true;
    maybeEmitSiftSignal();
  };

  const instrumentSiftQueue = (queue, source = currentAdaptiveSource()) => {
    if (!queue || (typeof queue !== "object" && typeof queue !== "function")) return queue;
    if (typeof queue.push !== "function") return queue;
    if (instrumentedSiftQueues.has(queue)) return queue;
    instrumentedSiftQueues.add(queue);
    rememberVendorSource(vendorState.sift, source);
    try {
      for (const entry of Array.from(queue)) observeSiftQueueCommand(entry, source);
    } catch {}
    patchObjectMethod(queue, "push", (origPush) =>
      function push(...items) {
        for (const item of items) observeSiftQueueCommand(item, source);
        return origPush.apply(this, items);
      }
    );
    return queue;
  };

  const instrumentFingerprintGlobal = (value, source = currentAdaptiveSource()) => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
    if (typeof value.load !== "function" || instrumentedFingerprintGlobals.has(value)) return value;
    instrumentedFingerprintGlobals.add(value);
    patchObjectMethod(value, "load", (origLoad) =>
      function load(options) {
        const state = vendorState.fingerprint;
        rememberVendorSource(state, source);
        state.loadCalled = true;
        state.apiKey ||= !!(
          options &&
          typeof options === "object" &&
          Object.prototype.hasOwnProperty.call(options, "apiKey")
        );
        const endpoint = firstStringEntry(options && options.endpoint);
        const scriptUrlPattern = firstStringEntry(options && options.scriptUrlPattern);
        if (endpoint) state.endpoint = endpoint;
        if (scriptUrlPattern) state.scriptUrlPattern = scriptUrlPattern;
        maybeEmitFingerprintSignal();
        return origLoad.apply(this, arguments);
      }
    );
    return value;
  };

  const patchWindowValue = (name, transform) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(window, name);
      if (desc && desc.configurable === false) return;
      const enumerable = desc ? desc.enumerable : true;
      let currentValue = undefined;
      if (desc && Object.prototype.hasOwnProperty.call(desc, "value")) {
        currentValue = transform(desc.value, currentAdaptiveSource());
      }
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable,
        get: stealth(
          function get() {
            return currentValue;
          },
          `get ${name}`,
          { length: 0 }
        ),
        set: stealth(
          function set(value) {
            currentValue = transform(value, currentAdaptiveSource());
          },
          `set ${name}`,
          { length: 1 }
        ),
      });
    } catch {}
  };

  const patchVendorGlobals = () => {
    patchWindowValue("ddjskey", (value, source) => {
      const state = vendorState.datadome;
      state.ddjskey = value != null && value !== "";
      rememberVendorSource(state, source);
      maybeEmitDatadomeSignal();
      return value;
    });
    patchWindowValue("ddoptions", (value, source) => {
      const state = vendorState.datadome;
      state.ddoptions = value != null;
      rememberVendorSource(state, source);
      maybeEmitDatadomeSignal();
      return value;
    });
    patchWindowValue("_pxAppId", (value, source) => {
      const state = vendorState.human;
      state.appId = value != null && value !== "";
      rememberVendorSource(state, source);
      maybeEmitHumanSignal();
      return value;
    });
    patchWindowValue("_pxHostUrl", (value, source) => {
      const state = vendorState.human;
      state.hostUrl = firstStringEntry(value);
      rememberVendorSource(state, source);
      maybeEmitHumanSignal();
      return value;
    });
    patchWindowValue("_pxJsClientSrc", (value, source) => {
      const state = vendorState.human;
      state.jsClientSrc = firstStringEntry(value);
      rememberVendorSource(state, source);
      maybeEmitHumanSignal();
      return value;
    });
    patchWindowValue("_sift", (value, source) => instrumentSiftQueue(value, source));
    patchWindowValue("FingerprintJS", (value, source) => instrumentFingerprintGlobal(value, source));
  };

  const observeVendorScript = (url) => {
    const parsed = parsedUrlFor(url);
    if (!parsed) return;
    const source = stableUrlLabelFor(parsed.href);
    const pathname = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();

    if (
      pathname === "/tags.js" ||
      (pathname.endsWith("/tags.js") && host.endsWith("datadome.co"))
    ) {
      const state = vendorState.datadome;
      state.scriptUrl = parsed.href;
      rememberVendorSource(state, source);
      maybeEmitDatadomeSignal();
    }

    if (
      pathname === "/s.js" ||
      /^\/js\/s-\d+\.js$/i.test(pathname) ||
      (host.endsWith("sift.com") &&
        (pathname === "/s.js" || /^\/js\/s-\d+\.js$/i.test(pathname)))
    ) {
      const state = vendorState.sift;
      state.scriptUrl = parsed.href;
      rememberVendorSource(state, source);
      maybeEmitSiftSignal();
    }

    if (
      pathname.endsWith("/main.min.js") ||
      host.endsWith("perimeterx.net") ||
      host.endsWith("px-cdn.net") ||
      host.endsWith("px-cloud.net")
    ) {
      const state = vendorState.human;
      if (!state.jsClientSrc) state.jsClientSrc = parsed.href;
      rememberVendorSource(state, source);
      maybeEmitHumanSignal();
    }
  };

  let vendorScanTicks = 0;
  const scanVendorRuntime = () => {
    vendorScanTicks++;
    try {
      if (window.ddjskey != null) {
        vendorState.datadome.ddjskey = true;
        maybeEmitDatadomeSignal();
      }
    } catch {}
    try {
      if (window.ddoptions != null) {
        vendorState.datadome.ddoptions = true;
        maybeEmitDatadomeSignal();
      }
    } catch {}
    try {
      if (window._pxAppId != null) {
        vendorState.human.appId = true;
        maybeEmitHumanSignal();
      }
    } catch {}
    try {
      if (window._pxHostUrl != null) {
        vendorState.human.hostUrl = firstStringEntry(window._pxHostUrl);
        maybeEmitHumanSignal();
      }
    } catch {}
    try {
      if (window._pxJsClientSrc != null) {
        vendorState.human.jsClientSrc = firstStringEntry(window._pxJsClientSrc);
        maybeEmitHumanSignal();
      }
    } catch {}
    try {
      instrumentFingerprintGlobal(window.FingerprintJS);
    } catch {}
    try {
      if (window._sift != null) instrumentSiftQueue(window._sift);
    } catch {}
    try {
      for (const script of document.scripts || []) observeVendorScript(script.src);
    } catch {}
    if (vendorScanTicks < 20) setTimeout(scanVendorRuntime, 500);
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
    patchVendorGlobals();
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
    setTimeout(scanVendorRuntime, 0);
  } catch {}
})();
