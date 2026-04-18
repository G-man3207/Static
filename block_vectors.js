// Static - MAIN-world blocking for extension probe vectors beyond fetch/XHR.
(() => {
  const BAD_RE = /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  const BRIDGE_EVENT = "__static_probe_bridge_init__";
  const MAX_QUEUED_PROBES = 1000;
  const queuedProbeEvents = [];
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

  const nativeSourceFor = (fn, fallbackName) => {
    try {
      return origFnToString.call(fn);
    } catch {
      return `function ${fallbackName}() { [native code] }`;
    }
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
    flushQueuedProbes();
    document.removeEventListener(BRIDGE_EVENT, onBridgeInit);
  };
  document.addEventListener(BRIDGE_EVENT, onBridgeInit);

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

  const isBad = (input) => {
    try {
      return BAD_RE.test(getUrl(input));
    } catch {
      return false;
    }
  };

  const bump = (where, url) => {
    try {
      postProbe(url, where);
    } catch {}
  };

  const guardProp = (proto, prop, label) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    const setterHolder = {
      set [prop](value) {
        if (isBad(value)) {
          bump(label, value);
          return;
        }
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

  const patchElementProperties = () => {
    guardProp(HTMLLinkElement.prototype, "href", "link.href");
    guardProp(HTMLScriptElement.prototype, "src", "script.src");
    guardProp(HTMLImageElement.prototype, "src", "img.src");
    guardProp(HTMLIFrameElement.prototype, "src", "iframe.src");
    if (typeof HTMLSourceElement !== "undefined") {
      guardProp(HTMLSourceElement.prototype, "src", "source.src");
    }
    if (typeof HTMLEmbedElement !== "undefined") {
      guardProp(HTMLEmbedElement.prototype, "src", "embed.src");
    }
    if (typeof HTMLObjectElement !== "undefined") {
      guardProp(HTMLObjectElement.prototype, "data", "object.data");
    }
  };

  const attrGuard = (origFn, label, name, length) => {
    const wrapped = {
      [name](...args) {
        const argName = args.length >= 3 ? args[1] : args[0];
        const argValue = args.length >= 3 ? args[2] : args[1];
        if (typeof argName === "string") {
          const lowerName = argName.toLowerCase();
          if (
            (lowerName === "src" || lowerName === "href" || lowerName === "data") &&
            isBad(argValue)
          ) {
            bump(label, argValue);
            return;
          }
        }
        return origFn.apply(this, args);
      },
    }[name];
    return stealth(wrapped, name, { length });
  };

  const patchAttributes = () => {
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
  };

  const patchBeacon = () => {
    try {
      const navProto = Object.getPrototypeOf(navigator);
      const beaconDesc = navProto && Object.getOwnPropertyDescriptor(navProto, "sendBeacon");
      const origBeacon = beaconDesc && beaconDesc.value;
      if (typeof origBeacon !== "function") return;
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
    } catch {
      patchBeaconFallback();
    }
  };

  const patchBeaconFallback = () => {
    if (!navigator.sendBeacon) return;
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
  };

  const patchWorkerCtor = (Ctor, label) => {
    if (typeof Ctor !== "function") return Ctor;
    const wrapped = function (url, opts) {
      if (isBad(url)) {
        bump(label, url);
        const origin = location && location.origin ? location.origin : "null";
        throw new DOMException(
          `Failed to construct '${label}': Script at '${String(
            url
          )}' cannot be accessed from origin '${origin}'.`,
          "SecurityError"
        );
      }
      return new Ctor(url, opts);
    };
    wrapped.prototype = Ctor.prototype;
    alignPrototypeConstructor(wrapped, Ctor);
    return stealth(wrapped, label, { length: 1 });
  };

  const patchWorkers = () => {
    if (window.Worker) window.Worker = patchWorkerCtor(window.Worker, "Worker");
    if (window.SharedWorker) {
      window.SharedWorker = patchWorkerCtor(window.SharedWorker, "SharedWorker");
    }
  };

  const makeBlockedEventSource = (url, opts, origES) => {
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
          if (prop === "target" || prop === "currentTarget" || prop === "srcElement") return fake;
          if (prop === "composedPath") return () => [fake];
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
            return listener.handleEvent(eventForPage);
          }
        };
        listenerWrappers.push({ type, listener, capture: captureFor(options), wrapped });
        target.addEventListener(type, wrapped, options);
      },
      "addEventListener",
      { length: 2 }
    );
    const removeEventListener = stealth(
      function removeEventListener(type, listener, options) {
        const capture = captureFor(options);
        const index = listenerWrappers.findIndex(
          (entry) => entry.type === type && entry.listener === listener && entry.capture === capture
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
        if (prop !== "onerror") return Reflect.set(t, prop, value);
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
  };

  const patchEventSource = () => {
    if (!window.EventSource) return;
    const origES = window.EventSource;
    const wrappedES = function EventSource(url, opts) {
      if (!isBad(url)) return new origES(url, opts);
      bump("EventSource", url);
      return makeBlockedEventSource(url, opts, origES);
    };
    wrappedES.prototype = origES.prototype;
    alignPrototypeConstructor(wrappedES, origES);
    wrappedES.CONNECTING = 0;
    wrappedES.OPEN = 1;
    wrappedES.CLOSED = 2;
    window.EventSource = stealth(wrappedES, "EventSource", { length: 1 });
  };

  const patchServiceWorkerRegister = () => {
    try {
      if (!navigator.serviceWorker || typeof navigator.serviceWorker.register !== "function") {
        return;
      }
      const sw = navigator.serviceWorker;
      const swProto = Object.getPrototypeOf(sw);
      const registerDesc = swProto && Object.getOwnPropertyDescriptor(swProto, "register");
      const origRegister = registerDesc && registerDesc.value;
      if (typeof origRegister !== "function") return;
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
    } catch {}
  };

  patchElementProperties();
  patchAttributes();
  patchBeacon();
  patchWorkers();
  patchEventSource();
  patchServiceWorkerRegister();
})();
