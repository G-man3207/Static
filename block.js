// Static — MAIN-world engine.
//
// Patches the page's window so that:
//   1. fetch / XHR / element src|href|data / setAttribute / sendBeacon /
//      Worker / SharedWorker / EventSource / serviceWorker.register calls
//      targeting `chrome-extension://` (or equivalent in other browsers) are
//      rejected by default — blocking pages from enumerating installed
//      extensions.
//   2. When Noise mode is on AND the probed ID is in the origin's persona
//      (a stable 3–8 ID subset drawn from IDs this site has previously
//      probed for), fetch/XHR return a plausible-looking decoy response
//      instead of an error. Pages see those IDs as "installed."
//      Element-based probes (script/img src, setAttribute) stay blocked
//      regardless — consistent behavior beats a partial decoy that could
//      be detected by correlating vectors.
//   3. Known extension-bridge window globals are locked to undefined before
//      any page script runs.
//   4. All wrapped functions remain indistinguishable from their native
//      counterparts under Function.prototype.toString checks.
//
// Pattern lists come from lists.js (loaded just before this file in the same
// content-script group). Persona + Noise-mode flag arrive from bridge.js via
// window.postMessage on page load (and on toggle).
(() => {
  const CFG = globalThis.__static_config__ || {};
  const BAD_RE = CFG.probeUrlRegex || /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  const STRIP_GLOBALS = CFG.stripGlobals || [];
  const EXT_ID_RE = /^(?:chrome|moz|ms-browser|safari-web|edge)-extension:\/\/([a-z0-9]+)/i;
  let blocked = 0;

  // Persona state — populated from bridge.js via window.postMessage.
  let persona = new Set();
  let noiseEnabled = false;

  const bump = (where, url) => {
    blocked++;
    if (blocked === 1 || blocked === 10 || blocked === 100 || blocked % 500 === 0) {
      console.debug("[Static]", where, "— total blocked:", blocked);
    }
    try {
      window.postMessage(
        { __static_probe_blocked__: true, url: url == null ? "" : String(url).slice(0, 512) },
        "*"
      );
    } catch {}
  };

  const getUrl = (input) => {
    if (input == null) return "";
    if (typeof input === "string") return input;
    if (typeof URL !== "undefined" && input instanceof URL) return input.href;
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    if (typeof input.url === "string") return input.url;
    try {
      return String(input);
    } catch {
      return "";
    }
  };

  const isBad = (u) => {
    try {
      return BAD_RE.test(getUrl(u));
    } catch {
      return false;
    }
  };

  const extractExtId = (urlStr) => {
    const m = EXT_ID_RE.exec(String(urlStr || ""));
    return m ? m[1] : null;
  };

  const shouldDecoy = (url) => {
    if (!noiseEnabled) return false;
    const id = extractExtId(url);
    return id != null && persona.has(id);
  };

  // Persona + noise flag arrive from isolated-world bridge.js.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (d && d.__static_config_update__ === true) {
      if (Array.isArray(d.persona)) persona = new Set(d.persona);
      if (typeof d.noiseEnabled === "boolean") noiseEnabled = d.noiseEnabled;
    }
  });

  // ─── Decoy response synthesis ───────────────────────────────────────────
  // Minimal valid 1×1 transparent PNG — served when a probe targets an image
  // path (icons etc.) under Noise mode.
  const PNG_1x1_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const PNG_1x1 = Uint8Array.from(atob(PNG_1x1_B64), (c) => c.charCodeAt(0));

  const FAKE_MANIFEST = {
    manifest_version: 3,
    name: "Browser Extension",
    version: "1.0.0",
    description: "",
    icons: { 16: "icon.png", 48: "icon.png", 128: "icon.png" },
  };

  const buildDecoyBody = (url) => {
    let pathname = "";
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch {}
    if (pathname.endsWith("/manifest.json") || pathname === "/" || pathname === "") {
      return {
        body: JSON.stringify(FAKE_MANIFEST),
        contentType: "application/json; charset=utf-8",
      };
    }
    if (/\.(png|jpe?g|gif|webp|ico|bmp)$/i.test(pathname)) {
      return { body: PNG_1x1, contentType: "image/png" };
    }
    if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) {
      return { body: "", contentType: "application/javascript; charset=utf-8" };
    }
    if (pathname.endsWith(".html") || pathname.endsWith(".htm")) {
      return {
        body: "<!doctype html><html><body></body></html>",
        contentType: "text/html; charset=utf-8",
      };
    }
    if (pathname.endsWith(".css")) return { body: "", contentType: "text/css; charset=utf-8" };
    if (pathname.endsWith(".json"))
      return { body: "{}", contentType: "application/json; charset=utf-8" };
    if (pathname.endsWith(".svg"))
      return {
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        contentType: "image/svg+xml; charset=utf-8",
      };
    return { body: "", contentType: "application/octet-stream" };
  };

  const buildDecoyResponse = (url) => {
    const { body, contentType } = buildDecoyBody(url);
    try {
      return new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": contentType },
      });
    } catch {
      return new Response("", { status: 200 });
    }
  };

  // ─── Stealth: Function.prototype.toString ───────────────────────────────
  const stealthFns = new WeakMap();
  const origFnToString = Function.prototype.toString;
  const patchedFnToString = function toString() {
    if (stealthFns.has(this)) return stealthFns.get(this);
    return origFnToString.call(this);
  };
  stealthFns.set(patchedFnToString, "function toString() { [native code] }");
  try {
    Object.defineProperty(patchedFnToString, "name", { value: "toString", configurable: true });
    Object.defineProperty(patchedFnToString, "length", { value: 0, configurable: true });
  } catch {}
  Function.prototype.toString = patchedFnToString;

  const stealth = (fn, nativeName) => {
    stealthFns.set(fn, "function " + nativeName + "() { [native code] }");
    try {
      Object.defineProperty(fn, "name", { value: nativeName, configurable: true });
    } catch {}
    return fn;
  };

  // ─── 1. fetch ───────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    const wrappedFetch = function fetch(input, init) {
      if (isBad(input)) {
        const u = getUrl(input);
        if (shouldDecoy(u)) {
          bump("fetch-decoy", u);
          return Promise.resolve(buildDecoyResponse(u));
        }
        bump("fetch", u);
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return origFetch.apply(this, arguments);
    };
    try {
      Object.defineProperty(wrappedFetch, "length", { value: 1, configurable: true });
    } catch {}
    window.fetch = stealth(wrappedFetch, "fetch");
  }

  // ─── 2. XMLHttpRequest ──────────────────────────────────────────────────
  const blockedXHRs = new WeakMap();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const wrappedOpen = function open(method, url, ...rest) {
    const bad = isBad(url);
    if (bad) blockedXHRs.set(this, getUrl(url));
    return origOpen.call(this, method, bad ? "about:blank" : url, ...rest);
  };
  const fakeXhrSuccess = function (xhr, url) {
    const { body, contentType } = buildDecoyBody(url);
    const text = typeof body === "string" ? body : "";
    queueMicrotask(() => {
      try {
        Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
        Object.defineProperty(xhr, "status", { value: 200, configurable: true });
        Object.defineProperty(xhr, "statusText", { value: "OK", configurable: true });
        Object.defineProperty(xhr, "responseURL", { value: url, configurable: true });
        Object.defineProperty(xhr, "responseText", { value: text, configurable: true });
        Object.defineProperty(xhr, "response", { value: text, configurable: true });
        const origGetHeader = xhr.getResponseHeader;
        xhr.getResponseHeader = function (name) {
          if (String(name).toLowerCase() === "content-type") return contentType;
          return origGetHeader ? origGetHeader.call(this, name) : null;
        };
        xhr.dispatchEvent(new Event("readystatechange"));
        xhr.dispatchEvent(new Event("load"));
        xhr.dispatchEvent(new Event("loadend"));
      } catch {}
    });
  };
  const wrappedSend = function send(...args) {
    if (blockedXHRs.has(this)) {
      const url = blockedXHRs.get(this);
      blockedXHRs.delete(this);
      if (shouldDecoy(url)) {
        bump("xhr-decoy", url);
        fakeXhrSuccess(this, url);
        return;
      }
      bump("xhr", url);
      queueMicrotask(() => {
        try {
          this.dispatchEvent(new Event("error"));
        } catch {}
        try {
          this.dispatchEvent(new Event("loadend"));
        } catch {}
      });
      return;
    }
    return origSend.apply(this, args);
  };
  XMLHttpRequest.prototype.open = stealth(wrappedOpen, "open");
  XMLHttpRequest.prototype.send = stealth(wrappedSend, "send");

  // ─── 3. Element src / href / data property setters ──────────────────────
  const guardProp = (proto, prop, label) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(v) {
        if (isBad(v)) {
          bump(label, v);
          return;
        }
        return desc.set.call(this, v);
      },
    });
  };
  guardProp(HTMLLinkElement.prototype, "href", "link.href");
  guardProp(HTMLScriptElement.prototype, "src", "script.src");
  guardProp(HTMLImageElement.prototype, "src", "img.src");
  guardProp(HTMLIFrameElement.prototype, "src", "iframe.src");
  if (typeof HTMLSourceElement !== "undefined")
    guardProp(HTMLSourceElement.prototype, "src", "source.src");
  if (typeof HTMLEmbedElement !== "undefined")
    guardProp(HTMLEmbedElement.prototype, "src", "embed.src");
  if (typeof HTMLObjectElement !== "undefined")
    guardProp(HTMLObjectElement.prototype, "data", "object.data");

  // ─── 4. setAttribute / setAttributeNS fallback ──────────────────────────
  const attrGuard = (origFn, label, name) => {
    const wrapped = function (...args) {
      const argName = args.length >= 3 ? args[1] : args[0];
      const argValue = args.length >= 3 ? args[2] : args[1];
      if (typeof argName === "string") {
        const n = argName.toLowerCase();
        if ((n === "src" || n === "href" || n === "data") && isBad(argValue)) {
          bump(label, argValue);
          return;
        }
      }
      return origFn.apply(this, args);
    };
    return stealth(wrapped, name);
  };
  Element.prototype.setAttribute = attrGuard(
    Element.prototype.setAttribute,
    "setAttribute",
    "setAttribute"
  );
  Element.prototype.setAttributeNS = attrGuard(
    Element.prototype.setAttributeNS,
    "setAttributeNS",
    "setAttributeNS"
  );

  // ─── 5. navigator.sendBeacon ────────────────────────────────────────────
  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    const wrappedBeacon = function sendBeacon(url, data) {
      if (isBad(url)) {
        bump("sendBeacon", url);
        return true;
      }
      return origBeacon(url, data);
    };
    try {
      navigator.sendBeacon = stealth(wrappedBeacon, "sendBeacon");
    } catch {}
  }

  // ─── 6. Worker / SharedWorker ───────────────────────────────────────────
  const patchWorkerCtor = (Ctor, label) => {
    if (typeof Ctor !== "function") return Ctor;
    const wrapped = function (url, opts) {
      if (isBad(url)) {
        bump(label, url);
        const fake = new EventTarget();
        fake.postMessage = () => {};
        fake.terminate = () => {};
        fake.port = { postMessage: () => {}, start: () => {}, close: () => {} };
        queueMicrotask(() => {
          try {
            fake.dispatchEvent(new Event("error"));
          } catch {}
        });
        return fake;
      }
      return new Ctor(url, opts);
    };
    wrapped.prototype = Ctor.prototype;
    return stealth(wrapped, label);
  };
  if (window.Worker) window.Worker = patchWorkerCtor(window.Worker, "Worker");
  if (window.SharedWorker) window.SharedWorker = patchWorkerCtor(window.SharedWorker, "SharedWorker");

  // ─── 7. EventSource ─────────────────────────────────────────────────────
  if (window.EventSource) {
    const origES = window.EventSource;
    const wrappedES = function EventSource(url, opts) {
      if (isBad(url)) {
        bump("EventSource", url);
        const fake = new EventTarget();
        Object.assign(fake, {
          readyState: 2,
          url: String(url),
          withCredentials: false,
          close: () => {},
        });
        queueMicrotask(() => {
          try {
            fake.dispatchEvent(new Event("error"));
          } catch {}
        });
        return fake;
      }
      return new origES(url, opts);
    };
    wrappedES.prototype = origES.prototype;
    wrappedES.CONNECTING = 0;
    wrappedES.OPEN = 1;
    wrappedES.CLOSED = 2;
    window.EventSource = stealth(wrappedES, "EventSource");
  }

  // ─── 8. navigator.serviceWorker.register ────────────────────────────────
  // Reading navigator.serviceWorker itself throws SecurityError in sandboxed
  // iframes that lack `allow-same-origin` (e.g. tweet-embed / ad iframes),
  // so the whole section is wrapped.
  try {
    if (navigator.serviceWorker && typeof navigator.serviceWorker.register === "function") {
      const origRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      const wrappedRegister = function register(url, opts) {
        if (isBad(url)) {
          bump("serviceWorker.register", url);
          return Promise.reject(new TypeError("Failed to register a ServiceWorker"));
        }
        return origRegister(url, opts);
      };
      try {
        navigator.serviceWorker.register = stealth(wrappedRegister, "register");
      } catch {}
    }
  } catch {}

  // ─── 9. Lock down devtools / extension-bridge globals ───────────────────
  for (const k of STRIP_GLOBALS) {
    try {
      const existing = Object.getOwnPropertyDescriptor(window, k);
      if (existing && !existing.configurable) continue;
      Object.defineProperty(window, k, {
        configurable: false,
        enumerable: false,
        get: () => undefined,
        set: () => {},
      });
    } catch {}
  }
})();
