// Static - ISOLATED-world opt-in cosmetic cleanup for locally learned ad slots.
(() => {
  const MODE_COSMETIC = "cosmetic";
  const HIGH_SCORE = 80;
  const MIN_HITS = 2;
  const MARK_ATTR = "data-static-ad-cleanup";
  const ENTRY_ATTR = "data-static-ad-entry";
  const MARK_CLASS = "static-ad-cleanup";
  const HIDDEN_CLASS = "static-ad-cleanup-hidden";
  const COLLAPSED_CLASS = "static-ad-cleanup-collapsed";
  const AD_SIZES = Object.freeze([
    Object.freeze([300, 250]),
    Object.freeze([728, 90]),
    Object.freeze([320, 50]),
    Object.freeze([160, 600]),
    Object.freeze([300, 600]),
    Object.freeze([970, 250]),
  ]);
  const AD_TOKEN_RE =
    /(?:^|[\s_-])(?:ad|ads|adslot|advert|advertisement|dfp|gpt|promoted|sponsor|sponsored)(?:$|[\s_-])/i;
  const AD_URL_RE =
    /(?:^|[/_.-])(?:ad|ads|adserver|adslot|advert|auction|bid|creative|dfp|doubleclick|gpt|googleads|impression|prebid|pubads|sponsor|sponsored)(?:$|[/_.-])/i;
  const EMPTY_LABEL_RE = /^(?:ad|ads|advertisement|advertising|sponsored|promoted)?$/i;
  const SAFE_SELECTOR_RE = /^(?:#[^,>+~\s]+|[a-z][a-z0-9-]*\.[^,>+~\s]+)$/i;
  const STRUCTURE_RE =
    /^iframe:(\d{2,4})x(\d{2,4}),parent:([a-z0-9-]+)(?:,position:(fixed|sticky))?$/i;
  const SKIP_TARGET_TAGS = new Set([
    "article",
    "audio",
    "button",
    "canvas",
    "dialog",
    "footer",
    "form",
    "header",
    "input",
    "main",
    "nav",
    "select",
    "textarea",
    "video",
  ]);
  const HIDE_PROPS = ["visibility", "pointer-events"];
  const COLLAPSE_PROPS = [
    "border",
    "display",
    "height",
    "margin",
    "max-height",
    "max-width",
    "min-height",
    "min-width",
    "overflow",
    "padding",
    "width",
  ];
  const managedNodes = new Map();
  let currentConfig = { active: false, entries: [] };
  let observer = null;
  let scanTimer = 0;
  let applying = false;

  const pageOrigin = () => {
    try {
      return location.origin === "null" ? "" : location.origin;
    } catch {
      return "";
    }
  };

  const origin = pageOrigin();
  if (!origin || !(chrome && chrome.storage && chrome.storage.local)) return;

  const numericDimension = (value) => {
    const number = Number.parseFloat(String(value || "").replace(/px$/i, ""));
    return Number.isFinite(number) && number > 0 ? number : 0;
  };

  const elementText = (element) =>
    String((element && element.textContent) || "")
      .replace(/\s+/g, " ")
      .trim();

  const tokenFromSelector = (selector) => {
    const value = String(selector || "");
    const idMatch = value.match(/^#(.+)$/);
    if (idMatch) return idMatch[1].replace(/\\/g, "");
    const classMatch = value.match(/^[a-z][a-z0-9-]*\.(.+)$/i);
    return classMatch ? classMatch[1].replace(/\\/g, "") : "";
  };

  const hasAdToken = (value) => AD_TOKEN_RE.test(String(value || ""));

  const hasAdUrlToken = (value) => {
    try {
      const parsed = new URL(String(value || ""), location.href);
      return AD_URL_RE.test(`${parsed.hostname}${parsed.pathname}`);
    } catch {
      return AD_URL_RE.test(String(value || ""));
    }
  };

  const attrHasAdToken = (element) => {
    try {
      for (const attr of element.attributes || []) {
        if (hasAdToken(attr.name) || hasAdToken(attr.value)) return true;
      }
    } catch {}
    return false;
  };

  const elementHasAdMarker = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (hasAdToken(element.id) || hasAdToken(element.className)) return true;
    if (
      hasAdToken(element.getAttribute("aria-label")) ||
      hasAdToken(element.getAttribute("title"))
    ) {
      return true;
    }
    if (attrHasAdToken(element)) return true;
    const tagName = String(element.tagName || "").toLowerCase();
    if (tagName === "iframe") {
      return (
        hasAdUrlToken(element.getAttribute("src")) ||
        hasAdToken(element.getAttribute("name")) ||
        hasAdToken(element.getAttribute("title"))
      );
    }
    return false;
  };

  const isKnownAdSize = (width, height) =>
    AD_SIZES.some(
      ([adWidth, adHeight]) => Math.abs(width - adWidth) <= 2 && Math.abs(height - adHeight) <= 2
    );

  const iframeSizeFor = (iframe) => {
    const attrWidth = numericDimension(iframe.getAttribute("width"));
    const attrHeight = numericDimension(iframe.getAttribute("height"));
    if (attrWidth && attrHeight) return [attrWidth, attrHeight];
    const styleWidth = numericDimension(iframe.style && iframe.style.width);
    const styleHeight = numericDimension(iframe.style && iframe.style.height);
    if (styleWidth && styleHeight) return [styleWidth, styleHeight];
    try {
      const computed = getComputedStyle(iframe);
      const cssWidth = numericDimension(computed.width);
      const cssHeight = numericDimension(computed.height);
      if (cssWidth && cssHeight) return [cssWidth, cssHeight];
    } catch {}
    try {
      const rect = iframe.getBoundingClientRect();
      if (rect.width && rect.height) return [rect.width, rect.height];
    } catch {}
    return [0, 0];
  };

  const isKnownAdIframe = (element) => {
    if (!element || String(element.tagName || "").toLowerCase() !== "iframe") return false;
    const [width, height] = iframeSizeFor(element);
    return isKnownAdSize(width, height);
  };

  const knownAdIframesIn = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return [];
    if (isKnownAdIframe(element)) return [element];
    try {
      return Array.from(element.querySelectorAll("iframe")).filter(isKnownAdIframe);
    } catch {
      return [];
    }
  };

  const safeIframeDocumentIsEmpty = (iframe) => {
    try {
      const doc = iframe.contentDocument;
      if (!doc || !doc.body) return true;
      return elementText(doc.body) === "" && doc.body.children.length === 0;
    } catch {
      return false;
    }
  };

  const iframeIsEmpty = (iframe) => {
    const src = String(iframe.getAttribute("src") || "")
      .trim()
      .toLowerCase();
    const srcdoc = String(iframe.getAttribute("srcdoc") || "").trim();
    if (srcdoc) return false;
    if (!src || src === "about:blank" || src === "about:srcdoc") {
      return safeIframeDocumentIsEmpty(iframe);
    }
    return false;
  };

  const isEmptyAdContainer = (element) => {
    const text = elementText(element);
    if (text && !EMPTY_LABEL_RE.test(text)) return false;
    try {
      return Array.from(element.children || []).every((child) => {
        const tag = String(child.tagName || "").toLowerCase();
        return tag === "iframe" || tag === "ins" || tag === "script" || tag === "style";
      });
    } catch {
      return false;
    }
  };

  const targetIsUnsafe = (element) => {
    const tagName = String(element && element.tagName ? element.tagName : "").toLowerCase();
    if (!tagName || tagName === "html" || tagName === "body" || SKIP_TARGET_TAGS.has(tagName)) {
      return true;
    }
    const role = String(element.getAttribute && element.getAttribute("role"));
    return role === "navigation" || role === "banner" || role === "main" || role === "contentinfo";
  };

  const targetHasAdEvidence = (element, entry) => {
    if (!element || targetIsUnsafe(element)) return false;
    const selectorToken = entry && entry.kind === "selector" ? tokenFromSelector(entry.value) : "";
    const marker =
      elementHasAdMarker(element) ||
      hasAdToken(selectorToken) ||
      knownAdIframesIn(element).some(elementHasAdMarker);
    if (!marker) return false;
    return knownAdIframesIn(element).length > 0 || isEmptyAdContainer(element);
  };

  const actionForTarget = (element) => {
    if (String(element.tagName || "").toLowerCase() === "iframe" && iframeIsEmpty(element)) {
      return "collapse";
    }
    try {
      const computed = getComputedStyle(element);
      if (
        computed.position === "fixed" ||
        computed.position === "sticky" ||
        computed.position === "absolute"
      ) {
        return "collapse";
      }
    } catch {}
    if (isEmptyAdContainer(element)) {
      try {
        const rect = element.getBoundingClientRect();
        if (rect.height <= 120) return "collapse";
      } catch {}
    }
    return "hide";
  };

  const snapshotStyles = (element, props) => {
    const styles = {};
    for (const prop of props) {
      styles[prop] = {
        priority: element.style.getPropertyPriority(prop),
        value: element.style.getPropertyValue(prop),
      };
    }
    return styles;
  };

  const restoreStyleSnapshot = (element, styles) => {
    for (const [prop, snapshot] of Object.entries(styles || {})) {
      if (snapshot.value) {
        element.style.setProperty(prop, snapshot.value, snapshot.priority || "");
      } else {
        element.style.removeProperty(prop);
      }
    }
  };

  const attrSnapshotFor = (element) => ({
    entry: element.getAttribute(ENTRY_ATTR),
    mark: element.getAttribute(MARK_ATTR),
  });

  const restoreAttr = (element, name, value) => {
    if (value == null) {
      element.removeAttribute(name);
    } else {
      element.setAttribute(name, value);
    }
  };

  const restoreNode = (element) => {
    const state = managedNodes.get(element);
    if (!state) return;
    restoreStyleSnapshot(element, state.styles);
    restoreAttr(element, MARK_ATTR, state.attrs.mark);
    restoreAttr(element, ENTRY_ATTR, state.attrs.entry);
    try {
      element.classList.remove(MARK_CLASS, HIDDEN_CLASS, COLLAPSED_CLASS);
      for (const className of state.classes) element.classList.add(className);
    } catch {}
    managedNodes.delete(element);
  };

  const restoreAll = () => {
    for (const element of Array.from(managedNodes.keys())) restoreNode(element);
  };

  const styleNode = (element, action) => {
    if (action === "collapse") {
      element.style.setProperty("display", "none", "important");
      element.style.setProperty("width", "0px", "important");
      element.style.setProperty("height", "0px", "important");
      element.style.setProperty("min-width", "0px", "important");
      element.style.setProperty("min-height", "0px", "important");
      element.style.setProperty("max-width", "0px", "important");
      element.style.setProperty("max-height", "0px", "important");
      element.style.setProperty("margin", "0px", "important");
      element.style.setProperty("padding", "0px", "important");
      element.style.setProperty("border", "0px", "important");
      element.style.setProperty("overflow", "hidden", "important");
      return;
    }
    element.style.setProperty("visibility", "hidden", "important");
    element.style.setProperty("pointer-events", "none", "important");
  };

  const markNode = (element, action, entry, seen) => {
    seen.add(element);
    const existing = managedNodes.get(element);
    if (existing && existing.action === action) return;
    if (existing) restoreNode(element);
    const props = action === "collapse" ? COLLAPSE_PROPS : HIDE_PROPS;
    managedNodes.set(element, {
      action,
      attrs: attrSnapshotFor(element),
      classes: Array.from(element.classList || []).filter((className) =>
        [MARK_CLASS, HIDDEN_CLASS, COLLAPSED_CLASS].includes(className)
      ),
      styles: snapshotStyles(element, props),
    });
    styleNode(element, action);
    element.setAttribute(MARK_ATTR, action);
    element.setAttribute(ENTRY_ATTR, `${entry.kind}:${String(entry.value || "").slice(0, 80)}`);
    try {
      element.classList.add(MARK_CLASS, action === "collapse" ? COLLAPSED_CLASS : HIDDEN_CLASS);
    } catch {}
  };

  const activeEntry = (entry) =>
    entry &&
    !entry.diagnosticOnly &&
    (entry.kind === "selector" || entry.kind === "structure") &&
    (entry.hits || 0) >= MIN_HITS &&
    (entry.score || 0) >= HIGH_SCORE;

  const selectorTargets = (entry) => {
    const selector = String(entry.value || "");
    if (!SAFE_SELECTOR_RE.test(selector)) return [];
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch {
      return [];
    }
  };

  const structureTargets = (entry) => {
    const match = String(entry.value || "").match(STRUCTURE_RE);
    if (!match) return [];
    const expectedWidth = Number.parseInt(match[1], 10);
    const expectedHeight = Number.parseInt(match[2], 10);
    const parentTag = match[3].toLowerCase();
    const targets = [];
    for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
      const [width, height] = iframeSizeFor(iframe);
      const parent = iframe.parentElement || iframe;
      const tagName = String(parent.tagName || "").toLowerCase();
      if (!isKnownAdSize(width, height) || !isKnownAdSize(expectedWidth, expectedHeight)) continue;
      if (tagName !== parentTag) continue;
      targets.push(parent);
      if (iframeIsEmpty(iframe) && (elementHasAdMarker(iframe) || elementHasAdMarker(parent))) {
        targets.push(iframe);
      }
    }
    return targets;
  };

  const targetsForEntry = (entry) =>
    entry.kind === "selector" ? selectorTargets(entry) : structureTargets(entry);

  const cleanEmptyIframesInside = (target, entry, seen) => {
    for (const iframe of knownAdIframesIn(target)) {
      if (!iframeIsEmpty(iframe)) continue;
      if (!elementHasAdMarker(iframe) && !elementHasAdMarker(target)) continue;
      markNode(iframe, "collapse", entry, seen);
    }
  };

  const cleanTarget = (target, entry, seen) => {
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
    cleanEmptyIframesInside(target, entry, seen);
    if (!targetHasAdEvidence(target, entry)) return;
    markNode(target, actionForTarget(target), entry, seen);
  };

  const applyCleanup = () => {
    scanTimer = 0;
    if (!currentConfig.active) {
      restoreAll();
      return;
    }
    applying = true;
    const seen = new Set();
    try {
      for (const entry of currentConfig.entries) {
        for (const target of targetsForEntry(entry)) cleanTarget(target, entry, seen);
      }
      for (const element of Array.from(managedNodes.keys())) {
        if (!seen.has(element)) restoreNode(element);
      }
    } finally {
      applying = false;
    }
  };

  const requestApply = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(applyCleanup, 0);
  };

  const cleanupModeFor = (prefs) => {
    const mode = prefs && prefs.mode;
    return mode === "diagnostic" || mode === MODE_COSMETIC ? mode : "off";
  };

  const siteCleanupDisabled = (prefs) => {
    const sites = (prefs && (prefs.sites || prefs.site)) || {};
    const site = sites[origin] || {};
    return !!(site.cleanupDisabled || site.disabled);
  };

  const configFromStored = (stored) => {
    const prefs = (stored && stored.ad_prefs) || {};
    const playbooks = (stored && stored.ad_playbooks) || {};
    const playbook = playbooks[origin] || {};
    const cosmetic = Array.isArray(playbook.cosmetic) ? playbook.cosmetic : [];
    const highPlaybook = playbook.confidence === "high" || !!playbook.cosmeticSafe;
    const active =
      cleanupModeFor(prefs) === MODE_COSMETIC &&
      highPlaybook &&
      !siteCleanupDisabled(prefs) &&
      !playbook.disabled;
    return {
      active,
      entries: active ? cosmetic.filter(activeEntry).slice(0, 24) : [],
    };
  };

  const refreshConfig = async () => {
    try {
      currentConfig = configFromStored(
        await chrome.storage.local.get({ ad_playbooks: {}, ad_prefs: {} })
      );
    } catch {
      currentConfig = { active: false, entries: [] };
    }
    requestApply();
  };

  const startObserver = () => {
    if (observer || typeof MutationObserver !== "function" || !document.documentElement) return;
    observer = new MutationObserver(() => {
      if (!applying) requestApply();
    });
    try {
      observer.observe(document.documentElement, {
        attributeFilter: ["aria-label", "class", "height", "id", "src", "style", "title", "width"],
        attributes: true,
        childList: true,
        subtree: true,
      });
    } catch {}
  };

  const init = () => {
    startObserver();
    refreshConfig();
  };

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || (!changes.ad_prefs && !changes.ad_playbooks)) return;
    refreshConfig();
  });

  if (document.documentElement) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  }
})();
