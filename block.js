/* eslint-disable max-lines -- MAIN-world fetch/XHR shims are safer kept contiguous */
// Static - MAIN-world fetch/XHR extension probe blocker and Noise decoy engine.
(() => {
  const BAD_RE = /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i;
  const CHROME_EXT_ID_RE = /^[a-p]{32}$/;
  const BRIDGE_EVENT = "__static_noise_bridge_init__";
  const MAX_QUEUED_PROBES = 1000;
  const queuedProbeEvents = [];
  let bridgePort = null;
  let persona = new Set();
  let noiseEnabled = false;
  let disabled = false;

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

  const applyConfigUpdate = (data) => {
    if (!data || data.type !== "config_update") return;
    if (Array.isArray(data.persona)) {
      persona = new Set(data.persona.filter((id) => typeof id === "string"));
    }
    if (typeof data.noiseEnabled === "boolean") {
      noiseEnabled = data.noiseEnabled;
    }
    if (typeof data.disabled === "boolean") {
      disabled = data.disabled;
      window.__staticDisabled = disabled;
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

  const normalizeUrlString = (value) => String(value).trim();

  const getUrl = (input) => {
    if (input == null) return "";
    if (typeof input === "string") return normalizeUrlString(input);
    if (typeof URL !== "undefined" && input instanceof URL) return input.href;
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    if (typeof input.url === "string") return normalizeUrlString(input.url);
    try {
      return normalizeUrlString(input);
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

  const extensionIdentityFor = (url) => {
    try {
      const parsed = new URL(String(url || ""));
      const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
      const id = parsed.hostname.toLowerCase();
      if (
        (scheme === "chrome-extension" || scheme === "edge-extension") &&
        CHROME_EXT_ID_RE.test(id)
      ) {
        return { id, scheme };
      }
    } catch {}
    return null;
  };

  const extractExtId = (url) => {
    const identity = extensionIdentityFor(url);
    return identity ? identity.id : null;
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
  const IMAGE_DECOY_PATHS = [
    /(?:^|\/)(?:icon|logo|badge|action|browser_action|page_action)(?:[-_. ]?(?:\d{1,4}|small|medium|large|default))?\.(?:png|jpe?g|gif|webp|ico|bmp|svg)$/i,
    /(?:^|\/)(?:icons?|images?|img)\/(?:[^/]+\/)*(?:icon|logo|badge|action|browser_action|page_action)(?:[-_. ]?(?:\d{1,4}|small|medium|large|default))?\.(?:png|jpe?g|gif|webp|ico|bmp|svg)$/i,
    /(?:^|\/)(?:16|19|24|32|38|48|64|96|128|256|512)\.(?:png|jpe?g|gif|webp|ico|bmp|svg)$/i,
  ];
  const SCRIPT_DECOY_PATHS = [
    /(?:^|\/)(?:content(?:[-_. ]script)?|inject(?:ed)?|background(?:[-_. ]page)?|bundle|main|page|popup|options|index)(?:[-_. ]?[a-z0-9]+)?\.(?:m?js)$/i,
  ];
  const HTML_DECOY_PATHS = [
    /(?:^|\/)(?:page|popup|options|background|index)(?:[-_. ]?[a-z0-9]+)?\.(?:html|htm)$/i,
  ];
  const STYLE_DECOY_PATHS = [
    /(?:^|\/)(?:style|styles|content|popup|options|main|index)(?:[-_. ]?[a-z0-9]+)?\.css$/i,
  ];
  const fakeXhrResponses = new WeakMap();
  const fakeFetchResponses = new WeakMap();

  const descriptorOwnerFor = (proto, prop) => {
    let cursor = proto;
    while (cursor) {
      const desc = Object.getOwnPropertyDescriptor(cursor, prop);
      if (desc) return { owner: cursor, desc };
      cursor = Object.getPrototypeOf(cursor);
    }
    return null;
  };

  const patchFakeResponseMetadata = () => {
    if (typeof Response === "undefined" || !Response.prototype) return;
    for (const prop of ["type", "url"]) {
      const found = descriptorOwnerFor(Response.prototype, prop);
      if (!found || !found.desc || typeof found.desc.get !== "function") continue;
      const { desc, owner } = found;
      Object.defineProperty(owner, prop, {
        ...desc,
        get: stealth(
          function get() {
            const fake = fakeFetchResponses.get(this);
            if (fake && Object.prototype.hasOwnProperty.call(fake, prop)) return fake[prop];
            return desc.get.call(this);
          },
          `get ${prop}`,
          { length: 0, source: nativeSourceFor(desc.get, `get ${prop}`) }
        ),
      });
    }

    const cloneDesc = Object.getOwnPropertyDescriptor(Response.prototype, "clone");
    const origClone = cloneDesc && cloneDesc.value;
    if (typeof origClone !== "function") return;
    const wrappedClone = {
      clone() {
        const cloned = origClone.apply(this, arguments);
        const fake = fakeFetchResponses.get(this);
        if (fake) fakeFetchResponses.set(cloned, fake);
        return cloned;
      },
    }.clone;
    Object.defineProperty(Response.prototype, "clone", {
      ...cloneDesc,
      value: stealth(wrappedClone, "clone", {
        length: 0,
        source: nativeSourceFor(origClone, "clone"),
      }),
    });
  };

  const fakeXhrValueFor = (xhr, prop, desc) => {
    const fake = fakeXhrResponses.get(xhr);
    if (fake && Object.prototype.hasOwnProperty.call(fake, prop)) {
      if (prop === "responseText" && fake.responseTextError) {
        throw new DOMException(
          "The value is only accessible if the object's 'responseType' is '' or 'text'.",
          "InvalidStateError"
        );
      }
      return fake[prop];
    }
    return desc.get.call(xhr);
  };

  const patchFakeXhrMetadata = () => {
    if (typeof XMLHttpRequest === "undefined" || !XMLHttpRequest.prototype) return;
    for (const prop of [
      "readyState",
      "response",
      "responseText",
      "responseURL",
      "status",
      "statusText",
    ]) {
      const found = descriptorOwnerFor(XMLHttpRequest.prototype, prop);
      if (!found || !found.desc || typeof found.desc.get !== "function") continue;
      const { desc, owner } = found;
      Object.defineProperty(owner, prop, {
        ...desc,
        get: stealth(
          function get() {
            return fakeXhrValueFor(this, prop, desc);
          },
          `get ${prop}`,
          { length: 0, source: nativeSourceFor(desc.get, `get ${prop}`) }
        ),
      });
    }
  };

  const pathForDecoy = (url) => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  };

  const matchesPathPattern = (pathname, patterns) =>
    patterns.some((pattern) => pattern.test(pathname));

  const decoyKindForPath = (url) => {
    const pathname = pathForDecoy(url);
    if (!pathname) return null;
    if (pathname.endsWith("/manifest.json")) return "manifest";
    if (/\.(png|jpe?g|gif|webp|ico|bmp|svg)$/i.test(pathname)) {
      return matchesPathPattern(pathname, IMAGE_DECOY_PATHS) ? "image" : null;
    }
    if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) {
      return matchesPathPattern(pathname, SCRIPT_DECOY_PATHS) ? "script" : null;
    }
    if (pathname.endsWith(".html") || pathname.endsWith(".htm")) {
      return matchesPathPattern(pathname, HTML_DECOY_PATHS) ? "html" : null;
    }
    if (pathname.endsWith(".css")) {
      return matchesPathPattern(pathname, STYLE_DECOY_PATHS) ? "style" : null;
    }
    return null;
  };

  const buildDecoyBody = (url) => {
    const pathname = pathForDecoy(url);
    const kind = decoyKindForPath(url);
    if (kind === "manifest") {
      return {
        body: JSON.stringify(FAKE_MANIFEST),
        contentType: "application/json; charset=utf-8",
      };
    }
    if (kind === "image") {
      if (pathname.endsWith(".svg")) {
        return {
          body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
          contentType: "image/svg+xml; charset=utf-8",
        };
      }
      return { body: PNG_1X1, contentType: "image/png" };
    }
    if (kind === "script") {
      return { body: "", contentType: "application/javascript; charset=utf-8" };
    }
    if (kind === "html") {
      return {
        body: "<!doctype html><html><body></body></html>",
        contentType: "text/html; charset=utf-8",
      };
    }
    if (kind === "style") return { body: "", contentType: "text/css; charset=utf-8" };
    return null;
  };

  const fetchMethodFor = (input, init) => {
    const initMethod = init && init.method;
    if (initMethod != null) return String(initMethod).toUpperCase();
    try {
      if (typeof Request !== "undefined" && input instanceof Request && input.method) {
        return String(input.method).toUpperCase();
      }
    } catch {}
    return "GET";
  };

  const isDecoyableMethod = (method) => method === "GET" || method === "HEAD";

  const byteLengthFor = (body) => {
    if (typeof body === "string") return new TextEncoder().encode(body).length;
    if (body instanceof Uint8Array) return body.byteLength;
    return 0;
  };

  const buildDecoyResponse = (url, method = "GET", decoyBody = buildDecoyBody(url)) => {
    if (!decoyBody) return null;
    const { body, contentType } = decoyBody;
    const responseBody = method === "HEAD" ? null : body;
    try {
      const response = new Response(responseBody, {
        status: 200,
        statusText: "OK",
        headers: {
          "content-length": String(byteLengthFor(body)),
          "content-type": contentType,
        },
      });
      fakeFetchResponses.set(response, { type: "basic", url: String(url) });
      return response;
    } catch {
      return new Response("", { status: 200 });
    }
  };

  const bump = (where, url) => {
    try {
      postProbe(url, where);
    } catch {}
  };

  const textBodyFor = (body) => {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) {
      try {
        return new TextDecoder().decode(body);
      } catch {
        return "";
      }
    }
    return "";
  };

  const arrayBufferFor = (body, text) => {
    if (body instanceof Uint8Array) {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    }
    return new TextEncoder().encode(text).buffer;
  };

  const responseValueFor = (xhr, body, contentType, text) => {
    const responseType = String(xhr.responseType || "");
    if (responseType === "arraybuffer") return arrayBufferFor(body, text);
    if (responseType === "blob") return new Blob([body], { type: contentType });
    if (responseType === "document") return null;
    if (responseType === "json") {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    }
    return text;
  };

  const patchFetch = () => {
    const origFetch = window.fetch;
    if (typeof origFetch !== "function") return;
    const wrappedFetch = {
      fetch(input) {
        if (disabled) return origFetch.apply(this, arguments);
        if (isBad(input)) {
          const url = getUrl(input);
          const method = fetchMethodFor(input, arguments[1]);
          const decoyBody = buildDecoyBody(url);
          if (shouldDecoy(url) && isDecoyableMethod(method) && decoyBody) {
            bump("fetch-decoy", url);
            return Promise.resolve(buildDecoyResponse(url, method, decoyBody));
          }
          bump("fetch", url);
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return origFetch.apply(this, arguments);
      },
    }.fetch;
    window.fetch = stealth(wrappedFetch, "fetch", { length: 1 });
  };

  const emptyFakeXhr = (readyState) => ({
    allHeaders: "",
    contentLength: null,
    contentType: null,
    readyState,
    response: "",
    responseText: "",
    responseTextError: false,
    responseURL: "",
    status: 0,
    statusText: "",
  });

  const parseHeaderNames = (rawHeaders) => {
    const names = new Set();
    for (const line of String(rawHeaders || "").split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index <= 0) continue;
      names.add(line.slice(0, index).trim().toLowerCase());
    }
    return names;
  };

  const fakeXhrSuccess = (xhr, blocked, decoyBody = buildDecoyBody(blocked.url)) => {
    const { async = true, method = "GET", url } = blocked;
    if (!decoyBody) {
      fakeXhrFailure(xhr, async);
      return;
    }
    const { contentType } = decoyBody;
    const body = method === "HEAD" ? "" : decoyBody.body;
    const text = method === "HEAD" ? "" : textBodyFor(body);
    const contentLength = String(byteLengthFor(decoyBody.body));
    const responseType = String(xhr.responseType || "");
    const responseValue = responseValueFor(xhr, body, contentType, text);
    const fake = emptyFakeXhr(1);
    fakeXhrResponses.set(xhr, fake);
    const settle = () => {
      try {
        xhr.dispatchEvent(new ProgressEvent("loadstart"));
      } catch {}
      try {
        Object.assign(fake, {
          allHeaders: `content-type: ${contentType}\r\ncontent-length: ${contentLength}\r\n`,
          contentLength,
          contentType,
          readyState: 2,
          responseURL: url,
          status: 200,
          statusText: "OK",
        });
        xhr.dispatchEvent(new Event("readystatechange"));
        fake.readyState = 3;
        xhr.dispatchEvent(new Event("readystatechange"));
        Object.assign(fake, {
          readyState: 4,
          response: responseValue,
          responseText: text,
          responseTextError: !!(responseType && responseType !== "text"),
        });
        xhr.dispatchEvent(new Event("readystatechange"));
        xhr.dispatchEvent(new Event("load"));
        xhr.dispatchEvent(new Event("loadend"));
      } catch {}
    };
    if (async) queueMicrotask(settle);
    else settle();
  };

  const fakeXhrFailure = (xhr, async = true) => {
    const fake = emptyFakeXhr(4);
    fakeXhrResponses.set(xhr, { ...fake, readyState: 1 });
    const settle = () => {
      try {
        xhr.dispatchEvent(new ProgressEvent("loadstart"));
      } catch {}
      try {
        fakeXhrResponses.set(xhr, fake);
        xhr.dispatchEvent(new Event("readystatechange"));
      } catch {}
      try {
        xhr.dispatchEvent(new Event("error"));
      } catch {}
      try {
        xhr.dispatchEvent(new Event("loadend"));
      } catch {}
    };
    if (async) queueMicrotask(settle);
    else settle();
  };

  const patchXhr = () => {
    const blockedXHRs = new WeakMap();
    const visibleHeaderCache = new WeakMap();
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origGetResponseHeader = XMLHttpRequest.prototype.getResponseHeader;
    const origGetAllResponseHeaders = XMLHttpRequest.prototype.getAllResponseHeaders;
    const visibleHeaderNamesFor = (xhr) => {
      try {
        const rawHeaders = origGetAllResponseHeaders.call(xhr);
        const cached = visibleHeaderCache.get(xhr);
        if (cached && cached.rawHeaders === rawHeaders) return cached.names;
        const names = parseHeaderNames(rawHeaders);
        visibleHeaderCache.set(xhr, { rawHeaders, names });
        return names;
      } catch {
        return null;
      }
    };
    const wrappedOpen = {
      open(method, url, ...rest) {
        if (disabled) return origOpen.call(this, method, url, ...rest);
        const bad = isBad(url);
        if (bad) {
          blockedXHRs.set(this, {
            async: rest.length === 0 || rest[0] !== false,
            method: String(method || "GET").toUpperCase(),
            url: getUrl(url),
          });
        } else fakeXhrResponses.delete(this);
        visibleHeaderCache.delete(this);
        return origOpen.call(this, method, bad ? "about:blank" : url, ...rest);
      },
    }.open;
    const wrappedSend = {
      send(...args) {
        if (disabled) return origSend.apply(this, args);
        if (!blockedXHRs.has(this)) return origSend.apply(this, args);
        const blocked = blockedXHRs.get(this);
        blockedXHRs.delete(this);
        const decoyBody = buildDecoyBody(blocked.url);
        if (shouldDecoy(blocked.url) && isDecoyableMethod(blocked.method) && decoyBody) {
          bump("xhr-decoy", blocked.url);
          fakeXhrSuccess(this, blocked, decoyBody);
          return;
        }
        bump("xhr", blocked.url);
        fakeXhrFailure(this, blocked.async);
      },
    }.send;
    const wrappedGetResponseHeader = {
      getResponseHeader(name) {
        const fake = fakeXhrResponses.get(this);
        if (fake) {
          const lower = String(name).toLowerCase();
          if (lower === "content-type") return fake.contentType;
          if (lower === "content-length") return fake.contentLength;
          return null;
        }
        const normalizedName = String(name == null ? "" : name)
          .trim()
          .toLowerCase();
        if (!normalizedName) return null;
        const visibleHeaderNames = visibleHeaderNamesFor(this);
        if (visibleHeaderNames && !visibleHeaderNames.has(normalizedName)) return null;
        return origGetResponseHeader.apply(this, arguments);
      },
    }.getResponseHeader;
    const wrappedGetAllResponseHeaders = {
      getAllResponseHeaders() {
        const fake = fakeXhrResponses.get(this);
        if (fake) return fake.allHeaders;
        const rawHeaders = origGetAllResponseHeaders.apply(this, arguments);
        visibleHeaderCache.set(this, { rawHeaders, names: parseHeaderNames(rawHeaders) });
        return rawHeaders;
      },
    }.getAllResponseHeaders;
    XMLHttpRequest.prototype.open = stealth(wrappedOpen, "open");
    XMLHttpRequest.prototype.send = stealth(wrappedSend, "send");
    XMLHttpRequest.prototype.getResponseHeader = stealth(
      wrappedGetResponseHeader,
      "getResponseHeader",
      { length: 1 }
    );
    XMLHttpRequest.prototype.getAllResponseHeaders = stealth(
      wrappedGetAllResponseHeaders,
      "getAllResponseHeaders",
      { length: 0 }
    );
  };

  patchFakeResponseMetadata();
  patchFakeXhrMetadata();
  patchFetch();
  patchXhr();
})();
