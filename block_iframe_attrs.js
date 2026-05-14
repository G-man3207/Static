// Static - MAIN-world iframe policy attribute normalizer.
(() => {
  const LEGACY_ALLOW_ATTRS = ["allowfullscreen", "allowpaymentrequest"];
  const IFRAME_POLICY_ATTR_RE =
    /\s(?:sandbox|allow|allowfullscreen|allowpaymentrequest)(?:\s*=|\s|\/?>)/i;
  const IFRAME_MARKUP_RE = /<iframe\b/i;
  const IFRAME_TAG_RE = /<iframe\b[^>]*>/gi;
  const SANDBOX_ATTR_RE = /(\ssandbox\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  const ALLOW_ATTR_RE = /(\sallow\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  const LEGACY_ALLOW_ATTR_RE =
    /\sallow(?:fullscreen|paymentrequest)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gi;
  const HAS_ALLOW_ATTR_RE = /\sallow(?:\s*=|\s|\/?>)/i;
  const FALLBACK_SANDBOX_TOKENS = new Set([
    "allow-downloads",
    "allow-forms",
    "allow-modals",
    "allow-orientation-lock",
    "allow-pointer-lock",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
    "allow-presentation",
    "allow-same-origin",
    "allow-scripts",
    "allow-storage-access-by-user-activation",
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation",
    "allow-top-navigation-to-custom-protocols",
  ]);
  let supportedAllowFeatures = null;
  let sandboxTokenList = null;
  let nativeRemoveAttribute = null;

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

  const readPolicyFeatures = (policy) => {
    if (!policy) return [];
    try {
      if (typeof policy.features === "function") return policy.features();
    } catch {}
    try {
      if (typeof policy.allowedFeatures === "function") return policy.allowedFeatures();
    } catch {}
    return [];
  };

  const getSupportedAllowFeatures = () => {
    if (supportedAllowFeatures) return supportedAllowFeatures;
    const supported = [];
    try {
      supported.push(...readPolicyFeatures(document.featurePolicy || document.permissionsPolicy));
    } catch {}
    if (!supported.length && typeof document.createElement === "function") {
      try {
        supported.push(...readPolicyFeatures(document.createElement("iframe").featurePolicy));
      } catch {}
    }
    supportedAllowFeatures = new Set(supported.map((feature) => String(feature).toLowerCase()));
    return supportedAllowFeatures;
  };

  const sandboxSupports = (token) => {
    const safeToken = String(token || "").toLowerCase();
    if (!safeToken) return false;
    if (!sandboxTokenList && typeof document.createElement === "function") {
      try {
        sandboxTokenList = document.createElement("iframe").sandbox;
      } catch {
        sandboxTokenList = false;
      }
    }
    try {
      if (sandboxTokenList && typeof sandboxTokenList.supports === "function") {
        return sandboxTokenList.supports(safeToken);
      }
    } catch {}
    return FALLBACK_SANDBOX_TOKENS.has(safeToken);
  };

  const normalizedTokensFor = (value, supports) => {
    const kept = [];
    const seen = new Set();
    for (const token of String(value == null ? "" : value).split(/\s+/)) {
      const safeToken = token.trim().toLowerCase();
      if (!safeToken || seen.has(safeToken) || !supports(safeToken)) continue;
      seen.add(safeToken);
      kept.push(safeToken);
    }
    return kept;
  };

  const normalizeTokenList = (value, supports) => normalizedTokensFor(value, supports).join(" ");

  const normalizeSandboxTokens = (tokens) =>
    normalizedTokensFor(tokens.map((token) => String(token)).join(" "), sandboxSupports);

  const normalizeSandboxValue = (value) => normalizeTokenList(value, sandboxSupports);

  const normalizeAllowValue = (value) => {
    const raw = value == null ? "" : String(value);
    const supported = getSupportedAllowFeatures();
    if (!raw || !supported.size) return raw;

    const kept = [];
    for (const part of raw.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^[^\s]+/);
      if (!match || supported.has(match[0].toLowerCase())) kept.push(trimmed);
    }
    return kept.join("; ");
  };

  const isIframe = (element) =>
    typeof HTMLIFrameElement !== "undefined" && element instanceof HTMLIFrameElement;

  const attrLocalName = (name) => {
    const normalized = String(name || "").toLowerCase();
    const colon = normalized.lastIndexOf(":");
    return colon === -1 ? normalized : normalized.slice(colon + 1);
  };

  const removeLegacyAllowAttrs = (element) => {
    for (const attr of LEGACY_ALLOW_ATTRS) {
      try {
        if (element.hasAttribute(attr) && nativeRemoveAttribute) {
          nativeRemoveAttribute.call(element, attr);
        }
      } catch {}
    }
  };

  const normalizeIframeAttr = (element, name, value) => {
    if (!isIframe(element)) return { skip: false, value };
    const localName = attrLocalName(name);
    if (localName === "sandbox") return { skip: false, value: normalizeSandboxValue(value) };
    if (localName === "allow") {
      removeLegacyAllowAttrs(element);
      return { skip: false, value: normalizeAllowValue(value) };
    }
    if (LEGACY_ALLOW_ATTRS.includes(localName) && element.hasAttribute("allow")) {
      return { skip: true, value };
    }
    return { skip: false, value };
  };

  const attrValue = (doubleQuoted, singleQuoted, bare) => {
    if (doubleQuoted !== undefined) return { quote: '"', value: doubleQuoted };
    if (singleQuoted !== undefined) return { quote: "'", value: singleQuoted };
    return { quote: "", value: bare || "" };
  };

  const replaceAttrValue = (groups, normalize) => {
    const [, prefix, doubleQuoted, singleQuoted, bare] = groups;
    const { quote, value } = attrValue(doubleQuoted, singleQuoted, bare);
    return `${prefix}${quote}${normalize(value)}${quote}`;
  };

  const replaceSandboxAttr = (...groups) => replaceAttrValue(groups, normalizeSandboxValue);

  const replaceAllowAttr = (...groups) => replaceAttrValue(groups, normalizeAllowValue);

  const sanitizeIframeTag = (tag) => {
    if (!IFRAME_POLICY_ATTR_RE.test(tag)) return tag;
    let nextTag = tag.replace(SANDBOX_ATTR_RE, replaceSandboxAttr);
    nextTag = nextTag.replace(ALLOW_ATTR_RE, replaceAllowAttr);
    if (HAS_ALLOW_ATTR_RE.test(nextTag)) nextTag = nextTag.replace(LEGACY_ALLOW_ATTR_RE, "");
    return nextTag;
  };

  const sanitizeIframeMarkup = (value) => {
    if (typeof value !== "string" || !IFRAME_MARKUP_RE.test(value)) return value;
    return value.replace(IFRAME_TAG_RE, sanitizeIframeTag);
  };

  const patchAttributeSetters = () => {
    const origSetAttribute = Element.prototype.setAttribute;
    const origSetAttributeNS = Element.prototype.setAttributeNS;
    nativeRemoveAttribute = Element.prototype.removeAttribute;
    const wrapped = {
      setAttribute(name, value) {
        if (window.__staticDisabled) return origSetAttribute.call(this, name, value);
        const normalized = normalizeIframeAttr(this, name, value);
        if (normalized.skip) return;
        return origSetAttribute.call(this, name, normalized.value);
      },
      setAttributeNS(ns, name, value) {
        if (window.__staticDisabled) return origSetAttributeNS.call(this, ns, name, value);
        const normalized = normalizeIframeAttr(this, name, value);
        if (normalized.skip) return;
        return origSetAttributeNS.call(this, ns, name, normalized.value);
      },
    };
    Element.prototype.setAttribute = stealth(wrapped.setAttribute, "setAttribute", { length: 2 });
    Element.prototype.setAttributeNS = stealth(wrapped.setAttributeNS, "setAttributeNS", {
      length: 3,
    });
  };

  const patchIframeStringProperty = (prop, normalize, beforeSet) => {
    if (typeof HTMLIFrameElement === "undefined") return;
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, prop);
    if (!desc || !desc.set) return;
    const setterHolder = {
      set [prop](value) {
        if (window.__staticDisabled) {
          desc.set.call(this, value);
          return;
        }
        if (beforeSet) beforeSet(this);
        desc.set.call(this, normalize(value));
      },
    };
    const wrappedSet = Object.getOwnPropertyDescriptor(setterHolder, prop).set;
    Object.defineProperty(HTMLIFrameElement.prototype, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: stealth(wrappedSet, `set ${prop}`, {
        length: desc.set.length,
        source: nativeSourceFor(desc.set, `set ${prop}`),
      }),
    });
  };

  const patchIframeLegacyBooleanProperty = (prop) => {
    if (typeof HTMLIFrameElement === "undefined") return;
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, prop);
    if (!desc || !desc.set) return;
    const setterHolder = {
      set [prop](value) {
        if (window.__staticDisabled) {
          desc.set.call(this, value);
          return;
        }
        if (value && this.hasAttribute("allow")) return;
        desc.set.call(this, value);
      },
    };
    const wrappedSet = Object.getOwnPropertyDescriptor(setterHolder, prop).set;
    Object.defineProperty(HTMLIFrameElement.prototype, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: stealth(wrappedSet, `set ${prop}`, {
        length: desc.set.length,
        source: nativeSourceFor(desc.set, `set ${prop}`),
      }),
    });
  };

  const patchHtmlSink = (proto, prop) => {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    const setterHolder = {
      set [prop](value) {
        if (window.__staticDisabled) {
          desc.set.call(this, value);
          return;
        }
        desc.set.call(this, sanitizeIframeMarkup(value));
      },
    };
    const wrappedSet = Object.getOwnPropertyDescriptor(setterHolder, prop).set;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: stealth(wrappedSet, `set ${prop}`, {
        length: desc.set.length,
        source: nativeSourceFor(desc.set, `set ${prop}`),
      }),
    });
  };

  const patchInsertAdjacentHTML = () => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "insertAdjacentHTML");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      insertAdjacentHTML(position, html) {
        if (window.__staticDisabled) return orig.call(this, position, html);
        return orig.call(this, position, sanitizeIframeMarkup(html));
      },
    }.insertAdjacentHTML;
    Object.defineProperty(Element.prototype, "insertAdjacentHTML", {
      ...desc,
      value: stealth(wrapped, "insertAdjacentHTML", {
        length: orig.length,
        source: nativeSourceFor(orig, "insertAdjacentHTML"),
      }),
    });
  };

  const isSandboxTokenList = (list) => {
    try {
      return (
        list &&
        typeof list.supports === "function" &&
        list.supports("allow-scripts") &&
        list.supports("allow-same-origin")
      );
    } catch {
      return false;
    }
  };

  const patchDomTokenListValue = (proto) => {
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (!desc || !desc.set) return;
    const setterHolder = {
      set value(nextValue) {
        if (window.__staticDisabled) {
          desc.set.call(this, nextValue);
          return;
        }
        const value = isSandboxTokenList(this) ? normalizeSandboxValue(nextValue) : nextValue;
        desc.set.call(this, value);
      },
    };
    Object.defineProperty(proto, "value", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: stealth(Object.getOwnPropertyDescriptor(setterHolder, "value").set, "set value", {
        length: desc.set.length,
        source: nativeSourceFor(desc.set, "set value"),
      }),
    });
  };

  const patchDomTokenListAdd = (proto) => {
    const desc = Object.getOwnPropertyDescriptor(proto, "add");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      add(...tokens) {
        if (window.__staticDisabled) return orig.apply(this, tokens);
        if (!isSandboxTokenList(this)) return orig.apply(this, tokens);
        const normalized = normalizeSandboxTokens(tokens);
        if (!normalized.length) return;
        return orig.apply(this, normalized);
      },
    }.add;
    Object.defineProperty(proto, "add", {
      ...desc,
      value: stealth(wrapped, "add", { length: orig.length, source: nativeSourceFor(orig, "add") }),
    });
  };

  const patchDomTokenListToggle = (proto) => {
    const desc = Object.getOwnPropertyDescriptor(proto, "toggle");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      toggle(token, force) {
        if (window.__staticDisabled) return orig.apply(this, arguments);
        if (!isSandboxTokenList(this)) return orig.apply(this, arguments);
        const [normalized] = normalizeSandboxTokens([token]);
        if (!normalized) return false;
        if (arguments.length > 1) return orig.call(this, normalized, force);
        return orig.call(this, normalized);
      },
    }.toggle;
    Object.defineProperty(proto, "toggle", {
      ...desc,
      value: stealth(wrapped, "toggle", {
        length: orig.length,
        source: nativeSourceFor(orig, "toggle"),
      }),
    });
  };

  const patchDomTokenListReplace = (proto) => {
    const desc = Object.getOwnPropertyDescriptor(proto, "replace");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      replace(token, newToken) {
        if (window.__staticDisabled) return orig.apply(this, arguments);
        if (!isSandboxTokenList(this)) return orig.apply(this, arguments);
        const oldToken = String(token || "")
          .trim()
          .toLowerCase();
        const [safeNewToken] = normalizeSandboxTokens([newToken]);
        if (!oldToken || !sandboxSupports(oldToken) || !safeNewToken) return false;
        return orig.call(this, oldToken, safeNewToken);
      },
    }.replace;
    Object.defineProperty(proto, "replace", {
      ...desc,
      value: stealth(wrapped, "replace", {
        length: orig.length,
        source: nativeSourceFor(orig, "replace"),
      }),
    });
  };

  const patchSandboxDomTokenList = () => {
    if (typeof DOMTokenList === "undefined" || !DOMTokenList.prototype) return;
    patchDomTokenListValue(DOMTokenList.prototype);
    patchDomTokenListAdd(DOMTokenList.prototype);
    patchDomTokenListToggle(DOMTokenList.prototype);
    patchDomTokenListReplace(DOMTokenList.prototype);
  };

  if (typeof Element !== "undefined" && Element.prototype) {
    patchAttributeSetters();
    patchHtmlSink(Element.prototype, "innerHTML");
    patchHtmlSink(Element.prototype, "outerHTML");
    patchInsertAdjacentHTML();
  }
  patchIframeStringProperty("allow", normalizeAllowValue, removeLegacyAllowAttrs);
  patchIframeStringProperty("sandbox", normalizeSandboxValue);
  patchIframeLegacyBooleanProperty("allowFullscreen");
  patchIframeLegacyBooleanProperty("allowPaymentRequest");
  patchSandboxDomTokenList();
})();
