/* eslint-disable max-lines, max-statements, complexity -- adaptive and vendor-runtime shims are safer kept contiguous */
// Static - MAIN-world observe-only adaptive behavior logger.
(() => {
  const BRIDGE_EVENT = "__static_adaptive_bridge_init__";
  const ADAPTIVE_WINDOW_MS = 4000;
  const ADAPTIVE_COOLDOWN_MS = 7000;
  const ADAPTIVE_TRIGGER_SCORE = 7;
  const ADAPTIVE_SOURCE_URL_RE = /\b(?:https?):\/\/[^\s)]+/g;
  const STATIC_INTERNAL_OBSERVER_RE =
    /(?:chrome|edge)-extension:\/\/[a-p]{32}\/block_style_vectors\.js|(?:moz|safari-web)-extension:\/\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\/block_style_vectors\.js/i;
  const ADAPTIVE_WEIGHTS = {
    canvas: 4,
    webgl: 4,
    audio: 4,
    environment: 2,
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
  const ADAPTIVE_EVENT_SOURCE_SKIP_TYPES = new Set([
    "input",
    "change",
    "keydown",
    "keyup",
    "keypress",
    "click",
    "dblclick",
    "mousedown",
    "mouseup",
    "mousemove",
    "pointerdown",
    "pointerup",
    "pointermove",
    "scroll",
    "focus",
    "blur",
  ]);
  const DOM_MARKER_ATTR_RE =
    /^(?:data-(?:1password(?:-|$)|1p(?:-|$)|onepassword(?:-|$)|op(?:-|$)|lastpass(?:-|$)|lp-(?:ignore|id|tab)|dashlane(?:-|$)|dashlanecreated|grammarly(?:-|$)|gramm(?:-|$)|gr-c-s-(?:loaded|check-loaded)$|honey(?:-|$)|honeyextension(?:-|$)|keeper(?:-|$)|roboform(?:-|$)|nordpass(?:-|$))|__lpform_)/i;
  const DOM_MARKER_TAG_RE = /^(?:grammarly-|lastpass-|dashlane-|honey-|onepassword-)/i;
  const DOM_MARKER_CLASS_RE =
    /^(?:grammarly(?:$|-)|lastpass(?:$|-)|__lpform|lpform|dashlane(?:$|-)|honey(?:$|-)|onepassword(?:$|-))/i;
  const adaptiveWindows = new Map();
  const queuedSignals = [];
  const reportedVendorSignals = new Set();
  const instrumentedFingerprintGlobals = new WeakSet();
  const instrumentedSiftQueues = new WeakSet();
  const MAX_QUEUED_SIGNALS = 50;
  const VENDOR_SIGNAL_SCORE = 9;
  const vendorState = {
    datadome: { ddjskey: false, ddoptions: false, endpoint: "", scriptUrl: "", source: "" },
    fingerprint: {
      apiCall: "",
      apiKey: false,
      endpoint: "",
      endpointReason: "",
      initialized: false,
      scriptUrlPattern: "",
      source: "",
    },
    human: { appId: "", hostUrl: "", jsClientReason: "", jsClientSrc: "", source: "" },
    sift: { account: false, scriptUrl: "", source: "", trackPageview: false },
  };
  let disabled = false;
  let bridgePort = null;
  let activeAdaptiveSource = "";
  const asyncSourceWrappers = new WeakMap();
  const eventListenerWrappers = new WeakMap();

  const STEALTH_KEY = "__ss2605__";
  const stealthFns = globalThis[STEALTH_KEY] || new WeakMap();
  if (!globalThis[STEALTH_KEY]) {
    try {
      Object.defineProperty(globalThis, STEALTH_KEY, {
        value: stealthFns,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      globalThis[STEALTH_KEY] = stealthFns;
    }
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
  }
  const origFnToString = Function.prototype.toString;

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

  const descriptorOwnerFor = (proto, prop) => {
    let cursor = proto;
    while (cursor) {
      const desc = Object.getOwnPropertyDescriptor(cursor, prop);
      if (desc) return { desc, owner: cursor };
      cursor = Object.getPrototypeOf(cursor);
    }
    return null;
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
    if (disabled) return;
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
    bridgePort.onmessage = (event) => {
      const msg = event && event.data;
      if (msg && msg.type === "config_update" && msg.disabled != null) {
        disabled = !!msg.disabled;
      }
    };
    flushQueuedSignals();
    document.removeEventListener(BRIDGE_EVENT, onBridgeInit);
  };
  document.addEventListener(BRIDGE_EVENT, onBridgeInit);

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

  const stackAdaptiveSource = () => {
    try {
      const stack = String(new Error().stack || "");
      for (const match of stack.matchAll(ADAPTIVE_SOURCE_URL_RE)) {
        const candidate = match[0].replace(/:\d+(?::\d+)?$/, "");
        let parsed = null;
        try {
          parsed = new URL(candidate, location.href);
        } catch {
          continue;
        }
        const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
        if (protocol !== "http" && protocol !== "https") continue;
        if (parsed.origin === location.origin && parsed.pathname === location.pathname) continue;
        return stableUrlLabelFor(parsed.href);
      }
    } catch {}
    return "";
  };

  const currentAdaptiveSource = () => {
    if (activeAdaptiveSource) return activeAdaptiveSource;
    try {
      if (document.currentScript && document.currentScript.src) {
        return stableUrlLabelFor(document.currentScript.src);
      }
    } catch {}
    return stackAdaptiveSource() || "inline-or-runtime";
  };

  const hasStaticInternalObserverCaller = () => {
    try {
      return STATIC_INTERNAL_OBSERVER_RE.test(String(new Error().stack || ""));
    } catch {
      return false;
    }
  };

  const isFallbackAdaptiveSource = (source) => {
    const safeSource = String(source || "");
    return !safeSource || safeSource === "inline-or-runtime" || safeSource.startsWith("runtime:");
  };

  const runtimeAdaptiveSourceFor = (source, label) => {
    const safeSource = String(source || "").slice(0, 160);
    if (!isFallbackAdaptiveSource(safeSource)) return safeSource;
    if (safeSource.startsWith("runtime:")) return safeSource;
    const safeLabel = String(label || "async")
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .slice(0, 48);
    return `runtime:${safeLabel || "async"}`;
  };

  const runWithAdaptiveSource = (source, callback, thisArg, args) => {
    const previousSource = activeAdaptiveSource;
    if (source) activeAdaptiveSource = source;
    try {
      return callback.apply(thisArg, args);
    } finally {
      activeAdaptiveSource = previousSource;
    }
  };

  const wrapAsyncCallback = (callback, source, label) => {
    if (typeof callback !== "function") return callback;
    const safeSource = runtimeAdaptiveSourceFor(source, label);
    let bySource = asyncSourceWrappers.get(callback);
    if (!bySource) {
      bySource = new Map();
      asyncSourceWrappers.set(callback, bySource);
    }
    if (bySource.has(safeSource)) return bySource.get(safeSource);
    const callbackName = callback.name || "callback";
    const wrapped = function (...args) {
      return runWithAdaptiveSource(safeSource, callback, this, args);
    };
    const stealthed = stealth(wrapped, callbackName, {
      length: callback.length,
      source: nativeSourceFor(callback, callbackName),
    });
    bySource.set(safeSource, stealthed);
    return stealthed;
  };

  const eventListenerKeyFor = (type, options) => {
    const capture =
      options === true || !!(options && typeof options === "object" && options.capture === true);
    return `${String(type || "").toLowerCase()}::${capture ? "1" : "0"}`;
  };

  const wrappedEventListenerFor = (target, registration) => {
    const { type, listener, options, source } = registration;
    if (!listener) return listener;
    const eventType = String(type || "").toLowerCase();
    if (ADAPTIVE_EVENT_SOURCE_SKIP_TYPES.has(eventType)) return listener;
    const listenerType = typeof listener;
    const isFunctionListener = listenerType === "function";
    const hasHandleEvent =
      !isFunctionListener &&
      (listenerType === "object" || listenerType === "function") &&
      typeof listener.handleEvent === "function";
    if (!isFunctionListener && !hasHandleEvent) return listener;

    const key = eventListenerKeyFor(eventType, options);
    let targetMap = eventListenerWrappers.get(listener);
    if (!targetMap) {
      targetMap = new WeakMap();
      eventListenerWrappers.set(listener, targetMap);
    }
    let wrappedByKey = targetMap.get(target);
    if (!wrappedByKey) {
      wrappedByKey = new Map();
      targetMap.set(target, wrappedByKey);
    }
    if (wrappedByKey.has(key)) return wrappedByKey.get(key);

    const safeSource = runtimeAdaptiveSourceFor(source, `listener.${eventType || "event"}`);
    const wrapped = isFunctionListener
      ? (() => {
          const listenerName = listener.name || "listener";
          const wrappedListener = function (...args) {
            return runWithAdaptiveSource(safeSource, listener, this, args);
          };
          return stealth(wrappedListener, listenerName, {
            length: listener.length,
            source: nativeSourceFor(listener, listenerName),
          });
        })()
      : (() => {
          const initialHandleEvent = listener.handleEvent;
          const wrappedHandleEvent = stealth(
            function handleEvent(...args) {
              const currentHandleEvent = listener && listener.handleEvent;
              if (typeof currentHandleEvent !== "function") return;
              return runWithAdaptiveSource(safeSource, currentHandleEvent, listener, args);
            },
            "handleEvent",
            {
              length: typeof initialHandleEvent === "function" ? initialHandleEvent.length : 1,
              source: nativeSourceFor(initialHandleEvent, "handleEvent"),
            }
          );
          const wrappedListener = {};
          try {
            Object.defineProperty(wrappedListener, "handleEvent", {
              configurable: true,
              enumerable: false,
              writable: true,
              value: wrappedHandleEvent,
            });
          } catch {
            wrappedListener.handleEvent = wrappedHandleEvent;
          }
          return wrappedListener;
        })();

    wrappedByKey.set(key, wrapped);
    return wrapped;
  };

  const eventListenerForRemoval = (target, type, listener, options) => {
    if (!listener) return listener;
    const targetMap = eventListenerWrappers.get(listener);
    if (!targetMap) return listener;
    const wrappedByKey = targetMap.get(target);
    if (!wrappedByKey) return listener;
    return wrappedByKey.get(eventListenerKeyFor(type, options)) || listener;
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
    const source = currentAdaptiveSource();
    maybeCaptureDatadomeSourceFromNetwork(url, source);
    recordAdaptiveSignal("network", {
      endpoint,
      detail: `${where}:${sizeBucketFor(body)}`,
      source,
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

  const isDatadomeTagPath = (pathname, host) =>
    pathname === "/tags.js" ||
    /^\/v\d+\.\d+\.\d+\/tags\.js$/i.test(pathname) ||
    (pathname.endsWith("/tags.js") && host === "js.datadome.co");

  const datadomeEndpointForScriptUrl = (url) => {
    const parsed = parsedUrlFor(url);
    if (!parsed) return "";
    const pathname = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (!isDatadomeTagPath(pathname, host)) return "";
    if (host === "js.datadome.co") return ["https:", "", "api-js.datadome.co", "js", ""].join("/");
    return `${parsed.origin}/js/`;
  };

  const datadomeScriptReasonFor = (url) => {
    const parsed = parsedUrlFor(url);
    if (!parsed) return "";
    return isDatadomeTagPath(parsed.pathname.toLowerCase(), parsed.hostname.toLowerCase())
      ? "script:tags.js"
      : "script:custom-path";
  };

  const rememberVendorSource = (state, source) => {
    const safeSource = String(source || "").slice(0, 160);
    if (!safeSource) return;
    if (isFallbackAdaptiveSource(state.source) || !isFallbackAdaptiveSource(safeSource)) {
      state.source = safeSource;
    }
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
    const endpoint = state.endpoint || datadomeEndpointForScriptUrl(state.scriptUrl);
    if (!state.ddjskey || !state.scriptUrl || !endpoint) return;
    emitVendorSignal("DataDome", "anti-bot", {
      source: state.source || stableUrlLabelFor(state.scriptUrl || endpoint),
      endpoint,
      reasons: [
        "global:ddjskey",
        state.ddoptions ? "global:ddoptions" : "",
        state.endpoint ? "config:endpoint" : "",
        datadomeScriptReasonFor(state.scriptUrl),
      ],
    });
  };

  const maybeCaptureDatadomeSourceFromNetwork = (url, source) => {
    const state = vendorState.datadome;
    if (!state.ddjskey || isFallbackAdaptiveSource(source)) return;
    const configuredEndpoint = stableEndpointFor(
      state.endpoint || datadomeEndpointForScriptUrl(state.scriptUrl)
    );
    const observedEndpoint = stableEndpointFor(url);
    if (!configuredEndpoint || !observedEndpoint || configuredEndpoint !== observedEndpoint) return;
    if (!state.scriptUrl) state.scriptUrl = source;
    rememberVendorSource(state, source);
    maybeEmitDatadomeSignal();
  };

  const maybeEmitFingerprintSignal = () => {
    const state = vendorState.fingerprint;
    if (!state.initialized) return;
    emitVendorSignal("Fingerprint", "fingerprinting", {
      source: state.source || "inline-or-runtime",
      endpoint: state.endpoint || state.scriptUrlPattern,
      reasons: [
        state.apiCall ? `api:${state.apiCall}` : "api:init",
        state.apiKey ? "config:apiKey" : "",
        state.endpoint ? state.endpointReason || "config:endpoint" : "",
        state.scriptUrlPattern ? "config:scriptUrlPattern" : "",
      ],
    });
  };

  const maybeEmitHumanSignal = () => {
    const state = vendorState.human;
    if (!state.appId || !state.jsClientSrc) return;
    emitVendorSignal("HUMAN", "anti-bot", {
      source: state.source || stableUrlLabelFor(state.jsClientSrc || state.hostUrl),
      endpoint: state.hostUrl || state.jsClientSrc,
      reasons: [
        "global:_pxAppId",
        state.hostUrl ? "global:_pxHostUrl" : "",
        state.jsClientReason || "",
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
    patchObjectMethod(
      queue,
      "push",
      (origPush) =>
        function push(...items) {
          for (const item of items) observeSiftQueueCommand(item, source);
          return origPush.apply(this, items);
        }
    );
    return queue;
  };

  const observeFingerprintCall = (apiCall, options, source) => {
    const state = vendorState.fingerprint;
    rememberVendorSource(state, source);
    state.initialized = true;
    state.apiCall = apiCall;
    state.apiKey ||= !!(
      options &&
      typeof options === "object" &&
      Object.prototype.hasOwnProperty.call(options, "apiKey")
    );
    const endpoint = firstStringEntry(options && (options.endpoints || options.endpoint));
    const scriptUrlPattern = firstStringEntry(options && options.scriptUrlPattern);
    if (endpoint) {
      state.endpoint = endpoint;
      state.endpointReason =
        options && Object.prototype.hasOwnProperty.call(options, "endpoints")
          ? "config:endpoints"
          : "config:endpoint";
    }
    if (scriptUrlPattern) state.scriptUrlPattern = scriptUrlPattern;
    maybeEmitFingerprintSignal();
  };

  const instrumentFingerprintGlobal = (value, source = currentAdaptiveSource()) => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
    const hasLoad = typeof value.load === "function";
    const hasStart = typeof value.start === "function";
    if ((!hasLoad && !hasStart) || instrumentedFingerprintGlobals.has(value)) return value;
    instrumentedFingerprintGlobals.add(value);
    if (hasLoad) {
      patchObjectMethod(
        value,
        "load",
        (origLoad) =>
          function load(options) {
            observeFingerprintCall("load", options, source);
            return origLoad.apply(this, arguments);
          }
      );
    }
    if (hasStart) {
      patchObjectMethod(
        value,
        "start",
        (origStart) =>
          function start(options) {
            observeFingerprintCall("start", options, source);
            return origStart.apply(this, arguments);
          }
      );
    }
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
      state.endpoint = firstStringEntry(value && value.endpoint);
      rememberVendorSource(state, source);
      maybeEmitDatadomeSignal();
      return value;
    });
    patchWindowValue("_pxAppId", (value, source) => {
      const state = vendorState.human;
      state.appId = firstStringEntry(value) || (value != null && value !== "" ? String(value) : "");
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
      state.jsClientReason = state.jsClientSrc ? "global:_pxJsClientSrc" : "";
      rememberVendorSource(
        state,
        state.jsClientSrc ? stableUrlLabelFor(state.jsClientSrc) : source
      );
      maybeEmitHumanSignal();
      return value;
    });
    patchWindowValue("_sift", (value, source) => instrumentSiftQueue(value, source));
    patchWindowValue("Fingerprint", (value, source) => instrumentFingerprintGlobal(value, source));
    patchWindowValue("FingerprintJS", (value, source) =>
      instrumentFingerprintGlobal(value, source)
    );
  };

  const humanDefaultFirstPartyInitPathFor = (appId) => {
    const normalized = String(appId || "").trim();
    const match = normalized.match(/^px([a-z0-9]+)$/i);
    if (!match) return "";
    return `/${match[1].toLowerCase()}/init.js`;
  };

  const humanCustomFirstPartyPrefixFor = (hostUrl) => {
    const parsed = parsedUrlFor(hostUrl);
    if (!parsed || parsed.origin !== location.origin) return "";
    const match = parsed.pathname.toLowerCase().match(/^(\/.+?)\/xhr(?:\/|$)/);
    return match ? match[1] : "";
  };

  const humanCustomFirstPartyInitPathFor = (hostUrl) => {
    const prefix = humanCustomFirstPartyPrefixFor(hostUrl);
    return prefix ? `${prefix}/init.js` : "";
  };

  const observeVendorScript = (url) => {
    const parsed = parsedUrlFor(url);
    if (!parsed) return;
    const source = stableUrlLabelFor(parsed.href);
    const pathname = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const humanDefaultInitPath = humanDefaultFirstPartyInitPathFor(vendorState.human.appId);
    const humanCustomInitPath = humanCustomFirstPartyInitPathFor(vendorState.human.hostUrl);
    if (isDatadomeTagPath(pathname, host)) {
      const state = vendorState.datadome;
      state.scriptUrl = parsed.href;
      rememberVendorSource(state, source);
      maybeEmitDatadomeSignal();
    }

    if (
      pathname === "/s.js" ||
      /^\/js\/s-\d+\.js$/i.test(pathname) ||
      (host.endsWith("sift.com") && (pathname === "/s.js" || /^\/js\/s-\d+\.js$/i.test(pathname)))
    ) {
      const state = vendorState.sift;
      state.scriptUrl = parsed.href;
      rememberVendorSource(state, source);
      maybeEmitSiftSignal();
    }

    if (
      pathname === humanDefaultInitPath ||
      pathname === humanCustomInitPath ||
      pathname.endsWith("/main.min.js") ||
      host.endsWith("perimeterx.net") ||
      host.endsWith("px-cdn.net") ||
      host.endsWith("px-cloud.net")
    ) {
      const state = vendorState.human;
      if (!state.jsClientSrc) state.jsClientSrc = parsed.href;
      if (!state.jsClientReason) {
        state.jsClientReason =
          pathname === humanDefaultInitPath
            ? "script:init.js"
            : pathname === humanCustomInitPath
              ? "script:prefix-init.js"
              : "script:main.min.js";
      }
      rememberVendorSource(state, source);
      maybeEmitHumanSignal();
    }
  };

  let vendorScanTicks = 0;
  const scanVendorRuntime = () => {
    if (disabled) return;
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
        vendorState.human.appId =
          firstStringEntry(window._pxAppId) ||
          (window._pxAppId != null && window._pxAppId !== "" ? String(window._pxAppId) : "");
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
        vendorState.human.jsClientReason = vendorState.human.jsClientSrc
          ? "global:_pxJsClientSrc"
          : "";
        rememberVendorSource(
          vendorState.human,
          vendorState.human.jsClientSrc
            ? stableUrlLabelFor(vendorState.human.jsClientSrc)
            : currentAdaptiveSource()
        );
        maybeEmitHumanSignal();
      }
    } catch {}
    try {
      instrumentFingerprintGlobal(window.Fingerprint);
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

  const patchGetter = (proto, prop, detail, kind) => {
    try {
      const found = descriptorOwnerFor(proto, prop);
      const desc = found && found.desc;
      if (!desc || typeof desc.get !== "function") return;
      Object.defineProperty(found.owner, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: stealth(
          function get() {
            try {
              recordAdaptiveSignal(kind, { detail });
            } catch {}
            return desc.get.call(this);
          },
          `get ${prop}`,
          { length: 0, source: nativeSourceFor(desc.get, `get ${prop}`) }
        ),
      });
    } catch {}
  };

  const patchNavigatorGetter = (prop) => {
    patchGetter(Navigator.prototype, prop, `navigator.${prop}`, "navigator");
  };

  const patchScreenGetter = (prop) => {
    if (typeof Screen === "undefined" || !Screen.prototype) return;
    patchGetter(Screen.prototype, prop, `screen.${prop}`, "environment");
  };

  const patchEnvironmentApis = () => {
    for (const prop of [
      "availHeight",
      "availWidth",
      "colorDepth",
      "height",
      "pixelDepth",
      "width",
    ]) {
      patchScreenGetter(prop);
    }
    patchMethod({
      owner: Date.prototype,
      name: "getTimezoneOffset",
      recorder: () => recordAdaptiveSignal("environment", { detail: "date.getTimezoneOffset" }),
    });
    if (typeof Intl !== "undefined" && Intl.DateTimeFormat && Intl.DateTimeFormat.prototype) {
      patchMethod({
        owner: Intl.DateTimeFormat.prototype,
        name: "resolvedOptions",
        recorder: () => recordAdaptiveSignal("environment", { detail: "intl.resolvedOptions" }),
      });
    }
    try {
      const storageProto = navigator.storage && Object.getPrototypeOf(navigator.storage);
      patchMethod({
        owner: storageProto,
        name: "estimate",
        recorder: () => recordAdaptiveSignal("environment", { detail: "storage.estimate" }),
      });
    } catch {}
    if (typeof Navigator !== "undefined" && Navigator.prototype) {
      patchMethod({
        owner: Navigator.prototype,
        name: "getBattery",
        recorder: () => recordAdaptiveSignal("environment", { detail: "navigator.getBattery" }),
      });
    }
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
    const attrLocalName = (name) => {
      const normalized = String(name || "").toLowerCase();
      const colon = normalized.lastIndexOf(":");
      return colon === -1 ? normalized : normalized.slice(colon + 1);
    };
    const classStringHasMarker = (value) =>
      String(value || "")
        .split(/\s+/)
        .some((className) => DOM_MARKER_CLASS_RE.test(className));
    const elementHasMarkerClass = (node) => {
      try {
        if (!node || !node.classList) return false;
        for (const className of node.classList) {
          if (DOM_MARKER_CLASS_RE.test(className)) return true;
        }
      } catch {}
      return false;
    };
    const isDomMarkerElement = (node) => {
      try {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
        const tagName = String(node.tagName || "").toLowerCase();
        if (DOM_MARKER_TAG_RE.test(tagName)) return true;
        if (elementHasMarkerClass(node)) return true;
        for (const attr of node.attributes || []) {
          if (DOM_MARKER_ATTR_RE.test(attr.name)) return true;
        }
      } catch {}
      return false;
    };
    const nodeListHasMarker = (nodes) => {
      try {
        for (const node of nodes || []) {
          if (isDomMarkerElement(node)) return true;
        }
      } catch {}
      return false;
    };
    const shouldHideMutationRecord = (record) => {
      try {
        if (!record) return false;
        if (record.type === "childList") {
          return nodeListHasMarker(record.addedNodes) || nodeListHasMarker(record.removedNodes);
        }
        if (record.type !== "attributes") return false;
        const name = attrLocalName(record.attributeName);
        if (DOM_MARKER_ATTR_RE.test(name)) return true;
        if (name !== "class") return false;
        return classStringHasMarker(record.oldValue) || elementHasMarkerClass(record.target);
      } catch {
        return false;
      }
    };
    const filteredMutationRecordsFor = (records) => {
      let filtered = null;
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (shouldHideMutationRecord(record)) {
          if (!filtered) filtered = Array.prototype.slice.call(records, 0, index);
          continue;
        }
        if (filtered) filtered.push(record);
      }
      return filtered || records;
    };
    const WrappedMutationObserver = function MutationObserver(callback) {
      if (!new.target) return Reflect.apply(OrigMutationObserver, this, arguments);
      const callbackSource = currentAdaptiveSource();
      const callbackForPage =
        typeof callback === "function"
          ? function mutationObserverCallback(records, observerForCallback) {
              const filteredRecords = filteredMutationRecordsFor(records);
              if (!filteredRecords.length) return undefined;
              return callback.call(this, filteredRecords, observerForCallback);
            }
          : callback;
      const observer = Reflect.construct(
        OrigMutationObserver,
        [wrapAsyncCallback(callbackForPage, callbackSource, "mutation-observer")],
        new.target
      );
      const origObserve = observer.observe;
      observer.observe = stealth(
        function observe(target, options) {
          try {
            const globalTarget =
              target === document ||
              target === document.documentElement ||
              target === document.body;
            if (globalTarget && options && options.subtree && !hasStaticInternalObserverCaller()) {
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

  const patchAsyncSourceContext = () => {
    patchObjectMethod(
      window,
      "setTimeout",
      (origSetTimeout) =>
        function setTimeout(_handler) {
          const args = Array.from(arguments);
          args[0] = wrapAsyncCallback(args[0], currentAdaptiveSource(), "setTimeout");
          return origSetTimeout.apply(this, args);
        }
    );
    patchObjectMethod(
      window,
      "setInterval",
      (origSetInterval) =>
        function setInterval(_handler) {
          const args = Array.from(arguments);
          args[0] = wrapAsyncCallback(args[0], currentAdaptiveSource(), "setInterval");
          return origSetInterval.apply(this, args);
        }
    );
    patchObjectMethod(
      window,
      "requestAnimationFrame",
      (origRequestAnimationFrame) =>
        function requestAnimationFrame(callback) {
          return origRequestAnimationFrame.call(
            this,
            wrapAsyncCallback(callback, currentAdaptiveSource(), "requestAnimationFrame")
          );
        }
    );
    patchObjectMethod(
      window,
      "requestIdleCallback",
      (origRequestIdleCallback) =>
        function requestIdleCallback(_callback) {
          const args = Array.from(arguments);
          args[0] = wrapAsyncCallback(args[0], currentAdaptiveSource(), "requestIdleCallback");
          return origRequestIdleCallback.apply(this, args);
        }
    );
    patchObjectMethod(
      window,
      "queueMicrotask",
      (origQueueMicrotask) =>
        function queueMicrotask(callback) {
          return origQueueMicrotask.call(
            this,
            wrapAsyncCallback(callback, currentAdaptiveSource(), "queueMicrotask")
          );
        }
    );
    patchObjectMethod(
      Promise.prototype,
      "then",
      (origThen) =>
        function then(onFulfilled, onRejected) {
          const source = currentAdaptiveSource();
          return origThen.call(
            this,
            wrapAsyncCallback(onFulfilled, source, "promise.then"),
            wrapAsyncCallback(onRejected, source, "promise.then")
          );
        }
    );
    patchObjectMethod(
      Promise.prototype,
      "catch",
      (origCatch) =>
        function catch_(onRejected) {
          return origCatch.call(
            this,
            wrapAsyncCallback(onRejected, currentAdaptiveSource(), "promise.catch")
          );
        }
    );
    patchObjectMethod(
      Promise.prototype,
      "finally",
      (origFinally) =>
        function finally_(onFinally) {
          return origFinally.call(
            this,
            wrapAsyncCallback(onFinally, currentAdaptiveSource(), "promise.finally")
          );
        }
    );
  };

  const patchEventHandlerProperty = (owner, prop, label) => {
    if (!owner) return;
    try {
      const desc = Object.getOwnPropertyDescriptor(owner, prop);
      if (!desc || typeof desc.set !== "function") return;
      Object.defineProperty(owner, prop, {
        ...desc,
        set: stealth(
          function set(value) {
            return desc.set.call(this, wrapAsyncCallback(value, currentAdaptiveSource(), label));
          },
          `set ${prop}`,
          {
            length: desc.set.length,
            source: nativeSourceFor(desc.set, `set ${prop}`),
          }
        ),
      });
    } catch {}
  };

  const patchMessageHandlers = () => {
    patchEventHandlerProperty(window, "onmessage", "onmessage");
    if (typeof Window !== "undefined" && Window.prototype) {
      patchEventHandlerProperty(Window.prototype, "onmessage", "onmessage");
    }
    if (typeof MessagePort !== "undefined" && MessagePort.prototype) {
      patchEventHandlerProperty(MessagePort.prototype, "onmessage", "messageport.onmessage");
    }
    if (typeof BroadcastChannel !== "undefined" && BroadcastChannel.prototype) {
      patchEventHandlerProperty(
        BroadcastChannel.prototype,
        "onmessage",
        "broadcastchannel.onmessage"
      );
    }
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
    patchNetworkConstructor("WebSocket", webSocketEndpointFor);
    patchNetworkConstructor("WebTransport");
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

  const webSocketEndpointFor = (input) => {
    const candidate = firstStringEntry(input);
    if (!candidate) return "";
    try {
      const parsed = new URL(candidate, location.href);
      if (parsed.protocol === "http:") parsed.protocol = "ws:";
      if (parsed.protocol === "https:") parsed.protocol = "wss:";
      return parsed.href;
    } catch {
      return candidate;
    }
  };

  const copyConstructorStatics = (wrapped, original) => {
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
      } catch {}
    }
  };

  const patchNetworkConstructor = (name, urlFor = firstStringEntry) => {
    const OrigCtor = window[name];
    if (typeof OrigCtor !== "function") return;
    const WrappedCtor = function (...args) {
      if (!new.target) return OrigCtor.apply(this, args);
      recordAdaptiveNetwork(name, urlFor(args[0]), null);
      return Reflect.construct(OrigCtor, args, new.target);
    };
    WrappedCtor.prototype = OrigCtor.prototype;
    copyConstructorStatics(WrappedCtor, OrigCtor);
    alignPrototypeConstructor(WrappedCtor, OrigCtor);
    window[name] = stealth(WrappedCtor, name, {
      length: OrigCtor.length,
      source: nativeSourceFor(OrigCtor, name),
    });
  };

  const patchInputHooks = () => {
    if (typeof EventTarget === "undefined" || !EventTarget.prototype) return;
    const origAddEventListener = EventTarget.prototype.addEventListener;
    const origRemoveEventListener = EventTarget.prototype.removeEventListener;
    const wrappedAddEventListener = {
      addEventListener(type, listener) {
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
        const args = Array.from(arguments);
        args[1] = wrappedEventListenerFor(this, {
          type,
          listener,
          options: arguments[2],
          source: currentAdaptiveSource(),
        });
        return origAddEventListener.apply(this, args);
      },
    }.addEventListener;
    const wrappedRemoveEventListener = {
      removeEventListener(type, listener) {
        const args = Array.from(arguments);
        args[1] = eventListenerForRemoval(this, type, listener, arguments[2]);
        return origRemoveEventListener.apply(this, args);
      },
    }.removeEventListener;
    EventTarget.prototype.addEventListener = stealth(wrappedAddEventListener, "addEventListener", {
      length: 2,
    });
    EventTarget.prototype.removeEventListener = stealth(
      wrappedRemoveEventListener,
      "removeEventListener",
      { length: 2 }
    );
  };

  try {
    patchVendorGlobals();
    patchReadbackApis();
    patchGpuApis();
    patchCryptoApis();
    patchAudioApis();
    patchEnvironmentApis();
    patchMutationObserver();
    patchAsyncSourceContext();
    patchMessageHandlers();
    patchNetworkApis();
    patchInputHooks();
    for (const prop of [
      "hardwareConcurrency",
      "deviceMemory",
      "maxTouchPoints",
      "pdfViewerEnabled",
      "platform",
      "plugins",
      "languages",
      "userAgent",
      "vendor",
      "webdriver",
    ]) {
      patchNavigatorGetter(prop);
    }
    setTimeout(scanVendorRuntime, 0);
  } catch {}
})();
