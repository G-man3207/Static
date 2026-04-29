/* eslint-disable max-lines, max-statements -- MAIN-world element decoy shims are safer kept contiguous */
// Static - MAIN-world passive element decoys for Noise-mode personas.
(() => {
  const BAD_RE = /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  const BAD_URL_RE = /\b(?:chrome|moz|ms-browser|safari-web|edge)-extension:[^\s"'()<>]+/i;
  const CHROME_EXT_ID_RE = /^[a-p]{32}$/;
  const BRIDGE_EVENT = "__static_element_decoy_bridge_init__";
  const PNG_1X1_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const PNG_1X1_BINARY = atob(PNG_1X1_B64);
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
  const attrNodeOriginals = new WeakMap();
  const elementOriginals = new WeakMap();
  const mutationOldValueOriginals = new WeakMap();
  const MAX_QUEUED_PROBES = 1000;
  let bridgePort = null;
  let noiseEnabled = false;
  let persona = new Set();
  let nativeAttrValueGetter = null;
  let nativeAttrValueSetter = null;
  let nativeGetAttribute = null;
  let nativeGetAttributeNS = null;
  let trustedScriptUrlPolicy = undefined;

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

  const alignPrototypeConstructor = (wrapped, original) => {
    try {
      const proto = original && original.prototype;
      if (!proto) return;
      const desc = Object.getOwnPropertyDescriptor(proto, "constructor") || {
        configurable: true,
        enumerable: false,
        writable: true,
      };
      Object.defineProperty(proto, "constructor", {
        ...desc,
        value: wrapped,
      });
    } catch {}
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

  const rememberAttrNodeOriginal = (attr, original) => {
    if (isAttrNode(attr)) attrNodeOriginals.set(attr, String(original));
  };

  const forgetAttrNodeOriginal = (attr) => {
    if (isAttrNode(attr)) attrNodeOriginals.delete(attr);
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

  const attrNodeFor = (el, name, ns = null) => {
    try {
      if (!el) return null;
      if (ns) return el.getAttributeNodeNS(ns, attrLocalName(name));
      return el.getAttributeNode(name);
    } catch {
      return null;
    }
  };

  const rememberElementAttrNodeOriginal = (el, name, original, ns = null) => {
    rememberAttrNodeOriginal(attrNodeFor(el, name, ns), original);
  };

  const rememberCurrentAttrNodeOriginal = (el, name, ns = null) => {
    const original =
      (ns && rememberedOriginal(el, attrNsKeyFor(ns, name))) ||
      rememberedOriginal(el, attrKeyFor(name)) ||
      rememberedOriginal(el, attrPropFor(name));
    if (original) rememberElementAttrNodeOriginal(el, name, original, ns);
  };

  const forgetAttributeOriginal = (el, name) => {
    forgetOriginal(el, attrKeyFor(name));
  };

  const forgetNamespacedAttributeOriginal = (el, ns, name) => {
    forgetAttributeOriginal(el, name);
    forgetOriginal(el, attrNsKeyFor(ns, name));
  };

  const forgetElementAttrNodeOriginal = (el, name, ns = null) => {
    forgetAttrNodeOriginal(attrNodeFor(el, name, ns));
  };

  const mutationAttrKeyFor = (ns, name) =>
    `${String(ns || "").toLowerCase()}:${attrLocalName(name)}`;

  const nativeElementAttrValueFor = (el, name, ns = null) => {
    try {
      if (ns && nativeGetAttributeNS) return nativeGetAttributeNS.call(el, ns, attrLocalName(name));
      if (nativeGetAttribute) return nativeGetAttribute.call(el, name);
      return el && typeof el.getAttribute === "function" ? el.getAttribute(name) : null;
    } catch {
      return null;
    }
  };

  const rememberMutationOldValueOriginal = ({ el, name, nativeValue, ns, original }) => {
    if (!el || nativeValue == null) return;
    const key = mutationAttrKeyFor(ns, name);
    let originals = mutationOldValueOriginals.get(el);
    if (!originals) {
      originals = new Map();
      mutationOldValueOriginals.set(el, originals);
    }
    originals.set(`${key}\n${String(nativeValue)}`, String(original));
  };

  const rememberNativeMutationValue = (el, name, ns, original) => {
    rememberMutationOldValueOriginal({
      el,
      name,
      nativeValue: nativeElementAttrValueFor(el, name, ns),
      ns,
      original,
    });
  };

  const originalMutationOldValueFor = (record) => {
    if (!record || record.type !== "attributes" || record.oldValue == null) return null;
    const originals = mutationOldValueOriginals.get(record.target);
    if (!originals) return null;
    const key = mutationAttrKeyFor(record.attributeNamespace, record.attributeName);
    return originals.get(`${key}\n${String(record.oldValue)}`) || null;
  };

  const mutationRecordForPage = (record) => {
    const originalOldValue = originalMutationOldValueFor(record);
    if (!originalOldValue) return record;
    return new Proxy(record, {
      get(target, prop) {
        if (prop === "oldValue") return originalOldValue;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  const mutationRecordsForPage = (records) => {
    let filtered = null;
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const nextRecord = mutationRecordForPage(record);
      if (nextRecord !== record && !filtered) {
        filtered = Array.prototype.slice.call(records, 0, index);
      }
      if (filtered) filtered.push(nextRecord);
    }
    return filtered || records;
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

  const replacementTokenFor = (value) => {
    let hash = 0x811c9dc5;
    const text = String(value || "");
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  };

  const pngDataUrlFor = (original) => {
    const token = `static:${replacementTokenFor(original)}`;
    let binary = PNG_1X1_BINARY;
    for (let index = 0; index < token.length; index++) {
      binary += String.fromCharCode(token.charCodeAt(index) & 0xff);
    }
    return `data:image/png;base64,${btoa(binary)}`;
  };

  const textDataUrlFor = (mime, body) => `data:${mime},${encodeURIComponent(body)}`;

  const decoyUrlFor = (kind, prop, original) => {
    if (kind === "image" && prop === "srcset") {
      return `${pngDataUrlFor(original)} 1x`;
    }
    if (kind === "image") return pngDataUrlFor(original);
    if (kind === "script") {
      return textDataUrlFor(
        "application/javascript;charset=utf-8",
        `/* static:${replacementTokenFor(original)} */`
      );
    }
    if (kind === "style") {
      return textDataUrlFor("text/css", `/* static:${replacementTokenFor(original)} */`);
    }
    if (kind === "html") {
      return textDataUrlFor(
        "text/html;charset=utf-8",
        `<!doctype html><!-- static:${replacementTokenFor(original)} -->`
      );
    }
    return textDataUrlFor("text/plain", `static:${replacementTokenFor(original)}`);
  };

  const blockedUrlFor = (prop, original) => {
    const url = `data:image/png;base64,not-valid-${replacementTokenFor(original)}`;
    return prop === "srcset" ? `${url} 1x` : url;
  };

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

  const replacementUrlFor = (mode, kind, prop, original) => {
    if (mode === "decoy") return decoyUrlFor(kind, prop, original);
    return blockedUrlFor(prop, original);
  };

  const isScriptSrcSink = (el, prop) =>
    prop === "src" && typeof HTMLScriptElement !== "undefined" && el instanceof HTMLScriptElement;

  const cspTrustedTypesAllowsPolicy = (policyName) => {
    try {
      for (const meta of document.querySelectorAll("meta[http-equiv]")) {
        if (String(meta.httpEquiv || "").toLowerCase() !== "content-security-policy") continue;
        const directives = String(meta.content || "").split(";");
        for (const directive of directives) {
          const parts = directive.trim().split(/\s+/).filter(Boolean);
          if (String(parts.shift() || "").toLowerCase() !== "trusted-types") continue;
          const tokens = parts.map((part) => part.replace(/^'|'$/g, ""));
          if (tokens.includes("none")) return false;
          if (!tokens.includes("*") && !tokens.includes(policyName)) return false;
        }
      }
    } catch {}
    return true;
  };

  const trustedPolicyForScriptUrls = () => {
    if (!globalThis.trustedTypes || typeof globalThis.trustedTypes.createPolicy !== "function") {
      return null;
    }
    if (trustedScriptUrlPolicy !== undefined) return trustedScriptUrlPolicy;
    if (!cspTrustedTypesAllowsPolicy("staticElementDecoys")) {
      trustedScriptUrlPolicy = null;
      return trustedScriptUrlPolicy;
    }
    try {
      trustedScriptUrlPolicy = globalThis.trustedTypes.createPolicy("staticElementDecoys", {
        createScriptURL: (value) => value,
      });
    } catch {
      trustedScriptUrlPolicy = null;
    }
    return trustedScriptUrlPolicy;
  };

  const replacementValueFor = ({ el, kind, mode, original, prop }) => {
    const url = replacementUrlFor(mode, kind, prop, original);
    if (!isScriptSrcSink(el, prop)) return url;
    if (!globalThis.trustedTypes) return url;
    const policy = trustedPolicyForScriptUrls();
    if (!policy) return null;
    try {
      return policy.createScriptURL(url);
    } catch {
      return null;
    }
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
          const replacement = replacementValueFor({
            el: this,
            kind: probe.kind,
            mode: probe.mode,
            original,
            prop,
          });
          if (replacement != null) {
            desc.set.call(this, replacement);
            rememberNativeMutationValue(this, prop, null, original);
            rememberElementAttrNodeOriginal(this, prop, original);
          }
          return;
        }
        forgetElementAttrNodeOriginal(this, prop);
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
    if (!isAttrNode(attr)) return "";
    const attrNodeOriginal = attrNodeOriginals.get(attr);
    if (attrNodeOriginal) return attrNodeOriginal;
    if (!attr.ownerElement) return "";
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
    writeAttr = true,
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
    rememberAttrNodeOriginal(attr, original);
    if (prop === "srcset") rememberOriginal(el, "currentSrc", probe.url);
    postProbe(probe.url, probe.mode === "decoy" ? `${label}-${prop}-decoy` : label);
    if (writeAttr) {
      setNativeAttrValue(attr, replacementUrlFor(probe.mode, probe.kind, prop, original));
      rememberMutationOldValueOriginal({
        el,
        name: attr.name || attr.localName,
        nativeValue: nativeAttrValueFor(attr),
        ns: attr.namespaceURI,
        original,
      });
    }
  };

  const applyAttrValueProbe = (attr, value, label) => {
    if (!isAttrNode(attr) || !attr.ownerElement) return false;
    const prop = attrPropFor(attr.name || attr.localName);
    const probe = prop && elementProbe(attr.ownerElement, prop, value);
    if (!probe) {
      forgetAttrNodeOriginal(attr);
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
        forgetAttrNodeOriginal(this);
        desc.set.call(this, value);
      },
    };
    const wrappedSet = desc.set
      ? Object.getOwnPropertyDescriptor(setterHolder, prop).set
      : desc.set;
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
      `(\\s${escapeRegExp(String(name).toLowerCase())}\\s*=\\s*")${escapeRegExp(nativeEscaped)}(")`,
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
      nextHtml = replaceSerializedAttrOnce(nextHtml, entry.name, entry.nativeValue, entry.original);
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
        get: stealth(
          Object.getOwnPropertyDescriptor(innerGetterHolder, "innerHTML").get,
          "get innerHTML",
          {
            length: 0,
            source: nativeSourceFor(innerDesc.get, "get innerHTML"),
          }
        ),
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
        get: stealth(
          Object.getOwnPropertyDescriptor(outerGetterHolder, "outerHTML").get,
          "get outerHTML",
          {
            length: 0,
            source: nativeSourceFor(outerDesc.get, "get outerHTML"),
          }
        ),
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

  const applyElementAttributeProbe = ({
    baseLabel,
    el,
    name,
    ns = null,
    probe,
    prop,
    setReplacement,
    value,
  }) => {
    const original = prop === "srcset" ? String(value) : probe.url;
    rememberOriginal(el, prop, original);
    if (ns) rememberNamespacedAttributeOriginal(el, ns, name, original);
    else rememberAttributeOriginal(el, name, original);
    if (prop === "srcset") rememberOriginal(el, "currentSrc", probe.url);
    postProbe(probe.url, probe.mode === "decoy" ? `${baseLabel}-${prop}-decoy` : baseLabel);
    const replacement = replacementValueFor({
      el,
      kind: probe.kind,
      mode: probe.mode,
      original,
      prop,
    });
    if (replacement == null) return undefined;
    const result = setReplacement(replacement);
    rememberNativeMutationValue(el, name, ns, original);
    rememberElementAttrNodeOriginal(el, name, original, ns);
    return result;
  };

  const patchAttributes = () => {
    const origSetAttribute = Element.prototype.setAttribute;
    const origSetAttributeNS = Element.prototype.setAttributeNS;
    const origGetAttribute = Element.prototype.getAttribute;
    const origGetAttributeNS = Element.prototype.getAttributeNS;
    const origRemoveAttribute = Element.prototype.removeAttribute;
    const origRemoveAttributeNS = Element.prototype.removeAttributeNS;
    nativeGetAttribute = origGetAttribute;
    nativeGetAttributeNS = origGetAttributeNS;
    const wrapped = {
      setAttribute(name, value) {
        const prop = attrPropFor(name);
        const probe = prop && elementProbe(this, prop, value);
        if (probe) {
          return applyElementAttributeProbe({
            baseLabel: "setAttribute",
            el: this,
            name,
            probe,
            prop,
            setReplacement: (replacement) => origSetAttribute.call(this, name, replacement),
            value,
          });
        }
        if (prop) {
          forgetElementAttrNodeOriginal(this, name);
          forgetOriginal(this, prop);
          forgetAttributeOriginal(this, name);
        }
        return origSetAttribute.apply(this, arguments);
      },
      setAttributeNS(ns, name, value) {
        const prop = attrPropFor(name);
        const probe = prop && elementProbe(this, prop, value);
        if (probe) {
          return applyElementAttributeProbe({
            baseLabel: "setAttributeNS",
            el: this,
            name,
            ns,
            probe,
            prop,
            setReplacement: (replacement) => origSetAttributeNS.call(this, ns, name, replacement),
            value,
          });
        }
        if (prop) {
          forgetElementAttrNodeOriginal(this, name, ns);
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
          rememberCurrentAttrNodeOriginal(this, name);
          forgetOriginal(this, prop);
          forgetAttributeOriginal(this, name);
        }
        return origRemoveAttribute.apply(this, arguments);
      },
      removeAttributeNS(ns, name) {
        const prop = attrPropFor(name);
        if (prop) {
          rememberCurrentAttrNodeOriginal(this, name, ns);
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
    const oldAttrFor = (el, attr) => {
      try {
        if (attr.namespaceURI) return el.getAttributeNodeNS(attr.namespaceURI, attr.localName);
        return el.getAttributeNode(attr.name);
      } catch {
        return null;
      }
    };
    const applyAttrNodeProbe = ({ el, attr, found, label, nativeSetter }) => {
      const original = found.prop === "srcset" ? nativeAttrValueFor(attr) : found.probe.url;
      const replacement = replacementValueFor({
        el,
        kind: found.probe.kind,
        mode: found.probe.mode,
        original,
        prop: found.prop,
      });
      const oldAttr = oldAttrFor(el, attr);
      if (replacement == null) return oldAttr;
      setNativeAttrValue(attr, replacement);
      let result;
      try {
        result = nativeSetter.call(el, attr);
      } catch (error) {
        setNativeAttrValue(attr, original);
        throw error;
      }
      rememberAttrProbe({
        attr,
        el,
        label,
        probe: found.probe,
        prop: found.prop,
        value: original,
        writeAttr: false,
      });
      rememberMutationOldValueOriginal({
        el,
        name: attr.name || attr.localName,
        nativeValue: nativeAttrValueFor(attr),
        ns: attr.namespaceURI,
        original,
      });
      return result;
    };
    const wrapped = {
      setAttributeNode(attr) {
        const found = attributeNodeProbe(this, attr);
        if (found) {
          return applyAttrNodeProbe({
            attr,
            el: this,
            found,
            label: "setAttributeNode",
            nativeSetter: origSetAttributeNode,
          });
        }
        return origSetAttributeNode.apply(this, arguments);
      },
      setAttributeNodeNS(attr) {
        const found = attributeNodeProbe(this, attr);
        if (found) {
          return applyAttrNodeProbe({
            attr,
            el: this,
            found,
            label: "setAttributeNodeNS",
            nativeSetter: origSetAttributeNodeNS,
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

  const patchMutationObserver = () => {
    if (typeof MutationObserver !== "function") return;
    const OrigMutationObserver = MutationObserver;
    const WrappedMutationObserver = function MutationObserver(callback) {
      if (!new.target) return Reflect.apply(OrigMutationObserver, this, arguments);
      const callbackForPage =
        typeof callback === "function"
          ? function mutationObserverCallback(records, observer) {
              return callback.call(this, mutationRecordsForPage(records), observer);
            }
          : callback;
      const observer = Reflect.construct(OrigMutationObserver, [callbackForPage], new.target);
      const origTakeRecords = observer.takeRecords;
      if (typeof origTakeRecords === "function") {
        observer.takeRecords = stealth(
          function takeRecords() {
            return mutationRecordsForPage(origTakeRecords.apply(this, arguments));
          },
          "takeRecords",
          {
            length: 0,
            source: nativeSourceFor(origTakeRecords, "takeRecords"),
          }
        );
      }
      return observer;
    };
    WrappedMutationObserver.prototype = OrigMutationObserver.prototype;
    alignPrototypeConstructor(WrappedMutationObserver, OrigMutationObserver);
    window.MutationObserver = stealth(WrappedMutationObserver, "MutationObserver", {
      length: 1,
      source: nativeSourceFor(OrigMutationObserver, "MutationObserver"),
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
          target.baseVal = replacementUrlFor(probe.mode, probe.kind, "href", probe.url);
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
  patchMutationObserver();
  if (typeof SVGUseElement !== "undefined") patchSvgHref(SVGUseElement, "svg.use.href");
  if (typeof SVGImageElement !== "undefined") patchSvgHref(SVGImageElement, "svg.image.href");
  if (typeof SVGScriptElement !== "undefined") patchSvgHref(SVGScriptElement, "svg.script.href");
})();
