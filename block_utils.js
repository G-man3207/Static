// Static - shared MAIN-world utilities for block content scripts.
// This file must load FIRST among MAIN-world content scripts in manifest.json.
(() => {
  const U = {};

  // ======================================================================
  // Stealth infrastructure — makes wrapped functions look native under
  // Function.prototype.toString inspection.
  // ======================================================================
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

  U.stealth = (fn, nativeName, opts = {}) => {
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

  U.nativeSourceFor = (fn, fallbackName) => {
    if (stealthFns.has(fn)) return stealthFns.get(fn);
    try {
      return origFnToString.call(fn);
    } catch {
      return `function ${fallbackName}() { [native code] }`;
    }
  };

  U.origFnToString = origFnToString;

  // ======================================================================
  // Prototype / reflection utilities
  // ======================================================================

  U.descriptorOwnerFor = (proto, prop) => {
    let cursor = proto;
    while (cursor) {
      const desc = Object.getOwnPropertyDescriptor(cursor, prop);
      if (desc) return { desc, owner: cursor };
      cursor = Object.getPrototypeOf(cursor);
    }
    return null;
  };

  U.alignPrototypeConstructor = (wrapped, original) => {
    try {
      const proto = original && original.prototype;
      if (!proto) return;
      const desc = Object.getOwnPropertyDescriptor(proto, "constructor") || {
        configurable: true,
        enumerable: false,
        writable: true,
      };
      Object.defineProperty(proto, "constructor", { ...desc, value: wrapped });
    } catch {}
  };

  U.copyConstructorStatics = (wrapped, original) => {
    for (const key of Reflect.ownKeys(original)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      try {
        const desc = Object.getOwnPropertyDescriptor(original, key);
        if (desc) Object.defineProperty(wrapped, key, desc);
      } catch {}
    }
  };

  // ======================================================================
  // URL / extension-ID detection utilities
  // ======================================================================

  U.CHROME_EXT_ID_RE = /^[a-p]{32}$/;
  U.BAD_RE = /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  U.BAD_URL_RE = /\b(?:chrome|moz|ms-browser|safari-web|edge)-extension:[^\s"'()<>]+/i;

  U.EXT_ID_RE_BY_SCHEME = {
    "chrome-extension": U.CHROME_EXT_ID_RE,
    "edge-extension": U.CHROME_EXT_ID_RE,
    "moz-extension": /^[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$/i,
    "safari-web-extension": /^[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$/i,
  };

  U.normalizeUrlString = (value) => String(value).trim();

  U.getUrl = (input) => {
    if (input == null) return "";
    if (typeof input === "string") return U.normalizeUrlString(input);
    if (typeof URL !== "undefined" && input instanceof URL) return input.href;
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    if (typeof input.url === "string") return U.normalizeUrlString(input.url);
    try {
      return U.normalizeUrlString(input);
    } catch {
      return "";
    }
  };

  U.isBad = (input) => {
    try {
      return U.BAD_RE.test(U.getUrl(input));
    } catch {
      return false;
    }
  };

  U.badUrlFor = (input) => (U.isBad(input) ? U.getUrl(input) : "");

  U.firstBadUrlIn = (input) => {
    try {
      if (U.isBad(input)) return U.getUrl(input);
      const match = String(input == null ? "" : input).match(U.BAD_URL_RE);
      return match ? match[0] : "";
    } catch {
      return "";
    }
  };

  U.extensionIdentityFor = (url) => {
    try {
      const parsed = new URL(String(url || ""));
      const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
      const id = parsed.hostname.toLowerCase();
      const idRe = U.EXT_ID_RE_BY_SCHEME[scheme];
      if (idRe && idRe.test(id)) {
        return { id, scheme };
      }
    } catch {}
    return null;
  };

  U.extractExtId = (url) => {
    const identity = U.extensionIdentityFor(url);
    return identity ? identity.id : null;
  };

  // ======================================================================
  // Decoy path patterns — shared between block.js and block_element_decoys.js
  // ======================================================================

  U.IMAGE_DECOY_PATHS = [
    /(?:^|\/)(?:icon|logo|badge|action|browser_action|page_action)(?:[-_. ]?(?:\d{1,4}|small|medium|large|default))?\.(?:png|jpe?g|gif|webp|ico|bmp|svg)$/i,
    /(?:^|\/)(?:icons?|images?|img)\/(?:[^/]+\/)*(?:icon|logo|badge|action|browser_action|page_action)(?:[-_. ]?(?:\d{1,4}|small|medium|large|default))?\.(?:png|jpe?g|gif|webp|ico|bmp|svg)$/i,
    /(?:^|\/)(?:16|19|24|32|38|48|64|96|128|256|512)\.(?:png|jpe?g|gif|webp|ico|bmp|svg)$/i,
  ];
  U.SCRIPT_DECOY_PATHS = [
    /(?:^|\/)(?:content(?:[-_. ]script)?|inject(?:ed)?|background(?:[-_. ]page)?|bundle|main|page|popup|options|index)(?:[-_. ]?[a-z0-9]+)?\.(?:m?js)$/i,
  ];
  U.HTML_DECOY_PATHS = [
    /(?:^|\/)(?:page|popup|options|background|index)(?:[-_. ]?[a-z0-9]+)?\.(?:html|htm)$/i,
  ];
  U.STYLE_DECOY_PATHS = [
    /(?:^|\/)(?:style|styles|content|popup|options|main|index)(?:[-_. ]?[a-z0-9]+)?\.css$/i,
  ];

  U.pathFor = (url) => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  };

  U.matchesPathPattern = (pathname, patterns) => patterns.some((pattern) => pattern.test(pathname));

  // ======================================================================
  // DOM / attribute utilities
  // ======================================================================

  U.readPolicyFeatures = (policy) => {
    if (!policy) return [];
    try {
      if (typeof policy.features === "function") return policy.features();
    } catch {}
    try {
      if (typeof policy.allowedFeatures === "function") return policy.allowedFeatures();
    } catch {}
    return [];
  };

  U.attrLocalName = (el, name) => {
    if (typeof name !== "string") return "";
    const lower = name.toLowerCase();
    if (lower === "class") return "class";
    if (lower === "style" || lower.startsWith("data-")) return lower;
    if (el && el.namespaceURI === "http://www.w3.org/1999/xhtml") return lower;
    const colon = lower.lastIndexOf(":");
    return colon === -1 ? lower : lower.slice(colon + 1);
  };

  // ======================================================================
  // Bridge setup — shared MessagePort init pattern used by most block scripts.
  //
  // Each block script creates its own bridge via setupBridge(eventName, maxQueue, onConfigUpdate).
  // Returns { post, getPort } where:
  //   post(type, payload) — queues message until bridge connects, then forwards.
  //   getPort()           — returns the connected port (or null before connect).
  // ======================================================================

  U.setupBridge = (eventName, maxQueue, onConfigUpdate) => {
    let port = null;
    const queued = [];

    const onBridgeInit = (event) => {
      if (port) return;
      const p = event && event.ports && event.ports[0];
      if (!p || typeof p.postMessage !== "function") return;
      try {
        event.stopImmediatePropagation();
      } catch {}
      port = p;
      port.onmessage = (portEvent) => {
        try {
          onConfigUpdate(portEvent.data);
        } catch {}
      };
      try {
        port.start();
      } catch {}
      const batch = queued.splice(0, queued.length);
      for (const msg of batch) {
        try {
          port.postMessage(msg);
        } catch {
          port = null;
          return;
        }
      }
      document.removeEventListener(eventName, onBridgeInit);
    };

    document.addEventListener(eventName, onBridgeInit);

    return {
      post: (type, payload) => {
        const msg = payload == null ? { type } : { type, ...payload };
        if (port) {
          try {
            port.postMessage(msg);
            return;
          } catch {
            port = null;
          }
        }
        if (queued.length < maxQueue) {
          queued.push(msg);
        }
      },
      getPort: () => port,
    };
  };

  // Export on globalThis so subsequent MAIN-world scripts can access it.
  try {
    Object.defineProperty(globalThis, "__static_block_utils__", {
      value: U,
      configurable: false,
      writable: false,
    });
  } catch {
    globalThis.__static_block_utils__ = U;
  }
})();
