// Static - MAIN-world blocking for CSS declaration extension URL probes.
(() => {
  const BAD_RE = /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  const BAD_URL_RE = /\b(?:chrome|moz|ms-browser|safari-web|edge)-extension:[^\s"'()<>]+/i;
  const BRIDGE_EVENT = "__static_style_probe_bridge_init__";
  const MAX_QUEUED_PROBES = 1000;
  const STYLE_MARKUP_RE = /<\s*style(?:\s|>|\/)/i;
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

  const isStyleElement = (node) => {
    return (
      node &&
      node.nodeType === Node.ELEMENT_NODE &&
      String(node.localName || "").toLowerCase() === "style"
    );
  };

  const clearStyleText = (style) => {
    while (style.firstChild) {
      try {
        style.removeChild(style.firstChild);
      } catch {
        return;
      }
    }
  };

  const blockStyleText = (label, value) => {
    const url = firstBadUrlIn(value);
    if (!url) return false;
    bump(label, url);
    return true;
  };

  const scrubStyleTextNode = (style, label) => {
    if (!isStyleElement(style)) return false;
    const text = style.textContent || "";
    if (!blockStyleText(label, text)) return false;
    clearStyleText(style);
    return true;
  };

  const scrubStyleTextTree = (node, label) => {
    if (!node || typeof node.querySelectorAll !== "function") return false;
    let changed = isStyleElement(node) && scrubStyleTextNode(node, label);
    try {
      for (const style of node.querySelectorAll("style")) {
        changed = scrubStyleTextNode(style, label) || changed;
      }
    } catch {}
    return changed;
  };

  const sanitizeStyleMarkup = (value, label, innerHTMLDesc) => {
    if (typeof value !== "string" || !STYLE_MARKUP_RE.test(value)) return value;
    const template = document.createElement("template");
    try {
      innerHTMLDesc.set.call(template, value);
    } catch {
      return value;
    }
    const root = template.content || template;
    if (!scrubStyleTextTree(root, label)) return value;
    try {
      return innerHTMLDesc.get.call(template);
    } catch {
      return "";
    }
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

  const patchTextContent = (proto) => {
    const desc = Object.getOwnPropertyDescriptor(proto, "textContent");
    if (!desc || !desc.set) return;
    const wrapped = {
      set textContent(value) {
        if (isStyleElement(this) && blockStyleText("style.textContent", value)) {
          desc.set.call(this, "");
          return;
        }
        desc.set.call(this, value);
      },
    };
    Object.defineProperty(proto, "textContent", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: stealth(Object.getOwnPropertyDescriptor(wrapped, "textContent").set, "set textContent", {
        length: desc.set.length,
        source: nativeSourceFor(desc.set, "set textContent"),
      }),
    });
  };

  const patchInnerHTML = (proto, innerHTMLDesc) => {
    if (!innerHTMLDesc || !innerHTMLDesc.set) return;
    const wrapped = {
      set innerHTML(value) {
        const nextValue =
          isStyleElement(this) && blockStyleText("style.innerHTML", value)
            ? ""
            : sanitizeStyleMarkup(value, "style.innerHTML", innerHTMLDesc);
        innerHTMLDesc.set.call(this, nextValue);
      },
    };
    Object.defineProperty(proto, "innerHTML", {
      configurable: true,
      enumerable: innerHTMLDesc.enumerable,
      get: innerHTMLDesc.get,
      set: stealth(Object.getOwnPropertyDescriptor(wrapped, "innerHTML").set, "set innerHTML", {
        length: innerHTMLDesc.set.length,
        source: nativeSourceFor(innerHTMLDesc.set, "set innerHTML"),
      }),
    });
  };

  const patchInsertAdjacentHTML = (proto, innerHTMLDesc) => {
    const desc = Object.getOwnPropertyDescriptor(proto, "insertAdjacentHTML");
    const orig = desc && desc.value;
    if (typeof orig !== "function" || !innerHTMLDesc) return;
    const wrapped = {
      insertAdjacentHTML(position, html) {
        const nextHtml =
          isStyleElement(this) && blockStyleText("style.insertAdjacentHTML", html)
            ? ""
            : sanitizeStyleMarkup(html, "style.insertAdjacentHTML", innerHTMLDesc);
        return orig.call(this, position, nextHtml);
      },
    }.insertAdjacentHTML;
    Object.defineProperty(proto, "insertAdjacentHTML", {
      ...desc,
      value: stealth(wrapped, "insertAdjacentHTML", {
        length: orig.length,
        source: nativeSourceFor(orig, "insertAdjacentHTML"),
      }),
    });
  };

  const scrubInsertionArgs = (target, args, label) => {
    const nextArgs = [];
    for (const arg of args) {
      if (isStyleElement(target) && typeof arg === "string" && blockStyleText(label, arg)) {
        continue;
      }
      if (arg && typeof arg === "object") scrubStyleTextTree(arg, label);
      nextArgs.push(arg);
    }
    return nextArgs;
  };

  const patchNodeInsertionMethod = (proto, name, label) => {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      [name](node, ...rest) {
        if (node && typeof node === "object") scrubStyleTextTree(node, label);
        return orig.call(this, node, ...rest);
      },
    }[name];
    Object.defineProperty(proto, name, {
      ...desc,
      value: stealth(wrapped, name, { length: orig.length, source: nativeSourceFor(orig, name) }),
    });
  };

  const patchElementInsertionMethod = (proto, name, label) => {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      [name](...args) {
        return orig.apply(this, scrubInsertionArgs(this, args, label));
      },
    }[name];
    Object.defineProperty(proto, name, {
      ...desc,
      value: stealth(wrapped, name, { length: orig.length, source: nativeSourceFor(orig, name) }),
    });
  };

  const patchStyleTextInsertion = () => {
    const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    patchTextContent(Node.prototype);
    patchInnerHTML(Element.prototype, innerHTMLDesc);
    patchInsertAdjacentHTML(Element.prototype, innerHTMLDesc);
    for (const name of ["appendChild", "insertBefore", "replaceChild"]) {
      patchNodeInsertionMethod(Node.prototype, name, "style.domInsertion");
    }
    for (const name of ["append", "prepend", "replaceChildren"]) {
      patchElementInsertionMethod(Element.prototype, name, `style.${name}`);
    }
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
        if (record.type === "characterData") {
          scrubStyleTextNode(record.target && record.target.parentNode, "style.text");
          continue;
        }
        if (record.type === "attributes") {
          scrubElementStyle(record.target, "style.attribute");
          continue;
        }
        for (const node of record.addedNodes) {
          scrubTree(node, "style.attribute");
          scrubStyleTextTree(node, "style.text");
        }
      }
    });
    observer.observe(document.documentElement, {
      attributeFilter: ["style"],
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    scrubTree(document.documentElement, "style.attribute");
    scrubStyleTextTree(document.documentElement, "style.text");
    return true;
  };

  if (typeof CSSStyleDeclaration !== "undefined" && CSSStyleDeclaration.prototype) {
    patchSetProperty(CSSStyleDeclaration.prototype);
    patchCssText(CSSStyleDeclaration.prototype);
  }
  patchStyleTextInsertion();
  if (!observeStyleAttributes()) {
    document.addEventListener("DOMContentLoaded", observeStyleAttributes, { once: true });
  }
})();
