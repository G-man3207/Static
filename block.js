// Static - MAIN-world fetch/XHR extension probe blocker and Noise decoy engine.
(() => {
  const BAD_RE = /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  const EXT_ID_RE = /^(?:chrome|moz|ms-browser|safari-web|edge)-extension:\/\/([a-z0-9]+)/i;
  const BRIDGE_EVENT = "__static_noise_bridge_init__";
  const MAX_QUEUED_PROBES = 1000;
  const queuedProbeEvents = [];
  let bridgePort = null;
  let persona = new Set();
  let noiseEnabled = false;

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

  const applyConfigUpdate = (data) => {
    if (!data || data.type !== "config_update") return;
    if (Array.isArray(data.persona)) {
      persona = new Set(data.persona.filter((id) => typeof id === "string"));
    }
    if (typeof data.noiseEnabled === "boolean") {
      noiseEnabled = data.noiseEnabled;
    }
  };

  const postProbe = (url, where) => {
    const safeUrl = url == null ? "" : String(url).slice(0, 512);
    const safeWhere = where == null ? "" : String(where).slice(0, 64);
    if (bridgePort) {
      try {
        bridgePort.postMessage({ type: "probe_blocked", where: safeWhere, url: safeUrl });
        return;
      } catch {
        bridgePort = null;
      }
    }
    if (queuedProbeEvents.length < MAX_QUEUED_PROBES) {
      queuedProbeEvents.push({ url: safeUrl, where: safeWhere });
    }
  };

  const flushQueuedProbes = () => {
    if (!bridgePort) return;
    const batch = queuedProbeEvents.splice(0, queuedProbeEvents.length);
    for (const event of batch) {
      try {
        bridgePort.postMessage({ type: "probe_blocked", ...event });
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
    bridgePort.onmessage = (portEvent) => applyConfigUpdate(portEvent.data);
    try {
      bridgePort.start();
    } catch {}
    flushQueuedProbes();
    document.removeEventListener(BRIDGE_EVENT, onBridgeInit);
  };
  document.addEventListener(BRIDGE_EVENT, onBridgeInit);

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

  const isBad = (input) => {
    try {
      return BAD_RE.test(getUrl(input));
    } catch {
      return false;
    }
  };

  const extractExtId = (url) => {
    const match = EXT_ID_RE.exec(String(url || ""));
    return match ? match[1] : null;
  };

  const shouldDecoy = (url) => {
    if (!noiseEnabled) return false;
    const id = extractExtId(url);
    return id != null && persona.has(id);
  };

  const PNG_1X1_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const PNG_1X1 = Uint8Array.from(atob(PNG_1X1_B64), (char) => char.charCodeAt(0));
  const FAKE_MANIFEST = {
    manifest_version: 3,
    name: "Browser Extension",
    version: "1.0.0",
    description: "",
    icons: { 16: "icon.png", 48: "icon.png", 128: "icon.png" },
  };

  const pathForDecoy = (url) => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  };

  const buildDecoyBody = (url) => {
    const pathname = pathForDecoy(url);
    if (pathname.endsWith("/manifest.json") || pathname === "/" || pathname === "") {
      return {
        body: JSON.stringify(FAKE_MANIFEST),
        contentType: "application/json; charset=utf-8",
      };
    }
    if (/\.(png|jpe?g|gif|webp|ico|bmp)$/i.test(pathname)) {
      return { body: PNG_1X1, contentType: "image/png" };
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
    if (pathname.endsWith(".json")) {
      return { body: "{}", contentType: "application/json; charset=utf-8" };
    }
    if (pathname.endsWith(".svg")) {
      return {
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        contentType: "image/svg+xml; charset=utf-8",
      };
    }
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

  const bump = (where, url) => {
    try {
      postProbe(url, where);
    } catch {}
  };

  const patchFetch = () => {
    const origFetch = window.fetch;
    if (typeof origFetch !== "function") return;
    const wrappedFetch = {
      fetch(input) {
        if (isBad(input)) {
          const url = getUrl(input);
          if (shouldDecoy(url)) {
            bump("fetch-decoy", url);
            return Promise.resolve(buildDecoyResponse(url));
          }
          bump("fetch", url);
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return origFetch.apply(this, arguments);
      },
    }.fetch;
    window.fetch = stealth(wrappedFetch, "fetch", { length: 1 });
  };

  const fakeXhrSuccess = (xhr, url) => {
    const { body, contentType } = buildDecoyBody(url);
    const text = typeof body === "string" ? body : "";
    queueMicrotask(() => {
      try {
        xhr.dispatchEvent(new ProgressEvent("loadstart"));
      } catch {}
      try {
        Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
        Object.defineProperty(xhr, "status", { value: 200, configurable: true });
        Object.defineProperty(xhr, "statusText", { value: "OK", configurable: true });
        Object.defineProperty(xhr, "responseURL", { value: url, configurable: true });
        Object.defineProperty(xhr, "responseText", { value: text, configurable: true });
        Object.defineProperty(xhr, "response", { value: text, configurable: true });
        const origGetHeader = xhr.getResponseHeader;
        xhr.getResponseHeader = {
          getResponseHeader(name) {
            if (String(name).toLowerCase() === "content-type") return contentType;
            return origGetHeader ? origGetHeader.call(this, name) : null;
          },
        }.getResponseHeader;
        xhr.dispatchEvent(new Event("readystatechange"));
        xhr.dispatchEvent(new Event("load"));
        xhr.dispatchEvent(new Event("loadend"));
      } catch {}
    });
  };

  const fakeXhrFailure = (xhr) => {
    queueMicrotask(() => {
      try {
        xhr.dispatchEvent(new ProgressEvent("loadstart"));
      } catch {}
      try {
        Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
        Object.defineProperty(xhr, "status", { value: 0, configurable: true });
        Object.defineProperty(xhr, "statusText", { value: "", configurable: true });
        Object.defineProperty(xhr, "responseURL", { value: "", configurable: true });
        Object.defineProperty(xhr, "responseText", { value: "", configurable: true });
        Object.defineProperty(xhr, "response", { value: "", configurable: true });
        xhr.dispatchEvent(new Event("readystatechange"));
      } catch {}
      try {
        xhr.dispatchEvent(new Event("error"));
      } catch {}
      try {
        xhr.dispatchEvent(new Event("loadend"));
      } catch {}
    });
  };

  const patchXhr = () => {
    const blockedXHRs = new WeakMap();
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const wrappedOpen = {
      open(method, url, ...rest) {
        const bad = isBad(url);
        if (bad) blockedXHRs.set(this, getUrl(url));
        return origOpen.call(this, method, bad ? "about:blank" : url, ...rest);
      },
    }.open;
    const wrappedSend = {
      send(...args) {
        if (!blockedXHRs.has(this)) return origSend.apply(this, args);
        const url = blockedXHRs.get(this);
        blockedXHRs.delete(this);
        if (shouldDecoy(url)) {
          bump("xhr-decoy", url);
          fakeXhrSuccess(this, url);
          return;
        }
        bump("xhr", url);
        fakeXhrFailure(this);
      },
    }.send;
    XMLHttpRequest.prototype.open = stealth(wrappedOpen, "open");
    XMLHttpRequest.prototype.send = stealth(wrappedSend, "send");
  };

  patchFetch();
  patchXhr();
})();
