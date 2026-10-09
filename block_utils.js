/* eslint-disable max-lines, max-statements -- shared readers (URLs, CSS, HTML sinks) stay in one place so every MAIN-world script reads values the same way */
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

  const withoutTabsOrNewlines = (value) => String(value).replace(/[\t\n\r]/g, "");

  // Read a URL string the way the URL parser does: it drops every ASCII tab
  // and newline and strips C0 controls and spaces from both ends.
  U.normalizeUrlString = (value) => {
    const text = withoutTabsOrNewlines(value);
    let start = 0;
    let end = text.length;
    while (start < end && text.charCodeAt(start) <= 0x20) start++;
    while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
    return text.slice(start, end);
  };

  // Request's own URL getter brand-checks its receiver, so it also reads
  // Requests from other frames and rejects look-alike objects.
  let requestUrlGetter = null;
  try {
    requestUrlGetter = Object.getOwnPropertyDescriptor(Request.prototype, "url").get;
  } catch {}

  U.getUrl = (input) => {
    if (input == null) return "";
    if (typeof input === "string") return U.normalizeUrlString(input);
    if (typeof URL !== "undefined" && input instanceof URL) return input.href;
    if (requestUrlGetter) {
      try {
        return requestUrlGetter.call(input);
      } catch {}
    }
    // Anything else is stringified, as the browser does.
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
      const match = withoutTabsOrNewlines(input == null ? "" : input).match(U.BAD_URL_RE);
      return match ? match[0] : "";
    } catch {
      return "";
    }
  };

  // Every extension scheme ends in "extension:", which the URL parser still
  // reads through tabs and newlines; text without it can name none.
  const EXTENSION_TAIL_RE =
    /e[\t\n\r]*x[\t\n\r]*t[\t\n\r]*e[\t\n\r]*n[\t\n\r]*s[\t\n\r]*i[\t\n\r]*o[\t\n\r]*n[\t\n\r]*:/i;

  // Whether text (markup, a list of URLs) mentions an extension URL anywhere.
  U.hasBadUrl = (text) => {
    const value = String(text == null ? "" : text);
    return EXTENSION_TAIL_RE.test(value) && U.BAD_URL_RE.test(withoutTabsOrNewlines(value));
  };

  // ======================================================================
  // CSS — only string and url() tokens make the browser load anything, and
  // the CSS parser decodes escapes in them (and in function names) before
  // the URL parser sees the value. U.sanitizeCssText neutralizes just those
  // tokens, so CSS that mentions an extension URL keeps every other rule.
  // ======================================================================

  const CSS_INERT_URL = "about:invalid";
  const isCssNewline = (ch) => ch === "\n" || ch === "\r" || ch === "\f";
  const isCssWhitespace = (ch) => ch === " " || ch === "\t" || isCssNewline(ch);
  const isCssNameChar = (ch) => /[\w-]/.test(ch) || ch.charCodeAt(0) >= 0x80;
  const startsCssEscape = (text, i) =>
    text[i] === "\\" && i + 1 < text.length && !isCssNewline(text[i + 1]);

  const decodeCssHex = (hex) => {
    const code = parseInt(hex, 16);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : "\ufffd";
  };

  // CSS Syntax "consume an escaped code point"; text[i] is the backslash.
  const consumeCssEscape = (text, i) => {
    const hex = /^[\da-f]{1,6}/i.exec(text.slice(i + 1, i + 7));
    if (!hex) return [text[i + 1], i + 2];
    let next = i + 1 + hex[0].length;
    if (text[next] === "\r" && text[next + 1] === "\n") next += 2;
    else if (isCssWhitespace(text[next] || "")) next += 1;
    return [decodeCssHex(hex[0]), next];
  };

  // CSS text with every escape decoded (escaped newlines dropped), to look
  // for what the CSS parser will read without tokenizing it.
  const CSS_ESCAPE_RE = /\\(?:([\da-f]{1,6})(?:\r\n|[ \t\n\r\f])?|([^\n\r\f])|[\n\r\f])/gi;
  U.cssUnescape = (text) =>
    String(text).replace(CSS_ESCAPE_RE, (match, hex, char) =>
      hex ? decodeCssHex(hex) : char || ""
    );

  // A quoted string's value; it ends at the closing quote or, unclosed, at a newline.
  const consumeCssString = (text, start) => {
    let value = "";
    let i = start + 1;
    while (i < text.length && text[i] !== text[start] && !isCssNewline(text[i])) {
      if (text[i] !== "\\") {
        value += text[i++];
      } else if (startsCssEscape(text, i)) {
        const [decoded, next] = consumeCssEscape(text, i);
        value += decoded;
        i = next;
      } else {
        // An escaped newline continues the string; a trailing backslash is dropped.
        i += text[i + 1] === "\r" && text[i + 2] === "\n" ? 3 : 2;
      }
    }
    return [value, text[i] === text[start] ? i + 1 : i];
  };

  const consumeCssName = (text, start) => {
    let name = "";
    let i = start;
    while (i < text.length) {
      if (isCssNameChar(text[i])) {
        name += text[i++];
      } else if (startsCssEscape(text, i)) {
        const [decoded, next] = consumeCssEscape(text, i);
        name += decoded;
        i = next;
      } else {
        break;
      }
    }
    return [name, i];
  };

  // An unquoted url(...) value; whitespace may only trail it.
  const consumeCssUrl = (text, start) => {
    let value = "";
    let ended = false;
    let i = start;
    while (i < text.length && text[i] !== ")") {
      if (!ended && startsCssEscape(text, i)) {
        const [decoded, next] = consumeCssEscape(text, i);
        value += decoded;
        i = next;
        continue;
      }
      if (isCssWhitespace(text[i])) ended = true;
      else if (!ended) value += text[i];
      i++;
    }
    return [value, Math.min(i + 1, text.length)];
  };

  // At a name: where an unquoted url(...) token ends and its value, or where
  // the name ends. url("…") stops at its string, which the caller reads next.
  const consumeCssNameToken = (text, start) => {
    const [name, end] = consumeCssName(text, start);
    if (name.toLowerCase() !== "url" || text[end] !== "(") return { end };
    let valueStart = end + 1;
    while (isCssWhitespace(text[valueStart] || "")) valueStart++;
    if (text[valueStart] === '"' || text[valueStart] === "'") return { end: valueStart };
    const [value, urlEnd] = consumeCssUrl(text, valueStart);
    return { end: urlEnd, value };
  };

  let lastCleanCss = "";

  // { text, url }: the CSS with each string or url() token that resolves to
  // an extension URL replaced by an inert one, and the first such URL ("" if none).
  U.sanitizeCssText = (input) => {
    const text = String(input == null ? "" : input);
    // Most CSS names no extension scheme even with its escapes decoded: skip
    // the tokenizer then, and for the text just found clean (style text is
    // checked by its setter, on insertion, and again by the observer).
    if (text === lastCleanCss) return { text, url: "" };
    if (!U.hasBadUrl(text.includes("\\") ? U.cssUnescape(text) : text)) {
      lastCleanCss = text;
      return { text, url: "" };
    }
    let out = "";
    let copied = 0;
    let url = "";
    const neutralize = (start, end, replacement, value) => {
      if (!U.isBad(value)) return;
      out += text.slice(copied, start) + replacement;
      copied = end;
      url ||= U.getUrl(value);
    };
    let i = 0;
    while (i < text.length) {
      const start = i;
      if (text.startsWith("/*", i)) {
        const close = text.indexOf("*/", i + 2);
        i = close === -1 ? text.length : close + 2;
      } else if (text[i] === '"' || text[i] === "'") {
        const [value, end] = consumeCssString(text, i);
        neutralize(start, end, `"${CSS_INERT_URL}"`, value);
        i = end;
      } else if (isCssNameChar(text[i]) || startsCssEscape(text, i)) {
        const token = consumeCssNameToken(text, i);
        if (token.value !== undefined) {
          neutralize(start, token.end, `url(${CSS_INERT_URL})`, token.value);
        }
        i = token.end;
      } else {
        i++;
      }
    }
    if (!url) lastCleanCss = text;
    return url ? { text: out + text.slice(copied), url } : { text, url: "" };
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

  // ======================================================================
  // HTML sinks — innerHTML / outerHTML / insertAdjacentHTML take TrustedHTML
  // or a string. Wrappers read the markup the way the sink converts it and
  // hand the page's own value on unless they change the markup, so pages
  // keep enforcing their own Trusted Types policies.
  // ======================================================================

  let trustedHtmlPolicy = null;
  let isTrustedHtml = () => false;
  let trustedHtmlText = null;
  try {
    const factory = globalThis.trustedTypes;
    isTrustedHtml = factory.isHTML.bind(factory);
    trustedHtmlText = TrustedHTML.prototype.toString;
    // Created at document_start: header CSP applies, a later <meta> allow-list does not.
    if (U.cspAllowsTrustedTypesPolicy("staticBlockIframeAttrs")) {
      trustedHtmlPolicy = factory.createPolicy("staticBlockIframeAttrs", {
        createHTML: (html) => html,
      });
    }
  } catch {}

  // TrustedHTML from Static's own policy, or null when the page's CSP forbids it.
  U.trustedHtml = (html) => {
    try {
      return trustedHtmlPolicy ? trustedHtmlPolicy.createHTML(html) : null;
    } catch {
      return null;
    }
  };

  // The markup a sink reads from value: TrustedHTML keeps its own text, the
  // [LegacyNullToEmptyString] properties read null as "", and anything else
  // is stringified once (a Symbol throws, as it does natively).
  U.htmlSinkText = (value, nullIsEmpty) => {
    if (value === null && nullIsEmpty) return "";
    if (trustedHtmlText && isTrustedHtml(value)) return trustedHtmlText.call(value);
    return `${value}`;
  };

  // What a wrapper hands on after reading text from value and producing next:
  // the page's own value when nothing changed; otherwise next, re-created as
  // TrustedHTML when the page passed TrustedHTML. Without a Static policy a
  // cosmetic change is dropped (the page's value goes on) and a blocking one
  // goes on as a string: accepted unless the page enforces Trusted Types.
  // Changed strings stay strings, and objects become the string already read
  // so their toString() runs once.
  U.htmlSinkValue = (value, text, next, cosmetic = false) => {
    if (trustedHtmlText && isTrustedHtml(value)) {
      if (next === text) return value;
      return U.trustedHtml(next) || (cosmetic ? value : next);
    }
    if (next === text && (value === null || typeof value === "string")) return value;
    return next;
  };

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
