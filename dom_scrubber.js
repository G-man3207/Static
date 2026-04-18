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

  const matchesAny = (patterns, value) => patterns.some((pattern) => pattern.test(value));

  const scrubTag = (el) => {
    const tagName = el.tagName && el.tagName.toLowerCase();
    if (!tagName || !matchesAny(TAG_PATTERNS, tagName)) return false;
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
      if (!matchesAny(ATTR_PATTERNS, attr.name.toLowerCase())) continue;
      try {
        el.removeAttribute(attr.name);
      } catch {}
    }
  };

  const scrubClasses = (el) => {
    if (!el.classList || !el.classList.length) return;
    const toRemove = [];
    for (const cls of el.classList) {
      if (matchesAny(CLASS_PATTERNS, cls)) toRemove.push(cls);
    }
    for (const cls of toRemove) {
      try {
        el.classList.remove(cls);
      } catch {}
    }
  };

  const scrubEl = (el) => {
    if (!el || el.nodeType !== 1) return;
    if (scrubTag(el)) return;
    scrubAttributes(el);
    scrubClasses(el);
  };

  const scrubTree = (root) => {
    if (!root) return;
    scrubEl(root);
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll("*")) scrubEl(el);
    }
  };

  if (document.documentElement) scrubTree(document.documentElement);

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.addedNodes) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) scrubTree(node);
        }
      }
      if (m.type === "attributes") scrubEl(m.target);
    }
  });
  try {
    obs.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  } catch {}
})();
