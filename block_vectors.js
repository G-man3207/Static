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

  const postProbe = (url, where) => {
    const safeUrl = url == null ? "" : String(url).slice(0, 512);
    const safeWhere = where == null ? "" : String(where).slice(0, 64);
    bridge.post("probe_blocked", { url: safeUrl, where: safeWhere });
  };

  const bump = (where, url) => {
    try {
      postProbe(url, where);
    } catch {}
  };

  const guardProp = (proto, prop, label, urlFinder = U.badUrlFor) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    const setterHolder = {
      set [prop](value) {
        if (disabled) {
          desc.set.call(this, value);
          return;
        }
        const url = urlFinder(value);
        if (url) {
          bump(label, url);
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
      set: U.stealth(guardedSetter, `set ${prop}`, {
        length: desc.set.length,
        source: U.nativeSourceFor(desc.set, `set ${prop}`),
      }),
    });
  };

  const patchElementProperties = () => {
    guardProp(HTMLLinkElement.prototype, "href", "link.href");
    guardProp(HTMLScriptElement.prototype, "src", "script.src");
    guardProp(HTMLImageElement.prototype, "src", "img.src");
    guardProp(HTMLImageElement.prototype, "srcset", "img.srcset", U.firstBadUrlIn);
    guardProp(HTMLIFrameElement.prototype, "src", "iframe.src");
    if (typeof HTMLAnchorElement !== "undefined") {
      guardProp(HTMLAnchorElement.prototype, "href", "anchor.href");
      guardProp(HTMLAnchorElement.prototype, "ping", "anchor.ping", U.firstBadUrlIn);
    }
    if (typeof HTMLAreaElement !== "undefined") {
      guardProp(HTMLAreaElement.prototype, "href", "area.href");
    }
    if (typeof HTMLBaseElement !== "undefined") {
      guardProp(HTMLBaseElement.prototype, "href", "base.href");
    }
    if (typeof HTMLInputElement !== "undefined") {
      guardProp(HTMLInputElement.prototype, "src", "input.src");
      guardProp(HTMLInputElement.prototype, "formAction", "input.formAction");
    }
    if (typeof HTMLFormElement !== "undefined") {
      guardProp(HTMLFormElement.prototype, "action", "form.action");
    }
    if (typeof HTMLButtonElement !== "undefined") {
      guardProp(HTMLButtonElement.prototype, "formAction", "button.formAction");
    }
    if (typeof HTMLMediaElement !== "undefined") {
      guardProp(HTMLMediaElement.prototype, "src", "media.src");
    }
    if (typeof HTMLTrackElement !== "undefined") {
      guardProp(HTMLTrackElement.prototype, "src", "track.src");
    }
    if (typeof HTMLVideoElement !== "undefined") {
      guardProp(HTMLVideoElement.prototype, "poster", "video.poster");
    }
    if (typeof HTMLSourceElement !== "undefined") {
      guardProp(HTMLSourceElement.prototype, "src", "source.src");
      guardProp(HTMLSourceElement.prototype, "srcset", "source.srcset", U.firstBadUrlIn);
    }
    if (typeof HTMLEmbedElement !== "undefined") {
      guardProp(HTMLEmbedElement.prototype, "src", "embed.src");
    }
    if (typeof HTMLObjectElement !== "undefined") {
      guardProp(HTMLObjectElement.prototype, "data", "object.data");
    }
  };

  const getSupportedIframeAllowFeatures = (() => {
    let cached = null;
    return () => {
      if (cached) return cached;
      const supported = [];
      try {
        supported.push(
          ...U.readPolicyFeatures(document.featurePolicy || document.permissionsPolicy)
        );
      } catch {}
      if (!supported.length) {
        try {
          supported.push(...U.readPolicyFeatures(document.createElement("iframe").featurePolicy));
        } catch {}
      }
      cached = new Set(supported.map((feature) => String(feature).toLowerCase()));
      return cached;
    };
  })();

  const normalizeIframeAllowValue = (element, value) => {
    if (typeof HTMLIFrameElement === "undefined" || !(element instanceof HTMLIFrameElement)) {
      return value;
    }
    const raw = value == null ? "" : String(value);
    const supported = getSupportedIframeAllowFeatures();
    if (!raw || !supported.size) return raw;

    const kept = [];
    let changed = false;
    for (const part of raw.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^[^\s]+/);
      if (!match || supported.has(match[0].toLowerCase())) {
        kept.push(trimmed);
        continue;
      }
      changed = true;
    }
    return changed ? kept.join("; ") : raw;
  };

  const attrGuard = (origFn, label, name, length) => {
    const blockedAttrUrl = (attrName, value) => {
      const localName = U.attrLocalName(null, attrName);
      if (localName === "ping") return U.firstBadUrlIn(value);
      if (
        localName === "src" ||
        localName === "href" ||
        localName === "data" ||
        localName === "poster" ||
        localName === "action" ||
        localName === "formaction"
      ) {
        return U.badUrlFor(value);
      }
      if (localName === "srcset") {
        return U.firstBadUrlIn(value);
      }
      return "";
    };
    const wrapped = {
      [name](...args) {
        const argName = args.length >= 3 ? args[1] : args[0];
        const argValue = args.length >= 3 ? args[2] : args[1];
        const nextArgs = args.slice();
        if (disabled) return origFn.apply(this, nextArgs);
        if (typeof argName === "string") {
          const normalizedName = argName.toLowerCase();
          const url = blockedAttrUrl(normalizedName, argValue);
          if (url) {
            bump(label, url);
            return;
          }
          if (normalizedName === "allow") {
            nextArgs[args.length >= 3 ? 2 : 1] = normalizeIframeAllowValue(this, argValue);
          }
        }
        return origFn.apply(this, nextArgs);
      },
    }[name];
    return U.stealth(wrapped, name, { length, source: U.nativeSourceFor(origFn, name) });
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
          if (disabled) return origBeacon.apply(this, arguments);
          if (U.isBad(url)) {
            bump("sendBeacon", url);
            throw new TypeError("Failed to execute 'sendBeacon' on 'Navigator': Invalid URL");
          }
          return origBeacon.apply(this, arguments);
        },
      }.sendBeacon;
      Object.defineProperty(navProto, "sendBeacon", {
        ...beaconDesc,
        value: U.stealth(wrappedBeacon, "sendBeacon", { length: 1 }),
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
        if (disabled) return origBeacon.apply(this, arguments);
        const data = arguments[1];
        if (U.isBad(url)) {
          bump("sendBeacon", url);
          throw new TypeError("Failed to execute 'sendBeacon' on 'Navigator': Invalid URL");
        }
        return origBeacon(url, data);
      },
    }.sendBeacon;
    try {
      Object.defineProperty(navigator, "sendBeacon", {
        value: U.stealth(wrappedBeacon, "sendBeacon", { length: 1 }),
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch {}
  };

  const patchWorkerCtor = (Ctor, label) => {
    if (typeof Ctor !== "function") return Ctor;
    const wrapped = function (url) {
      if (!new.target) return Reflect.apply(Ctor, this, arguments);
      if (disabled) return Reflect.construct(Ctor, arguments, new.target);
      if (U.isBad(url)) {
        bump(label, url);
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
        bump("Audio", src);
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
      bump("EventSource", url);
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
          if (disabled) return origRegister.apply(this, arguments);
          if (U.isBad(url)) {
            bump("serviceWorker.register", url);
            return Promise.reject(new TypeError("Failed to register a ServiceWorker"));
          }
          return origRegister.apply(this, arguments);
        },
      }.register;
      Object.defineProperty(swProto, "register", {
        ...registerDesc,
        value: U.stealth(wrappedRegister, "register", { length: 1 }),
      });
    } catch {}
  };

  const patchWorkletAddModule = () => {
    if (typeof Worklet === "undefined" || !Worklet.prototype) return;
    const desc = Object.getOwnPropertyDescriptor(Worklet.prototype, "addModule");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrappedAddModule = {
      addModule(moduleURL) {
        if (disabled) return orig.apply(this, arguments);
        if (U.isBad(moduleURL)) {
          const url = U.getUrl(moduleURL);
          bump("Worklet.addModule", url);
          return Promise.reject(
            new DOMException("Unable to load a worklet's module.", "AbortError")
          );
        }
        return orig.apply(this, arguments);
      },
    }.addModule;
    Object.defineProperty(Worklet.prototype, "addModule", {
      ...desc,
      value: U.stealth(wrappedAddModule, "addModule", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "addModule"),
      }),
    });
  };

  const patchCssMethod = (proto, name, label, onBlocked) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      [name](...args) {
        if (disabled) return orig.apply(this, args);
        const target = name === "addRule" ? `${args[0] || ""} ${args[1] || ""}` : args[0];
        const url = U.firstBadUrlIn(target);
        if (url) {
          bump(label, url);
          return onBlocked.call(this, args);
        }
        return orig.apply(this, args);
      },
    }[name];
    Object.defineProperty(proto, name, {
      ...desc,
      value: U.stealth(wrapped, name, {
        length: orig.length,
        source: U.nativeSourceFor(orig, name),
      }),
    });
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
