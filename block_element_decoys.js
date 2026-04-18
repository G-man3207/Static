// Static - MAIN-world passive element decoys for Noise-mode personas.
(() => {
  const BAD_RE = /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  const CHROME_EXT_ID_RE = /^[a-p]{32}$/;
  const BRIDGE_EVENT = "__static_element_decoy_bridge_init__";
  const PNG_1X1_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const queuedProbeEvents = [];
  const elementOriginals = new WeakMap();
  const MAX_QUEUED_PROBES = 1000;
  let bridgePort = null;
  let noiseEnabled = false;
  let persona = new Set();

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

  const applyConfigUpdate = (data) => {
    if (!data || data.type !== "config_update") return;
    if (Array.isArray(data.persona)) {
      persona = new Set(data.persona.filter((id) => typeof id === "string"));
    }
    if (typeof data.noiseEnabled === "boolean") noiseEnabled = data.noiseEnabled;
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
    bridgePort.onmessage = (portEvent) => applyConfigUpdate(portEvent.data);
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

  const extractExtId = (url) => {
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

  const shouldDecoy = (url) => {
    if (!noiseEnabled) return false;
    const id = extractExtId(url);
    return id != null && persona.has(id);
  };

  const rememberOriginal = (el, prop, url) => {
    const entry = elementOriginals.get(el) || {};
    entry[prop] = String(url);
    elementOriginals.set(el, entry);
  };

  const forgetOriginal = (el, prop) => {
    const entry = elementOriginals.get(el);
    if (entry) delete entry[prop];
  };

  const rememberedOriginal = (el, prop) => {
    const entry = elementOriginals.get(el);
    return entry && entry[prop];
  };

  const pathFor = (url) => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  };

  const decoyUrlFor = (url, prop, el) => {
    const path = pathFor(url);
    const tag = String((el && el.tagName) || "").toLowerCase();
    if (prop === "src" && tag === "script") return "data:application/javascript;charset=utf-8,";
    if (prop === "poster") return `data:image/png;base64,${PNG_1X1_B64}`;
    if (prop === "href" && (path.endsWith(".css") || tag === "link")) return "data:text/css,";
    if (/\.(png|jpe?g|gif|webp|ico|bmp|svg)$/i.test(path) || prop === "src") {
      return `data:image/png;base64,${PNG_1X1_B64}`;
    }
    if (prop === "data") return "data:text/html;charset=utf-8,<!doctype%20html>";
    return "data:text/plain,";
  };

  const blockedUrlFor = () => "data:image/png;base64,not-valid";

  const canHandlePassiveElement = (el, prop) => {
    const tag = String((el && el.tagName) || "").toLowerCase();
    if (prop === "src") return ["img", "input", "script", "source", "embed"].includes(tag);
    if (prop === "href") return tag === "link" || tag === "use" || tag === "image";
    if (prop === "data") return tag === "object";
    if (prop === "poster") return tag === "video";
    return false;
  };

  const elementProbeMode = (el, prop, value) => {
    if (!isBad(value) || !canHandlePassiveElement(el, prop)) return null;
    return shouldDecoy(value) ? "decoy" : "block";
  };

  const replacementUrlFor = (mode, url, prop, el) => {
    if (mode === "decoy") return decoyUrlFor(url, prop, el);
    return blockedUrlFor();
  };

  const guardProp = (proto, prop, label) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    const setterHolder = {
      set [prop](value) {
        const mode = elementProbeMode(this, prop, value);
        if (mode) {
          const url = getUrl(value);
          rememberOriginal(this, prop, url);
          postProbe(url, mode === "decoy" ? `${label}-decoy` : label);
          desc.set.call(this, replacementUrlFor(mode, url, prop, this));
          return;
        }
        forgetOriginal(this, prop);
        desc.set.call(this, value);
      },
    };
    const get = desc.get
      ? stealth(
          function get() {
            return rememberedOriginal(this, prop) || desc.get.call(this);
          },
          `get ${prop}`,
          { length: desc.get.length, source: nativeSourceFor(desc.get, `get ${prop}`) }
        )
      : desc.get;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get,
      set: stealth(Object.getOwnPropertyDescriptor(setterHolder, prop).set, `set ${prop}`, {
        length: desc.set.length,
        source: nativeSourceFor(desc.set, `set ${prop}`),
      }),
    });
  };

  const attrPropFor = (name) => {
    const lower = String(name || "").toLowerCase();
    if (lower === "src" || lower === "href" || lower === "data" || lower === "poster") {
      return lower;
    }
    return null;
  };

  const patchAttributes = () => {
    const origSetAttribute = Element.prototype.setAttribute;
    const origSetAttributeNS = Element.prototype.setAttributeNS;
    const origGetAttribute = Element.prototype.getAttribute;
    const origGetAttributeNS = Element.prototype.getAttributeNS;
    const origRemoveAttribute = Element.prototype.removeAttribute;
    const origRemoveAttributeNS = Element.prototype.removeAttributeNS;
    const wrapped = {
      setAttribute(name, value) {
        const prop = attrPropFor(name);
        const mode = prop && elementProbeMode(this, prop, value);
        if (mode) {
          const url = getUrl(value);
          rememberOriginal(this, prop, url);
          postProbe(url, mode === "decoy" ? `setAttribute-${prop}-decoy` : "setAttribute");
          return origSetAttribute.call(this, name, replacementUrlFor(mode, url, prop, this));
        }
        if (prop) forgetOriginal(this, prop);
        return origSetAttribute.apply(this, arguments);
      },
      setAttributeNS(ns, name, value) {
        const prop = attrPropFor(name);
        const mode = prop && elementProbeMode(this, prop, value);
        if (mode) {
          const url = getUrl(value);
          rememberOriginal(this, prop, url);
          postProbe(url, mode === "decoy" ? `setAttributeNS-${prop}-decoy` : "setAttributeNS");
          return origSetAttributeNS.call(this, ns, name, replacementUrlFor(mode, url, prop, this));
        }
        if (prop) forgetOriginal(this, prop);
        return origSetAttributeNS.apply(this, arguments);
      },
      getAttribute(name) {
        const prop = attrPropFor(name);
        return (prop && rememberedOriginal(this, prop)) || origGetAttribute.apply(this, arguments);
      },
      getAttributeNS(ns, name) {
        const prop = attrPropFor(name);
        return (
          (prop && rememberedOriginal(this, prop)) || origGetAttributeNS.apply(this, arguments)
        );
      },
      removeAttribute(name) {
        const prop = attrPropFor(name);
        if (prop) forgetOriginal(this, prop);
        return origRemoveAttribute.apply(this, arguments);
      },
      removeAttributeNS(ns, name) {
        const prop = attrPropFor(name);
        if (prop) forgetOriginal(this, prop);
        return origRemoveAttributeNS.apply(this, arguments);
      },
    };
    Element.prototype.setAttribute = stealth(wrapped.setAttribute, "setAttribute", { length: 2 });
    Element.prototype.setAttributeNS = stealth(wrapped.setAttributeNS, "setAttributeNS", {
      length: 3,
    });
    Element.prototype.getAttribute = stealth(wrapped.getAttribute, "getAttribute", { length: 1 });
    Element.prototype.getAttributeNS = stealth(wrapped.getAttributeNS, "getAttributeNS", {
      length: 2,
    });
    Element.prototype.removeAttribute = stealth(wrapped.removeAttribute, "removeAttribute", {
      length: 1,
    });
    Element.prototype.removeAttributeNS = stealth(wrapped.removeAttributeNS, "removeAttributeNS", {
      length: 2,
    });
  };

  const patchCurrentSrc = () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "currentSrc");
    if (!desc || !desc.get) return;
    Object.defineProperty(HTMLImageElement.prototype, "currentSrc", {
      configurable: true,
      enumerable: desc.enumerable,
      get: stealth(
        function get() {
          return rememberedOriginal(this, "src") || desc.get.call(this);
        },
        "get currentSrc",
        { length: 0, source: nativeSourceFor(desc.get, "get currentSrc") }
      ),
    });
  };

  const patchStyleSheetHref = () => {
    if (typeof StyleSheet === "undefined" || !StyleSheet.prototype) return;
    const desc = Object.getOwnPropertyDescriptor(StyleSheet.prototype, "href");
    if (!desc || !desc.get) return;
    Object.defineProperty(StyleSheet.prototype, "href", {
      configurable: true,
      enumerable: desc.enumerable,
      get: stealth(
        function get() {
          try {
            return rememberedOriginal(this.ownerNode, "href") || desc.get.call(this);
          } catch {
            return desc.get.call(this);
          }
        },
        "get href",
        { length: 0, source: nativeSourceFor(desc.get, "get href") }
      ),
    });
  };

  guardProp(HTMLImageElement.prototype, "src", "img.src");
  if (typeof HTMLInputElement !== "undefined") {
    guardProp(HTMLInputElement.prototype, "src", "input.src");
  }
  guardProp(HTMLScriptElement.prototype, "src", "script.src");
  guardProp(HTMLLinkElement.prototype, "href", "link.href");
  if (typeof HTMLVideoElement !== "undefined") {
    guardProp(HTMLVideoElement.prototype, "poster", "video.poster");
  }
  if (typeof HTMLSourceElement !== "undefined") {
    guardProp(HTMLSourceElement.prototype, "src", "source.src");
  }
  if (typeof HTMLEmbedElement !== "undefined") {
    guardProp(HTMLEmbedElement.prototype, "src", "embed.src");
  }
  if (typeof HTMLObjectElement !== "undefined") {
    guardProp(HTMLObjectElement.prototype, "data", "object.data");
  }
  patchAttributes();
  patchCurrentSrc();
  patchStyleSheetHref();
})();
