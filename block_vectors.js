// Static - MAIN-world blocking for extension probe vectors beyond fetch/XHR.
(() => {
  const U = globalThis.__static_block_utils__;
  const BRIDGE_EVENT = "__perf_probe_bi__";
  const MAX_QUEUED_PROBES = 1000;
  let disabled = false;

  const applyConfigUpdate = (data) => {
    if (data && data.type === "config_update" && typeof data.disabled === "boolean") {
      disabled = data.disabled;
    }
  };

  const bridge = U.setupBridge(BRIDGE_EVENT, MAX_QUEUED_PROBES, applyConfigUpdate);

  const guardProp = (proto, prop, label, urlFinder = U.badUrlFor) => {
    U.wrapSetter(proto, prop, (nativeSet) => ({
      set(value) {
        const url = disabled ? "" : urlFinder(value);
        if (url) {
          bridge.probe(url, label);
          return;
        }
        nativeSet.call(this, value);
      },
    }));
  };

  // [element constructor, property, probe label, URL finder for list-valued props]
  const GUARDED_PROPS = [
    ["HTMLLinkElement", "href", "link.href"],
    ["HTMLScriptElement", "src", "script.src"],
    ["HTMLImageElement", "src", "img.src"],
    ["HTMLImageElement", "srcset", "img.srcset", U.firstBadUrlIn],
    ["HTMLIFrameElement", "src", "iframe.src"],
    ["HTMLAnchorElement", "href", "anchor.href"],
    ["HTMLAnchorElement", "ping", "anchor.ping", U.firstBadUrlIn],
    ["HTMLAreaElement", "href", "area.href"],
    ["HTMLBaseElement", "href", "base.href"],
    ["HTMLInputElement", "src", "input.src"],
    ["HTMLInputElement", "formAction", "input.formAction"],
    ["HTMLFormElement", "action", "form.action"],
    ["HTMLButtonElement", "formAction", "button.formAction"],
    ["HTMLMediaElement", "src", "media.src"],
    ["HTMLTrackElement", "src", "track.src"],
    ["HTMLVideoElement", "poster", "video.poster"],
    ["HTMLSourceElement", "src", "source.src"],
    ["HTMLSourceElement", "srcset", "source.srcset", U.firstBadUrlIn],
    ["HTMLEmbedElement", "src", "embed.src"],
    ["HTMLObjectElement", "data", "object.data"],
  ];

  const patchElementProperties = () => {
    for (const [ctorName, prop, label, urlFinder] of GUARDED_PROPS) {
      const Ctor = window[ctorName];
      if (Ctor) guardProp(Ctor.prototype, prop, label, urlFinder);
    }
  };

  const blockedAttrUrl = (attrName, value) => {
    const localName = U.attrLocalName(null, attrName);
    if (localName === "ping" || localName === "srcset") return U.firstBadUrlIn(value);
    if (["src", "href", "data", "poster", "action", "formaction"].includes(localName)) {
      return U.badUrlFor(value);
    }
    return "";
  };

  // iframe `allow` values are normalized by block_iframe_attrs.js, which wraps
  // these setters after this script.
  const patchAttributes = () => {
    for (const name of ["setAttribute", "setAttributeNS"]) {
      const namespaced = name === "setAttributeNS";
      U.wrapMethod(Element.prototype, name, (orig) => ({
        [name](...args) {
          const attrName = namespaced ? args[1] : args[0];
          const url =
            !disabled && typeof attrName === "string"
              ? blockedAttrUrl(attrName, namespaced ? args[2] : args[1])
              : "";
          if (url) {
            bridge.probe(url, name);
            return;
          }
          return orig.apply(this, args);
        },
      }));
    }
  };

  const patchBeacon = () => {
    try {
      U.wrapMethod(Object.getPrototypeOf(navigator), "sendBeacon", (origBeacon) => ({
        sendBeacon(url) {
          if (disabled) return origBeacon.apply(this, arguments);
          if (U.isBad(url)) {
            bridge.probe(url, "sendBeacon");
            throw new TypeError("Failed to execute 'sendBeacon' on 'Navigator': Invalid URL");
          }
          return origBeacon.apply(this, arguments);
        },
      }));
    } catch {}
  };

  const patchWorkerCtor = (Ctor, label) => {
    if (typeof Ctor !== "function") return Ctor;
    const wrapped = function (url) {
      if (!new.target) return Reflect.apply(Ctor, this, arguments);
      if (disabled) return Reflect.construct(Ctor, arguments, new.target);
      if (U.isBad(url)) {
        bridge.probe(url, label);
        const origin = location && location.origin ? location.origin : "null";
        throw new DOMException(
          `Failed to construct '${label}': Script at '${String(
            url
          )}' cannot be accessed from origin '${origin}'.`,
          "SecurityError"
        );
      }
      return Reflect.construct(Ctor, arguments, new.target);
    };
    wrapped.prototype = Ctor.prototype;
    U.alignPrototypeConstructor(wrapped, Ctor);
    return U.stealth(wrapped, label, { length: 1 });
  };

  const patchWorkers = () => {
    if (window.Worker) {
      window.Worker = patchWorkerCtor(window.Worker, "Worker");
    }
    if (window.SharedWorker) {
      window.SharedWorker = patchWorkerCtor(window.SharedWorker, "SharedWorker");
    }
  };

  const patchAudioCtor = () => {
    if (typeof window.Audio !== "function") return;
    const OrigAudio = window.Audio;
    const wrappedAudio = function Audio(src) {
      if (!new.target) return Reflect.apply(OrigAudio, this, arguments);
      if (disabled) return Reflect.construct(OrigAudio, arguments, new.target);
      if (arguments.length > 0 && U.isBad(src)) {
        bridge.probe(src, "Audio");
        return Reflect.construct(OrigAudio, [], new.target);
      }
      return Reflect.construct(OrigAudio, arguments, new.target);
    };
    wrappedAudio.prototype = OrigAudio.prototype;
    U.alignPrototypeConstructor(wrappedAudio, OrigAudio);
    window.Audio = U.stealth(wrappedAudio, "Audio", {
      length: OrigAudio.length,
      source: U.nativeSourceFor(OrigAudio, "Audio"),
    });
  };

  const makeBlockedEventSource = (url, opts, origES) => {
    const target = new EventTarget();
    let readyState = origES.CONNECTING;
    let onerror = null;
    let onerrorHandler = null;
    const listenerWrappers = [];
    const close = U.stealth(
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
    const addEventListener = U.stealth(
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
    const removeEventListener = U.stealth(
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
        if (prop === Symbol.toStringTag) return "EventSource";
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
      if (!new.target) return Reflect.apply(origES, this, arguments);
      if (disabled) return Reflect.construct(origES, arguments, new.target);
      if (!U.isBad(url)) return Reflect.construct(origES, arguments, new.target);
      bridge.probe(url, "EventSource");
      return makeBlockedEventSource(url, opts, origES);
    };
    wrappedES.prototype = origES.prototype;
    U.alignPrototypeConstructor(wrappedES, origES);
    wrappedES.CONNECTING = 0;
    wrappedES.OPEN = 1;
    wrappedES.CLOSED = 2;
    window.EventSource = U.stealth(wrappedES, "EventSource", { length: 1 });
  };

  const patchServiceWorkerRegister = () => {
    try {
      if (!navigator.serviceWorker) return;
      U.wrapMethod(Object.getPrototypeOf(navigator.serviceWorker), "register", (origRegister) => ({
        register(url) {
          if (disabled) return origRegister.apply(this, arguments);
          if (U.isBad(url)) {
            bridge.probe(url, "serviceWorker.register");
            return Promise.reject(new TypeError("Failed to register a ServiceWorker"));
          }
          return origRegister.apply(this, arguments);
        },
      }));
    } catch {}
  };

  const patchWorkletAddModule = () => {
    if (typeof Worklet === "undefined") return;
    U.wrapMethod(Worklet.prototype, "addModule", (orig) => ({
      addModule(moduleURL) {
        if (disabled) return orig.apply(this, arguments);
        if (U.isBad(moduleURL)) {
          bridge.probe(U.getUrl(moduleURL), "Worklet.addModule");
          return Promise.reject(
            new DOMException("Unable to load a worklet's module.", "AbortError")
          );
        }
        return orig.apply(this, arguments);
      },
    }));
  };

  const patchCssMethod = (proto, name, label, onBlocked) => {
    U.wrapMethod(proto, name, (orig) => ({
      [name](...args) {
        if (disabled) return orig.apply(this, args);
        const target = name === "addRule" ? `${args[0] || ""} ${args[1] || ""}` : args[0];
        const url = U.sanitizeCssText(target).url || U.firstBadUrlIn(target);
        if (url) {
          bridge.probe(url, label);
          return onBlocked.call(this, args);
        }
        return orig.apply(this, args);
      },
    }));
  };

  const patchCssRules = () => {
    if (typeof CSSStyleSheet === "undefined" || !CSSStyleSheet.prototype) return;
    patchCssMethod(CSSStyleSheet.prototype, "insertRule", "css.insertRule", function (args) {
      return typeof args[1] === "number" ? args[1] : 0;
    });
    patchCssMethod(CSSStyleSheet.prototype, "replace", "css.replace", function () {
      return Promise.resolve(this);
    });
    patchCssMethod(CSSStyleSheet.prototype, "replaceSync", "css.replaceSync", function () {});
    patchCssMethod(CSSStyleSheet.prototype, "addRule", "css.addRule", function () {
      return -1;
    });
  };

  patchElementProperties();
  patchAttributes();
  patchBeacon();
  patchWorkers();
  patchAudioCtor();
  patchEventSource();
  patchServiceWorkerRegister();
  patchWorkletAddModule();
  patchCssRules();
})();
