// Static — DOM-marker scrubber (ISOLATED world).
//
// Walks the DOM at load and watches every mutation, stripping any attributes,
// classes, or custom tags that browser extensions use to announce themselves
// to the page. Defeats a whole class of "is extension X installed?" checks
// that work by querying the DOM for vendor-specific selectors.
//
// Pattern lists come from lists.js. To keep an extension working, make sure
// its markers aren't matched by any pattern there.
(() => {
  const CFG = globalThis.__static_config__ || {};
  const ATTR_PATTERNS = CFG.domStripAttrs || [];
  const TAG_PATTERNS = CFG.domStripTags || [];
  const CLASS_PATTERNS = CFG.domStripClasses || [];
  if (!ATTR_PATTERNS.length && !TAG_PATTERNS.length && !CLASS_PATTERNS.length) return;

  // Collapse each pattern list into a single master regex. One `.test()` per
  // attribute/class/tag is far cheaper than `.some((p) => p.test(v))` over N
  // patterns on every DOM mutation of a heavy SPA. Each source keeps its own
  // anchors inside a non-capturing group, so alternation is exact.
  const combinePatterns = (patterns) => {
    if (!patterns || patterns.length === 0) return null;
    return new RegExp(patterns.map((p) => `(?:${p.source})`).join("|"), "i");
  };
  const ATTR_RE = combinePatterns(ATTR_PATTERNS);
  const TAG_RE = combinePatterns(TAG_PATTERNS);
  const CLASS_RE = combinePatterns(CLASS_PATTERNS);
  let disabled = false;
  const OBSERVE_OPTIONS = {
    attributes: true,
    childList: true,
    subtree: true,
  };
  const SHADOW_RESCAN_DELAYS_MS = [0, 50, 250, 1000];
  const observedRoots = new WeakSet();
  const scheduledShadowScans = new WeakSet();
  let obs = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "static_persona_update") {
      chrome.runtime
        .sendMessage({ type: "static_get_persona" })
        .then((response) => {
          if (response && typeof response.disabled === "boolean") {
            disabled = response.disabled;
          }
        })
        .catch(() => {});
    }
  });

  const matchesAny = (re, value) => re !== null && re.test(value);

  const scrubTag = (el) => {
    const tagName = el.tagName && el.tagName.toLowerCase();
    if (!tagName || !matchesAny(TAG_RE, tagName)) return false;
    try {
      el.remove();
      return true;
    } catch {
      return false;
    }
  };

  const scrubAttributes = (el) => {
    if (!el.attributes || !el.attributes.length) return;
    for (let i = el.attributes.length - 1; i >= 0; i--) {
      const attr = el.attributes[i];
      if (!matchesAny(ATTR_RE, attr.name.toLowerCase())) continue;
      try {
        el.removeAttribute(attr.name);
      } catch {}
    }
  };

  const scrubClasses = (el) => {
    if (!el.classList || !el.classList.length) return;
    const toRemove = [];
    for (const cls of el.classList) {
      if (matchesAny(CLASS_RE, cls)) toRemove.push(cls);
    }
    for (const cls of toRemove) {
      try {
        el.classList.remove(cls);
      } catch {}
    }
  };

  const scrubShadowRoot = (el) => {
    const root = el && el.shadowRoot;
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    scrubTree(root);
    if (obs) {
      try {
        obs.observe(root, OBSERVE_OPTIONS);
      } catch {}
    }
  };

  const scrubEl = (el) => {
    if (!el || el.nodeType !== 1) return;
    if (scrubTag(el)) return;
    scrubAttributes(el);
    scrubClasses(el);
    scrubShadowRoot(el);
  };

  const scrubTree = (root) => {
    if (!root || disabled) return;
    scrubEl(root);
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll("*")) scrubEl(el);
    }
  };

  const scheduleShadowScan = (root) => {
    if (!root || scheduledShadowScans.has(root)) return;
    scheduledShadowScans.add(root);
    let pending = SHADOW_RESCAN_DELAYS_MS.length;
    for (const delay of SHADOW_RESCAN_DELAYS_MS) {
      setTimeout(() => {
        try {
          scrubTree(root);
        } finally {
          pending--;
          if (pending === 0) scheduledShadowScans.delete(root);
        }
      }, delay);
    }
  };

  const scheduleDocumentShadowScan = () => {
    scheduleShadowScan(document.documentElement || document);
  };

  const startScrubbing = () => {
    obs = new MutationObserver((muts) => {
      if (disabled) return;
      // Scrub synchronously: deferring (rAF/idle) would leave extension
      // markers visible to the page for a frame, defeating the scrubber's
      // anti-detection purpose. Per-record cost is bounded by the master
      // regexes above.
      for (const m of muts) {
        if (m.addedNodes) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) {
              scrubTree(node);
              scheduleShadowScan(node);
            }
          }
        }
        if (m.type === "attributes") {
          scrubEl(m.target);
          scheduleShadowScan(m.target);
        }
      }
    });

    if (!disabled && document.documentElement) {
      scrubTree(document.documentElement);
      scheduleDocumentShadowScan();
    }

    try {
      obs.observe(document.documentElement || document, OBSERVE_OPTIONS);
    } catch {}

    addEventListener("DOMContentLoaded", scheduleDocumentShadowScan, { once: true });
    addEventListener("load", scheduleDocumentShadowScan, { once: true });
  };

  (async () => {
    try {
      const currentOrigin = location.origin;
      if (currentOrigin && currentOrigin !== "null") {
        const { disabled_origins = {} } = await chrome.storage.local.get({ disabled_origins: {} });
        disabled = !!disabled_origins[currentOrigin];
      }
    } catch {}
    startScrubbing();
  })();
})();
