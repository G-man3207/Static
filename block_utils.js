// Static - shared MAIN-world utilities for block content scripts.
// This file must load FIRST among MAIN-world content scripts in manifest.json.
(() => {
  const U = {};
  // MAIN-world catches stay silent: console output here is page-visible and
  // would reveal Static.

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
  // Patch helpers — replace a native method or accessor while keeping its
  // descriptor and a native-looking name/length/toString. `wrap` receives the
  // current implementation and returns an object holding the replacement as a
  // concise method keyed by the method name, or by `get` / `set` for accessors
  // (e.g. `(orig) => ({ fetch() {} })`). Concise methods have no own
  // `prototype` and are not constructible, like the natives they replace.
  // Each helper returns the replaced implementation, or null if there was none.
  // ======================================================================

  const disguise = (fn, original, name) =>
    U.stealth(fn, name, { length: original.length, source: U.nativeSourceFor(original, name) });

  U.wrapMethod = (owner, name, wrap) => {
    const desc = owner && Object.getOwnPropertyDescriptor(owner, name);
    const orig = desc && desc.value;
    if (typeof orig !== "function") return null;
    Object.defineProperty(owner, name, { ...desc, value: disguise(wrap(orig)[name], orig, name) });
    return orig;
  };

  const wrapAccessor = (kind) => (owner, prop, wrap) => {
    const desc = owner && Object.getOwnPropertyDescriptor(owner, prop);
    const orig = desc && desc[kind];
    if (typeof orig !== "function") return null;
    Object.defineProperty(owner, prop, {
      ...desc,
      [kind]: disguise(wrap(orig)[kind], orig, `${kind} ${prop}`),
    });
    return orig;
  };
  U.wrapGetter = wrapAccessor("get");
  U.wrapSetter = wrapAccessor("set");

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

  U.sanitizeExtensionPath = (path) => {
    if (typeof path !== "string" || !path) return "";
    let value = path.split("?")[0].split("#")[0].trim().toLowerCase();
    if (!value) return "";
    if (!value.startsWith("/")) value = `/${value}`;
    if (value.includes("\\") || value.includes("://") || value.includes("//")) return "";
    if (value.includes("/../") || value.endsWith("/..") || value.includes("/./")) return "";
    if (value.length > 96) value = value.slice(0, 96);
    if (!/^\/[a-z0-9._\-/]+$/.test(value)) return "";
    return value;
  };

  U.learnedDecoyKindForPath = (pathname) => {
    const path = U.sanitizeExtensionPath(pathname);
    if (!path) return null;
    if (path.endsWith("/manifest.json") || path === "/manifest.json") return "manifest";
    if (/\.(png|gif|jpe?g|svg)$/.test(path)) return "image";
    if (path.endsWith(".js") || path.endsWith(".mjs")) return "script";
    if (path.endsWith(".html") || path.endsWith(".htm")) return "html";
    if (path.endsWith(".css")) return "style";
    if (path.endsWith(".json")) return "json";
    if (path.endsWith(".txt") || path.endsWith(".md")) return "text";
    if (path.endsWith(".xml")) return "xml";
    return null;
  };

  // Noise-mode persona state for one MAIN-world script, fed by config_update
  // messages: which extension IDs to answer for and which learned WAR paths.
  U.noisePersona = () => {
    let enabled = false;
    let ids = new Set();
    let paths = new Map();
    return {
      update(data) {
        if (Array.isArray(data.persona)) {
          ids = new Set(data.persona.filter((id) => typeof id === "string"));
        }
        if (data.personaPaths && typeof data.personaPaths === "object") {
          paths = new Map();
          for (const [id, list] of Object.entries(data.personaPaths)) {
            if (!Array.isArray(list)) continue;
            const safeList = list.filter((path) => typeof path === "string");
            paths.set(id.toLowerCase(), new Set(safeList.map((path) => path.toLowerCase())));
          }
        } else if (Array.isArray(data.persona)) {
          paths = new Map();
        }
        if (typeof data.noiseEnabled === "boolean") enabled = data.noiseEnabled;
      },
      shouldDecoy(url) {
        if (!enabled) return false;
        const id = U.extractExtId(url);
        return id != null && ids.has(id);
      },
      isLearnedPath(url) {
        const id = U.extractExtId(url);
        const learned = id && paths.get(id);
        const pathname = learned && U.sanitizeExtensionPath(U.pathFor(url));
        return !!pathname && learned.has(pathname);
      },
    };
  };

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

  // Token lists of every `<meta http-equiv="content-security-policy">`
  // directive called `name`, with quotes stripped.
  const cspMetaDirectives = (name) => {
    const found = [];
    try {
      for (const meta of document.querySelectorAll("meta[http-equiv]")) {
        if (String(meta.httpEquiv || "").toLowerCase() !== "content-security-policy") continue;
        for (const directive of String(meta.content || "").split(";")) {
          const parts = directive.trim().split(/\s+/).filter(Boolean);
          if (String(parts.shift() || "").toLowerCase() !== name) continue;
          found.push(parts.map((part) => part.replace(/^'|'$/g, "")));
        }
      }
    } catch {}
    return found;
  };

  U.cspAllowsTrustedTypesPolicy = (policyName) =>
    cspMetaDirectives("trusted-types").every(
      (tokens) => !tokens.includes("none") && (tokens.includes("*") || tokens.includes(policyName))
    );

  U.cspRequiresTrustedTypes = () =>
    cspMetaDirectives("require-trusted-types-for").some((tokens) => tokens.includes("script"));

  // ======================================================================
  // Bridge setup — shared MessagePort init pattern used by most block scripts.
  //
  // Each block script creates its own bridge via setupBridge(eventName, maxQueue, onConfigUpdate).
  // Returns { post, probe } where:
  //   post(type, payload) — queues message until bridge connects, then forwards.
  //   probe(url, where)   — reports a blocked extension probe; never throws.
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

    const post = (type, payload) => {
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
    };

    return {
      post,
      probe: (url, where) => {
        try {
          post("probe_blocked", {
            url: url == null ? "" : String(url).slice(0, 512),
            where: where == null ? "" : String(where).slice(0, 64),
          });
        } catch {}
      },
    };
  };

  // Export on globalThis so subsequent MAIN-world scripts can access it.
  // configurable: true so block_globals.js (the last MAIN-world script) can
  // delete this global after every script has captured its own `U` reference,
  // leaving no enumerable-or-not trace for pages to find.
  try {
    Object.defineProperty(globalThis, "__static_block_utils__", {
      value: U,
      configurable: true,
      writable: false,
    });
  } catch {
    globalThis.__static_block_utils__ = U;
  }
})();
