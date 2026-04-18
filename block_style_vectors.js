// Static - MAIN-world blocking for CSS declaration extension URL probes.
(() => {
  const BAD_RE = /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  const BAD_URL_RE = /\b(?:chrome|moz|ms-browser|safari-web|edge)-extension:[^\s"'()<>]+/i;
  const BRIDGE_EVENT = "__static_style_probe_bridge_init__";
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

  const firstBadUrlIn = (input) => {
    try {
      if (isBad(input)) return getUrl(input);
      const match = String(input == null ? "" : input).match(BAD_URL_RE);
      return match ? match[0] : "";
    } catch {
      return "";
    }
  };

  const bump = (where, url) => {
    try {
      postProbe(url, where);
    } catch {}
  };

  const patchSetProperty = (proto) => {
    const desc = Object.getOwnPropertyDescriptor(proto, "setProperty");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      setProperty(name, value, priority) {
        const url = firstBadUrlIn(value);
        if (url) {
          bump("style.setProperty", url);
          return;
        }
        return orig.call(this, name, value, priority);
      },
    }.setProperty;
    Object.defineProperty(proto, "setProperty", {
      ...desc,
      value: stealth(wrapped, "setProperty", {
        length: orig.length,
        source: nativeSourceFor(orig, "setProperty"),
      }),
    });
  };

  const patchCssText = (proto) => {
    const desc = Object.getOwnPropertyDescriptor(proto, "cssText");
    if (!desc || !desc.set) return;
    const wrapped = {
      set cssText(value) {
        const url = firstBadUrlIn(value);
        if (url) {
          bump("style.cssText", url);
          return;
        }
        desc.set.call(this, value);
      },
    };
    Object.defineProperty(proto, "cssText", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: stealth(Object.getOwnPropertyDescriptor(wrapped, "cssText").set, "set cssText", {
        length: desc.set.length,
        source: nativeSourceFor(desc.set, "set cssText"),
      }),
    });
  };

  const scrubElementStyle = (el, label) => {
    if (!el || !el.style) return;
    const style = el.style;
    for (let index = style.length - 1; index >= 0; index--) {
      const name = style.item(index);
      const value = style.getPropertyValue(name);
      const url = firstBadUrlIn(value);
      if (url) {
        bump(label, url);
        try {
          style.removeProperty(name);
        } catch {}
      }
    }
  };

  const scrubTree = (node, label) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    scrubElementStyle(node, label);
    if (typeof node.querySelectorAll !== "function") return;
    try {
      for (const el of node.querySelectorAll("[style]")) scrubElementStyle(el, label);
    } catch {}
  };

  const observeStyleAttributes = () => {
    if (typeof MutationObserver === "undefined" || !document.documentElement) return false;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          scrubElementStyle(record.target, "style.attribute");
          continue;
        }
        for (const node of record.addedNodes) scrubTree(node, "style.attribute");
      }
    });
    observer.observe(document.documentElement, {
      attributeFilter: ["style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    scrubTree(document.documentElement, "style.attribute");
    return true;
  };

  if (typeof CSSStyleDeclaration !== "undefined" && CSSStyleDeclaration.prototype) {
    patchSetProperty(CSSStyleDeclaration.prototype);
    patchCssText(CSSStyleDeclaration.prototype);
  }
  if (!observeStyleAttributes()) {
    document.addEventListener("DOMContentLoaded", observeStyleAttributes, { once: true });
  }
})();
