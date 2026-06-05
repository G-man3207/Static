/* eslint-disable max-lines, max-statements -- MAIN-world element decoy shims are safer kept contiguous */
// Static - MAIN-world passive element decoys for Noise-mode personas.
(() => {
  const U = globalThis.__static_block_utils__;
  const BRIDGE_EVENT = "__perf_decoy_bi__";
  const PNG_1X1_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const PNG_1X1_BINARY = atob(PNG_1X1_B64);
  const IMAGE_DECOY_PATHS = U.IMAGE_DECOY_PATHS;
  const SCRIPT_DECOY_PATHS = U.SCRIPT_DECOY_PATHS;
  const HTML_DECOY_PATHS = U.HTML_DECOY_PATHS;
  const STYLE_DECOY_PATHS = U.STYLE_DECOY_PATHS;
  const animatedHrefProxies = new WeakMap();
  const attrNodeOriginals = new WeakMap();
  const elementOriginals = new WeakMap();
  const mutationOldValueOriginals = new WeakMap();
  const MAX_QUEUED_PROBES = 1000;
  let noiseEnabled = false;
  let persona = new Set();
  let disabled = false;
  let nativeAttrValueGetter = null;
  let nativeAttrValueSetter = null;
  let nativeGetAttribute = null;
  let nativeGetAttributeNS = null;
  let trustedScriptUrlPolicy = undefined;

  const applyConfigUpdate = (data) => {
    if (!data || data.type !== "config_update") return;
    if (Array.isArray(data.persona)) {
      persona = new Set(data.persona.filter((id) => typeof id === "string"));
    }
    if (typeof data.noiseEnabled === "boolean") noiseEnabled = data.noiseEnabled;
    if (typeof data.disabled === "boolean") disabled = data.disabled;
  };

  const bridge = U.setupBridge(BRIDGE_EVENT, MAX_QUEUED_PROBES, applyConfigUpdate);

  const postProbe = (url, where) => {
    const safeUrl = url == null ? "" : String(url).slice(0, 512);
    const safeWhere = where == null ? "" : String(where).slice(0, 64);
    bridge.post("probe_blocked", { url: safeUrl, where: safeWhere });
  };

  const shouldDecoy = (url) => {
    if (!noiseEnabled) return false;
    const id = U.extractExtId(url);
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
    `attrns:${String(ns || "").toLowerCase()}:${U.attrLocalName(null, name)}`;

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
      if (ns) return el.getAttributeNodeNS(ns, U.attrLocalName(null, name));
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
    `${String(ns || "").toLowerCase()}:${U.attrLocalName(null, name)}`;

  const nativeElementAttrValueFor = (el, name, ns = null) => {
    try {
      if (ns && nativeGetAttributeNS) {
        return nativeGetAttributeNS.call(el, ns, U.attrLocalName(null, name));
      }
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

  const pathFor = U.pathFor;

  const matchesPathPattern = U.matchesPathPattern;

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

  const canHandleTagProp = (tag, prop) => {
    if (prop === "src") return ["img", "input", "script", "source", "embed"].includes(tag);
    if (prop === "srcset") return tag === "img" || tag === "source";
    if (prop === "href") return tag === "link" || tag === "use" || tag === "image";
    if (prop === "data") return tag === "object";
    if (prop === "poster") return tag === "video";
    if (prop === "action" || prop === "formaction") {
      return ["form", "button", "input"].includes(tag);
    }
    return false;
  };

  const tagFrom = (elOrTag) => {
    if (elOrTag == null) return "";
    if (typeof elOrTag === "string") return elOrTag.toLowerCase();
    return String((elOrTag && elOrTag.tagName) || "").toLowerCase();
  };

  const passiveDecoyKindFor = (url, prop, elOrTag) => {
    const pathname = pathFor(url);
    const tag = tagFrom(elOrTag);
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

  const probeUrlFor = (prop, value) => {
    if (prop === "srcset") {
      const match = String(value == null ? "" : value).match(U.BAD_URL_RE);
      return match ? match[0] : "";
    }
    return U.isBad(value) ? U.getUrl(value) : "";
  };

  const elementProbe = (el, prop, value) => {
    if (disabled) return null;
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

  // -----------------------------------------------------------------------
  // HTML sink sanitization (innerHTML, outerHTML, insertAdjacentHTML,
  // DOMParser, Range) to close extension-URL injection bypass.
  // Always prevents the bad URL from persisting in the live DOM tree
  // (fail-closed for sinks per noise contract) and reports the probe.
  // For eligible decoy cases, replacement inert data is used in real DOM
  // while getters/serialization still surface the original (via remember).
  // -----------------------------------------------------------------------

  const bumpSinkProbe = (baseLabel, url, isDecoy) => {
    try {
      const where = isDecoy ? `${baseLabel}-decoy` : baseLabel;
      postProbe(url, where);
    } catch {}
  };

  const rewriteSrcsetValue = (val, tagNameOrEl, bumpFn) => {
    if (typeof val !== "string" || !val || !U.BAD_URL_RE.test(val)) return val;
    return val
      .split(",")
      .map((piece) => {
        const trimmed = piece.trim();
        if (!trimmed) return piece;
        const m = trimmed.match(/^(\S+)(.*)$/);
        if (!m) return piece;
        const u = m[1];
        const rest = m[2] || "";
        if (!U.isBad(u)) return piece;
        const url = U.getUrl(u);
        const k = passiveDecoyKindFor(url, "srcset", tagNameOrEl);
        if (!k) {
          bumpFn(url, false);
          return `data:image/png;base64,not-valid${rest}`;
        }
        const mo = shouldDecoy(url) && k ? "decoy" : "block";
        const r = replacementUrlFor(mo, k, "srcset", url);
        bumpFn(url, mo === "decoy");
        const clean = r.replace(/\s+1x$/i, "");
        return `${clean}${rest}`;
      })
      .join(",");
  };

  const sanitizeHtmlMarkup = (html, labelBase) => {
    if (typeof html !== "string" || !html || !U.BAD_URL_RE.test(html)) {
      return { sanitized: html, tokenMap: new Map() };
    }
    const tokenMap = new Map();
    const localBump = (url, isDecoy) => bumpSinkProbe(labelBase, url, isDecoy);

    const sanitized = html.replace(
      /<([a-z][a-z0-9-]*)\b([^>]*)>/gi,
      (full, tagName, attrsChunk) => {
        // eslint-disable-next-line max-params
        const rewriteOneAttr = (am, attr, norm, quoteChar, val) => {
          if (!val || !U.isBad(val)) return am;
          const q = quoteChar || "";
          const prop = norm.toLowerCase();
          const url = U.getUrl(val);
          if (prop === "srcset") {
            // always rewrite per-candidate for srcset to support mixed
            const finalVal = rewriteSrcsetValue(val, tagName, (u, d) => localBump(u, d));
            return `${attr}=${q}${finalVal}${q}`;
          }
          const k = passiveDecoyKindFor(url, prop, tagName);
          if (!canHandleTagProp(tagName, prop)) {
            localBump(url, false);
            return `${attr}=${q}${q}`;
          }
          const mo = k && shouldDecoy(url) ? "decoy" : "block";
          const repl = replacementUrlFor(mo, k, prop, url);
          const tm = repl.match(/static:([a-z0-9]+)/i) || repl.match(/not-valid-([a-z0-9]+)/i);
          if (tm) tokenMap.set(tm[1], url);
          localBump(url, mo === "decoy");
          return `${attr}=${q}${repl}${q}`;
        };
        const chunk = attrsChunk.replace(
          /\b((src|href|data|poster|action|formaction|srcset))\s*=\s*(["']?)([^"'\s>]*?)\3/gi,
          rewriteOneAttr
        );
        return `<${tagName}${chunk}>`;
      }
    );

    return { sanitized, tokenMap };
  };

  const attachRemembersToSubtree = (root, tokenMap) => {
    if (!root || !tokenMap || tokenMap.size === 0) return;
    const suspect = ["src", "href", "data", "poster", "srcset", "action", "formaction"];
    // eslint-disable-next-line complexity
    const visit = (el) => {
      if (!el) return;
      const hasAttrApi = typeof el.getAttribute === "function";
      if (hasAttrApi) {
        for (const prop of suspect) {
          let realVal = null;
          try {
            const lc = prop === "formaction" ? "formaction" : prop;
            if (prop === "srcset" || prop === "src" || prop === "href" || prop === "poster") {
              // bypass getter via native desc if possible
              const ctorProto = el.constructor && el.constructor.prototype;
              const d = ctorProto && Object.getOwnPropertyDescriptor(ctorProto, prop);
              // eslint-disable-next-line max-depth
              if (d && d.get) realVal = d.get.call(el);
            }
            if (realVal == null) realVal = el.getAttribute(lc || prop);
          } catch {
            try {
              realVal = el.getAttribute(prop === "formaction" ? "formaction" : prop);
            } catch {}
          }
          if (!realVal || typeof realVal !== "string") continue;
          const cands = prop === "srcset" ? realVal.split(",") : [realVal];
          for (const c of cands) {
            const u = c.trim().split(/\s+/)[0];
            if (u && (u.includes("static:") || u.includes("not-valid-"))) {
              const tm = u.match(/(?:static:|not-valid-)([a-z0-9]+)/i);
              const tok = tm ? tm[1] : null;
              // eslint-disable-next-line max-depth
              if (tok && tokenMap.has(tok)) {
                const orig = tokenMap.get(tok);
                rememberOriginal(el, prop, orig);
                // eslint-disable-next-line max-depth
                if (prop === "srcset") rememberOriginal(el, "currentSrc", orig);
                rememberElementAttrNodeOriginal(el, prop, orig);
                rememberNativeMutationValue(el, prop, null, orig);
              }
            }
          }
        }
      }
      try {
        let child = el.firstElementChild;
        for (; child; child = child.nextElementSibling) visit(child);
      } catch {}
    };
    const start = root.content || root;
    visit(start);
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
      ? U.stealth(
          function get() {
            return rememberedOriginal(this, prop) || desc.get.call(this);
          },
          `get ${prop}`,
          { length: desc.get.length, source: U.nativeSourceFor(desc.get, `get ${prop}`) }
        )
      : desc.get;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get,
      set: U.stealth(Object.getOwnPropertyDescriptor(setterHolder, prop).set, `set ${prop}`, {
        length: desc.set.length,
        source: U.nativeSourceFor(desc.set, `set ${prop}`),
      }),
    });
  };

  const attrPropFor = (name) => {
    const lower = U.attrLocalName(null, name);
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
    const found = U.descriptorOwnerFor(proto, prop);
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
      get: U.stealth(wrappedGet, `get ${prop}`, {
        length: 0,
        source: U.nativeSourceFor(desc.get, `get ${prop}`),
      }),
      set: desc.set
        ? U.stealth(wrappedSet, `set ${prop}`, {
            length: 1,
            source: U.nativeSourceFor(desc.set, `set ${prop}`),
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
      value: U.stealth(wrapped, "cloneNode", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "cloneNode"),
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
    const attrName = escapeRegExp(String(name).toLowerCase());
    const originalEscaped = escapeSerializedAttr(originalValue);
    // Double-quoted
    let next = html.replace(
      new RegExp(`(\\s${attrName}\\s*=\\s*")${escapeRegExp(nativeEscaped)}(")`, "i"),
      `$1${originalEscaped}$2`
    );
    // Single-quoted
    next = next.replace(
      new RegExp(`(\\s${attrName}\\s*=\\s*')${escapeRegExp(nativeEscaped)}(')`, "i"),
      `$1${originalEscaped}$2`
    );
    // Unquoted (value must not contain spaces or tag delimiters)
    if (!/[\s"'=<>`]/.test(nativeValue)) {
      next = next.replace(
        new RegExp(`(\\s${attrName}\\s*=\\s*)${escapeRegExp(nativeEscaped)}(\\s|>|/>)`, "i"),
        `$1${originalEscaped}$2`
      );
    }
    return next;
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
        get: U.stealth(
          Object.getOwnPropertyDescriptor(innerGetterHolder, "innerHTML").get,
          "get innerHTML",
          {
            length: 0,
            source: U.nativeSourceFor(innerDesc.get, "get innerHTML"),
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
        get: U.stealth(
          Object.getOwnPropertyDescriptor(outerGetterHolder, "outerHTML").get,
          "get outerHTML",
          {
            length: 0,
            source: U.nativeSourceFor(outerDesc.get, "get outerHTML"),
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
      value: U.stealth(wrapped, "serializeToString", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "serializeToString"),
      }),
    });
  };

  const patchHtmlSetters = () => {
    const patchOne = (proto, prop) => {
      if (!proto) return;
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set) return;
      const nativeSet = desc.set;
      const wrapped = {
        set [prop](value) {
          if (disabled) {
            nativeSet.call(this, value);
            return;
          }
          const input = typeof value === "string" ? value : "";
          const { sanitized, tokenMap } = sanitizeHtmlMarkup(input, prop);
          nativeSet.call(this, sanitized);
          if (tokenMap && tokenMap.size > 0) {
            attachRemembersToSubtree(this, tokenMap);
          }
        },
      };
      const wset = Object.getOwnPropertyDescriptor(wrapped, prop).set;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: U.stealth(wset, `set ${prop}`, {
          length: desc.set.length,
          source: U.nativeSourceFor(desc.set, `set ${prop}`),
        }),
      });
    };
    if (typeof Element !== "undefined" && Element.prototype) {
      patchOne(Element.prototype, "innerHTML");
      patchOne(Element.prototype, "outerHTML");
    }
    if (typeof ShadowRoot !== "undefined" && ShadowRoot.prototype) {
      patchOne(ShadowRoot.prototype, "innerHTML");
    }
  };

  const patchInsertAdjacentHTMLForElements = () => {
    if (typeof Element === "undefined" || !Element.prototype) return;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "insertAdjacentHTML");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      insertAdjacentHTML(position, html) {
        if (disabled) return orig.call(this, position, html);
        const input = typeof html === "string" ? html : "";
        const { sanitized, tokenMap } = sanitizeHtmlMarkup(input, "insertAdjacentHTML");
        const result = orig.call(this, position, sanitized);
        if (tokenMap && tokenMap.size > 0) {
          attachRemembersToSubtree(this, tokenMap);
        }
        return result;
      },
    }.insertAdjacentHTML;
    Object.defineProperty(Element.prototype, "insertAdjacentHTML", {
      ...desc,
      value: U.stealth(wrapped, "insertAdjacentHTML", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "insertAdjacentHTML"),
      }),
    });
  };

  const patchDomParser = () => {
    if (typeof DOMParser === "undefined" || !DOMParser.prototype) return;
    const desc = Object.getOwnPropertyDescriptor(DOMParser.prototype, "parseFromString");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      parseFromString(markup, type) {
        if (disabled || typeof markup !== "string" || !U.BAD_URL_RE.test(markup)) {
          return orig.apply(this, arguments);
        }
        const t = String(type || "");
        if (!/html/i.test(t)) return orig.apply(this, arguments);
        const { sanitized, tokenMap } = sanitizeHtmlMarkup(markup, "DOMParser");
        const doc = orig.call(this, sanitized, type);
        if (tokenMap && tokenMap.size > 0 && doc) {
          attachRemembersToSubtree(doc.documentElement || doc.body, tokenMap);
        }
        return doc;
      },
    }.parseFromString;
    Object.defineProperty(DOMParser.prototype, "parseFromString", {
      ...desc,
      value: U.stealth(wrapped, "parseFromString", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "parseFromString"),
      }),
    });
  };

  const patchRangeFragment = () => {
    if (typeof Range === "undefined" || !Range.prototype) return;
    const desc = Object.getOwnPropertyDescriptor(Range.prototype, "createContextualFragment");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      createContextualFragment(html) {
        if (disabled || typeof html !== "string" || !U.BAD_URL_RE.test(html)) {
          return orig.apply(this, arguments);
        }
        const { sanitized, tokenMap } = sanitizeHtmlMarkup(html, "createContextualFragment");
        const frag = orig.call(this, sanitized);
        if (tokenMap && tokenMap.size > 0 && frag) {
          attachRemembersToSubtree(frag, tokenMap);
        }
        return frag;
      },
    }.createContextualFragment;
    Object.defineProperty(Range.prototype, "createContextualFragment", {
      ...desc,
      value: U.stealth(wrapped, "createContextualFragment", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "createContextualFragment"),
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
    Element.prototype.setAttribute = U.stealth(wrapped.setAttribute, "setAttribute", { length: 2 });
    Element.prototype.setAttributeNS = U.stealth(wrapped.setAttributeNS, "setAttributeNS", {
      length: 3,
    });
    Element.prototype.getAttribute = U.stealth(wrapped.getAttribute, "getAttribute", { length: 1 });
    Element.prototype.getAttributeNS = U.stealth(wrapped.getAttributeNS, "getAttributeNS", {
      length: 2,
    });
    Element.prototype.removeAttribute = U.stealth(wrapped.removeAttribute, "removeAttribute", {
      length: 1,
    });
    Element.prototype.removeAttributeNS = U.stealth(
      wrapped.removeAttributeNS,
      "removeAttributeNS",
      {
        length: 2,
      }
    );
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
      Element.prototype.setAttributeNode = U.stealth(wrapped.setAttributeNode, "setAttributeNode", {
        length: 1,
      });
    }
    if (typeof origSetAttributeNodeNS === "function") {
      Element.prototype.setAttributeNodeNS = U.stealth(
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
      get: U.stealth(
        function get() {
          return (
            rememberedOriginal(this, "currentSrc") ||
            rememberedOriginal(this, "src") ||
            desc.get.call(this)
          );
        },
        "get currentSrc",
        { length: 0, source: U.nativeSourceFor(desc.get, "get currentSrc") }
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
      get: U.stealth(
        function get() {
          try {
            return rememberedOriginal(this.ownerNode, "href") || desc.get.call(this);
          } catch {
            return desc.get.call(this);
          }
        },
        "get href",
        { length: 0, source: U.nativeSourceFor(desc.get, "get href") }
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
      // Chain through any already-patched MutationObserver (e.g. block_adaptive.js
      // which loads before this script per manifest.json ordering).
      const observer = Reflect.construct(OrigMutationObserver, [callbackForPage], new.target);
      const origTakeRecords = observer.takeRecords;
      if (typeof origTakeRecords === "function") {
        observer.takeRecords = U.stealth(
          function takeRecords() {
            return mutationRecordsForPage(origTakeRecords.apply(this, arguments));
          },
          "takeRecords",
          {
            length: 0,
            source: U.nativeSourceFor(origTakeRecords, "takeRecords"),
          }
        );
      }
      return observer;
    };
    WrappedMutationObserver.prototype = OrigMutationObserver.prototype;
    U.alignPrototypeConstructor(WrappedMutationObserver, OrigMutationObserver);
    window.MutationObserver = U.stealth(WrappedMutationObserver, "MutationObserver", {
      length: 1,
      source: U.nativeSourceFor(OrigMutationObserver, "MutationObserver"),
    });
  };

  const svgHrefProbe = (el, value) => {
    if (disabled) return null;
    const url = U.isBad(value) ? U.getUrl(value) : "";
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
      get: U.stealth(
        function get() {
          const animated = desc.get.call(this);
          return animated && typeof animated === "object"
            ? animatedHrefProxyFor(this, animated, label)
            : animated;
        },
        "get href",
        { length: 0, source: U.nativeSourceFor(desc.get, "get href") }
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
  patchHtmlSetters();
  patchInsertAdjacentHTMLForElements();
  patchDomParser();
  patchRangeFragment();
  if (typeof SVGUseElement !== "undefined") patchSvgHref(SVGUseElement, "svg.use.href");
  if (typeof SVGImageElement !== "undefined") patchSvgHref(SVGImageElement, "svg.image.href");
  if (typeof SVGScriptElement !== "undefined") patchSvgHref(SVGScriptElement, "svg.script.href");
})();
