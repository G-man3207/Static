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

  // The text a payload adds to a style: a string, a text node's data, or a
  // fragment's text children (element children are not style text).
  const pieceTextOf = (value) => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    if (value.nodeType === Node.TEXT_NODE) return value.data;
    let text = "";
    if (value.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (let child = value.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === Node.TEXT_NODE) text += child.data;
      }
    }
    return text;
  };

  // The text a style holds once `piece` goes in before child `at` (at the
  // end when null), in place of child `replaced` if given.
  const styleTextWith = (style, piece, at, replaced) => {
    let text = "";
    for (let child = style.firstChild; child; child = child.nextSibling) {
      if (child === at) text += piece;
      if (child !== replaced && child.nodeType === Node.TEXT_NODE) text += child.data;
    }
    return at ? text : text + piece;
  };

  // A piece that is clean alone can finish an extension URL begun by the
  // style's other text. Only pieces naming an extension scheme pay for the
  // whole-text check; when it finds one, the style gets its whole text
  // sanitized instead of the piece.
  const rewroteSplitStyleText = (style, piece, wholeText, label) => {
    if (!piece || !U.hasBadUrl(piece.includes("\\") ? U.cssUnescape(piece) : piece)) return false;
    const text = wholeText();
    const next = sanitizeStyleText(label, text);
    if (next === text) return false;
    style.textContent = next;
    return true;
  };

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
      // Static's own TrustedHTML: Trusted Types pages reject plain strings.
      innerHTMLDesc.set.call(template, U.trustedHtml(value) || value);
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
        if (disabled || !(isStyleElement(this) || isStyleTextNode(this))) {
          nativeSet.call(this, value);
          return;
        }
        const next = sanitizeStyleText("style.textContent", value);
        const piece = next == null ? "" : String(next);
        const style = this.parentNode;
        const wholeText = () => styleTextWith(style, piece, this, this);
        if (
          isStyleTextNode(this) &&
          rewroteSplitStyleText(style, piece, wholeText, "style.textContent")
        ) {
          return;
        }
        nativeSet.call(this, next);
      },
    }));
  };

  const patchStyleTextNodeSetter = (proto, prop, label) => {
    U.wrapSetter(proto, prop, (nativeSet) => ({
      set(value) {
        if (disabled || !isStyleTextNode(this)) {
          nativeSet.call(this, value);
          return;
        }
        const next = sanitizeStyleText(label, value);
        const piece = next == null ? "" : String(next);
        const style = this.parentNode;
        const wholeText = () => styleTextWith(style, piece, this, this);
        if (rewroteSplitStyleText(style, piece, wholeText, label)) return;
        nativeSet.call(this, next);
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
        const text = U.htmlSinkText(value, true);
        const next = isStyleElement(this)
          ? sanitizeStyleText("style.innerHTML", text)
          : sanitizeStyleMarkup(text, "style.innerHTML", innerHTMLDesc);
        nativeSet.call(this, U.htmlSinkValue(value, text, next));
      },
    }));
  };

  const patchOuterHTML = (proto, innerHTMLDesc) => {
    if (!innerHTMLDesc) return;
    U.wrapSetter(proto, "outerHTML", (nativeSet) => ({
      set(value) {
        if (disabled) {
          nativeSet.call(this, value);
          return;
        }
        const text = U.htmlSinkText(value, true);
        const next = sanitizeStyleMarkup(text, "style.outerHTML", innerHTMLDesc);
        nativeSet.call(this, U.htmlSinkValue(value, text, next));
      },
    }));
  };

  const patchInsertAdjacentHTML = (proto, innerHTMLDesc) => {
    if (!innerHTMLDesc) return;
    U.wrapMethod(proto, "insertAdjacentHTML", (orig) => ({
      insertAdjacentHTML(position, html) {
        if (disabled || arguments.length < 2) return orig.apply(this, arguments);
        const text = U.htmlSinkText(html, false);
        const next = isStyleElement(this)
          ? sanitizeStyleText("style.insertAdjacentHTML", text)
          : sanitizeStyleMarkup(text, "style.insertAdjacentHTML", innerHTMLDesc);
        return orig.call(this, position, U.htmlSinkValue(html, text, next));
      },
    }));
  };

  const patchInsertAdjacentText = (proto) => {
    U.wrapMethod(proto, "insertAdjacentText", (orig) => ({
      insertAdjacentText(position, text) {
        if (disabled || !isStyleElement(this)) return orig.call(this, position, text);
        const label = "style.insertAdjacentText";
        const nextText = sanitizeStyleText(label, text);
        const where = String(position).toLowerCase();
        if (where === "afterbegin" || where === "beforeend") {
          const at = where === "afterbegin" ? this.firstChild : null;
          const piece = String(nextText);
          const wholeText = () => styleTextWith(this, piece, at, null);
          if (rewroteSplitStyleText(this, piece, wholeText, label)) return undefined;
        }
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
        if (isStyleElement(this)) {
          // appendChild puts the node last; insertBefore / replaceChild at rest[0].
          const at = name === "appendChild" ? null : rest[0] || null;
          const replaced = name === "replaceChild" ? at : null;
          const piece = pieceTextOf(node);
          const wholeText = () => styleTextWith(this, piece, at, replaced);
          if (rewroteSplitStyleText(this, piece, wholeText, label)) {
            return name === "replaceChild" ? rest[0] : node;
          }
        }
        return orig.call(this, node, ...rest);
      },
    }));
  };

  const patchElementInsertionMethod = (proto, name, label) => {
    U.wrapMethod(proto, name, (orig) => ({
      [name](...args) {
        if (disabled) return orig.apply(this, args);
        const nextArgs = scrubInsertionArgs(this, args, label);
        if (isStyleElement(this)) {
          // All the call's pieces together, so a URL split between them counts.
          const piece = nextArgs.map(pieceTextOf).join("");
          const at = name === "prepend" ? this.firstChild : null;
          const wholeText = () =>
            name === "replaceChildren" ? piece : styleTextWith(this, piece, at, null);
          if (rewroteSplitStyleText(this, piece, wholeText, label)) return undefined;
        }
        return orig.apply(this, nextArgs);
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
