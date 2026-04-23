/* eslint-disable max-lines -- MAIN-world replay shims are safer kept contiguous */
// Static - MAIN-world opt-in session-replay poisoning.
(() => {
  const BRIDGE_EVENT = "__static_replay_bridge_init__";
  const REPLAY_RE =
    /(fullstory|fs\.js|logrocket|mouseflow|smartlook|clarity|heap|pendo|luckyorange|inspectlet|browsee|contentsquare|quantummetric|session[-_]?replay|@sentry\/replay|sentry.*(?:replay|rrweb)|browser\.sentry-cdn\.com\/.*replay|replayIntegration|replayCanvasIntegration|replaysSessionSampleRate|replaysOnErrorSampleRate|beforeAddRecordingEvent|ReplayCanvas|rrweb|sessionReplaySampleRate|replaySampleRate|premiumSampleRate|startSessionReplayRecording(?:Manually)?|stopSessionReplayRecording|@datadog\/browser-rum)/i;
  const REPLAY_GLOBALS =
    `FS _fs_org _fs_host LogRocket Mouseflow mouseflow smartlook clarity heap pendo __lo_site_id __insp Inspectlet Browsee QuantumMetricAPI`.split(
      " "
    );
  const REPLAY_EVENT_TYPES = new Set(
    `input change keydown keyup keypress click dblclick mousedown mouseup mousemove pointerdown pointerup pointermove scroll focus blur`.split(
      " "
    )
  );
  const queuedSignals = [];
  const reportedReplaySignals = new Set();
  const eventJitter = new WeakMap();
  const targetProxyCache = new WeakMap();
  const replayListenerWrappers = new WeakMap();
  const activeReplayListeners = [];
  const replayRegistrationStack = [];
  const datadogGlobals = new WeakSet();
  const MAX_QUEUED_SIGNALS = 50;
  let bridgePort = null;
  let replayMode = "off";
  let replayDetected = false;
  let replayNoiseStarted = false;
  let decoySurface = null;
  let replayScanTicks = 0;

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

  const nativeSourceFor = (fn, fallbackName) => {
    try {
      return origFnToString.call(fn);
    } catch {
      return `function ${fallbackName}() { [native code] }`;
    }
  };

  const isObjectLike = (value) => value && (typeof value === "object" || typeof value === "function");

  const currentReplayRegistration = () =>
    replayRegistrationStack.length > 0
      ? replayRegistrationStack[replayRegistrationStack.length - 1]
      : null;

  const runReplayRegistration = (signal, fn, context = {}) => {
    if (typeof fn !== "function") return undefined;
    const ctx = { added: 0, signal };
    let completed = false;
    replayRegistrationStack.push(ctx);
    try {
      const result = fn.apply(context.thisArg, context.args);
      completed = true;
      return result;
    } finally {
      replayRegistrationStack.pop();
      if (completed && (context.markAlways || ctx.added > 0)) {
        markReplayDetected(signal);
      }
    }
  };

  const positiveNumber = (value) => {
    const num = typeof value === "string" ? Number(value) : value;
    return Number.isFinite(num) && num > 0;
  };

  const datadogReplaySignalForConfig = (config) => {
    if (!isObjectLike(config)) return null;
    if (positiveNumber(config.sessionReplaySampleRate)) {
      return "global:DD_RUM.sessionReplaySampleRate";
    }
    if (positiveNumber(config.premiumSampleRate)) {
      return "global:DD_RUM.premiumSampleRate";
    }
    if (positiveNumber(config.replaySampleRate)) {
      return "global:DD_RUM.replaySampleRate";
    }
    return null;
  };

  const patchDatadogMethod = (target, key, wrap) => {
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

  const instrumentDatadogGlobal = (value) => {
    if (!isObjectLike(value) || datadogGlobals.has(value)) return value;
    datadogGlobals.add(value);
    patchDatadogMethod(value, "init", (origInit) =>
      function init(config) {
        const signal = datadogReplaySignalForConfig(config);
        if (!signal) return origInit.apply(this, arguments);
        return runReplayRegistration(signal, origInit, { args: arguments, thisArg: this });
      }
    );
    patchDatadogMethod(value, "startSessionReplayRecording", (origStart) =>
      function startSessionReplayRecording() {
        return runReplayRegistration("global:DD_RUM.startSessionReplayRecording", origStart, {
          args: arguments,
          markAlways: true,
          thisArg: this,
        });
      }
    );
    return value;
  };

  const patchDatadogGlobal = () => {
    try {
      const desc = Object.getOwnPropertyDescriptor(window, "DD_RUM");
      if (desc) {
        if ("value" in desc) instrumentDatadogGlobal(desc.value);
        return;
      }
      let currentValue = undefined;
      Object.defineProperty(window, "DD_RUM", {
        configurable: true,
        enumerable: true,
        get: stealth(
          function get() {
            return currentValue;
          },
          "get DD_RUM",
          { length: 0 }
        ),
        set: stealth(
          function set(value) {
            currentValue = instrumentDatadogGlobal(value);
          },
          "set DD_RUM",
          { length: 1 }
        ),
      });
    } catch {}
  };

  const applyConfigUpdate = (data) => {
    if (!data || data.type !== "config_update") return;
    if (typeof data.replayMode === "string") {
      replayMode = data.replayMode;
      if (replayDetected) startReplayNoise();
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
    if (queuedSignals.length < MAX_QUEUED_SIGNALS) {
      queuedSignals.push(safeSignal);
    }
  };

  const flushQueuedSignals = () => {
    if (!bridgePort) return;
    const batch = queuedSignals.splice(0, queuedSignals.length);
    for (const signal of batch) {
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
    flushQueuedSignals();
    document.removeEventListener(BRIDGE_EVENT, onBridgeInit);
  };
  document.addEventListener(BRIDGE_EVENT, onBridgeInit);

  const isReplayScriptUrl = (url) => {
    try {
      return REPLAY_RE.test(String(url || ""));
    } catch {
      return false;
    }
  };

  const redactPathSegment = (segment) => {
    if (!segment) return segment;
    if (/^[0-9a-f-]{36}$/i.test(segment)) {
      return ":uuid";
    }
    if (/^[0-9a-f]{16,}$/i.test(segment)) return ":hex";
    if (/^\d{5,}$/.test(segment)) return ":num";
    if (segment.length < 24 || !/[a-z]/i.test(segment) || !/\d/.test(segment)) return segment;
    const ext = segment.match(/\.[a-z0-9]{1,8}$/i);
    return ext ? `:token${ext[0].toLowerCase()}` : ":token";
  };

  const redactedPathnameFor = (pathname) =>
    String(pathname || "").replace(/[^/]+/g, redactPathSegment);

  const stableUrlLabelFor = (url) => {
    try {
      const parsed = new URL(String(url), location.href);
      return parsed.origin + redactedPathnameFor(parsed.pathname);
    } catch {
      try {
        return String(url || "")
          .replace(/[?#].*$/, "")
          .slice(0, 160);
      } catch {
        return "";
      }
    }
  };

  const markReplayDetected = (signal) => {
    replayDetected = true;
    const safeSignal = signal == null ? "unknown" : String(signal).slice(0, 96);
    if (!reportedReplaySignals.has(safeSignal)) {
      reportedReplaySignals.add(safeSignal);
      postReplayDetected(safeSignal);
    }
    startReplayNoise();
  };

  const maybeDetectReplayScript = (url) => {
    if (isReplayScriptUrl(url)) {
      markReplayDetected(`script:${stableUrlLabelFor(url).slice(0, 72)}`);
    }
  };

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
    if (jitter) return jitter;
    jitter = {
      x: Math.floor(Math.random() * 17) - 8,
      y: Math.floor(Math.random() * 13) - 6,
    };
    eventJitter.set(event, jitter);
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
      get(t, prop, _receiver) {
        if (replayMode !== "off" && shouldRedactTarget(t)) {
          if (prop === "value" || prop === "defaultValue") return redactedValueFor(t);
          if (prop === "textContent" || prop === "innerText") return "redacted";
          if (prop === "getAttribute") return redactedGetAttributeFor(t);
        }
        if (shouldJitterRect(prop)) return jitteredRectFor(t);
        const value = Reflect.get(t, prop, t);
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
    targetProxyCache.set(target, proxy);
    return proxy;
  };

  const redactedGetAttributeFor = (target) => (name) => {
    if (String(name).toLowerCase() === "value") return redactedValueFor(target);
    return target.getAttribute(name);
  };

  const shouldJitterRect = (prop) =>
    (replayMode === "noise" || replayMode === "chaos") && prop === "getBoundingClientRect";

  const jitteredRectFor = (target) => () => {
    const rect = target.getBoundingClientRect();
    const x = Math.floor(Math.random() * 7) - 3;
    const y = Math.floor(Math.random() * 7) - 3;
    return new DOMRect(rect.x + x, rect.y + y, rect.width, rect.height);
  };

  const proxiedReplayEvent = (event) => {
    if (!event || (typeof event !== "object" && typeof event !== "function")) return event;
    return new Proxy(event, {
      get(e, prop, _receiver) {
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
    const registration = currentReplayRegistration();
    if (registration) return true;
    if (currentScriptLooksReplay()) {
      markReplayDetected(
        `listener-script:${stableUrlLabelFor(document.currentScript.src).slice(0, 72)}`
      );
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
      return listener.handleEvent(eventForListener);
    }
  };

  const patchReplayListeners = () => {
    if (typeof EventTarget === "undefined" || !EventTarget.prototype) return;
    const origAddEventListener = EventTarget.prototype.addEventListener;
    const origRemoveEventListener = EventTarget.prototype.removeEventListener;
    const wrappedAddEventListener = {
      addEventListener(type, listener, options) {
        if (!listener || !shouldWrapReplayListener(type, listener)) {
          return origAddEventListener.apply(this, arguments);
        }
        const wrapped = getReplayListenerWrapper(listener);
        const result = origAddEventListener.call(this, type, wrapped, options);
        rememberActiveReplayListener(this, type, listener);
        return result;
      },
    }.addEventListener;
    const wrappedRemoveEventListener = {
      removeEventListener(type, listener, options) {
        forgetActiveReplayListener(this, type, listener);
        return origRemoveEventListener.call(
          this,
          type,
          replayListenerWrappers.get(listener) || listener,
          options
        );
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

  const getReplayListenerWrapper = (listener) => {
    let wrapped = replayListenerWrappers.get(listener);
    if (wrapped) return wrapped;
    wrapped = function (event) {
      return invokeReplayListener(listener, this, event);
    };
    replayListenerWrappers.set(listener, wrapped);
    return wrapped;
  };

  const rememberActiveReplayListener = (target, type, listener) => {
    const eventType = String(type);
    const exists = activeReplayListeners.some(
      (entry) => entry.target === target && entry.type === eventType && entry.listener === listener
    );
    if (!exists) {
      activeReplayListeners.push({ target, type: eventType, listener });
      const registration = currentReplayRegistration();
      if (registration) registration.added++;
    }
  };

  const forgetActiveReplayListener = (target, type, listener) => {
    const eventType = String(type);
    for (let i = activeReplayListeners.length - 1; i >= 0; i--) {
      const entry = activeReplayListeners[i];
      if (entry.target === target && entry.type === eventType && entry.listener === listener) {
        activeReplayListeners.splice(i, 1);
      }
    }
  };

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
    if (replayMode === "chaos") dispatchReplayChaos(x, y);
  };

  const dispatchReplayChaos = (x, y) => {
    const target = ensureDecoySurface();
    if (!target) return;
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
    try {
      instrumentDatadogGlobal(window.DD_RUM);
    } catch {}
    for (const key of REPLAY_GLOBALS) {
      try {
        if (window[key] != null) markReplayDetected(`global:${key}`);
      } catch {}
    }
    try {
      for (const script of document.scripts || []) maybeDetectReplayScript(script.src);
    } catch {}
    if (replayScanTicks < 20) setTimeout(scanReplaySignals, 500);
  };

  const patchReplayScriptProperties = () => {
    guardScriptProp(HTMLScriptElement.prototype, "src", "script.src");
    const origSetAttribute = Element.prototype.setAttribute;
    const origSetNS = Element.prototype.setAttributeNS;
    Element.prototype.setAttribute = makeAttributeDetector(origSetAttribute, "setAttribute", 2);
    Element.prototype.setAttributeNS = makeAttributeDetector(origSetNS, "setAttributeNS", 3);
  };

  const guardScriptProp = (proto, prop) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    const setterHolder = {
      set [prop](value) {
        maybeDetectReplayScript(value);
        desc.set.call(this, value);
      },
    };
    const guardedSetter = Object.getOwnPropertyDescriptor(setterHolder, prop).set;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: stealth(guardedSetter, `set ${prop}`, {
        length: desc.set.length,
        source: nativeSourceFor(desc.set, `set ${prop}`),
      }),
    });
  };

  const makeAttributeDetector = (origFn, name, length) => {
    const wrapped = {
      [name](...args) {
        const attrName = args.length >= 3 ? args[1] : args[0];
        const attrValue = args.length >= 3 ? args[2] : args[1];
        if (typeof attrName === "string" && attrName.toLowerCase() === "src") {
          maybeDetectReplayScript(attrValue);
        }
        return origFn.apply(this, args);
      },
    }[name];
    return stealth(wrapped, name, { length });
  };

  patchDatadogGlobal();
  patchReplayScriptProperties();
  patchReplayListeners();
  setTimeout(scanReplaySignals, 0);
})();
