// Static - MAIN-world iframe policy attribute normalizer.
(() => {
  const U = globalThis.__static_block_utils__;
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
  const BRIDGE_EVENT = "__perf_iframe_bi__";
  let supportedAllowFeatures = null;
  let sandboxTokenList = null;
  let nativeRemoveAttribute = null;
  let disabled = false;

  const applyConfigUpdate = (data) => {
    if (data && data.type === "config_update" && typeof data.disabled === "boolean") {
      disabled = data.disabled;
    }
  };

  U.setupBridge(BRIDGE_EVENT, 1000, applyConfigUpdate);

  const getSupportedAllowFeatures = () => {
    if (supportedAllowFeatures) return supportedAllowFeatures;
    const supported = [];
    try {
      supported.push(...U.readPolicyFeatures(document.featurePolicy || document.permissionsPolicy));
    } catch {}
    if (!supported.length) {
      try {
        supported.push(...U.readPolicyFeatures(document.createElement("iframe").featurePolicy));
      } catch {}
    }
    supportedAllowFeatures = new Set(supported.map((feature) => String(feature).toLowerCase()));
    return supportedAllowFeatures;
  };

  const sandboxSupports = (token) => {
    const safeToken = String(token || "").toLowerCase();
    if (!safeToken) return false;
    if (!sandboxTokenList) {
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

  const normalizeSandboxTokens = (tokens) =>
    normalizedTokensFor(tokens.map((token) => String(token)).join(" "), sandboxSupports);

  const normalizeSandboxValue = (value) => normalizedTokensFor(value, sandboxSupports).join(" ");

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
    const localName = U.attrLocalName(null, name);
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
    nativeRemoveAttribute = Element.prototype.removeAttribute;
    U.wrapMethod(Element.prototype, "setAttribute", (origSetAttribute) => ({
      setAttribute(name, value) {
        if (disabled) return origSetAttribute.call(this, name, value);
        const normalized = normalizeIframeAttr(this, name, value);
        if (normalized.skip) return;
        return origSetAttribute.call(this, name, normalized.value);
      },
    }));
    U.wrapMethod(Element.prototype, "setAttributeNS", (origSetAttributeNS) => ({
      setAttributeNS(ns, name, value) {
        if (disabled) return origSetAttributeNS.call(this, ns, name, value);
        const normalized = normalizeIframeAttr(this, name, value);
        if (normalized.skip) return;
        return origSetAttributeNS.call(this, ns, name, normalized.value);
      },
    }));
  };

  const patchIframeStringProperty = (prop, normalize, beforeSet) => {
    if (typeof HTMLIFrameElement === "undefined") return;
    U.wrapSetter(HTMLIFrameElement.prototype, prop, (nativeSet) => ({
      set(value) {
        if (disabled) {
          nativeSet.call(this, value);
          return;
        }
        if (beforeSet) beforeSet(this);
        nativeSet.call(this, normalize(value));
      },
    }));
  };

  const patchIframeLegacyBooleanProperty = (prop) => {
    if (typeof HTMLIFrameElement === "undefined") return;
    U.wrapSetter(HTMLIFrameElement.prototype, prop, (nativeSet) => ({
      set(value) {
        if (!disabled && value && this.hasAttribute("allow")) return;
        nativeSet.call(this, value);
      },
    }));
  };

  const patchHtmlSink = (proto, prop) => {
    U.wrapSetter(proto, prop, (nativeSet) => ({
      set(value) {
        if (disabled) {
          nativeSet.call(this, value);
          return;
        }
        const text = U.htmlSinkText(value, true);
        nativeSet.call(this, U.htmlSinkValue(value, text, sanitizeIframeMarkup(text)));
      },
    }));
  };

  const patchInsertAdjacentHTML = () => {
    U.wrapMethod(Element.prototype, "insertAdjacentHTML", (orig) => ({
      insertAdjacentHTML(position, html) {
        if (disabled || arguments.length < 2) return orig.apply(this, arguments);
        const text = U.htmlSinkText(html, false);
        return orig.call(this, position, U.htmlSinkValue(html, text, sanitizeIframeMarkup(text)));
      },
    }));
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

  const patchSandboxDomTokenList = () => {
    if (typeof DOMTokenList === "undefined" || !DOMTokenList.prototype) return;
    const proto = DOMTokenList.prototype;
    U.wrapSetter(proto, "value", (nativeSet) => ({
      set(nextValue) {
        const sandbox = !disabled && isSandboxTokenList(this);
        nativeSet.call(this, sandbox ? normalizeSandboxValue(nextValue) : nextValue);
      },
    }));
    U.wrapMethod(proto, "add", (orig) => ({
      add(...tokens) {
        if (disabled || !isSandboxTokenList(this)) return orig.apply(this, tokens);
        const normalized = normalizeSandboxTokens(tokens);
        if (!normalized.length) return;
        return orig.apply(this, normalized);
      },
    }));
    U.wrapMethod(proto, "toggle", (orig) => ({
      toggle(token, force) {
        if (disabled || !isSandboxTokenList(this)) return orig.apply(this, arguments);
        const [normalized] = normalizeSandboxTokens([token]);
        if (!normalized) return false;
        if (arguments.length > 1) return orig.call(this, normalized, force);
        return orig.call(this, normalized);
      },
    }));
    U.wrapMethod(proto, "replace", (orig) => ({
      replace(token, newToken) {
        if (disabled || !isSandboxTokenList(this)) return orig.apply(this, arguments);
        const oldToken = String(token || "")
          .trim()
          .toLowerCase();
        const [safeNewToken] = normalizeSandboxTokens([newToken]);
        if (!oldToken || !sandboxSupports(oldToken) || !safeNewToken) return false;
        return orig.call(this, oldToken, safeNewToken);
      },
    }));
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
