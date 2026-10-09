// Static - MAIN-world blocking for CSS declaration extension URL probes.
(() => {
  const U = globalThis.__static_block_utils__;
  const BRIDGE_EVENT = "__perf_style_bi__";
  const MAX_QUEUED_PROBES = 1000;
  const STYLE_MARKUP_RE = /<\s*style(?:\s|>|\/)/i;
  const STYLE_ATTR_MARKUP_RE = /\sstyle\s*=/i;
  let nativeCssTextGetter = null;
  let nativeCssTextSetter = null;
  let disabled = false;

  const bridge = U.setupBridge(BRIDGE_EVENT, MAX_QUEUED_PROBES, (data) => {
    if (data && data.type === "config_update" && typeof data.disabled === "boolean") {
      disabled = data.disabled;
    }
  });

  const isStyleElement = (node) => {
    return (
      node &&
      node.nodeType === Node.ELEMENT_NODE &&
      String(node.localName || "").toLowerCase() === "style"
    );
  };

  const isStyleTextNode = (node) => {
    return node && node.nodeType === Node.TEXT_NODE && isStyleElement(node.parentNode);
  };

  // Style text with its extension URLs neutralized (the rest kept), reporting
  // the first one. Returns the value untouched when there are none.
  const sanitizeStyleText = (label, value) => {
    const { text, url } = U.sanitizeCssText(value);
    if (!url) return value;
    bridge.probe(url, label);
    return text;
  };

  // The first extension URL a CSS declaration value can load, escapes included.
  const badCssUrlIn = (value) => U.sanitizeCssText(value).url || U.firstBadUrlIn(value);

  const scrubStyleTextPayload = (node, label) => {
    if (!node || typeof node !== "object") return false;
    let changed = false;
    const visit = (current) => {
      if (!current) return;
      if (current.nodeType === Node.TEXT_NODE) {
        const text = current.textContent || "";
        const next = sanitizeStyleText(label, text);
        if (next !== text) {
          try {
            current.textContent = next;
            changed = true;
          } catch {}
        }
        return;
      }
      for (let child = current.firstChild; child; child = child.nextSibling) {
        visit(child);
      }
    };
    visit(node);
    return changed;
  };

  const removeBadStyleProperties = (style) => {
    if (!style) return false;
    let changed = false;
    for (let index = style.length - 1; index >= 0; index--) {
      const name = style.item(index);
      const value = style.getPropertyValue(name);
      if (!badCssUrlIn(value)) continue;
      try {
        style.removeProperty(name);
        changed = true;
      } catch {}
    }
    return changed;
  };

  const safeCssTextFor = (style) => {
    try {
      if (nativeCssTextGetter) return nativeCssTextGetter.call(style);
    } catch {}
    try {
      return style.cssText || "";
    } catch {
      return "";
    }
  };

  const sanitizeStyleDeclarationValue = (value, label) => {
    const url = badCssUrlIn(value);
    if (!url) return { changed: false, value };
    bridge.probe(url, label);

    if (!nativeCssTextSetter || typeof document.createElement !== "function") {
      return { changed: true, value: "" };
    }

    try {
      const scratch = document.createElement("div");
      nativeCssTextSetter.call(scratch.style, String(value == null ? "" : value));
      removeBadStyleProperties(scratch.style);
      return { changed: true, value: safeCssTextFor(scratch.style) };
    } catch {
      return { changed: true, value: "" };
    }
  };

  const scrubStyleTextNode = (style, label) => {
    if (!isStyleElement(style)) return false;
    const text = style.textContent || "";
    const next = sanitizeStyleText(label, text);
    if (next === text) return false;
    try {
      style.textContent = next;
    } catch {}
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
    if (
      typeof value !== "string" ||
      (!STYLE_MARKUP_RE.test(value) && !STYLE_ATTR_MARKUP_RE.test(value))
    ) {
      return value;
    }
    const template = document.createElement("template");
    try {
      innerHTMLDesc.set.call(template, value);
    } catch {
      return value;
    }
    const root = template.content || template;
    const textChanged = scrubStyleTextTree(root, label);
    const attrChanged = scrubTree(root, label);
    const changed = textChanged || attrChanged;
    if (!changed) return value;
    try {
      return innerHTMLDesc.get.call(template);
    } catch {
      return "";
    }
  };

  const patchSetProperty = (proto) => {
    U.wrapMethod(proto, "setProperty", (orig) => ({
      setProperty(name, value, priority) {
        if (disabled) return orig.call(this, name, value, priority);
        const url = badCssUrlIn(value);
        if (url) {
          bridge.probe(url, "style.setProperty");
          return;
        }
        return orig.call(this, name, value, priority);
      },
    }));
  };

  // Setter that strips extension URLs from a CSS declaration value.
  const sanitizingDeclarationSetter = (label) => (nativeSet) => ({
    set(value) {
      if (disabled) {
        nativeSet.call(this, value);
        return;
      }
      const sanitized = sanitizeStyleDeclarationValue(value, label);
      nativeSet.call(this, sanitized.changed ? sanitized.value : value);
    },
  });

  const patchCssText = (proto) => {
    const desc = Object.getOwnPropertyDescriptor(proto, "cssText");
    if (!desc || !desc.set) return;
    nativeCssTextGetter = desc.get;
    nativeCssTextSetter = desc.set;
    U.wrapSetter(proto, "cssText", sanitizingDeclarationSetter("style.cssText"));
  };

  const patchCssUrlPropertySetters = (proto) => {
    for (const prop of Object.getOwnPropertyNames(proto || {})) {
      if (prop === "cssText") continue;
      try {
        U.wrapSetter(proto, prop, sanitizingDeclarationSetter("style.property"));
      } catch {}
    }
  };

  const patchTextContent = (proto) => {
    U.wrapSetter(proto, "textContent", (nativeSet) => ({
      set(value) {
        const styleText = !disabled && (isStyleElement(this) || isStyleTextNode(this));
        nativeSet.call(this, styleText ? sanitizeStyleText("style.textContent", value) : value);
      },
    }));
  };

  const patchStyleTextNodeSetter = (proto, prop, label) => {
    U.wrapSetter(proto, prop, (nativeSet) => ({
      set(value) {
        const styleText = !disabled && isStyleTextNode(this);
        nativeSet.call(this, styleText ? sanitizeStyleText(label, value) : value);
      },
    }));
  };

  const patchInnerHTML = (proto, innerHTMLDesc) => {
    U.wrapSetter(proto, "innerHTML", (nativeSet) => ({
      set(value) {
        if (disabled) {
          nativeSet.call(this, value);
          return;
        }
        const nextValue = isStyleElement(this)
          ? sanitizeStyleText("style.innerHTML", value)
          : sanitizeStyleMarkup(value, "style.innerHTML", innerHTMLDesc);
        nativeSet.call(this, nextValue);
      },
    }));
  };

  const patchOuterHTML = (proto, innerHTMLDesc) => {
    if (!innerHTMLDesc) return;
    U.wrapSetter(proto, "outerHTML", (nativeSet) => ({
      set(value) {
        nativeSet.call(
          this,
          disabled ? value : sanitizeStyleMarkup(value, "style.outerHTML", innerHTMLDesc)
        );
      },
    }));
  };

  const patchInsertAdjacentHTML = (proto, innerHTMLDesc) => {
    if (!innerHTMLDesc) return;
    U.wrapMethod(proto, "insertAdjacentHTML", (orig) => ({
      insertAdjacentHTML(position, html) {
        if (disabled) return orig.call(this, position, html);
        const nextHtml = isStyleElement(this)
          ? sanitizeStyleText("style.insertAdjacentHTML", html)
          : sanitizeStyleMarkup(html, "style.insertAdjacentHTML", innerHTMLDesc);
        return orig.call(this, position, nextHtml);
      },
    }));
  };

  const patchInsertAdjacentText = (proto) => {
    U.wrapMethod(proto, "insertAdjacentText", (orig) => ({
      insertAdjacentText(position, text) {
        if (disabled) return orig.call(this, position, text);
        const nextText = isStyleElement(this)
          ? sanitizeStyleText("style.insertAdjacentText", text)
          : text;
        return orig.call(this, position, nextText);
      },
    }));
  };

  const scrubInsertionArgs = (target, args, label) => {
    const nextArgs = [];
    for (const arg of args) {
      if (isStyleElement(target) && typeof arg === "string") {
        nextArgs.push(sanitizeStyleText(label, arg));
        continue;
      }
      if (isStyleElement(target) && arg && typeof arg === "object") {
        scrubStyleTextPayload(arg, label);
      }
      if (arg && typeof arg === "object") {
        scrubTree(arg, label);
        scrubStyleTextTree(arg, label);
      }
      nextArgs.push(arg);
    }
    return nextArgs;
  };

  const patchNodeInsertionMethod = (proto, name, label) => {
    U.wrapMethod(proto, name, (orig) => ({
      [name](node, ...rest) {
        if (disabled) return orig.call(this, node, ...rest);
        if (node && typeof node === "object") {
          if (isStyleElement(this)) scrubStyleTextPayload(node, label);
          scrubTree(node, label);
          scrubStyleTextTree(node, label);
        }
        return orig.call(this, node, ...rest);
      },
    }));
  };

  const patchElementInsertionMethod = (proto, name, label) => {
    U.wrapMethod(proto, name, (orig) => ({
      [name](...args) {
        if (disabled) return orig.apply(this, args);
        return orig.apply(this, scrubInsertionArgs(this, args, label));
      },
    }));
  };

  const patchStyleTextInsertion = () => {
    const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    patchTextContent(Node.prototype);
    patchStyleTextNodeSetter(Node.prototype, "nodeValue", "style.nodeValue");
    if (typeof CharacterData !== "undefined" && CharacterData.prototype) {
      patchStyleTextNodeSetter(CharacterData.prototype, "data", "style.data");
    }
    patchInnerHTML(Element.prototype, innerHTMLDesc);
    patchOuterHTML(Element.prototype, innerHTMLDesc);
    patchInsertAdjacentHTML(Element.prototype, innerHTMLDesc);
    patchInsertAdjacentText(Element.prototype);
    for (const name of ["appendChild", "insertBefore", "replaceChild"]) {
      patchNodeInsertionMethod(Node.prototype, name, "style.domInsertion");
    }
    for (const name of ["append", "prepend", "replaceChildren"]) {
      patchElementInsertionMethod(Element.prototype, name, `style.${name}`);
    }
  };

  const scrubElementStyle = (el, label) => {
    if (!el || !el.style) return false;
    const style = el.style;
    let changed = false;
    for (let index = style.length - 1; index >= 0; index--) {
      const name = style.item(index);
      const value = style.getPropertyValue(name);
      const url = badCssUrlIn(value);
      if (url) {
        bridge.probe(url, label);
        try {
          style.removeProperty(name);
          changed = true;
        } catch {}
      }
    }
    return changed;
  };

  const scrubTree = (node, label) => {
    if (!node) return false;
    let changed = false;
    if (node.nodeType === Node.ELEMENT_NODE) {
      changed = scrubElementStyle(node, label);
    }
    if (typeof node.querySelectorAll !== "function") return changed;
    try {
      for (const el of node.querySelectorAll("[style]")) {
        changed = scrubElementStyle(el, label) || changed;
      }
    } catch {}
    return changed;
  };

  const patchStyleAttributeSetters = () => {
    if (typeof Element === "undefined" || !Element.prototype) return;
    U.wrapMethod(Element.prototype, "setAttribute", (origSetAttribute) => ({
      setAttribute(name, value) {
        if (disabled) return origSetAttribute.apply(this, arguments);
        if (U.attrLocalName(null, name) === "style") {
          const sanitized = sanitizeStyleDeclarationValue(value, "style.setAttribute");
          return origSetAttribute.call(this, name, sanitized.changed ? sanitized.value : value);
        }
        return origSetAttribute.apply(this, arguments);
      },
    }));
    U.wrapMethod(Element.prototype, "setAttributeNS", (origSetAttributeNS) => ({
      setAttributeNS(ns, name, value) {
        if (disabled) return origSetAttributeNS.apply(this, arguments);
        if (U.attrLocalName(null, name) === "style") {
          const sanitized = sanitizeStyleDeclarationValue(value, "style.setAttributeNS");
          const safeValue = sanitized.changed ? sanitized.value : value;
          return origSetAttributeNS.call(this, ns, name, safeValue);
        }
        return origSetAttributeNS.apply(this, arguments);
      },
    }));
  };

  const observeStyleAttributes = () => {
    if (typeof MutationObserver === "undefined" || !document.documentElement) return false;
    const observer = new MutationObserver((records) => {
      if (disabled) return;
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
    patchCssUrlPropertySetters(CSSStyleDeclaration.prototype);
  }
  patchStyleAttributeSetters();
  patchStyleTextInsertion();
  if (!observeStyleAttributes()) {
    document.addEventListener("DOMContentLoaded", observeStyleAttributes, { once: true });
  }
})();
