/* eslint-disable max-lines, max-statements -- MAIN-world element decoy shims are safer kept contiguous */
// Static - MAIN-world passive element decoys for Noise-mode personas.
(() => {
  const BAD_RE = /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  const BAD_URL_RE = /\b(?:chrome|moz|ms-browser|safari-web|edge)-extension:[^\s"'()<>]+/i;
  const CHROME_EXT_ID_RE = /^[a-p]{32}$/;
  const BRIDGE_EVENT = "__static_element_decoy_bridge_init__";
  const PNG_1X1_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const IMAGE_DECOY_PATHS = [
    /(?:^|\/)(?:icon|logo|badge|action|browser_action|page_action)(?:[-_. ]?(?:\d{1,4}|small|medium|large|default))?\.(?:png|jpe?g|gif|webp|ico|bmp|svg)$/i,
    /(?:^|\/)(?:icons?|images?|img)\/(?:[^/]+\/)*(?:icon|logo|badge|action|browser_action|page_action)(?:[-_. ]?(?:\d{1,4}|small|medium|large|default))?\.(?:png|jpe?g|gif|webp|ico|bmp|svg)$/i,
    /(?:^|\/)(?:16|19|24|32|38|48|64|96|128|256|512)\.(?:png|jpe?g|gif|webp|ico|bmp|svg)$/i,
  ];
  const SCRIPT_DECOY_PATHS = [
    /(?:^|\/)(?:content(?:[-_. ]script)?|inject(?:ed)?|background(?:[-_. ]page)?|bundle|main|page|popup|options|index)(?:[-_. ]?[a-z0-9]+)?\.(?:m?js)$/i,
  ];
  const HTML_DECOY_PATHS = [
    /(?:^|\/)(?:page|popup|options|background|index)(?:[-_. ]?[a-z0-9]+)?\.(?:html|htm)$/i,
  ];
  const STYLE_DECOY_PATHS = [
    /(?:^|\/)(?:style|styles|content|popup|options|main|index)(?:[-_. ]?[a-z0-9]+)?\.css$/i,
  ];
  const queuedProbeEvents = [];
  const animatedHrefProxies = new WeakMap();
  const elementOriginals = new WeakMap();
  const MAX_QUEUED_PROBES = 1000;
  let bridgePort = null;
  let noiseEnabled = false;
  let persona = new Set();
  let nativeAttrValueGetter = null;
  let nativeAttrValueSetter = null;
  let nativeGetAttribute = null;

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

  const descriptorOwnerFor = (proto, prop) => {
    let cursor = proto;
    while (cursor) {
      const desc = Object.getOwnPropertyDescriptor(cursor, prop);
      if (desc) return { desc, owner: cursor };
      cursor = Object.getPrototypeOf(cursor);
    }
    return null;
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

  const normalizeUrlString = (value) => String(value).trim();

  const getUrl = (input) => {
    if (input == null) return "";
    if (typeof input === "string") return normalizeUrlString(input);
    if (typeof URL !== "undefined" && input instanceof URL) return input.href;
    if (typeof input.url === "string") return normalizeUrlString(input.url);
    try {
      return normalizeUrlString(input);
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
    if (!entry) return;
    delete entry[prop];
    if (prop === "srcset") delete entry.currentSrc;
  };

  const rememberedOriginal = (el, prop) => {
    const entry = elementOriginals.get(el);
    return entry && entry[prop];
  };

  const attrKeyFor = (name) => `attr:${String(name || "").toLowerCase()}`;

  const attrNsKeyFor = (ns, name) =>
    `attrns:${String(ns || "").toLowerCase()}:${attrLocalName(name)}`;

  const attrLocalName = (name) => {
    const normalized = String(name || "").toLowerCase();
    const colon = normalized.lastIndexOf(":");
    return colon === -1 ? normalized : normalized.slice(colon + 1);
  };

  const rememberAttributeOriginal = (el, name, url) => {
    rememberOriginal(el, attrKeyFor(name), url);
  };

  const rememberNamespacedAttributeOriginal = (el, ns, name, url) => {
    rememberAttributeOriginal(el, name, url);
    rememberOriginal(el, attrNsKeyFor(ns, name), url);
  };

  const forgetAttributeOriginal = (el, name) => {
    forgetOriginal(el, attrKeyFor(name));
  };

  const forgetNamespacedAttributeOriginal = (el, ns, name) => {
    forgetAttributeOriginal(el, name);
    forgetOriginal(el, attrNsKeyFor(ns, name));
  };

  const pathFor = (url) => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  };

  const matchesPathPattern = (pathname, patterns) =>
    patterns.some((pattern) => pattern.test(pathname));

  const imageDecoyPath = (pathname) => matchesPathPattern(pathname, IMAGE_DECOY_PATHS);
  const scriptDecoyPath = (pathname) => matchesPathPattern(pathname, SCRIPT_DECOY_PATHS);
  const htmlDecoyPath = (pathname) => matchesPathPattern(pathname, HTML_DECOY_PATHS);
  const styleDecoyPath = (pathname) => matchesPathPattern(pathname, STYLE_DECOY_PATHS);

  const passiveHrefDecoyKind = (tag, pathname) => {
    if (tag === "link") {
      if (styleDecoyPath(pathname)) return "style";
      if (imageDecoyPath(pathname)) return "image";
      if (scriptDecoyPath(pathname)) return "script";
      if (htmlDecoyPath(pathname)) return "html";
      return null;
    }
    if (tag === "use" || tag === "image") return imageDecoyPath(pathname) ? "image" : null;
    return null;
  };

  const passiveSrcDecoyKind = (tag, pathname) => {
    if (tag === "script") return scriptDecoyPath(pathname) ? "script" : null;
    if (tag === "img" || tag === "input" || tag === "source" || tag === "embed") {
      return imageDecoyPath(pathname) ? "image" : null;
    }
    return null;
  };

  const passiveDecoyKindFor = (url, prop, el) => {
    const pathname = pathFor(url);
    const tag = String((el && el.tagName) || "").toLowerCase();
    if (!pathname) return null;

    if (prop === "srcset" || prop === "poster") return imageDecoyPath(pathname) ? "image" : null;

    if (prop === "data" && tag === "object") return htmlDecoyPath(pathname) ? "html" : null;

    if (prop === "href") return passiveHrefDecoyKind(tag, pathname);

    if (prop === "src") return passiveSrcDecoyKind(tag, pathname);

    return null;
  };

  const decoyUrlFor = (kind, prop) => {
    if (kind === "image" && prop === "srcset") return `data:image/png;base64,${PNG_1X1_B64} 1x`;
    if (kind === "image") return `data:image/png;base64,${PNG_1X1_B64}`;
    if (kind === "script") return "data:application/javascript;charset=utf-8,";
    if (kind === "style") return "data:text/css,";
    if (kind === "html") return "data:text/html;charset=utf-8,<!doctype%20html>";
    return "data:text/plain,";
  };

  const blockedUrlFor = (prop) =>
    prop === "srcset" ? "data:image/png;base64,not-valid 1x" : "data:image/png;base64,not-valid";

  const canHandlePassiveElement = (el, prop) => {
    const tag = String((el && el.tagName) || "").toLowerCase();
    if (prop === "src") return ["img", "input", "script", "source", "embed"].includes(tag);
    if (prop === "srcset") return tag === "img" || tag === "source";
    if (prop === "href") return tag === "link" || tag === "use" || tag === "image";
    if (prop === "data") return tag === "object";
    if (prop === "poster") return tag === "video";
    return false;
  };

  const firstBadUrlInText = (value) => {
    try {
      const match = String(value == null ? "" : value).match(BAD_URL_RE);
      return match ? match[0] : "";
    } catch {
      return "";
    }
  };

  const probeUrlFor = (prop, value) => {
    if (prop === "srcset") return firstBadUrlInText(value);
    return isBad(value) ? getUrl(value) : "";
  };

  const elementProbe = (el, prop, value) => {
    const url = probeUrlFor(prop, value);
    if (!url || !canHandlePassiveElement(el, prop)) return null;
    const kind = passiveDecoyKindFor(url, prop, el);
    return { kind, mode: shouldDecoy(url) && kind ? "decoy" : "block", url };
  };

  const replacementUrlFor = (mode, kind, prop) => {
    if (mode === "decoy") return decoyUrlFor(kind, prop);
    return blockedUrlFor(prop);
  };

  const guardProp = (proto, prop, label) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    const setterHolder = {
      set [prop](value) {
        const probe = elementProbe(this, prop, value);
        if (probe) {
          const original = prop === "srcset" ? String(value) : probe.url;
          rememberOriginal(this, prop, original);
          if (prop === "srcset") rememberOriginal(this, "currentSrc", probe.url);
          postProbe(probe.url, probe.mode === "decoy" ? `${label}-decoy` : label);
          desc.set.call(this, replacementUrlFor(probe.mode, probe.kind, prop));
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
    const lower = attrLocalName(name);
    if (
      lower === "src" ||
      lower === "srcset" ||
      lower === "href" ||
      lower === "data" ||
      lower === "poster"
    ) {
      return lower;
    }
    return null;
  };

  const isAttrNode = (value) => typeof Attr !== "undefined" && value instanceof Attr;

  const nativeAttrValueFor = (attr) => {
    try {
      if (nativeAttrValueGetter) return nativeAttrValueGetter.call(attr);
      return attr.value;
    } catch {
      return "";
    }
  };

  const setNativeAttrValue = (attr, value) => {
    try {
      if (nativeAttrValueSetter) {
        nativeAttrValueSetter.call(attr, value);
        return;
      }
      attr.value = value;
    } catch {}
  };

  const attrOriginalFor = (attr) => {
    if (!isAttrNode(attr) || !attr.ownerElement) return "";
    const name = attr.name || attr.localName;
    const ns = attr.namespaceURI;
    if (ns) {
      const nsOriginal = rememberedOriginal(attr.ownerElement, attrNsKeyFor(ns, name));
      if (nsOriginal) return nsOriginal;
    }
    const attrOriginal = rememberedOriginal(attr.ownerElement, attrKeyFor(name));
    if (attrOriginal) return attrOriginal;
    const prop = attrPropFor(name);
    return prop ? rememberedOriginal(attr.ownerElement, prop) || "" : "";
  };

  const rememberAttrProbe = ({
    attr,
    el,
    label,
    probe,
    prop,
    value = nativeAttrValueFor(attr),
  }) => {
    const original = prop === "srcset" ? String(value) : probe.url;
    rememberOriginal(el, prop, original);
    rememberAttributeOriginal(el, attr.name || attr.localName, original);
    if (attr.namespaceURI) {
      rememberNamespacedAttributeOriginal(
        el,
        attr.namespaceURI,
        attr.name || attr.localName,
        original
      );
    }
    if (prop === "srcset") rememberOriginal(el, "currentSrc", probe.url);
    postProbe(probe.url, probe.mode === "decoy" ? `${label}-${prop}-decoy` : label);
    setNativeAttrValue(attr, replacementUrlFor(probe.mode, probe.kind, prop));
  };

  const applyAttrValueProbe = (attr, value, label) => {
    if (!isAttrNode(attr) || !attr.ownerElement) return false;
    const prop = attrPropFor(attr.name || attr.localName);
    const probe = prop && elementProbe(attr.ownerElement, prop, value);
    if (!probe) {
      if (prop) {
        forgetOriginal(attr.ownerElement, prop);
        forgetAttributeOriginal(attr.ownerElement, attr.name || attr.localName);
        if (attr.namespaceURI) {
          forgetNamespacedAttributeOriginal(attr.ownerElement, attr.namespaceURI, attr.name);
        }
      }
      return false;
    }
    rememberAttrProbe({ attr, el: attr.ownerElement, label, probe, prop, value });
    return true;
  };

  const attributeNodeProbe = (el, attr) => {
    if (!isAttrNode(attr)) return null;
    const prop = attrPropFor(attr.name || attr.localName);
    const probe = prop && elementProbe(el, prop, nativeAttrValueFor(attr));
    return probe ? { probe, prop } : null;
  };

  const patchAttrValueProperty = (proto, prop) => {
    const found = descriptorOwnerFor(proto, prop);
    const desc = found && found.desc;
    if (!desc || !desc.get) return;
    if (prop === "value") {
      nativeAttrValueGetter = desc.get;
      nativeAttrValueSetter = desc.set;
    }
    const getterHolder = {
      get [prop]() {
        return attrOriginalFor(this) || desc.get.call(this);
      },
    };
    const wrappedGet = Object.getOwnPropertyDescriptor(getterHolder, prop).get;
    const setterHolder = {
      set [prop](value) {
        if (applyAttrValueProbe(this, value, `attr.${prop}`)) return;
        desc.set.call(this, value);
      },
    };
    const wrappedSet = desc.set ? Object.getOwnPropertyDescriptor(setterHolder, prop).set : desc.set;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: stealth(wrappedGet, `get ${prop}`, {
        length: 0,
        source: nativeSourceFor(desc.get, `get ${prop}`),
      }),
      set: desc.set
        ? stealth(wrappedSet, `set ${prop}`, {
            length: 1,
            source: nativeSourceFor(desc.set, `set ${prop}`),
          })
        : desc.set,
    });
  };

  const patchAttrValues = () => {
    if (typeof Attr === "undefined" || !Attr.prototype) return;
    for (const prop of ["value", "nodeValue", "textContent"]) {
      patchAttrValueProperty(Attr.prototype, prop);
    }
  };

  const copyOriginalsForClone = (source, clone) => {
    const entry = elementOriginals.get(source);
    if (entry && clone) elementOriginals.set(clone, { ...entry });
  };

  const copyOriginalTreeForClone = (source, clone) => {
    if (!source || !clone) return;
    if (source.nodeType === Node.ELEMENT_NODE) copyOriginalsForClone(source, clone);
    let sourceChild = source.firstChild;
    let cloneChild = clone.firstChild;
    while (sourceChild && cloneChild) {
      copyOriginalTreeForClone(sourceChild, cloneChild);
      sourceChild = sourceChild.nextSibling;
      cloneChild = cloneChild.nextSibling;
    }
  };

  const patchCloneNode = () => {
    const desc = Object.getOwnPropertyDescriptor(Node.prototype, "cloneNode");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      cloneNode() {
        const clone = orig.apply(this, arguments);
        copyOriginalTreeForClone(this, clone);
        return clone;
      },
    }.cloneNode;
    Object.defineProperty(Node.prototype, "cloneNode", {
      ...desc,
      value: stealth(wrapped, "cloneNode", {
        length: orig.length,
        source: nativeSourceFor(orig, "cloneNode"),
      }),
    });
  };

  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const escapeSerializedAttr = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/\u00a0/g, "&nbsp;")
      .replace(/"/g, "&quot;");

  const replaceSerializedAttrOnce = (html, name, nativeValue, originalValue) => {
    const nativeEscaped = escapeSerializedAttr(nativeValue);
    if (!nativeEscaped || !html.includes(nativeEscaped)) return html;
    const pattern = new RegExp(
      `(\\s${escapeRegExp(String(name).toLowerCase())}\\s*=\\s*")${escapeRegExp(
        nativeEscaped
      )}(")`,
      "i"
    );
    return html.replace(pattern, `$1${escapeSerializedAttr(originalValue)}$2`);
  };

  const serializedAttrEntriesFor = (el) => {
    const entry = elementOriginals.get(el);
    if (!entry || !nativeGetAttribute) return [];
    const entries = [];
    const seen = new Set();
    const push = (name, original) => {
      const safeName = String(name || "").toLowerCase();
      if (!safeName || seen.has(safeName)) return;
      const nativeValue = nativeGetAttribute.call(el, safeName);
      if (nativeValue == null || String(nativeValue) === String(original)) return;
      seen.add(safeName);
      entries.push({ name: safeName, nativeValue, original });
    };

    for (const [key, original] of Object.entries(entry)) {
      if (key.startsWith("attr:")) push(key.slice("attr:".length), original);
    }
    for (const prop of ["src", "srcset", "href", "data", "poster"]) {
      if (entry[prop]) push(prop, entry[prop]);
    }
    return entries;
  };

  const applySerializedOriginalsFor = (el, html) => {
    let nextHtml = html;
    for (const entry of serializedAttrEntriesFor(el)) {
      nextHtml = replaceSerializedAttrOnce(
        nextHtml,
        entry.name,
        entry.nativeValue,
        entry.original
      );
    }
    return nextHtml;
  };

  const serializeWithOriginals = (root, html, includeRoot = true) => {
    let nextHtml = String(html);
    const visit = (node, includeNode) => {
      if (!node) return;
      if (includeNode && node.nodeType === Node.ELEMENT_NODE) {
        nextHtml = applySerializedOriginalsFor(node, nextHtml);
      }
      for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
        visit(child, true);
      }
    };
    visit(root, includeRoot);
    return nextHtml;
  };

  const patchHtmlSerialization = () => {
    const innerDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    const outerDesc = Object.getOwnPropertyDescriptor(Element.prototype, "outerHTML");
    if (innerDesc && innerDesc.get) {
      const innerGetterHolder = {
        get innerHTML() {
          return serializeWithOriginals(this, innerDesc.get.call(this), false);
        },
      };
      Object.defineProperty(Element.prototype, "innerHTML", {
        configurable: true,
        enumerable: innerDesc.enumerable,
        get: stealth(Object.getOwnPropertyDescriptor(innerGetterHolder, "innerHTML").get, "get innerHTML", {
          length: 0,
          source: nativeSourceFor(innerDesc.get, "get innerHTML"),
        }),
        set: innerDesc.set,
      });
    }
    if (outerDesc && outerDesc.get) {
      const outerGetterHolder = {
        get outerHTML() {
          return serializeWithOriginals(this, outerDesc.get.call(this), true);
        },
      };
      Object.defineProperty(Element.prototype, "outerHTML", {
        configurable: true,
        enumerable: outerDesc.enumerable,
        get: stealth(Object.getOwnPropertyDescriptor(outerGetterHolder, "outerHTML").get, "get outerHTML", {
          length: 0,
          source: nativeSourceFor(outerDesc.get, "get outerHTML"),
        }),
        set: outerDesc.set,
      });
    }
  };

  const patchXmlSerializer = () => {
    if (typeof XMLSerializer === "undefined" || !XMLSerializer.prototype) return;
    const desc = Object.getOwnPropertyDescriptor(XMLSerializer.prototype, "serializeToString");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      serializeToString(node) {
        return serializeWithOriginals(node, orig.apply(this, arguments), true);
      },
    }.serializeToString;
    Object.defineProperty(XMLSerializer.prototype, "serializeToString", {
      ...desc,
      value: stealth(wrapped, "serializeToString", {
        length: orig.length,
        source: nativeSourceFor(orig, "serializeToString"),
      }),
    });
  };

  const patchAttributes = () => {
    const origSetAttribute = Element.prototype.setAttribute;
    const origSetAttributeNS = Element.prototype.setAttributeNS;
    const origGetAttribute = Element.prototype.getAttribute;
    const origGetAttributeNS = Element.prototype.getAttributeNS;
    const origRemoveAttribute = Element.prototype.removeAttribute;
    const origRemoveAttributeNS = Element.prototype.removeAttributeNS;
    nativeGetAttribute = origGetAttribute;
    const wrapped = {
      setAttribute(name, value) {
        const prop = attrPropFor(name);
        const probe = prop && elementProbe(this, prop, value);
        if (probe) {
          const original = prop === "srcset" ? String(value) : probe.url;
          rememberOriginal(this, prop, original);
          rememberAttributeOriginal(this, name, original);
          if (prop === "srcset") rememberOriginal(this, "currentSrc", probe.url);
          postProbe(
            probe.url,
            probe.mode === "decoy" ? `setAttribute-${prop}-decoy` : "setAttribute"
          );
          return origSetAttribute.call(this, name, replacementUrlFor(probe.mode, probe.kind, prop));
        }
        if (prop) {
          forgetOriginal(this, prop);
          forgetAttributeOriginal(this, name);
        }
        return origSetAttribute.apply(this, arguments);
      },
      setAttributeNS(ns, name, value) {
        const prop = attrPropFor(name);
        const probe = prop && elementProbe(this, prop, value);
        if (probe) {
          const original = prop === "srcset" ? String(value) : probe.url;
          rememberOriginal(this, prop, original);
          rememberNamespacedAttributeOriginal(this, ns, name, original);
          if (prop === "srcset") rememberOriginal(this, "currentSrc", probe.url);
          postProbe(
            probe.url,
            probe.mode === "decoy" ? `setAttributeNS-${prop}-decoy` : "setAttributeNS"
          );
          return origSetAttributeNS.call(
            this,
            ns,
            name,
            replacementUrlFor(probe.mode, probe.kind, prop)
          );
        }
        if (prop) {
          forgetOriginal(this, prop);
          forgetNamespacedAttributeOriginal(this, ns, name);
        }
        return origSetAttributeNS.apply(this, arguments);
      },
      getAttribute(name) {
        const prop = attrPropFor(name);
        const attrOriginal = rememberedOriginal(this, attrKeyFor(name));
        if (attrOriginal) return attrOriginal;
        const nativeValue = origGetAttribute.apply(this, arguments);
        const propOriginal = prop && rememberedOriginal(this, prop);
        return propOriginal && nativeValue != null ? propOriginal : nativeValue;
      },
      getAttributeNS(ns, name) {
        const prop = attrPropFor(name);
        const attrOriginal = rememberedOriginal(this, attrNsKeyFor(ns, name));
        if (attrOriginal) return attrOriginal;
        const nativeValue = origGetAttributeNS.apply(this, arguments);
        const propOriginal = prop && rememberedOriginal(this, prop);
        return propOriginal && nativeValue != null ? propOriginal : nativeValue;
      },
      removeAttribute(name) {
        const prop = attrPropFor(name);
        if (prop) {
          forgetOriginal(this, prop);
          forgetAttributeOriginal(this, name);
        }
        return origRemoveAttribute.apply(this, arguments);
      },
      removeAttributeNS(ns, name) {
        const prop = attrPropFor(name);
        if (prop) {
          forgetOriginal(this, prop);
          forgetNamespacedAttributeOriginal(this, ns, name);
        }
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

  const patchAttributeNodes = () => {
    const origSetAttributeNode = Element.prototype.setAttributeNode;
    const origSetAttributeNodeNS = Element.prototype.setAttributeNodeNS;
    const wrapped = {
      setAttributeNode(attr) {
        const found = attributeNodeProbe(this, attr);
        if (found) {
          rememberAttrProbe({
            attr,
            el: this,
            label: "setAttributeNode",
            probe: found.probe,
            prop: found.prop,
          });
        }
        return origSetAttributeNode.apply(this, arguments);
      },
      setAttributeNodeNS(attr) {
        const found = attributeNodeProbe(this, attr);
        if (found) {
          rememberAttrProbe({
            attr,
            el: this,
            label: "setAttributeNodeNS",
            probe: found.probe,
            prop: found.prop,
          });
        }
        return origSetAttributeNodeNS.apply(this, arguments);
      },
    };
    if (typeof origSetAttributeNode === "function") {
      Element.prototype.setAttributeNode = stealth(wrapped.setAttributeNode, "setAttributeNode", {
        length: 1,
      });
    }
    if (typeof origSetAttributeNodeNS === "function") {
      Element.prototype.setAttributeNodeNS = stealth(
        wrapped.setAttributeNodeNS,
        "setAttributeNodeNS",
        { length: 1 }
      );
    }
  };

  const patchCurrentSrc = () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "currentSrc");
    if (!desc || !desc.get) return;
    Object.defineProperty(HTMLImageElement.prototype, "currentSrc", {
      configurable: true,
      enumerable: desc.enumerable,
      get: stealth(
        function get() {
          return (
            rememberedOriginal(this, "currentSrc") ||
            rememberedOriginal(this, "src") ||
            desc.get.call(this)
          );
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

  const svgHrefProbe = (el, value) => {
    const url = isBad(value) ? getUrl(value) : "";
    if (!url) return null;
    const kind = passiveDecoyKindFor(url, "href", el);
    return { kind, mode: shouldDecoy(url) && kind ? "decoy" : "block", url };
  };

  const animatedHrefProxyFor = (el, animated, label) => {
    const cached = animatedHrefProxies.get(animated);
    if (cached) return cached;
    const proxy = new Proxy(animated, {
      get(target, prop) {
        if (prop === "baseVal" || prop === "animVal") {
          return rememberedOriginal(el, "href") || target[prop];
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, prop, value) {
        if (prop !== "baseVal") {
          return Reflect.set(target, prop, value);
        }
        const probe = svgHrefProbe(el, value);
        if (probe) {
          rememberOriginal(el, "href", probe.url);
          rememberAttributeOriginal(el, "href", probe.url);
          postProbe(probe.url, probe.mode === "decoy" ? `${label}-decoy` : label);
          target.baseVal = replacementUrlFor(probe.mode, probe.kind, "href");
          return true;
        }
        forgetOriginal(el, "href");
        forgetAttributeOriginal(el, "href");
        target.baseVal = value;
        return true;
      },
    });
    animatedHrefProxies.set(animated, proxy);
    return proxy;
  };

  const patchSvgHref = (Ctor, label) => {
    const proto = Ctor && Ctor.prototype;
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, "href");
    if (!desc || !desc.get) return;
    Object.defineProperty(proto, "href", {
      configurable: true,
      enumerable: desc.enumerable,
      get: stealth(
        function get() {
          const animated = desc.get.call(this);
          return animated && typeof animated === "object"
            ? animatedHrefProxyFor(this, animated, label)
            : animated;
        },
        "get href",
        { length: 0, source: nativeSourceFor(desc.get, "get href") }
      ),
    });
  };

  patchAttrValues();
  patchCloneNode();
  guardProp(HTMLImageElement.prototype, "src", "img.src");
  guardProp(HTMLImageElement.prototype, "srcset", "img.srcset");
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
    guardProp(HTMLSourceElement.prototype, "srcset", "source.srcset");
  }
  if (typeof HTMLEmbedElement !== "undefined") {
    guardProp(HTMLEmbedElement.prototype, "src", "embed.src");
  }
  if (typeof HTMLObjectElement !== "undefined") {
    guardProp(HTMLObjectElement.prototype, "data", "object.data");
  }
  patchAttributes();
  patchAttributeNodes();
  patchHtmlSerialization();
  patchXmlSerializer();
  patchCurrentSrc();
  patchStyleSheetHref();
  if (typeof SVGUseElement !== "undefined") patchSvgHref(SVGUseElement, "svg.use.href");
  if (typeof SVGImageElement !== "undefined") patchSvgHref(SVGImageElement, "svg.image.href");
  if (typeof SVGScriptElement !== "undefined") patchSvgHref(SVGScriptElement, "svg.script.href");
})();
