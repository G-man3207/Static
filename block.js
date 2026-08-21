/* eslint-disable max-lines -- fetch/XHR blocking and Noise decoys are kept together for cross-vector consistency */
// Static - MAIN-world fetch/XHR extension probe blocker and Noise decoy engine.
(() => {
  const U = globalThis.__static_block_utils__;
  const BRIDGE_EVENT = "__perf_noise_bi__";
  const MAX_QUEUED_PROBES = 1000;
  const COMPAT_SIGNAL_THROTTLE_MS = 15000;
  const blockedFetchPromises = new WeakMap();
  let persona = new Set();
  let personaPaths = new Map();
  let noiseEnabled = false;
  let disabled = false;
  let lastCompatSignalAt = 0;

  const applyConfigUpdate = (data) => {
    if (!data || data.type !== "config_update") return;
    if (Array.isArray(data.persona)) {
      persona = new Set(data.persona.filter((id) => typeof id === "string"));
    }
    if (data.personaPaths && typeof data.personaPaths === "object") {
      const next = new Map();
      for (const [id, paths] of Object.entries(data.personaPaths)) {
        if (typeof id !== "string" || !Array.isArray(paths)) continue;
        next.set(
          id.toLowerCase(),
          new Set(
            paths.filter((path) => typeof path === "string").map((path) => path.toLowerCase())
          )
        );
      }
      personaPaths = next;
    } else if (Array.isArray(data.persona)) {
      personaPaths = new Map();
    }
    if (typeof data.noiseEnabled === "boolean") {
      noiseEnabled = data.noiseEnabled;
    }
    if (typeof data.disabled === "boolean") {
      disabled = data.disabled;
    }
  };

  const bridge = U.setupBridge(BRIDGE_EVENT, MAX_QUEUED_PROBES, applyConfigUpdate);

  const postProbe = (url, where) => {
    const safeUrl = url == null ? "" : String(url).slice(0, 512);
    const safeWhere = where == null ? "" : String(where).slice(0, 64);
    bridge.post("probe_blocked", { url: safeUrl, where: safeWhere });
  };

  const postCompatSignal = (signal) => {
    bridge.post("compat_signal", {
      kind: String(signal.kind || "unknown").slice(0, 64),
      url: signal.url == null ? "" : String(signal.url).slice(0, 512),
      vector: String(signal.vector || "unknown").slice(0, 64),
    });
  };

  const rejectBlockedFetch = (url) => {
    const rejection = Promise.reject(new TypeError("Failed to fetch"));
    try {
      blockedFetchPromises.set(rejection, { url, vector: "fetch" });
    } catch {}
    return rejection;
  };

  const reportUnhandledBlockedFetch = (event) => {
    if (disabled || !event || !blockedFetchPromises.has(event.promise)) return;
    const blocked = blockedFetchPromises.get(event.promise);
    blockedFetchPromises.delete(event.promise);
    const now = Date.now();
    if (now - lastCompatSignalAt < COMPAT_SIGNAL_THROTTLE_MS) return;
    lastCompatSignalAt = now;
    postCompatSignal({
      kind: "unhandled_blocked_fetch",
      url: blocked && blocked.url,
      vector: blocked && blocked.vector,
    });
  };

  window.addEventListener("unhandledrejection", reportUnhandledBlockedFetch, { capture: true });

  const shouldDecoy = (url) => {
    if (!noiseEnabled) return false;
    const id = U.extractExtId(url);
    return id != null && persona.has(id);
  };

  const PNG_1X1_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const PNG_1X1 = Uint8Array.from(atob(PNG_1X1_B64), (char) => char.charCodeAt(0));
  // Minimal valid 1x1 GIF / JPEG so path extension, Content-Type, and magic
  // bytes stay consistent. A universal PNG body for every image path is a
  // cheap Noise tell (manifest probes already use path-aware types).
  const GIF_1X1 = Uint8Array.from(
    atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
    (char) => char.charCodeAt(0)
  );
  const JPEG_1X1 = Uint8Array.from(
    atob(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA//2Q=="
    ),
    (char) => char.charCodeAt(0)
  );
  // Known store IDs get real-looking names so multi-ID probe dumps do not all
  // collapse to the same "Browser Extension" string. Unknown IDs get a stable
  // per-ID seeded name so personas still look diverse.
  const KNOWN_MANIFEST_NAMES = {
    nngceckbapebfimnlniiiahkandclblb: "Bitwarden - Free Password Manager",
    aeblfdkhhhdcdjpifhhbdiojplfjncoa: "1Password – Password Manager",
    hdokiejnpimakedhajhdlcegeplioahd: "LastPass: Free Password Manager",
    fdjamakpfbbddfjaooikfcpapjohcfmg: "Dashlane — Password Manager",
    ohigdmefobenhgkmpihnlmkphdoagcpe: "Keeper® Password Manager & Digital Vault",
    pnlccmojcmeohlpggmfnbbiapkmbliob: "RoboForm Password Manager",
    fooolghllnmhmmndgjiamiiodkpenpbb: "RoboForm Password Manager",
    bmikpgodpkclnkgmnpphehdgcimmided: "NordPass® Password Manager & Digital Vault",
    cjnlpnbkjbnmdieljmighbdoljmgfibk: "Proton Pass: Free Password Manager",
    oboonakemofpalcgghocfoadofidjkkk: "KeePassXC-Browser",
    dhdgffkkebhmkfjojejmpbldmpobfkfo: "Tampermonkey",
    clngdbkpkpeebahjckkjfobafhncgmne: "Stylus",
    bkdgflcldnnnapblkhphbgpggdiikppg: "DuckDuckGo Privacy Essentials",
    cjpalhdlnbpafiamejdnhcphjbkeiagm: "uBlock Origin",
    gighmmpiobklfepjocnamgkkbiglidom: "AdBlock — block ads across the web",
    cfhdojbkjhnklbpkdaibdccddilifddb: "Adblock Plus - free ad blocker",
    bgnkhhnnamicmpeenaelnjfhikgbkllg: "AdGuard AdBlocker",
    pkehgijcmpdhfbdbbnkijodmdjhbjlgp: "Privacy Badger",
    ddkjiahejlhfcafbddmgiahcphecmpfh: "uBlock Origin Lite",
    mlomiejdfkolichcflejclcbmpeaniij: "Ghostery Tracker & Ad Blocker",
    kbfnbcaeplbcioakkpcpgfkobkghlhen: "Grammarly: AI Writing Assistant",
    oldceeleldhonbafppcapldpdifcinji: "LanguageTool - Grammar and Spell Checker",
    nkbihfbeogaeaoehlefnkodbefgpgknn: "MetaMask",
    hnfanknocfeofbddgcijnmhnfnkdnaad: "Coinbase Wallet extension",
    bfnaelmomeimhlpmgjnjophhpkkoljpa: "Phantom",
    ibnejdfjmmkpcnlpebklmnkoeoihofec: "TronLink",
    bhhhlkgekbhbdjncpdbjkmjnnapolepf: "Solflare Wallet",
    acmacodkjbdgmoleebolmdjonilkdbch: "Rabby Wallet",
    egjidjbpglichdcongccjofoobgmfgei: "Trust Wallet",
    fmkadmapgofadopljbjfkapdkoienihi: "React Developer Tools",
    lmhkpmbekcpmknklioeibfkpmmfibljd: "Redux DevTools",
    nhdogjmejiglipccpnnnanhbledajbpd: "Vue.js devtools",
    aapbdbdomjkkjkaonfhkkikfgjllcleb: "Google Translate",
    cofdbpoegempjloogbagkncekinflcnj: "DeepL: translate and write with AI",
    npggkinfhjadegenkdjokdacdkopdfdb: "Proton VPN: Fast & Secure",
    eimadpbcbfnmbkopoojfekhnkhdbieeh: "Dark Reader",
    bfogiajgogklnfndlkggihnhakgkbjgg: "Rakuten: Get Cash Back For Shopping",
    lmelmgmclklieheidfjlabcjljeojmho: "Capital One Shopping: Save Now",
    bmnlcjabgnpnenekpadlanbbkooimhnj: "Honey: Automatic Coupons & Cash Back",
  };
  const GENERIC_MANIFEST_ADJECTIVES = [
    "Quick",
    "Smart",
    "Simple",
    "Secure",
    "Fast",
    "Easy",
    "Pro",
    "Lite",
  ];
  const GENERIC_MANIFEST_NOUNS = [
    "Helper",
    "Tools",
    "Assistant",
    "Shield",
    "Manager",
    "Boost",
    "Guard",
    "Kit",
  ];
  const IMAGE_DECOY_PATHS = U.IMAGE_DECOY_PATHS;
  const SCRIPT_DECOY_PATHS = U.SCRIPT_DECOY_PATHS;
  const HTML_DECOY_PATHS = U.HTML_DECOY_PATHS;
  const STYLE_DECOY_PATHS = U.STYLE_DECOY_PATHS;
  const fakeXhrResponses = new WeakMap();
  const fakeFetchResponses = new WeakMap();

  const hashExtensionId = (id) => {
    let h = 2166136261;
    const s = String(id || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  const buildFakeManifest = (url) => {
    const id = U.extractExtId(url) || "00000000000000000000000000000000";
    const h = hashExtensionId(id);
    const known = KNOWN_MANIFEST_NAMES[id];
    const name =
      known ||
      `${GENERIC_MANIFEST_ADJECTIVES[h % GENERIC_MANIFEST_ADJECTIVES.length]} ${
        GENERIC_MANIFEST_NOUNS[(h >>> 3) % GENERIC_MANIFEST_NOUNS.length]
      }`;
    const major = 1 + (h % 5);
    const minor = (h >>> 8) % 12;
    const patch = (h >>> 16) % 20;
    return {
      manifest_version: 3,
      name,
      version: `${major}.${minor}.${patch}`,
      description: "",
      icons: { 16: "icon.png", 48: "icon.png", 128: "icon.png" },
    };
  };

  const imageDecoyForPath = (pathname) => {
    if (pathname.endsWith(".svg")) {
      return {
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        contentType: "image/svg+xml; charset=utf-8",
      };
    }
    if (pathname.endsWith(".gif")) {
      return { body: GIF_1X1, contentType: "image/gif" };
    }
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
      return { body: JPEG_1X1, contentType: "image/jpeg" };
    }
    if (pathname.endsWith(".png")) {
      return { body: PNG_1X1, contentType: "image/png" };
    }
    // ico/bmp/webp and other allowlisted suffixes without matching magic stay
    // fail-closed — wrong bytes + Content-Type is worse than a clean block.
    return null;
  };

  const patchFakeResponseMetadata = () => {
    if (typeof Response === "undefined" || !Response.prototype) return;
    for (const prop of ["type", "url"]) {
      const found = U.descriptorOwnerFor(Response.prototype, prop);
      if (!found || !found.desc || typeof found.desc.get !== "function") continue;
      const { desc, owner } = found;
      Object.defineProperty(owner, prop, {
        ...desc,
        get: U.stealth(
          function get() {
            const fake = fakeFetchResponses.get(this);
            if (fake && Object.prototype.hasOwnProperty.call(fake, prop)) return fake[prop];
            return desc.get.call(this);
          },
          `get ${prop}`,
          { length: 0, source: U.nativeSourceFor(desc.get, `get ${prop}`) }
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
      value: U.stealth(wrappedClone, "clone", {
        length: 0,
        source: U.nativeSourceFor(origClone, "clone"),
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
      const found = U.descriptorOwnerFor(XMLHttpRequest.prototype, prop);
      if (!found || !found.desc || typeof found.desc.get !== "function") continue;
      const { desc, owner } = found;
      Object.defineProperty(owner, prop, {
        ...desc,
        get: U.stealth(
          function get() {
            return fakeXhrValueFor(this, prop, desc);
          },
          `get ${prop}`,
          { length: 0, source: U.nativeSourceFor(desc.get, `get ${prop}`) }
        ),
      });
    }
  };

  const pathForDecoy = U.pathFor;

  const matchesPathPattern = U.matchesPathPattern;

  const isLearnedPersonaPath = (url) => {
    const id = U.extractExtId(url);
    if (!id) return false;
    const learned = personaPaths.get(id);
    if (!learned) return false;
    const pathname = U.sanitizeExtensionPath(pathForDecoy(url));
    return pathname ? learned.has(pathname) : false;
  };

  const allowlistedOrLearnedKind = (url, pathname, patterns, kind) => {
    if (matchesPathPattern(pathname, patterns) || isLearnedPersonaPath(url)) return kind;
    return null;
  };

  const decoyKindForPath = (url) => {
    const pathname = pathForDecoy(url);
    if (!pathname) return null;
    if (pathname.endsWith("/manifest.json")) return "manifest";
    if (/\.(png|jpe?g|gif|webp|ico|bmp|svg)$/i.test(pathname)) {
      const kind = allowlistedOrLearnedKind(url, pathname, IMAGE_DECOY_PATHS, "image");
      return kind && imageDecoyForPath(pathname) ? "image" : null;
    }
    if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) {
      return allowlistedOrLearnedKind(url, pathname, SCRIPT_DECOY_PATHS, "script");
    }
    if (pathname.endsWith(".html") || pathname.endsWith(".htm")) {
      return allowlistedOrLearnedKind(url, pathname, HTML_DECOY_PATHS, "html");
    }
    if (pathname.endsWith(".css")) {
      return allowlistedOrLearnedKind(url, pathname, STYLE_DECOY_PATHS, "style");
    }
    return isLearnedPersonaPath(url) ? U.learnedDecoyKindForPath(pathname) : null;
  };

  const buildDecoyBody = (url) => {
    const pathname = pathForDecoy(url);
    const kind = decoyKindForPath(url);
    if (kind === "manifest") {
      return {
        body: JSON.stringify(buildFakeManifest(url)),
        contentType: "application/json; charset=utf-8",
      };
    }
    if (kind === "image") return imageDecoyForPath(pathname);
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
    if (kind === "json") {
      return { body: "{}", contentType: "application/json; charset=utf-8" };
    }
    if (kind === "text") return { body: "", contentType: "text/plain; charset=utf-8" };
    if (kind === "xml") {
      return {
        body: '<?xml version="1.0" encoding="UTF-8"?><root/>',
        contentType: "application/xml; charset=utf-8",
      };
    }
    return null;
  };

  const decoyHeadersFor = (url, contentType, len) => {
    const id =
      (typeof U !== "undefined" && U.extractExtId ? U.extractExtId(url) : null) ||
      "00000000000000000000000000000000";
    const iid = id || "00000000000000000000000000000000";
    let h = 0;
    for (let i = 0; i < iid.length; i++) h = (h * 31 + iid.charCodeAt(i)) >>> 0;
    const t = 1704067200000 + (h % 365) * 86400000;
    const lm = new Date(t).toUTCString();
    const hd = {
      "content-type": contentType,
      "last-modified": lm,
      "cache-control": "public, max-age=3600",
      etag: `"${h.toString(16).padStart(8, "0")}"`,
    };
    if (len != null) hd["content-length"] = String(len);
    return hd;
  };

  const byteLengthFor = (body) => {
    if (typeof body === "string") return new TextEncoder().encode(body).length;
    if (body instanceof Uint8Array) return body.byteLength;
    return 0;
  };

  const buildDecoyResponse = (url, method = "GET", decoyBody = buildDecoyBody(url)) => {
    if (!decoyBody) return null;
    const { body, contentType } = decoyBody;
    const responseBody = method === "HEAD" ? null : body;
    const len = byteLengthFor(body);
    const headers = decoyHeadersFor(url, contentType, len);
    try {
      const response = new Response(responseBody, {
        status: 200,
        statusText: "OK",
        headers,
      });
      fakeFetchResponses.set(response, { type: "default", url: String(url) });
      return response;
    } catch {
      return new Response("", {
        status: 200,
        headers: { "content-type": contentType || "text/plain" },
      });
    }
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
        if (U.isBad(input)) {
          const url = U.getUrl(input);
          const method = fetchMethodFor(input, arguments[1]);
          const decoyBody = buildDecoyBody(url);
          if (shouldDecoy(url) && isDecoyableMethod(method) && decoyBody) {
            bump("fetch-decoy", url);
            return Promise.resolve(buildDecoyResponse(url, method, decoyBody));
          }
          bump("fetch", url);
          return rejectBlockedFetch(url);
        }
        return origFetch.apply(this, arguments);
      },
    }.fetch;
    window.fetch = U.stealth(wrappedFetch, "fetch", { length: 1 });
  };

  const emptyFakeXhr = (readyState) => ({
    allHeaders: "",
    contentLength: null,
    contentType: null,
    headers: {},
    lastModified: null,
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
    const hdrs = decoyHeadersFor(blocked.url, contentType, contentLength);
    const settle = () => {
      try {
        xhr.dispatchEvent(new ProgressEvent("loadstart"));
      } catch {}
      try {
        Object.assign(fake, {
          allHeaders: `content-type: ${hdrs["content-type"]}\r\ncontent-length: ${contentLength}\r\nlast-modified: ${hdrs["last-modified"]}\r\ncache-control: ${hdrs["cache-control"]}\r\netag: ${hdrs.etag}\r\n`,
          contentLength,
          contentType: hdrs["content-type"],
          headers: hdrs,
          lastModified: hdrs["last-modified"],
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
        const bad = U.isBad(url);
        if (bad) {
          blockedXHRs.set(this, {
            async: rest.length === 0 || rest[0] !== false,
            method: String(method || "GET").toUpperCase(),
            url: U.getUrl(url),
          });
        } else {
          blockedXHRs.delete(this);
          fakeXhrResponses.delete(this);
        }
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
        const normalizedName = String(name == null ? "" : name)
          .trim()
          .toLowerCase();
        if (!normalizedName) return null;
        const fake = fakeXhrResponses.get(this);
        if (fake) {
          const headers = fake.headers || {};
          return Object.prototype.hasOwnProperty.call(headers, normalizedName)
            ? headers[normalizedName]
            : null;
        }
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
    XMLHttpRequest.prototype.open = U.stealth(wrappedOpen, "open");
    XMLHttpRequest.prototype.send = U.stealth(wrappedSend, "send");
    XMLHttpRequest.prototype.getResponseHeader = U.stealth(
      wrappedGetResponseHeader,
      "getResponseHeader",
      { length: 1 }
    );
    XMLHttpRequest.prototype.getAllResponseHeaders = U.stealth(
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
