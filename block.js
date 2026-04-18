// Static — MAIN-world engine.
//
// Patches the page's window so that:
//   1. fetch / XHR / element src|href|data / setAttribute / sendBeacon /
//      Worker / SharedWorker / EventSource / serviceWorker.register calls
//      targeting `chrome-extension://` (or equivalent in other browsers) are
//      rejected by default — blocking pages from enumerating installed
//      extensions.
//   2. When Noise mode is on AND the probed ID is in the origin's persona
//      (a stable 3–8 ID subset drawn from IDs this site has previously
//      probed for), fetch/XHR return a plausible-looking decoy response
//      instead of an error. Pages see those IDs as "installed."
//      Element-based probes (script/img src, setAttribute) stay blocked
//      regardless — consistent behavior beats a partial decoy that could
//      be detected by correlating vectors.
//   3. Known extension-bridge window globals are locked to undefined before
//      any page script runs.
//   4. All wrapped functions remain indistinguishable from their native
//      counterparts under Function.prototype.toString checks.
//
// MAIN-world constants are kept local to avoid exposing a Static-specific
// window global. Persona + Noise-mode state arrive through a private
// MessageChannel that bridge.js transfers at document_start.
(() => {
  const BAD_RE = /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  const REPLAY_RE =
    /(fullstory|fs\.js|logrocket|mouseflow|smartlook|clarity|heap|pendo|luckyorange|inspectlet|browsee|contentsquare|quantummetric|session[-_]?replay|@sentry\/replay|sentry.*(?:replay|rrweb)|browser\.sentry-cdn\.com\/.*replay|replayIntegration|replayCanvasIntegration|replaysSessionSampleRate|replaysOnErrorSampleRate|beforeAddRecordingEvent|ReplayCanvas|rrweb)/i;
  const REPLAY_GLOBALS = [
    "FS",
    "_fs_org",
    "_fs_host",
    "LogRocket",
    "Mouseflow",
    "mouseflow",
    "smartlook",
    "clarity",
    "heap",
    "pendo",
    "__lo_site_id",
    "__insp",
    "Inspectlet",
    "Browsee",
    "QuantumMetricAPI",
  ];
  const REPLAY_EVENT_TYPES = new Set([
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
  const STRIP_GLOBALS = [
    "__REACT_DEVTOOLS_GLOBAL_HOOK__",
    "__REDUX_DEVTOOLS_EXTENSION__",
    "__REDUX_DEVTOOLS_EXTENSION_COMPOSE__",
    "__VUE_DEVTOOLS_GLOBAL_HOOK__",
    "__MOBX_DEVTOOLS_GLOBAL_HOOK__",
    "__APOLLO_DEVTOOLS_GLOBAL_HOOK__",
    "__GRAMMARLY_DESKTOP_INTEGRATION__",
    "__grammarlyGlobalSessionId",
    "__onePasswordExtension",
    "__1passwordExtension",
    "__dashlaneExtensionInstalled",
    "__isDashlaneExtensionInstalled",
    "__honeyExtensionInstalled",
    "__keeper_extension_installed",
    "__nordpassExtensionInstalled",
    "__roboformExtensionInstalled",
  ];
  const EXT_ID_RE = /^(?:chrome|moz|ms-browser|safari-web|edge)-extension:\/\/([a-z0-9]+)/i;
  let blocked = 0;

  // Persona state — populated from bridge.js over the private MessageChannel.
  let persona = new Set();
  let noiseEnabled = false;
  let replayMode = "off";
  let replayDetected = false;
  let replayNoiseStarted = false;
  let bridgePort = null;
  const queuedProbeEvents = [];
  const queuedReplaySignals = [];
  const reportedReplaySignals = new Set();
  const MAX_QUEUED_PROBES = 1000;
  const MAX_QUEUED_REPLAY_SIGNALS = 50;
  const BRIDGE_EVENT = "__static_bridge_init__";

  const applyConfigUpdate = (d) => {
    if (!d || d.type !== "config_update") return;
    if (Array.isArray(d.persona)) {
      persona = new Set(d.persona.filter((id) => typeof id === "string"));
    }
    if (typeof d.noiseEnabled === "boolean") noiseEnabled = d.noiseEnabled;
    if (typeof d.replayMode === "string") {
      replayMode = d.replayMode;
      if (replayDetected) startReplayNoise();
    }
  };

  const postProbe = (url, where) => {
    const safeUrl = url == null ? "" : String(url).slice(0, 512);
    const safeWhere = where == null ? "" : String(where).slice(0, 64);
    if (bridgePort) {
      try {
        bridgePort.postMessage({ type: "probe_blocked", where: safeWhere, url: safeUrl });
        return;
      } catch {
        bridgePort = null;
      }
    }
    if (queuedProbeEvents.length < MAX_QUEUED_PROBES) {
      queuedProbeEvents.push({ url: safeUrl, where: safeWhere });
    }
  };

  const postReplayDetected = (signal) => {
    const safeSignal = signal == null ? "unknown" : String(signal).slice(0, 96);
    if (bridgePort) {
      try {
        bridgePort.postMessage({ type: "replay_detected", signal: safeSignal });
        return;
      } catch {
        bridgePort = null;
      }
    }
    if (queuedReplaySignals.length < MAX_QUEUED_REPLAY_SIGNALS) {
      queuedReplaySignals.push(safeSignal);
    }
  };

  const flushQueuedProbes = () => {
    if (!bridgePort) return;
    const batch = queuedProbeEvents.splice(0, queuedProbeEvents.length);
    for (const event of batch) {
      try {
        bridgePort.postMessage({ type: "probe_blocked", ...event });
      } catch {
        bridgePort = null;
        return;
      }
    }
    const replaySignals = queuedReplaySignals.splice(0, queuedReplaySignals.length);
    for (const signal of replaySignals) {
      try {
        bridgePort.postMessage({ type: "replay_detected", signal });
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
    bridgePort.onmessage = (portEvent) => applyConfigUpdate(portEvent.data);
    try {
      bridgePort.start();
    } catch {}
    flushQueuedProbes();
    document.removeEventListener(BRIDGE_EVENT, onBridgeInit);
  };
  document.addEventListener(BRIDGE_EVENT, onBridgeInit);

  const bump = (where, url) => {
    blocked++;
    if (blocked === 1 || blocked === 10 || blocked === 100 || blocked % 500 === 0) {
      console.debug("[Static]", where, "— total blocked:", blocked);
    }
    try {
      postProbe(url, where);
    } catch {}
  };

  const markReplayDetected = (signal) => {
    if (!replayDetected) replayDetected = true;
    const safeSignal = signal == null ? "unknown" : String(signal).slice(0, 96);
    if (!reportedReplaySignals.has(safeSignal)) {
      reportedReplaySignals.add(safeSignal);
      postReplayDetected(safeSignal);
    }
    startReplayNoise();
  };

  const isReplayScriptUrl = (url) => {
    try {
      return REPLAY_RE.test(String(url || ""));
    } catch {
      return false;
    }
  };

  const maybeDetectReplayScript = (url) => {
    if (isReplayScriptUrl(url)) markReplayDetected("script:" + String(url).slice(0, 72));
  };

  const getUrl = (input) => {
    if (input == null) return "";
    if (typeof input === "string") return input;
    if (typeof URL !== "undefined" && input instanceof URL) return input.href;
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    if (typeof input.url === "string") return input.url;
    try {
      return String(input);
    } catch {
      return "";
    }
  };

  const isBad = (u) => {
    try {
      return BAD_RE.test(getUrl(u));
    } catch {
      return false;
    }
  };

  const extractExtId = (urlStr) => {
    const m = EXT_ID_RE.exec(String(urlStr || ""));
    return m ? m[1] : null;
  };

  const shouldDecoy = (url) => {
    if (!noiseEnabled) return false;
    const id = extractExtId(url);
    return id != null && persona.has(id);
  };

  // ─── Decoy response synthesis ───────────────────────────────────────────
  // Minimal valid 1×1 transparent PNG — served when a probe targets an image
  // path (icons etc.) under Noise mode.
  const PNG_1x1_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const PNG_1x1 = Uint8Array.from(atob(PNG_1x1_B64), (c) => c.charCodeAt(0));

  const FAKE_MANIFEST = {
    manifest_version: 3,
    name: "Browser Extension",
    version: "1.0.0",
    description: "",
    icons: { 16: "icon.png", 48: "icon.png", 128: "icon.png" },
  };

  const buildDecoyBody = (url) => {
    let pathname = "";
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch {}
    if (pathname.endsWith("/manifest.json") || pathname === "/" || pathname === "") {
      return {
        body: JSON.stringify(FAKE_MANIFEST),
        contentType: "application/json; charset=utf-8",
      };
    }
    if (/\.(png|jpe?g|gif|webp|ico|bmp)$/i.test(pathname)) {
      return { body: PNG_1x1, contentType: "image/png" };
    }
    if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) {
      return { body: "", contentType: "application/javascript; charset=utf-8" };
    }
    if (pathname.endsWith(".html") || pathname.endsWith(".htm")) {
      return {
        body: "<!doctype html><html><body></body></html>",
        contentType: "text/html; charset=utf-8",
      };
    }
    if (pathname.endsWith(".css")) return { body: "", contentType: "text/css; charset=utf-8" };
    if (pathname.endsWith(".json"))
      return { body: "{}", contentType: "application/json; charset=utf-8" };
    if (pathname.endsWith(".svg"))
      return {
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        contentType: "image/svg+xml; charset=utf-8",
      };
    return { body: "", contentType: "application/octet-stream" };
  };

  const buildDecoyResponse = (url) => {
    const { body, contentType } = buildDecoyBody(url);
    try {
      return new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": contentType },
      });
    } catch {
      return new Response("", { status: 200 });
    }
  };

  // ─── Stealth: Function.prototype.toString ───────────────────────────────
  const stealthFns = new WeakMap();
  const origFnToString = Function.prototype.toString;
  const patchedFnToString = function toString() {
    if (stealthFns.has(this)) return stealthFns.get(this);
    return origFnToString.call(this);
  };
  stealthFns.set(patchedFnToString, "function toString() { [native code] }");
  try {
    Object.defineProperty(patchedFnToString, "name", { value: "toString", configurable: true });
    Object.defineProperty(patchedFnToString, "length", { value: 0, configurable: true });
  } catch {}
  Function.prototype.toString = patchedFnToString;

  const stealth = (fn, nativeName, opts = {}) => {
    stealthFns.set(fn, "function " + nativeName + "() { [native code] }");
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

  // ─── Replay poisoning (opt-in) ──────────────────────────────────────────
  const eventJitter = new WeakMap();
  const targetProxyCache = new WeakMap();
  const replayListenerWrappers = new WeakMap();
  const activeReplayListeners = [];
  let decoySurface = null;
  let replayScanTicks = 0;

  const shouldRedactTarget = (target) => {
    if (!target || target.nodeType !== 1) return false;
    const tag = String(target.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || !!target.isContentEditable;
  };

  const redactedValueFor = (target) => {
    const type = String((target && target.type) || "").toLowerCase();
    if (type === "email") return "redacted@example.invalid";
    if (type === "number" || type === "range") return "0";
    if (type === "checkbox" || type === "radio") return target.checked ? "on" : "";
    return "redacted";
  };

  const jitterFor = (event) => {
    let jitter = eventJitter.get(event);
    if (!jitter) {
      jitter = {
        x: Math.floor(Math.random() * 17) - 8,
        y: Math.floor(Math.random() * 13) - 6,
      };
      eventJitter.set(event, jitter);
    }
    return jitter;
  };

  const jitteredNumber = (event, prop, value) => {
    if (replayMode !== "noise" && replayMode !== "chaos") return value;
    if (typeof value !== "number") return value;
    const jitter = jitterFor(event);
    if (prop === "clientX" || prop === "pageX" || prop === "screenX") return value + jitter.x;
    if (prop === "clientY" || prop === "pageY" || prop === "screenY") return value + jitter.y;
    if (prop === "movementX") return value + Math.round(jitter.x / 3);
    if (prop === "movementY") return value + Math.round(jitter.y / 3);
    return value;
  };

  const proxiedReplayTarget = (target) => {
    if (!target || (typeof target !== "object" && typeof target !== "function")) return target;
    const cached = targetProxyCache.get(target);
    if (cached) return cached;
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        if (replayMode !== "off" && shouldRedactTarget(t)) {
          if (prop === "value" || prop === "defaultValue") return redactedValueFor(t);
          if (prop === "textContent" || prop === "innerText") return "redacted";
          if (prop === "getAttribute") {
            return (name) => {
              if (String(name).toLowerCase() === "value") return redactedValueFor(t);
              return t.getAttribute(name);
            };
          }
        }
        if (
          (replayMode === "noise" || replayMode === "chaos") &&
          prop === "getBoundingClientRect"
        ) {
          return () => {
            const rect = t.getBoundingClientRect();
            const x = Math.floor(Math.random() * 7) - 3;
            const y = Math.floor(Math.random() * 7) - 3;
            return new DOMRect(rect.x + x, rect.y + y, rect.width, rect.height);
          };
        }
        const value = Reflect.get(t, prop, t);
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
    targetProxyCache.set(target, proxy);
    return proxy;
  };

  const proxiedReplayEvent = (event) => {
    if (!event || (typeof event !== "object" && typeof event !== "function")) return event;
    return new Proxy(event, {
      get(e, prop, receiver) {
        if (prop === "target" || prop === "currentTarget" || prop === "srcElement") {
          return proxiedReplayTarget(Reflect.get(e, prop, e));
        }
        if (prop === "composedPath") {
          return () => {
            try {
              return e.composedPath().map((node) => proxiedReplayTarget(node));
            } catch {
              return [];
            }
          };
        }
        if (replayMode !== "off") {
          if (prop === "key") return "x";
          if (prop === "code") return "KeyX";
          if (prop === "data") return "x";
        }
        const value = Reflect.get(e, prop, e);
        return jitteredNumber(e, prop, typeof value === "function" ? value.bind(e) : value);
      },
    });
  };

  const listenerSource = (listener) => {
    try {
      if (typeof listener === "function") return origFnToString.call(listener);
      if (listener && typeof listener.handleEvent === "function") {
        return origFnToString.call(listener.handleEvent);
      }
    } catch {}
    return "";
  };

  const currentScriptLooksReplay = () => {
    try {
      return document.currentScript && isReplayScriptUrl(document.currentScript.src);
    } catch {
      return false;
    }
  };

  const shouldWrapReplayListener = (type, listener) => {
    if (!REPLAY_EVENT_TYPES.has(String(type))) return false;
    if (currentScriptLooksReplay()) {
      markReplayDetected("listener-script:" + document.currentScript.src.slice(0, 72));
      return true;
    }
    const src = listenerSource(listener);
    if (src && REPLAY_RE.test(src)) {
      markReplayDetected("listener-source");
      return true;
    }
    return false;
  };

  const invokeReplayListener = (listener, thisArg, event) => {
    const eventForListener = replayMode === "off" ? event : proxiedReplayEvent(event);
    if (typeof listener === "function") return listener.call(thisArg, eventForListener);
    if (listener && typeof listener.handleEvent === "function") {
      return listener.handleEvent.call(listener, eventForListener);
    }
  };

  if (typeof EventTarget !== "undefined" && EventTarget.prototype) {
    const origAddEventListener = EventTarget.prototype.addEventListener;
    const origRemoveEventListener = EventTarget.prototype.removeEventListener;
    const wrappedAddEventListener = {
      addEventListener(type, listener, options) {
        if (!listener || !shouldWrapReplayListener(type, listener)) {
          return origAddEventListener.apply(this, arguments);
        }
        let wrapped = replayListenerWrappers.get(listener);
        if (!wrapped) {
          wrapped = function (event) {
            return invokeReplayListener(listener, this, event);
          };
          replayListenerWrappers.set(listener, wrapped);
        }
        const result = origAddEventListener.call(this, type, wrapped, options);
        const eventType = String(type);
        if (
          !activeReplayListeners.some(
            (entry) =>
              entry.target === this && entry.type === eventType && entry.listener === listener
          )
        ) {
          activeReplayListeners.push({ target: this, type: eventType, listener });
        }
        return result;
      },
    }.addEventListener;
    const wrappedRemoveEventListener = {
      removeEventListener(type, listener, options) {
        const wrapped = replayListenerWrappers.get(listener);
        const eventType = String(type);
        for (let i = activeReplayListeners.length - 1; i >= 0; i--) {
          const entry = activeReplayListeners[i];
          if (entry.target === this && entry.type === eventType && entry.listener === listener) {
            activeReplayListeners.splice(i, 1);
          }
        }
        return origRemoveEventListener.call(this, type, wrapped || listener, options);
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
  }

  const ensureDecoySurface = () => {
    if (decoySurface && decoySurface.isConnected) return decoySurface;
    if (!document.documentElement) return null;
    const input = document.createElement("input");
    input.type = "text";
    input.tabIndex = -1;
    input.autocomplete = "off";
    input.setAttribute("aria-hidden", "true");
    input.style.cssText =
      "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none";
    document.documentElement.appendChild(input);
    decoySurface = input;
    return decoySurface;
  };

  const replayPathFor = (target) => {
    if (target === window) return [window];
    const path = [target];
    if (target !== document) path.push(document);
    if (document.documentElement && !path.includes(document.documentElement)) {
      path.push(document.documentElement);
    }
    if (document.body && !path.includes(document.body)) path.push(document.body);
    path.push(window);
    return path.filter(Boolean);
  };

  const makeReplayEvent = (type, target, props) => {
    const event = {
      type,
      target,
      currentTarget: target,
      srcElement: target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: false,
      timeStamp:
        typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(),
      composedPath: () => replayPathFor(target),
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {},
    };
    return Object.assign(event, props || {});
  };

  const invokeActiveReplayListeners = (type, event) => {
    for (const entry of activeReplayListeners.slice()) {
      if (entry.type !== type) continue;
      try {
        event.currentTarget = entry.target;
        invokeReplayListener(entry.listener, entry.target, event);
      } catch {}
    }
  };

  const dispatchReplayNoise = () => {
    if (!replayDetected || (replayMode !== "noise" && replayMode !== "chaos")) return;
    const x = 40 + Math.floor(Math.random() * Math.max(1, innerWidth - 80));
    const y = 40 + Math.floor(Math.random() * Math.max(1, innerHeight - 80));
    invokeActiveReplayListeners(
      "mousemove",
      makeReplayEvent("mousemove", document, { clientX: x, clientY: y, screenX: x, screenY: y })
    );
    if (replayMode === "chaos") {
      const target = ensureDecoySurface();
      if (target) {
        target.value = "redacted";
        invokeActiveReplayListeners(
          "click",
          makeReplayEvent("click", target, { clientX: x, clientY: y, screenX: x, screenY: y })
        );
        invokeActiveReplayListeners("focus", makeReplayEvent("focus", target));
        invokeActiveReplayListeners(
          "input",
          makeReplayEvent("input", target, { data: "x", inputType: "insertText" })
        );
        invokeActiveReplayListeners("blur", makeReplayEvent("blur", target));
      }
    }
  };

  function startReplayNoise() {
    if (replayNoiseStarted || (replayMode !== "noise" && replayMode !== "chaos")) return;
    replayNoiseStarted = true;
    let sent = 0;
    const loop = () => {
      if (!replayDetected || (replayMode !== "noise" && replayMode !== "chaos") || sent >= 24) {
        replayNoiseStarted = false;
        return;
      }
      sent++;
      dispatchReplayNoise();
      setTimeout(loop, 900 + Math.floor(Math.random() * 900));
    };
    setTimeout(loop, 500 + Math.floor(Math.random() * 500));
  }

  const scanReplaySignals = () => {
    replayScanTicks++;
    for (const key of REPLAY_GLOBALS) {
      try {
        if (window[key] != null) markReplayDetected("global:" + key);
      } catch {}
    }
    try {
      for (const script of document.scripts || []) maybeDetectReplayScript(script.src);
    } catch {}
    if (replayScanTicks < 20) setTimeout(scanReplaySignals, 500);
  };
  setTimeout(scanReplaySignals, 0);

  // ─── 1. fetch ───────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    const wrappedFetch = {
      fetch(input) {
        if (isBad(input)) {
          const u = getUrl(input);
          if (shouldDecoy(u)) {
            bump("fetch-decoy", u);
            return Promise.resolve(buildDecoyResponse(u));
          }
          bump("fetch", u);
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return origFetch.apply(this, arguments);
      },
    }.fetch;
    window.fetch = stealth(wrappedFetch, "fetch", { length: 1 });
  }

  // ─── 2. XMLHttpRequest ──────────────────────────────────────────────────
  const blockedXHRs = new WeakMap();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const wrappedOpen = {
    open(method, url, ...rest) {
      const bad = isBad(url);
      if (bad) blockedXHRs.set(this, getUrl(url));
      return origOpen.call(this, method, bad ? "about:blank" : url, ...rest);
    },
  }.open;
  const fakeXhrSuccess = function (xhr, url) {
    const { body, contentType } = buildDecoyBody(url);
    const text = typeof body === "string" ? body : "";
    queueMicrotask(() => {
      try {
        xhr.dispatchEvent(new ProgressEvent("loadstart"));
      } catch {}
      try {
        Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
        Object.defineProperty(xhr, "status", { value: 200, configurable: true });
        Object.defineProperty(xhr, "statusText", { value: "OK", configurable: true });
        Object.defineProperty(xhr, "responseURL", { value: url, configurable: true });
        Object.defineProperty(xhr, "responseText", { value: text, configurable: true });
        Object.defineProperty(xhr, "response", { value: text, configurable: true });
        const origGetHeader = xhr.getResponseHeader;
        xhr.getResponseHeader = {
          getResponseHeader(name) {
            if (String(name).toLowerCase() === "content-type") return contentType;
            return origGetHeader ? origGetHeader.call(this, name) : null;
          },
        }.getResponseHeader;
        xhr.dispatchEvent(new Event("readystatechange"));
        xhr.dispatchEvent(new Event("load"));
        xhr.dispatchEvent(new Event("loadend"));
      } catch {}
    });
  };
  const wrappedSend = {
    send(...args) {
      if (blockedXHRs.has(this)) {
        const url = blockedXHRs.get(this);
        blockedXHRs.delete(this);
        if (shouldDecoy(url)) {
          bump("xhr-decoy", url);
          fakeXhrSuccess(this, url);
          return;
        }
        bump("xhr", url);
        queueMicrotask(() => {
          try {
            this.dispatchEvent(new ProgressEvent("loadstart"));
          } catch {}
          try {
            Object.defineProperty(this, "readyState", { value: 4, configurable: true });
            Object.defineProperty(this, "status", { value: 0, configurable: true });
            Object.defineProperty(this, "statusText", { value: "", configurable: true });
            Object.defineProperty(this, "responseURL", { value: "", configurable: true });
            Object.defineProperty(this, "responseText", { value: "", configurable: true });
            Object.defineProperty(this, "response", { value: "", configurable: true });
            this.dispatchEvent(new Event("readystatechange"));
          } catch {}
          try {
            this.dispatchEvent(new Event("error"));
          } catch {}
          try {
            this.dispatchEvent(new Event("loadend"));
          } catch {}
        });
        return;
      }
      return origSend.apply(this, args);
    },
  }.send;
  XMLHttpRequest.prototype.open = stealth(wrappedOpen, "open");
  XMLHttpRequest.prototype.send = stealth(wrappedSend, "send");

  // ─── 3. Element src / href / data property setters ──────────────────────
  const guardProp = (proto, prop, label) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(v) {
        if (label === "script.src") maybeDetectReplayScript(v);
        if (isBad(v)) {
          bump(label, v);
          return;
        }
        return desc.set.call(this, v);
      },
    });
  };
  guardProp(HTMLLinkElement.prototype, "href", "link.href");
  guardProp(HTMLScriptElement.prototype, "src", "script.src");
  guardProp(HTMLImageElement.prototype, "src", "img.src");
  guardProp(HTMLIFrameElement.prototype, "src", "iframe.src");
  if (typeof HTMLSourceElement !== "undefined")
    guardProp(HTMLSourceElement.prototype, "src", "source.src");
  if (typeof HTMLEmbedElement !== "undefined")
    guardProp(HTMLEmbedElement.prototype, "src", "embed.src");
  if (typeof HTMLObjectElement !== "undefined")
    guardProp(HTMLObjectElement.prototype, "data", "object.data");

  // ─── 4. setAttribute / setAttributeNS fallback ──────────────────────────
  const attrGuard = (origFn, label, name, length) => {
    const wrapped = {
      [name](...args) {
        const argName = args.length >= 3 ? args[1] : args[0];
        const argValue = args.length >= 3 ? args[2] : args[1];
        if (typeof argName === "string") {
          const n = argName.toLowerCase();
          if (n === "src") maybeDetectReplayScript(argValue);
          if ((n === "src" || n === "href" || n === "data") && isBad(argValue)) {
            bump(label, argValue);
            return;
          }
        }
        return origFn.apply(this, args);
      },
    }[name];
    return stealth(wrapped, name, { length });
  };
  Element.prototype.setAttribute = attrGuard(
    Element.prototype.setAttribute,
    "setAttribute",
    "setAttribute",
    2
  );
  Element.prototype.setAttributeNS = attrGuard(
    Element.prototype.setAttributeNS,
    "setAttributeNS",
    "setAttributeNS",
    3
  );

  // ─── 5. navigator.sendBeacon ────────────────────────────────────────────
  try {
    const navProto = Object.getPrototypeOf(navigator);
    const beaconDesc = navProto && Object.getOwnPropertyDescriptor(navProto, "sendBeacon");
    const origBeacon = beaconDesc && beaconDesc.value;
    if (typeof origBeacon === "function") {
      const wrappedBeacon = {
        sendBeacon(url) {
          if (isBad(url)) {
            bump("sendBeacon", url);
            return true;
          }
          return origBeacon.apply(this, arguments);
        },
      }.sendBeacon;
      Object.defineProperty(navProto, "sendBeacon", {
        ...beaconDesc,
        value: stealth(wrappedBeacon, "sendBeacon", { length: 1 }),
      });
    }
  } catch {
    if (navigator.sendBeacon) {
      const origBeacon = navigator.sendBeacon.bind(navigator);
      const wrappedBeacon = {
        sendBeacon(url) {
          const data = arguments[1];
          if (isBad(url)) {
            bump("sendBeacon", url);
            return true;
          }
          return origBeacon(url, data);
        },
      }.sendBeacon;
      try {
        navigator.sendBeacon = stealth(wrappedBeacon, "sendBeacon", { length: 1 });
      } catch {}
    }
  }

  // ─── 6. Worker / SharedWorker ───────────────────────────────────────────
  const patchWorkerCtor = (Ctor, label) => {
    if (typeof Ctor !== "function") return Ctor;
    const wrapped = function (url, opts) {
      if (isBad(url)) {
        bump(label, url);
        const origin = location && location.origin ? location.origin : "null";
        throw new DOMException(
          "Failed to construct '" +
            label +
            "': Script at '" +
            String(url) +
            "' cannot be accessed from origin '" +
            origin +
            "'.",
          "SecurityError"
        );
      }
      return new Ctor(url, opts);
    };
    wrapped.prototype = Ctor.prototype;
    return stealth(wrapped, label, { length: 1 });
  };
  if (window.Worker) window.Worker = patchWorkerCtor(window.Worker, "Worker");
  if (window.SharedWorker)
    window.SharedWorker = patchWorkerCtor(window.SharedWorker, "SharedWorker");

  // ─── 7. EventSource ─────────────────────────────────────────────────────
  if (window.EventSource) {
    const origES = window.EventSource;
    const wrappedES = function EventSource(url, opts) {
      if (isBad(url)) {
        bump("EventSource", url);
        const target = new EventTarget();
        let readyState = origES.CONNECTING;
        let onerror = null;
        let onerrorHandler = null;
        const listenerWrappers = [];
        const close = stealth(
          function close() {
            readyState = origES.CLOSED;
          },
          "close",
          { length: 0 }
        );
        const wrapEvent = (event) =>
          new Proxy(event, {
            get(e, prop, receiver) {
              if (prop === "target" || prop === "currentTarget" || prop === "srcElement") {
                return fake;
              }
              if (prop === "composedPath") {
                return () => [fake];
              }
              const value = Reflect.get(e, prop, receiver);
              return typeof value === "function" ? value.bind(e) : value;
            },
          });
        const captureFor = (options) =>
          typeof options === "boolean" ? options : !!(options && options.capture);
        const addEventListener = stealth(
          function addEventListener(type, listener, options) {
            if (listener == null) return;
            const wrapped = (event) => {
              const eventForPage = wrapEvent(event);
              if (typeof listener === "function") return listener.call(fake, eventForPage);
              if (listener && typeof listener.handleEvent === "function") {
                return listener.handleEvent.call(listener, eventForPage);
              }
            };
            listenerWrappers.push({
              type,
              listener,
              capture: captureFor(options),
              wrapped,
            });
            target.addEventListener(type, wrapped, options);
          },
          "addEventListener",
          { length: 2 }
        );
        const removeEventListener = stealth(
          function removeEventListener(type, listener, options) {
            const capture = captureFor(options);
            const index = listenerWrappers.findIndex(
              (entry) =>
                entry.type === type && entry.listener === listener && entry.capture === capture
            );
            if (index === -1) return;
            const [entry] = listenerWrappers.splice(index, 1);
            target.removeEventListener(type, entry.wrapped, options);
          },
          "removeEventListener",
          { length: 2 }
        );
        const fake = new Proxy(target, {
          get(t, prop, receiver) {
            if (prop === "readyState") return readyState;
            if (prop === "url") return String(url);
            if (prop === "withCredentials") return !!(opts && opts.withCredentials);
            if (prop === "onerror") return onerror;
            if (prop === "close") return close;
            if (prop === "addEventListener") return addEventListener;
            if (prop === "removeEventListener") return removeEventListener;
            const value = Reflect.get(t, prop, receiver);
            return typeof value === "function" ? value.bind(t) : value;
          },
          set(t, prop, value) {
            if (prop === "onerror") {
              if (onerrorHandler) target.removeEventListener("error", onerrorHandler);
              onerror = typeof value === "function" ? value : null;
              onerrorHandler = onerror
                ? (event) => {
                    try {
                      onerror.call(fake, wrapEvent(event));
                    } catch {}
                  }
                : null;
              if (onerrorHandler) target.addEventListener("error", onerrorHandler);
              return true;
            }
            return Reflect.set(t, prop, value);
          },
          getPrototypeOf() {
            return origES.prototype;
          },
        });
        queueMicrotask(() => {
          readyState = origES.CLOSED;
          try {
            target.dispatchEvent(new Event("error"));
          } catch {}
        });
        return fake;
      }
      return new origES(url, opts);
    };
    wrappedES.prototype = origES.prototype;
    wrappedES.CONNECTING = 0;
    wrappedES.OPEN = 1;
    wrappedES.CLOSED = 2;
    window.EventSource = stealth(wrappedES, "EventSource", { length: 1 });
  }

  // ─── 8. navigator.serviceWorker.register ────────────────────────────────
  // Reading navigator.serviceWorker itself throws SecurityError in sandboxed
  // iframes that lack `allow-same-origin` (e.g. tweet-embed / ad iframes),
  // so the whole section is wrapped.
  try {
    if (navigator.serviceWorker && typeof navigator.serviceWorker.register === "function") {
      try {
        const sw = navigator.serviceWorker;
        const swProto = Object.getPrototypeOf(sw);
        const registerDesc = swProto && Object.getOwnPropertyDescriptor(swProto, "register");
        const origRegister = registerDesc && registerDesc.value;
        if (typeof origRegister === "function") {
          const wrappedRegister = {
            register(url) {
              if (isBad(url)) {
                bump("serviceWorker.register", url);
                return Promise.reject(new TypeError("Failed to register a ServiceWorker"));
              }
              return origRegister.apply(this, arguments);
            },
          }.register;
          Object.defineProperty(swProto, "register", {
            ...registerDesc,
            value: stealth(wrappedRegister, "register", { length: 1 }),
          });
        }
      } catch {}
    }
  } catch {}

  // ─── 9. Lock down devtools / extension-bridge globals ───────────────────
  for (const k of STRIP_GLOBALS) {
    try {
      const existing = Object.getOwnPropertyDescriptor(window, k);
      if (existing && !existing.configurable) continue;
      Object.defineProperty(window, k, {
        configurable: false,
        enumerable: false,
        get: () => undefined,
        set: () => {},
      });
    } catch {}
  }
})();
