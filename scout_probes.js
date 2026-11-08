/* eslint-disable max-lines -- one wrapper registry keeps the 40-install ceiling auditable */
// Static - scout probe-vector observation (MAIN world, observe only).
//
// Wraps the APIs a page can use to check whether an extension is installed and
// reports the extension URLs it sees. Every wrapper is a strict pass-through:
// the native implementation runs with the page's own `this`, arguments,
// return value, thrown value, property descriptors and promise identity, and
// Function.prototype.toString never reveals the wrapper (block_utils.js
// stealth). Counting happens in try/catch around the native call; a scout bug
// can only lose a hint, never change a page result.
//
// Fast path: a value without "-extension:" is never parsed, so ordinary page
// traffic pays one indexOf. Probe URL classification is in scout.js.
//
// Install ceiling: exactly 40 wrappers (see probeCountFor()). A MutationObserver
// backstop covers parser-inserted markup and URL attributes set through paths
// that are not wrapped (e.g. cloneNode) without spending another wrapper.
(() => {
  const bus = globalThis.__static_scout__;
  if (!bus) return;
  const U = bus.U;
  const catalog = bus.catalog || {};
  const MAX_PROBE_INSTALLS = 40;
  const MAX_URLS_PER_EVENT = 64;
  const MAX_OBSERVED_NODES = 500;
  const OBSERVED_ATTRIBUTES = [
    "action",
    "data",
    "formaction",
    "href",
    "poster",
    "src",
    "srcset",
    "style",
  ];
  const OBSERVED_ATTRIBUTE_SET = new Set(OBSERVED_ATTRIBUTES);
  const EMPTY_SET = new Set();

  // The native URL constructor, or a harmless fallback if a page context has
  // none (the scout still installs; URL classification just never matches).
  const NativeURL = globalThis.URL;
  const nativeGetAttribute = Element.prototype.getAttribute;

  const urlHrefGetter = (() => {
    try {
      const desc = Object.getOwnPropertyDescriptor(NativeURL.prototype, "href");
      return desc && typeof desc.get === "function" ? desc.get : null;
    } catch {
      return null;
    }
  })();
  const requestUrlGetter = (() => {
    try {
      if (typeof globalThis.Request !== "function") return null;
      const desc = Object.getOwnPropertyDescriptor(Request.prototype, "url");
      return desc && typeof desc.get === "function" ? desc.get : null;
    } catch {
      return null;
    }
  })();

  let probeInstalls = 0;

  const hasNeedle = (value) => typeof value === "string" && value.indexOf("-extension:") !== -1;

  const probeText = (text, where) => {
    if (!hasNeedle(text)) return;
    let matches;
    try {
      matches = text.match(new RegExp(U.BAD_URL_RE.source, "gi"));
    } catch {
      matches = null;
    }
    if (!matches) return;
    for (let index = 0; index < matches.length && index < MAX_URLS_PER_EVENT; index++) {
      bus.probe(matches[index].replace(/[,;]+$/, ""), where);
    }
  };

  const readURLObject = (value) => {
    if (!value || typeof value !== "object") return "";
    if (!urlHrefGetter) return "";
    try {
      return String(urlHrefGetter.call(value));
    } catch {
      return "";
    }
  };

  const readRequestURL = (value) => {
    if (!value || typeof value !== "object" || !requestUrlGetter) return "";
    try {
      return String(requestUrlGetter.call(value));
    } catch {
      return "";
    }
  };

  const inspectURL = (value, where) => {
    if (typeof value === "string") {
      if (hasNeedle(value)) probeText(value, where);
      return;
    }
    const href = readURLObject(value);
    if (hasNeedle(href)) probeText(href, where);
  };

  const inspectFetchInput = (value) => {
    inspectURL(value, "fetch");
    if (typeof value === "string" || !value || typeof value !== "object") return;
    const url = readRequestURL(value);
    if (hasNeedle(url)) probeText(url, "fetch");
  };

  const tagOf = (el) => {
    try {
      return String((el && el.tagName) || "").toLowerCase();
    } catch {
      return "";
    }
  };

  // ─── Attribute bookkeeping (shared with the observer backstop) ─────────────
  // The only page data kept is the most recent URL-ish attribute value that was
  // already reported for a node, so the observer can skip the duplicate record a
  // property setter or setAttribute produces. Values live and die with the node.
  const reportedAttributes = new WeakMap();
  const IMAGE_INSTANCES = new WeakSet();
  const AUDIO_INSTANCES = new WeakSet();

  const attributeKey = (value) => String(value == null ? "" : value).toLowerCase();

  const markReported = (node, name, value) => {
    try {
      if (!node || typeof node !== "object") return;
      let entry = reportedAttributes.get(node);
      if (!entry) {
        entry = new Map();
        reportedAttributes.set(node, entry);
      }
      entry.set(name, attributeKey(value));
    } catch {}
  };

  const alreadyReported = (node, name, value) => {
    try {
      const entry = reportedAttributes.get(node);
      if (!entry) return false;
      const reported = entry.get(name);
      return reported != null && reported === attributeKey(value);
    } catch {
      return false;
    }
  };

  // Flat attribute → tag → canonical vector tables. Keeping the mapping data
  // (instead of nested conditionals) is what makes the 16 property wrappers and
  // the observer backstop share one classification without drifting apart.
  const SRC_VECTORS = {
    audio: "audio",
    embed: "embed",
    frame: "frame",
    iframe: "iframe",
    img: "img",
    input: "input",
    script: "script",
    source: "source",
    track: "track",
    video: "media",
  };
  const HREF_VECTORS = { a: "anchor", area: "area", base: "base", link: "link" };
  const FORM_VECTORS = { button: "form", form: "form", input: "form" };
  const ATTRIBUTE_VECTORS = {
    action: (tag) => FORM_VECTORS[tag] || "dom-observer",
    data: (tag) => (tag === "object" ? "object" : "dom-observer"),
    formaction: (tag) => FORM_VECTORS[tag] || "dom-observer",
    href: (tag) => HREF_VECTORS[tag] || "dom-observer",
    poster: (tag) => (tag === "video" ? "video-poster" : "dom-observer"),
    src: (tag) => SRC_VECTORS[tag] || "dom-observer",
    srcset: (tag) => (tag === "img" || tag === "source" ? "img-srcset" : "dom-observer"),
    style: () => "style-attr",
  };
  const vectorForTag = (tag, name) => {
    const resolve = ATTRIBUTE_VECTORS[name];
    return resolve ? resolve(tag) : "dom-observer";
  };

  const vectorForElementProperty = (el, name) => {
    const tag = tagOf(el);
    if (name === "src") {
      if (tag === "img") return IMAGE_INSTANCES.has(el) ? "image-ctor" : "img";
      if (tag === "audio") return AUDIO_INSTANCES.has(el) ? "audio-ctor" : "audio";
    }
    return vectorForTag(tag, name);
  };

  // URL-valued attribute names a tag can actually load from. Used by
  // setAttribute so an unrelated `div.setAttribute("src", …)` is still a hint
  // but keeps its DOM-observer label (vectorForTag only knows the tag).
  const reportAttributeValue = (el, name, value) => {
    if (!hasNeedle(value)) return;
    if (alreadyReported(el, name, value)) return;
    markReported(el, name, value);
    probeText(value, vectorForElementProperty(el, name));
  };

  const inspectAttributeNode = (el, attribute) => {
    if (!el || !attribute || typeof attribute.value !== "string") return;
    if (!OBSERVED_ATTRIBUTE_SET.has(attribute.name)) return;
    if (!hasNeedle(attribute.value)) return;
    reportAttributeValue(el, attribute.name, attribute.value);
  };

  const install = (label, fn) => {
    if (probeInstalls >= MAX_PROBE_INSTALLS) return;
    try {
      fn();
      probeInstalls += 1;
    } catch {}
    void label;
  };

  // ─── URL-consuming APIs ─────────────────────────────────────────────────────
  const markUrlConstructor = (name, where, { tagSet, tagArg } = {}) => {
    const Original = globalThis[name];
    if (typeof Original !== "function" || typeof Original.prototype !== "object") return;
    const tag = (result) => {
      if (!tagSet || tagArg !== 0 || !result || typeof result !== "object") return;
      try {
        tagSet.add(result);
      } catch {}
    };
    const Wrapped = function (...args) {
      try {
        inspectURL(args[0], where);
      } catch {}
      if (!new.target) {
        const result = Reflect.apply(Original, this, args);
        tag(result);
        return result;
      }
      const result = Reflect.construct(Original, args, new.target);
      tag(result);
      return result;
    };
    Wrapped.prototype = Original.prototype;
    // WebIDL constructors expose a non-writable .prototype descriptor.
    try {
      Object.defineProperty(Wrapped, "prototype", { writable: false });
    } catch {}
    if (tagSet === IMAGE_INSTANCES || tagSet === AUDIO_INSTANCES) {
      // Legacy factories (Audio/Image) share HTML*Element.prototype whose
      // constructor must stay the element interface, exactly as native.
    } else {
      U.alignPrototypeConstructor(Wrapped, Original);
      U.copyConstructorStatics(Wrapped, Original);
    }
    const disguised = U.stealth(Wrapped, name, {
      length: Original.length,
      source: U.nativeSourceFor(Original, name),
    });
    try {
      Object.defineProperty(globalThis, name, {
        ...Object.getOwnPropertyDescriptor(globalThis, name),
        value: disguised,
      });
    } catch {
      globalThis[name] = disguised;
    }
  };

  const installUrlConsumers = () => {
    if (typeof globalThis.fetch === "function") {
      install("fetch", () => {
        U.wrapMethod(globalThis, "fetch", (origFetch) => ({
          fetch(input) {
            try {
              inspectFetchInput(input);
            } catch {}
            return origFetch.apply(this, arguments);
          },
        }));
      });
    }

    if (typeof globalThis.XMLHttpRequest === "function") {
      install("xhr.open", () => {
        U.wrapMethod(XMLHttpRequest.prototype, "open", (origOpen) => ({
          open(_method, url) {
            try {
              inspectURL(url, "xhr");
            } catch {}
            return origOpen.apply(this, arguments);
          },
        }));
      });
    }

    if (globalThis.navigator && typeof navigator.sendBeacon === "function") {
      install("beacon", () => {
        const found = U.descriptorOwnerFor(globalThis.navigator, "sendBeacon");
        if (!found) return;
        U.wrapMethod(found.owner, "sendBeacon", (origBeacon) => ({
          sendBeacon(url) {
            try {
              inspectURL(url, "beacon");
            } catch {}
            return origBeacon.apply(this, arguments);
          },
        }));
      });
    }

    if (typeof globalThis.Worker === "function") {
      install("worker", () => {
        markUrlConstructor("Worker", "worker");
      });
    }
    if (typeof globalThis.SharedWorker === "function") {
      install("shared-worker", () => {
        markUrlConstructor("SharedWorker", "shared-worker");
      });
    }
    if (typeof globalThis.EventSource === "function") {
      install("event-source", () => {
        markUrlConstructor("EventSource", "event-source");
      });
    }
    if (typeof globalThis.Audio === "function") {
      install("audio-ctor", () => {
        markUrlConstructor("Audio", "audio-ctor", { tagSet: AUDIO_INSTANCES, tagArg: 0 });
      });
    }
    if (typeof globalThis.Image === "function") {
      install("image-ctor", () => {
        markUrlConstructor("Image", "image-ctor", { tagSet: IMAGE_INSTANCES, tagArg: 0 });
      });
    }
    if (typeof globalThis.Worklet === "function" && Worklet.prototype) {
      install("worklet", () => {
        U.wrapMethod(Worklet.prototype, "addModule", (origAdd) => ({
          addModule(moduleURL) {
            try {
              inspectURL(moduleURL, "worklet");
            } catch {}
            return origAdd.apply(this, arguments);
          },
        }));
      });
    }
  };

  // ─── URL-reflecting properties ───────────────────────────────────────────────
  const guardProperty = (ctorName, property, attributeName, where) => {
    const Ctor = globalThis[ctorName];
    if (typeof Ctor !== "function" || !Ctor.prototype) return;
    let found;
    try {
      found = U.descriptorOwnerFor(Ctor.prototype, property);
    } catch {
      return;
    }
    if (!found || !found.desc || typeof found.desc.set !== "function") return;
    try {
      U.wrapSetter(found.owner, property, (nativeSet) => ({
        set(value) {
          if (typeof value !== "string" || !hasNeedle(value)) {
            nativeSet.call(this, value);
            return;
          }
          try {
            const resolved = typeof where === "function" ? where(this) : where;
            if (resolved) {
              markReported(this, attributeName, value);
              probeText(value, resolved);
            }
          } catch {}
          nativeSet.call(this, value);
        },
      }));
    } catch {}
  };

  const installUrlProperties = () => {
    // One wrapper per reflected property. The element tag decides the vector so
    // a shared HTMLMediaElement setter can report audio vs media.
    install("img.src", () => {
      guardProperty("HTMLImageElement", "src", "src", (el) =>
        IMAGE_INSTANCES.has(el) ? "image-ctor" : "img"
      );
    });
    install("img.srcset", () => {
      guardProperty("HTMLImageElement", "srcset", "srcset", "img-srcset");
    });
    install("script.src", () => {
      guardProperty("HTMLScriptElement", "src", "src", "script");
    });
    install("link.href", () => {
      guardProperty("HTMLLinkElement", "href", "href", "link");
    });
    install("iframe.src", () => {
      guardProperty("HTMLIFrameElement", "src", "src", "iframe");
    });
    install("source.src", () => {
      guardProperty("HTMLSourceElement", "src", "src", "source");
    });
    install("source.srcset", () => {
      guardProperty("HTMLSourceElement", "srcset", "srcset", "img-srcset");
    });
    install("video.poster", () => {
      guardProperty("HTMLVideoElement", "poster", "poster", "video-poster");
    });
    install("media.src", () => {
      guardProperty("HTMLMediaElement", "src", "src", (el) =>
        tagOf(el) === "audio" ? (AUDIO_INSTANCES.has(el) ? "audio-ctor" : "audio") : "media"
      );
    });
    install("object.data", () => {
      guardProperty("HTMLObjectElement", "data", "data", "object");
    });
    install("embed.src", () => {
      guardProperty("HTMLEmbedElement", "src", "src", "embed");
    });
    install("form.action", () => {
      guardProperty("HTMLFormElement", "action", "action", "form");
    });
    install("base.href", () => {
      guardProperty("HTMLBaseElement", "href", "href", "base");
    });
    install("a.href", () => {
      guardProperty("HTMLAnchorElement", "href", "href", "anchor");
    });
    install("area.href", () => {
      guardProperty("HTMLAreaElement", "href", "href", "area");
    });
    install("input.src", () => {
      guardProperty("HTMLInputElement", "src", "src", "input");
    });
    install("track.src", () => {
      guardProperty("HTMLTrackElement", "src", "src", "track");
    });
  };

  // ─── setAttribute ─────────────────────────────────────────────────────────────
  const installSetAttribute = () => {
    install("setAttribute", () => {
      U.wrapMethod(Element.prototype, "setAttribute", (origSetAttribute) => ({
        setAttribute(name, value) {
          const result = origSetAttribute.apply(this, arguments);
          try {
            if (typeof name === "string" && typeof value === "string") {
              const attribute = U.attrLocalName(this, name);
              if (OBSERVED_ATTRIBUTE_SET.has(attribute)) {
                reportAttributeValue(this, attribute, value);
              }
            }
          } catch {}
          return result;
        },
      }));
    });
  };

  // ─── CSSOM ────────────────────────────────────────────────────────────────────
  const installCssom = () => {
    const sheetProto = globalThis.CSSStyleSheet && CSSStyleSheet.prototype;
    for (const [method, where] of [
      ["insertRule", "cssom-insert"],
      ["addRule", "cssom-insert"],
      ["replace", "cssom-replace"],
      ["replaceSync", "cssom-replace"],
    ]) {
      if (!sheetProto || typeof sheetProto[method] !== "function") continue;
      install(where, () => {
        U.wrapMethod(sheetProto, method, (orig) => ({
          [method]() {
            try {
              // insertRule(rule, index) and the legacy addRule(selector, style)
              // both carry the URL in a string argument; replace/replaceSync
              // take the cssText first (and only) argument.
              for (const argument of arguments) {
                if (typeof argument === "string") probeText(argument, where);
              }
            } catch {}
            return orig.apply(this, arguments);
          },
        }));
      });
    }
    const declarationProto = globalThis.CSSStyleDeclaration && CSSStyleDeclaration.prototype;
    if (declarationProto) {
      install("cssom-setprop", () => {
        U.wrapMethod(declarationProto, "setProperty", (orig) => ({
          setProperty(name, value, priority) {
            try {
              if (typeof value === "string") probeText(value, "cssom-setprop");
            } catch {}
            return orig.call(this, name, value, priority);
          },
        }));
      });
      install("cssom-csstext", () => {
        U.wrapSetter(declarationProto, "cssText", (nativeSet) => ({
          set(value) {
            nativeSet.call(this, value);
            try {
              if (typeof value === "string") probeText(value, "cssom-csstext");
            } catch {}
          },
        }));
      });
    }
  };

  // ─── Markup sinks ─────────────────────────────────────────────────────────────
  const installMarkup = () => {
    const innerHTML = (proto) => {
      if (!proto) return;
      install("markup", () => {
        U.wrapSetter(proto, "innerHTML", (nativeSet) => ({
          set(value) {
            if (typeof value === "string" && hasNeedle(value)) {
              try {
                probeText(value, "markup");
              } catch {}
            }
            nativeSet.call(this, value);
          },
        }));
      });
    };
    innerHTML(globalThis.Element && Element.prototype);
    if (typeof globalThis.ShadowRoot === "function" && ShadowRoot.prototype) {
      install("markup", () => {
        U.wrapSetter(ShadowRoot.prototype, "innerHTML", (nativeSet) => ({
          set(value) {
            if (typeof value === "string" && hasNeedle(value)) {
              try {
                probeText(value, "markup");
              } catch {}
            }
            nativeSet.call(this, value);
          },
        }));
      });
    }
    install("markup", () => {
      U.wrapSetter(Element.prototype, "outerHTML", (nativeSet) => ({
        set(value) {
          if (typeof value === "string" && hasNeedle(value)) {
            try {
              probeText(value, "markup");
            } catch {}
          }
          nativeSet.call(this, value);
        },
      }));
    });
    install("markup", () => {
      U.wrapMethod(Element.prototype, "insertAdjacentHTML", (orig) => ({
        insertAdjacentHTML(position, html) {
          try {
            if (typeof html === "string") probeText(html, "markup");
          } catch {}
          return orig.apply(this, arguments);
        },
      }));
    });
    if (typeof globalThis.DOMParser === "function") {
      install("markup", () => {
        U.wrapMethod(DOMParser.prototype, "parseFromString", (orig) => ({
          parseFromString(markup, _type) {
            try {
              if (typeof markup === "string") probeText(markup, "markup");
            } catch {}
            return orig.apply(this, arguments);
          },
        }));
      });
    }
    if (typeof globalThis.Range === "function") {
      install("markup", () => {
        U.wrapMethod(Range.prototype, "createContextualFragment", (orig) => ({
          createContextualFragment(markup) {
            try {
              if (typeof markup === "string") probeText(markup, "markup");
            } catch {}
            return orig.apply(this, arguments);
          },
        }));
      });
    }
    if (typeof globalThis.document === "object" && document) {
      const found = (() => {
        try {
          return U.descriptorOwnerFor(document, "write");
        } catch {
          return null;
        }
      })();
      if (found && found.owner && typeof found.desc.value === "function") {
        install("markup", () => {
          U.wrapMethod(found.owner, "write", (orig) => ({
            write() {
              try {
                for (const argument of arguments) {
                  if (typeof argument === "string") probeText(argument, "markup");
                }
              } catch {}
              return orig.apply(this, arguments);
            },
          }));
        });
      }
    }
  };

  // ─── MutationObserver backstop ────────────────────────────────────────────────
  const styleTextSeen = new WeakMap();
  const scriptTextSeen = new WeakMap();

  const isTag = (node, name) => !!node && node.nodeType === 1 && tagOf(node) === name;

  const readText = (node) => {
    try {
      return String(node.textContent == null ? "" : node.textContent);
    } catch {
      return "";
    }
  };

  const scanStyleText = (style) => {
    if (!isTag(style, "style")) return;
    const text = readText(style);
    if (!hasNeedle(text) || styleTextSeen.get(style) === text) return;
    styleTextSeen.set(style, text);
    probeText(text, "style-text");
  };

  const scanScriptText = (script) => {
    if (!isTag(script, "script")) return;
    const text = readText(script);
    if (!hasNeedle(text) || scriptTextSeen.get(script) === text) return;
    scriptTextSeen.set(script, text);
    probeText(text, "dom-observer");
  };

  const scanTextParent = (node) => {
    try {
      if (isTag(node, "style")) scanStyleText(node);
      else if (isTag(node, "script")) scanScriptText(node);
    } catch {}
  };

  const scanElementAttributes = (el) => {
    try {
      const attributes = el.attributes;
      if (!attributes) return;
      for (const attribute of attributes) {
        inspectAttributeNode(el, attribute);
      }
      if (isTag(el, "style")) scanStyleText(el);
      else if (isTag(el, "script")) scanScriptText(el);
    } catch {}
  };

  const scanTree = (root) => {
    if (!root || root.nodeType !== 1) return;
    let budget = MAX_OBSERVED_NODES;
    const visit = (node) => {
      if (!node || budget <= 0) return;
      budget -= 1;
      scanElementAttributes(node);
      let child = node.firstElementChild;
      while (child) {
        if (budget <= 0) break;
        visit(child);
        child = child.nextElementSibling;
      }
    };
    try {
      visit(root);
    } catch {}
  };

  const reportAttributeRecord = (record) => {
    const name = String(record.attributeName || "").toLowerCase();
    if (!OBSERVED_ATTRIBUTE_SET.has(name)) return;
    const target = record.target;
    if (!target || target.nodeType !== 1) return;
    const value =
      name === "style"
        ? nativeGetAttribute.call(target, "style")
        : nativeGetAttribute.call(target, name);
    if (typeof value !== "string" || !hasNeedle(value)) return;
    if (alreadyReported(target, name, value)) return;
    reportAttributeValue(target, name, value);
  };

  const reportChildListRecord = (record) => {
    for (const node of record.addedNodes) {
      if (node.nodeType === 1) scanTree(node);
      else if (node.nodeType === 3) scanTextParent(node.parentNode);
    }
    const target = record.target;
    if (!target || target.nodeType !== 1) return;
    const tag = String(target.localName || "").toLowerCase();
    if (tag === "style" || tag === "script") scanTextParent(target);
  };

  const mutationRecords = (records) => {
    try {
      for (const record of records) {
        if (record.type === "attributes") reportAttributeRecord(record);
        else if (record.type === "characterData") {
          scanTextParent(record.target && record.target.parentNode);
        } else {
          reportChildListRecord(record);
        }
      }
    } catch {}
  };

  const installObserver = () => {
    if (typeof globalThis.MutationObserver !== "function") return;
    try {
      const observer = new MutationObserver(mutationRecords);
      const root = document.documentElement || document;
      observer.observe(root, {
        attributeFilter: OBSERVED_ATTRIBUTES,
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      bus.onFinalize(() => {
        try {
          observer.disconnect();
        } catch {}
      });
      // Content scripts run before parsing, but a page restored from bfcache or
      // a content script injected later may already have nodes worth scanning.
      scanTree(document.documentElement);
    } catch {}
  };

  // ─── Install ──────────────────────────────────────────────────────────────────
  installUrlConsumers();
  installUrlProperties();
  installSetAttribute();
  installCssom();
  installMarkup();
  installObserver();
  // Exposed for the static harness and for scout.js's own bookkeeping only; the
  // global is removed by scout_signals.js.
  bus.probeInstalls = probeInstalls;
  bus.probeInstalled = true;
  bus.probeVectorCount = catalog && catalog.vectors ? catalog.vectors.length : 0;
  bus.probeAllowedVectors = EMPTY_SET;
  bus.ready("probes");
})();
