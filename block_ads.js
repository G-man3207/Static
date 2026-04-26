/* eslint-disable max-lines, max-statements -- MAIN-world ad observers are safer kept contiguous */
// Static - MAIN-world observe-only ad behavior logger.
(() => {
  const BRIDGE_EVENT = "__static_ad_bridge_init__";
  const SIGNALS = globalThis.__static_ad_signals__ || {};
  const REASONS =
    SIGNALS.reasons ||
    Object.freeze({
      AD_IFRAME_SIZE: "ad_iframe.size",
      AMAZON_TAM_AUCTION: "amazon_tam.auction",
      GPT_SLOT: "gpt.slot",
      IMPRESSION_BEACON: "impression_beacon",
      OMID_MEASUREMENT: "omid.measurement",
      PREBID_AUCTION: "prebid.auction",
      SPONSORED_DOM: "sponsored_dom",
      STICKY_AD: "sticky_ad",
      VIDEO_AD: "video_ad",
      VIEWABILITY_PING: "viewability_ping",
    });
  const AD_SIZES =
    SIGNALS.sizes ||
    Object.freeze([
      Object.freeze([300, 250]),
      Object.freeze([728, 90]),
      Object.freeze([320, 50]),
      Object.freeze([160, 600]),
      Object.freeze([300, 600]),
      Object.freeze([970, 250]),
    ]);
  const scoreForReasons =
    SIGNALS.scoreForReasons ||
    ((reasonCounts) =>
      Object.keys(reasonCounts || {}).reduce(
        (sum, reason) => sum + (reason === REASONS.SPONSORED_DOM ? 1 : 2),
        0
      ));
  const confidenceForReasons = SIGNALS.confidenceForReasons || (() => "low");
  const VALID_REASONS = new Set(Object.values(REASONS));
  const SOURCE_URL_RE = /\b(?:https?):\/\/[^\s)]+/g;
  const SPONSORED_TOKEN_RE =
    /(?:^|[\s_-])(?:ad|ads|adslot|advert|advertisement|sponsored|promoted)(?:$|[\s_-])/i;
  const SPONSORED_ATTR_RE = /^data-(?:ad|ads|adslot|sponsored|promoted)(?:-|$)/i;
  const BROAD_SELECTOR_TOKENS = new Set([
    "ad",
    "ads",
    "advert",
    "advertisement",
    "banner",
    "promoted",
    "sponsor",
    "sponsored",
  ]);
  const BEACON_PATH_RE =
    /(?:^|[/?&_.-])(?:impression|impressions|viewability|viewable|beacon|pixel|adview|ad-view)(?:$|[/?&=_.-])/i;
  const VIEWABILITY_PATH_RE = /(?:^|[/?&_.-])(?:viewability|viewable)(?:$|[/?&=_.-])/i;
  const VIDEO_PATH_RE = /(?:^|[/_.-])(?:ima3?|vast|vmap|video[-_]?ad)(?:$|[/_.-])/i;
  const OMID_PATH_RE = /(?:^|[/_.-])omid(?:$|[/_.-])/i;
  const PREBID_PATH_RE = /(?:^|[/_.-])prebid(?:$|[/_.-])/i;
  const APSTAG_PATH_RE = /(?:^|[/_.-])apstag(?:$|[/_.-])/i;
  const MAX_COSMETIC_CANDIDATES = 4;
  const MAX_QUEUED_SIGNALS = 100;
  const queuedSignals = [];
  const reasonCounts = {};
  const reportedOnce = new Set();
  const reportedIframeSizes = new WeakSet();
  const reportedSponsoredNodes = new WeakSet();
  const reportedStickyNodes = new WeakSet();
  const adLikeNodes = new WeakSet();
  const imageBeaconUrls = new WeakMap();
  const wrappedMethods = new WeakSet();
  let bridgePort = null;
  let domObserver = null;
  let scanTicks = 0;

  try {
    delete globalThis.__static_ad_signals__;
  } catch {}

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

  const copyConstructorStatics = (wrapped, original) => {
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
      } catch {}
    }
  };

  const redactPathSegment = (segment) => {
    if (!segment) return segment;
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)
    ) {
      return ":uuid";
    }
    if (/^[0-9a-f]{16,}$/i.test(segment)) return ":hex";
    if (/^\d{5,}$/.test(segment)) return ":num";
    if (segment.length >= 24 && /[a-z]/i.test(segment) && /\d/.test(segment)) {
      const ext = segment.match(/\.[a-z0-9]{1,8}$/i);
      return ext ? `:token${ext[0].toLowerCase()}` : ":token";
    }
    return segment;
  };

  const redactedPathnameFor = (pathname) =>
    String(pathname || "")
      .split("/")
      .map(redactPathSegment)
      .join("/");

  const firstStringEntry = (value) => {
    if (typeof value === "string") return value;
    if (typeof URL !== "undefined" && value instanceof URL) return value.href;
    if (typeof Request !== "undefined" && value instanceof Request) return value.url;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = firstStringEntry(item);
        if (found) return found;
      }
    }
    return "";
  };

  const parsedUrlFor = (value) => {
    const candidate = firstStringEntry(value);
    if (!candidate) return null;
    try {
      return new URL(candidate, location.href);
    } catch {
      return null;
    }
  };

  const sourceLabelFor = (url) => {
    const parsed = parsedUrlFor(url);
    if (!parsed) return "";
    return `script:${parsed.origin}${redactedPathnameFor(parsed.pathname)}`.slice(0, 160);
  };

  const endpointLabelFor = (url) => {
    const parsed = parsedUrlFor(url);
    if (!parsed) return "";
    const path = redactedPathnameFor(parsed.pathname) || "/";
    const label =
      parsed.origin === location.origin ? `same-origin:${path}` : `${parsed.origin}${path}`;
    return label.slice(0, 160);
  };

  const stackAdSource = () => {
    try {
      const stack = String(new Error().stack || "");
      for (const match of stack.matchAll(SOURCE_URL_RE)) {
        const candidate = match[0].replace(/:\d+(?::\d+)?$/, "");
        const parsed = parsedUrlFor(candidate);
        if (
          !parsed ||
          (parsed.origin === location.origin && parsed.pathname === location.pathname)
        ) {
          continue;
        }
        return sourceLabelFor(parsed.href);
      }
    } catch {}
    return "";
  };

  const currentAdSource = () => {
    try {
      if (document.currentScript && document.currentScript.src) {
        return sourceLabelFor(document.currentScript.src);
      }
    } catch {}
    return stackAdSource() || "inline-or-runtime";
  };

  const cssEscape = (value) => {
    const text = String(value || "");
    try {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(text);
    } catch {}
    return text.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  const selectorTokenIsUnstable = (token) => {
    const value = String(token || "");
    if (/^[0-9a-f]{12,}$/i.test(value)) return true;
    if (/\d{5,}/.test(value)) return true;
    return value.length >= 24 && /[a-z]/i.test(value) && /\d/.test(value);
  };

  const selectorDiagnosticReason = (token) => {
    const value = String(token || "").toLowerCase();
    if (BROAD_SELECTOR_TOKENS.has(value)) return "broad-selector";
    if (selectorTokenIsUnstable(value)) return "unstable-selector";
    return "";
  };

  const classTokensFor = (element) => {
    const className =
      typeof element.className === "string" ? element.className : element.getAttribute("class");
    return String(className || "")
      .split(/\s+/)
      .filter(Boolean);
  };

  const selectorCandidateFor = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    const tagName = String(element.tagName || "div").toLowerCase();
    const id = String(element.id || "");
    if (id) {
      const reason = selectorDiagnosticReason(id);
      return {
        diagnosticOnly: !!reason,
        kind: "selector",
        reason,
        value: `#${cssEscape(id)}`,
      };
    }
    const adClass = classTokensFor(element).find((token) => SPONSORED_TOKEN_RE.test(token));
    if (!adClass) return null;
    const reason = selectorDiagnosticReason(adClass);
    return {
      diagnosticOnly: !!reason,
      kind: "selector",
      reason,
      value: `${tagName}.${cssEscape(adClass)}`,
    };
  };

  const selectorCandidateForSlotId = (slotId) => {
    if (typeof slotId !== "string" || !slotId || /\s/.test(slotId)) return null;
    try {
      const element = document.getElementById(slotId);
      if (element) return selectorCandidateFor(element);
    } catch {}
    const reason = selectorDiagnosticReason(slotId);
    return {
      diagnosticOnly: !!reason,
      kind: "selector",
      reason,
      value: `#${cssEscape(slotId)}`,
    };
  };

  const iframeForStructure = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    if (String(element.tagName || "").toLowerCase() === "iframe") return element;
    try {
      return element.querySelector && element.querySelector("iframe");
    } catch {
      return null;
    }
  };

  const structuralCandidateFor = (element) => {
    const iframe = iframeForStructure(element);
    if (iframe) {
      const [width, height] = iframeSizeFor(iframe);
      if (isKnownAdSize(width, height)) {
        const parent = iframe.parentElement || element;
        const tagName = String(parent && parent.tagName ? parent.tagName : "div").toLowerCase();
        let position = "";
        try {
          const computed = getComputedStyle(parent);
          if (computed.position === "fixed" || computed.position === "sticky") {
            position = `,position:${computed.position}`;
          }
        } catch {}
        return {
          diagnosticOnly: false,
          kind: "structure",
          reason: "",
          value: `iframe:${Math.round(width)}x${Math.round(height)},parent:${tagName}${position}`,
        };
      }
    }
    if (hasSponsoredName(element)) {
      return {
        diagnosticOnly: true,
        kind: "structure",
        reason: "weak-dom-only",
        value: `element:${String(element.tagName || "div").toLowerCase()},sponsored-name`,
      };
    }
    return null;
  };

  const cosmeticCandidatesFor = (element) => {
    const target =
      element && String(element.tagName || "").toLowerCase() === "iframe"
        ? element.parentElement || element
        : element;
    const candidates = [selectorCandidateFor(target), structuralCandidateFor(element)].filter(
      Boolean
    );
    return candidates.slice(0, MAX_COSMETIC_CANDIDATES);
  };

  const sanitizeCosmeticCandidate = (candidate) => ({
    diagnosticOnly: !!(candidate && candidate.diagnosticOnly),
    kind: String((candidate && candidate.kind) || "").slice(0, 32),
    reason: String((candidate && candidate.reason) || "").slice(0, 64),
    value: String((candidate && candidate.value) || "").slice(0, 160),
  });

  const sanitizeSignal = (signal) => ({
    confidence: String(signal.confidence || "learning").slice(0, 16),
    cosmetic: Array.isArray(signal.cosmetic)
      ? signal.cosmetic.map(sanitizeCosmeticCandidate).slice(0, MAX_COSMETIC_CANDIDATES)
      : [],
    endpoint: String(signal.endpoint || "").slice(0, 160),
    reasons: Array.isArray(signal.reasons)
      ? signal.reasons.map((reason) => String(reason).slice(0, 64)).slice(0, 12)
      : [],
    resourceType: String(signal.resourceType || "").slice(0, 32),
    score: Math.max(0, Math.min(100, Math.round(signal.score || 0))),
    source: String(signal.source || "unknown").slice(0, 160),
  });

  const postAdSignal = (signal) => {
    const safeSignal = sanitizeSignal(signal);
    if (bridgePort) {
      try {
        bridgePort.postMessage({ type: "ad_signal", signal: safeSignal });
        return;
      } catch {
        bridgePort = null;
      }
    }
    if (queuedSignals.length < MAX_QUEUED_SIGNALS) queuedSignals.push(safeSignal);
  };

  const flushQueuedSignals = () => {
    if (!bridgePort) return;
    const batch = queuedSignals.splice(0, queuedSignals.length);
    for (const signal of batch) {
      try {
        bridgePort.postMessage({ type: "ad_signal", signal });
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
    try {
      bridgePort.start();
    } catch {}
    flushQueuedSignals();
    document.removeEventListener(BRIDGE_EVENT, onBridgeInit);
  };
  document.addEventListener(BRIDGE_EVENT, onBridgeInit);

  const recordAdSignal = (reason, detail = {}) => {
    if (!VALID_REASONS.has(reason)) return;
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    postAdSignal({
      confidence: confidenceForReasons(reasonCounts),
      cosmetic: Array.isArray(detail.cosmetic) ? detail.cosmetic : [],
      endpoint: detail.endpoint || "",
      reasons: [reason],
      resourceType: detail.resourceType || "",
      score: scoreForReasons(reasonCounts),
      source: detail.source || currentAdSource(),
    });
  };

  const recordOnce = (key, reason, detail = {}) => {
    if (reportedOnce.has(key)) return;
    reportedOnce.add(key);
    recordAdSignal(reason, detail);
  };

  const hasAdEvidence = () => Object.keys(reasonCounts).some((reason) => reasonCounts[reason] > 0);

  const patchObjectMethod = (target, key, recorder) => {
    const orig = target && target[key];
    if (typeof orig !== "function" || wrappedMethods.has(orig)) return;
    const wrapped = function (...args) {
      try {
        recorder.apply(this, args);
      } catch {}
      return orig.apply(this, args);
    };
    const stealthed = stealth(wrapped, key, {
      length: orig.length,
      source: nativeSourceFor(orig, key),
    });
    wrappedMethods.add(stealthed);
    try {
      const desc = Object.getOwnPropertyDescriptor(target, key) || {
        configurable: true,
        enumerable: true,
        writable: true,
      };
      Object.defineProperty(target, key, { ...desc, value: stealthed });
    } catch {
      try {
        target[key] = stealthed;
      } catch {}
    }
  };

  const isObjectLike = (value) =>
    value && (typeof value === "object" || typeof value === "function");

  const instrumentGoogletag = (value) => {
    if (!isObjectLike(value)) return value;
    patchObjectMethod(value, "defineSlot", (_path, _size, slotId) =>
      recordAdSignal(REASONS.GPT_SLOT, {
        cosmetic: [selectorCandidateForSlotId(slotId)].filter(Boolean),
      })
    );
    patchObjectMethod(value, "defineOutOfPageSlot", (_path, slotId) =>
      recordAdSignal(REASONS.GPT_SLOT, {
        cosmetic: [selectorCandidateForSlotId(slotId)].filter(Boolean),
      })
    );
    patchObjectMethod(value, "pubads", () => recordAdSignal(REASONS.GPT_SLOT));
    return value;
  };

  const instrumentPrebid = (value) => {
    if (!isObjectLike(value)) return value;
    patchObjectMethod(value, "requestBids", () => recordAdSignal(REASONS.PREBID_AUCTION));
    patchObjectMethod(value, "sendAllBids", () => recordAdSignal(REASONS.PREBID_AUCTION));
    return value;
  };

  const instrumentAmazonTam = (value) => {
    if (!isObjectLike(value)) return value;
    patchObjectMethod(value, "fetchBids", () => recordAdSignal(REASONS.AMAZON_TAM_AUCTION));
    patchObjectMethod(value, "setDisplayBids", () => recordAdSignal(REASONS.AMAZON_TAM_AUCTION));
    return value;
  };

  const patchWindowValue = (name, transform) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(window, name);
      if (desc && desc.configurable === false) return;
      const enumerable = desc ? desc.enumerable : true;
      let currentValue = undefined;
      if (desc && Object.prototype.hasOwnProperty.call(desc, "value")) {
        currentValue = transform(desc.value);
      }
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable,
        get: stealth(
          function get() {
            return currentValue;
          },
          `get ${name}`,
          { length: 0 }
        ),
        set: stealth(
          function set(value) {
            currentValue = transform(value);
          },
          `set ${name}`,
          { length: 1 }
        ),
      });
    } catch {}
  };

  const numericDimension = (value) => {
    const number = Number.parseFloat(String(value || "").replace(/px$/i, ""));
    return Number.isFinite(number) && number > 0 ? number : 0;
  };

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

  const isKnownAdSize = (width, height) =>
    AD_SIZES.some(
      ([adWidth, adHeight]) => Math.abs(width - adWidth) <= 2 && Math.abs(height - adHeight) <= 2
    );

  const isAdSizedIframe = (node) => {
    if (!node || String(node.tagName || "").toLowerCase() !== "iframe") return false;
    const [width, height] = iframeSizeFor(node);
    return isKnownAdSize(width, height);
  };

  const hasSponsoredName = (element) => {
    try {
      if (SPONSORED_TOKEN_RE.test(String(element.id || ""))) return true;
      if (SPONSORED_TOKEN_RE.test(String(element.className || ""))) return true;
      for (const attr of element.attributes || []) {
        if (SPONSORED_ATTR_RE.test(attr.name)) return true;
      }
    } catch {}
    return false;
  };

  const markAdLikeNode = (node) => {
    if (!node) return;
    adLikeNodes.add(node);
    if (node.parentElement) adLikeNodes.add(node.parentElement);
  };

  const isAdLikeElement = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (adLikeNodes.has(element) || hasSponsoredName(element) || isAdSizedIframe(element)) {
      return true;
    }
    try {
      const iframe = element.querySelector && element.querySelector("iframe");
      return !!(iframe && isAdSizedIframe(iframe));
    } catch {
      return false;
    }
  };

  const maybeRecordStickyAd = (node) => {
    let cursor = node && node.parentElement;
    let depth = 0;
    while (cursor && depth < 5) {
      try {
        const position = getComputedStyle(cursor).position;
        if ((position === "fixed" || position === "sticky") && !reportedStickyNodes.has(cursor)) {
          reportedStickyNodes.add(cursor);
          markAdLikeNode(cursor);
          recordAdSignal(REASONS.STICKY_AD, { cosmetic: cosmeticCandidatesFor(cursor) });
          return;
        }
      } catch {}
      cursor = cursor.parentElement;
      depth++;
    }
  };

  const inspectIframe = (iframe) => {
    if (!isAdSizedIframe(iframe)) return;
    markAdLikeNode(iframe);
    if (!reportedIframeSizes.has(iframe)) {
      reportedIframeSizes.add(iframe);
      recordAdSignal(REASONS.AD_IFRAME_SIZE, { cosmetic: cosmeticCandidatesFor(iframe) });
    }
    maybeRecordStickyAd(iframe);
  };

  const inspectSponsoredDom = (element) => {
    if (!hasSponsoredName(element) || reportedSponsoredNodes.has(element)) return;
    reportedSponsoredNodes.add(element);
    markAdLikeNode(element);
    recordAdSignal(REASONS.SPONSORED_DOM, { cosmetic: cosmeticCandidatesFor(element) });
  };

  const scriptMarkerFor = (url) => {
    const parsed = parsedUrlFor(url);
    if (!parsed) return null;
    const label = `${parsed.pathname} ${parsed.search}`.toLowerCase();
    if (PREBID_PATH_RE.test(label)) return REASONS.PREBID_AUCTION;
    if (APSTAG_PATH_RE.test(label)) return REASONS.AMAZON_TAM_AUCTION;
    if (VIDEO_PATH_RE.test(label)) return REASONS.VIDEO_AD;
    if (OMID_PATH_RE.test(label)) return REASONS.OMID_MEASUREMENT;
    return null;
  };

  const inspectScript = (script) => {
    const src = script && script.src;
    const reason = scriptMarkerFor(src);
    if (!reason) return;
    recordOnce(`script:${reason}:${sourceLabelFor(src)}`, reason, { source: sourceLabelFor(src) });
  };

  const beaconReasonFor = (url) => {
    const parsed = parsedUrlFor(url);
    if (!parsed) return null;
    const label = `${parsed.pathname} ${parsed.search}`.toLowerCase();
    if (!BEACON_PATH_RE.test(label)) return null;
    return VIEWABILITY_PATH_RE.test(label) ? REASONS.VIEWABILITY_PING : REASONS.IMPRESSION_BEACON;
  };

  const resourceTypeFor = (where) => {
    if (where === "sendBeacon") return "ping";
    if (where === "image") return "image";
    if (where === "fetch" || where === "xhr") return "xmlhttprequest";
    return "other";
  };

  const recordAdNetwork = (where, url) => {
    if (!hasAdEvidence()) return;
    const reason = beaconReasonFor(url);
    if (!reason) return;
    const endpoint = endpointLabelFor(url);
    recordAdSignal(reason, { endpoint, resourceType: resourceTypeFor(where) });
  };

  const inspectImageBeacon = (img) => {
    const src = img && img.currentSrc ? img.currentSrc : img && img.src;
    if (!src || imageBeaconUrls.get(img) === src) return;
    imageBeaconUrls.set(img, src);
    recordAdNetwork("image", src);
  };

  const inspectElement = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    const tagName = String(node.tagName || "").toLowerCase();
    inspectSponsoredDom(node);
    if (tagName === "iframe") inspectIframe(node);
    if (tagName === "script") inspectScript(node);
    if (tagName === "img") inspectImageBeacon(node);
  };

  const inspectSubtree = (node) => {
    inspectElement(node);
    if (!node || typeof node.querySelectorAll !== "function") return;
    let inspected = 0;
    for (const element of node.querySelectorAll("iframe,script,img,[id],[class]")) {
      if (inspected >= 250) break;
      inspectElement(element);
      inspected++;
    }
  };

  const handleMutations = (records) => {
    for (const record of records) {
      if (record.type === "childList") {
        for (const node of record.addedNodes || []) inspectSubtree(node);
      }
      if (record.type === "attributes") inspectSubtree(record.target);
    }
  };

  const startDomObserver = () => {
    if (domObserver || typeof MutationObserver !== "function") return;
    try {
      domObserver = new MutationObserver(handleMutations);
      domObserver.observe(document.documentElement || document, {
        attributeFilter: ["class", "height", "id", "src", "style", "width"],
        attributes: true,
        childList: true,
        subtree: true,
      });
      inspectSubtree(document.documentElement);
    } catch {}
  };

  const patchIntersectionObserver = () => {
    const OrigIntersectionObserver = window.IntersectionObserver;
    if (typeof OrigIntersectionObserver !== "function") return;
    const WrappedIntersectionObserver = function IntersectionObserver(callback, options) {
      const observer = new OrigIntersectionObserver(callback, options);
      const origObserve = observer.observe;
      observer.observe = stealth(
        function observe(target) {
          try {
            if (isAdLikeElement(target)) {
              recordAdSignal(REASONS.VIEWABILITY_PING, { cosmetic: cosmeticCandidatesFor(target) });
            }
          } catch {}
          return origObserve.apply(this, arguments);
        },
        "observe",
        { length: 1, source: nativeSourceFor(origObserve, "observe") }
      );
      return observer;
    };
    WrappedIntersectionObserver.prototype = OrigIntersectionObserver.prototype;
    copyConstructorStatics(WrappedIntersectionObserver, OrigIntersectionObserver);
    alignPrototypeConstructor(WrappedIntersectionObserver, OrigIntersectionObserver);
    window.IntersectionObserver = stealth(WrappedIntersectionObserver, "IntersectionObserver", {
      length: 1,
      source: nativeSourceFor(OrigIntersectionObserver, "IntersectionObserver"),
    });
  };

  const patchNetworkApis = () => {
    patchObjectMethod(window, "fetch", (input) => recordAdNetwork("fetch", input));
    const xhrUrls = new WeakMap();
    patchObjectMethod(XMLHttpRequest.prototype, "open", function (_method, url) {
      xhrUrls.set(this, url);
    });
    patchObjectMethod(XMLHttpRequest.prototype, "send", function () {
      if (xhrUrls.has(this)) recordAdNetwork("xhr", xhrUrls.get(this));
    });
    try {
      const navProto = Object.getPrototypeOf(navigator);
      const desc = navProto && Object.getOwnPropertyDescriptor(navProto, "sendBeacon");
      const orig = desc && desc.value;
      if (typeof orig === "function" && !wrappedMethods.has(orig)) {
        const wrapped = function sendBeacon(url) {
          recordAdNetwork("sendBeacon", url);
          return orig.apply(this, arguments);
        };
        const stealthed = stealth(wrapped, "sendBeacon", {
          length: orig.length,
          source: nativeSourceFor(orig, "sendBeacon"),
        });
        wrappedMethods.add(stealthed);
        Object.defineProperty(navProto, "sendBeacon", { ...desc, value: stealthed });
      }
    } catch {}
  };

  const patchImageSrc = () => {
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
      if (!desc || typeof desc.set !== "function") return;
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        ...desc,
        set: stealth(
          function set(value) {
            try {
              recordAdNetwork("image", value);
            } catch {}
            return desc.set.call(this, value);
          },
          "set src",
          { length: 1, source: nativeSourceFor(desc.set, "set src") }
        ),
      });
    } catch {}
  };

  const scanRuntimeMarkers = () => {
    scanTicks++;
    try {
      instrumentGoogletag(window.googletag);
    } catch {}
    try {
      instrumentPrebid(window.pbjs);
    } catch {}
    try {
      instrumentAmazonTam(window.apstag);
    } catch {}
    try {
      if (window.google && window.google.ima) recordOnce("global:google.ima", REASONS.VIDEO_AD);
    } catch {}
    try {
      if (window.omid || window.omidSessionInterface) {
        recordOnce("global:omid", REASONS.OMID_MEASUREMENT);
      }
    } catch {}
    try {
      for (const script of document.scripts || []) inspectScript(script);
    } catch {}
    if (scanTicks < 20) setTimeout(scanRuntimeMarkers, 500);
  };

  try {
    patchWindowValue("googletag", instrumentGoogletag);
    patchWindowValue("pbjs", instrumentPrebid);
    patchWindowValue("apstag", instrumentAmazonTam);
    startDomObserver();
    patchIntersectionObserver();
    patchNetworkApis();
    patchImageSrc();
    setTimeout(scanRuntimeMarkers, 0);
  } catch {}
})();
