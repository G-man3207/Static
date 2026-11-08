/* eslint-disable max-lines, max-statements -- one installer per detection class keeps the Appendix A order auditable */
// Static - scout non-probe signals (MAIN world, observe only).
//
// Reads page *behavior*, never page content: vendor/replay resource URLs and
// globals from signals.js, device-readback API calls, user-agent reads, and the
// DOM-observable compatibility signals (sign-in fields, auth flows, CAPTCHA and
// bot frames, WebAuthn, PaymentRequest, Trusted Types, cross-origin frames).
// Every wrapped API is a strict pass-through; counts are deltas accumulated by
// scout.js and nothing here stores a page value.
(() => {
  const bus = globalThis.__static_scout__;
  if (!bus) return;
  const U = bus.U;
  const catalog = bus.catalog || {};
  const rowsOf = (rows) => (Array.isArray(rows) ? rows : []);

  const NativeURL = globalThis.URL;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeAddEventListener = EventTarget.prototype.addEventListener;
  const locationHref = String(globalThis.location ? globalThis.location.href : "http://localhost/");
  const currentPathname = String(
    globalThis.location && globalThis.location.pathname ? globalThis.location.pathname : "/"
  ).toLowerCase();
  const currentHostname = String(
    globalThis.location && globalThis.location.hostname ? globalThis.location.hostname : ""
  ).toLowerCase();
  const nativeGetAttribute = Element.prototype.getAttribute;

  // Caps that bound the DOM sweep cost on huge pages.
  const MAX_SELECTED_ELEMENTS = 400;
  const MAX_FRAMES = 200;
  const MAX_SWEEP_TIMES = [0, 400, 1500];
  const WEBGL_SURFACE_PARAMS = new Set([
    0x1f00, // VENDOR
    0x1f01, // RENDERER
    0x9245, // UNMASKED_VENDOR_WEBGL
    0x9246, // UNMASKED_RENDERER_WEBGL
  ]);

  // ─── Catalog matching ───────────────────────────────────────────────────────
  const indexCatalog = (rows) => {
    const index = { fragments: [], hostSuffixes: new Map(), pathRules: [], rowsById: new Map() };
    for (const row of rowsOf(rows)) {
      if (!row || typeof row.id !== "string") continue;
      index.rowsById.set(row.id, row);
      for (const domain of rowsOf(row.domains)) {
        if (typeof domain !== "string" || !domain) continue;
        const slash = domain.indexOf("/");
        if (slash !== -1) {
          index.pathRules.push({
            host: domain.slice(0, slash).toLowerCase(),
            id: row.id,
            prefix: `/${domain.slice(slash + 1).toLowerCase()}`,
          });
        } else if (domain.includes(".")) {
          index.hostSuffixes.set(domain.toLowerCase(), row.id);
        } else {
          index.fragments.push({ id: row.id, text: `/${domain.toLowerCase()}/` });
        }
      }
    }
    return index;
  };

  const vendorIndex = indexCatalog(catalog.vendors);
  const replayIndex = indexCatalog(catalog.replay);
  const vendorRows = rowsOf(catalog.vendors);

  const parsePageUrl = (value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
    try {
      const parsed = new NativeURL(value, locationHref);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const matchIndex = (index, parsed) => {
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    for (const rule of index.pathRules) {
      if ((host === rule.host || host.endsWith(`.${rule.host}`)) && path.startsWith(rule.prefix)) {
        return rule.id;
      }
    }
    let position = host.indexOf(".");
    let candidate = host;
    while (candidate) {
      const id = index.hostSuffixes.get(candidate);
      if (id) return id;
      if (position === -1) break;
      candidate = host.slice(position + 1);
      position = host.indexOf(".", position + 1);
    }
    for (const fragment of index.fragments) {
      if (path.includes(fragment.text)) return fragment.id;
    }
    return null;
  };

  const vendorRowFor = (parsed) => {
    if (!parsed || vendorIndex.rowsById.size === 0) return null;
    const id = matchIndex(vendorIndex, parsed);
    return id ? vendorIndex.rowsById.get(id) || null : null;
  };

  const replayFor = (parsed) => {
    if (!parsed || replayIndex.rowsById.size === 0) return null;
    return matchIndex(replayIndex, parsed);
  };

  // ─── Forwarded signals ───────────────────────────────────────────────────────
  const vendorSignaled = new Set();
  const noteVendor = (row) => {
    if (!row || vendorSignaled.has(row.id)) return;
    vendorSignaled.add(row.id);
    bus.vendor(row.id);
  };

  const noteResource = (value) => {
    try {
      const parsed = parsePageUrl(value);
      if (!parsed) return false;
      bus.metrics.resources += 1;
      const row = vendorRowFor(parsed);
      if (row) {
        bus.metrics.vendorMatches += 1;
        noteVendor(row);
      }
      const replayId = replayFor(parsed);
      if (replayId) bus.replay(replayId);
      return true;
    } catch {
      return false;
    }
  };

  const pathExists = (path) => {
    if (typeof path !== "string" || !path) return false;
    try {
      const segments = path.split(".");
      let holder = globalThis;
      for (let index = 0; index < segments.length; index++) {
        if (holder == null) return false;
        const segment = segments[index];
        if (!(segment in Object(holder))) return false;
        if (index === segments.length - 1) return true;
        holder = holder[segment];
      }
      return false;
    } catch {
      return false;
    }
  };

  const scanVendorGlobals = () => {
    for (const row of vendorRows) {
      for (const globalPath of rowsOf(row.globals)) {
        if (pathExists(globalPath)) {
          noteVendor(row);
          signalEmbeddedVendor(row);
          break;
        }
      }
    }
  };

  const scanReplayGlobals = () => {
    for (const row of rowsOf(catalog.replay)) {
      for (const globalPath of rowsOf(row.globals)) {
        if (pathExists(globalPath)) {
          try {
            bus.replay(row.id);
          } catch {}
          break;
        }
      }
    }
  };

  // ─── Compatibility signals ───────────────────────────────────────────────────
  const compatSignaled = new Set();
  const markCompat = (id) => {
    if (compatSignaled.has(id)) return;
    compatSignaled.add(id);
    bus.compat(id);
  };

  const LOGIN_PATH_RE =
    /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|log_in|authenticate|auth|sso|session\/new|users\/sign_in)(?:\/|$|\.)/i;
  const CHECKOUT_PATH_RE =
    /(?:^|\/)(?:checkout|check-out|payment|pay|billing|purchase|order|subscribe|cart|wallet)(?:\/|$|\.)/i;

  const classifyLocation = () => {
    try {
      const path = currentPathname;
      if (LOGIN_PATH_RE.test(path)) markCompat("login_path");
      if (CHECKOUT_PATH_RE.test(path)) markCompat("checkout_path");
    } catch {}
  };

  const safeQuery = (selector, limit) => {
    try {
      const found = document.querySelectorAll(selector);
      if (!found) return [];
      return Array.from(found).slice(0, limit);
    } catch {
      return [];
    }
  };

  const attributeOf = (element, name) => {
    try {
      const value = nativeGetAttribute.call(element, name);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };

  const CARD_TOKEN_RE =
    /(?:^|[-_\s])(?:cc|card|credit|debit|payment|pan|cvv|cvc|csc|exp(?:iry|iration)?|security[-_]?code)(?:$|[-_\s])/i;

  const isCardField = (element) => {
    const autocomplete = attributeOf(element, "autocomplete").toLowerCase();
    if (autocomplete.startsWith("cc-")) return true;
    return [attributeOf(element, "name"), attributeOf(element, "id")].some((token) =>
      CARD_TOKEN_RE.test(token)
    );
  };

  const scanFields = () => {
    try {
      if (
        safeQuery("input[type='password' i], input[autocomplete~='current-password' i]", 1).length
      ) {
        markCompat("password_field");
      }
      const emailSelector =
        "input[type='email' i], input[autocomplete~='email' i], input[name*='email' i], input[id*='email' i]";
      if (safeQuery(emailSelector, 1).length) markCompat("email_field");
      for (const input of safeQuery("input", MAX_SELECTED_ELEMENTS)) {
        if (isCardField(input)) {
          markCompat("card_field");
          break;
        }
      }
    } catch {}
  };

  const AUTH_HOST_RE =
    /(?:^|\.)(?:accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|github\.com|gitlab\.com|bitbucket\.org|auth0\.com|okta\.com|onelogin\.com|ping(?:identity|one)\.com|facebook\.com|linkedin\.com|twitter\.com|x\.com|slack\.com|dropbox\.com|salesforce\.com|shopify\.com|paypal\.com|amazon\.com)$/i;
  const AUTH_PATH_RE =
    /\/(?:oauth2?|authorize|openid|sso|saml2?|signin|sign-in|login|log-in|auth)(?:\/|$|\?)/i;

  const absoluteUrl = (value) => {
    try {
      return new NativeURL(value, locationHref);
    } catch {
      return null;
    }
  };

  const scanOauth = () => {
    if (compatSignaled.has("oauth_redirect")) return;
    for (const element of safeQuery("form[action], a[href]", MAX_SELECTED_ELEMENTS)) {
      const target = absoluteUrl(
        attributeOf(element, element.localName === "form" ? "action" : "href")
      );
      if (!target || target.hostname === currentHostname) continue;
      if (AUTH_HOST_RE.test(target.hostname) || AUTH_PATH_RE.test(target.pathname)) {
        markCompat("oauth_redirect");
        return;
      }
    }
  };

  const scannedFrames = new WeakSet();
  // A vendor's challenge script/global is one signal per page; each distinct
  // challenge frame is its own (repeated frames are what the engine weights).
  const compatEmbeddedVendors = new Set();
  let captchaSignal = false;

  const compatForKind = (kind) => {
    if (kind === "captcha") {
      captchaSignal = true;
      bus.compat("captcha");
    } else if (kind === "bot") {
      bus.compat("bot_challenge");
    }
  };

  const signalFrameVendor = (row) => {
    if (!row || (row.kind !== "captcha" && row.kind !== "bot")) return;
    compatForKind(row.kind);
  };

  const signalEmbeddedVendor = (row) => {
    if (!row || (row.kind !== "captcha" && row.kind !== "bot")) return;
    if (compatEmbeddedVendors.has(row.id)) return;
    compatEmbeddedVendors.add(row.id);
    compatForKind(row.kind);
  };

  const scanFrames = () => {
    try {
      for (const frame of safeQuery("iframe[src], frame[src]", MAX_FRAMES)) {
        if (scannedFrames.has(frame)) continue;
        scannedFrames.add(frame);
        const src = attributeOf(frame, "src");
        const target = absoluteUrl(src);
        noteResource(src);
        if (!target) continue;
        const row = vendorRowFor(target);
        if (row) signalFrameVendor(row);
        if (
          target.protocol.startsWith("http") &&
          target.hostname &&
          target.hostname.toLowerCase() !== currentHostname
        ) {
          bus.compat("cross_origin_frame");
        }
      }
    } catch {}
  };

  const scanScriptTags = () => {
    try {
      for (const script of safeQuery("script[src]", MAX_SELECTED_ELEMENTS)) {
        const src = attributeOf(script, "src");
        if (!src) continue;
        noteResource(src);
        const target = absoluteUrl(src);
        const row = target && vendorRowFor(target);
        if (row) signalEmbeddedVendor(row);
      }
    } catch {}
  };

  const scanActions = () => {
    try {
      for (const element of safeQuery("form[action], a[href]", MAX_SELECTED_ELEMENTS)) {
        noteResource(attributeOf(element, element.localName === "form" ? "action" : "href"));
      }
    } catch {}
  };

  const scanCaptchaMarkup = () => {
    if (captchaSignal) return;
    try {
      const found = document.querySelector(
        "[data-sitekey], .g-recaptcha, .h-captcha, .cf-turnstile, .frc-captcha, altcha-widget, [data-pcallback]"
      );
      if (found) {
        captchaSignal = true;
        bus.compat("captcha");
      }
    } catch {}
  };

  const scanTrustedTypes = () => {
    if (compatSignaled.has("trusted_types")) return;
    try {
      for (const meta of safeQuery("meta[http-equiv]", 32)) {
        const equiv = String(meta.httpEquiv || "").toLowerCase();
        if (equiv !== "content-security-policy") continue;
        const content = String(meta.content || "").toLowerCase();
        if (content.includes("require-trusted-types-for")) {
          markCompat("trusted_types");
          return;
        }
      }
    } catch {}
  };

  const scanPageCompat = () => {
    classifyLocation();
    scanFields();
    scanOauth();
    scanFrames();
    scanTrustedTypes();
    scanCaptchaMarkup();
  };

  // ─── Resource-URL observation ────────────────────────────────────────────────
  const observedResources = new Set();
  const inspectObservedResource = (value, kind) => {
    try {
      if (typeof value !== "string" || !value || observedResources.has(value)) return;
      if (observedResources.size < 1000) observedResources.add(value);
      noteResource(value);
      if (kind === "document") scanVendorGlobals();
    } catch {}
  };

  const installPerformanceObserver = () => {
    if (typeof globalThis.PerformanceObserver !== "function") return;
    const supported = PerformanceObserver.supportedEntryTypes;
    if (!Array.isArray(supported) || !supported.includes("resource")) return;
    try {
      const observer = new PerformanceObserver((list) => {
        try {
          for (const entry of list.getEntries()) inspectObservedResource(entry.name, "resource");
        } catch {}
      });
      observer.observe({ buffered: true, type: "resource" });
      bus.onFinalize(() => {
        try {
          observer.disconnect();
        } catch {}
      });
    } catch {}
  };

  // ─── Device readback counters ─────────────────────────────────────────────────
  const wrapCountingMethod = (proto, prop, surface, when) => {
    if (!proto) return false;
    let found;
    try {
      found = U.descriptorOwnerFor(proto, prop);
    } catch {
      return false;
    }
    if (!found || typeof found.desc.value !== "function") return false;
    try {
      U.wrapMethod(found.owner, prop, (orig) => ({
        [prop](...args) {
          const result = orig.apply(this, args);
          try {
            if (!when || when(args, this, result)) bus.device(surface);
          } catch {}
          return result;
        },
      }));
      return true;
    } catch {
      return false;
    }
  };

  const wrapCountingGetter = (target, prop, surface) => {
    if (!target) return false;
    let found;
    try {
      found = U.descriptorOwnerFor(target, prop);
    } catch {
      return false;
    }
    if (!found || !found.desc || typeof found.desc.get !== "function") return false;
    try {
      U.wrapGetter(found.owner, prop, (nativeGet) => ({
        get() {
          const value = nativeGet.call(this);
          bus.device(surface);
          return value;
        },
      }));
      return true;
    } catch {
      return false;
    }
  };

  const installCanvasAudioCounters = () => {
    // canvas image data + text metrics
    const canvas = globalThis.HTMLCanvasElement;
    if (canvas && canvas.prototype) {
      wrapCountingMethod(canvas.prototype, "toDataURL", "canvas");
      wrapCountingMethod(canvas.prototype, "toBlob", "canvas");
    }
    const context2d = globalThis.CanvasRenderingContext2D;
    if (context2d && context2d.prototype) {
      wrapCountingMethod(context2d.prototype, "getImageData", "canvas");
      wrapCountingMethod(context2d.prototype, "measureText", "canvas");
    }
    // WebGL renderer / vendor strings
    for (const ctorName of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
      const ctor = globalThis[ctorName];
      if (!ctor || !ctor.prototype) continue;
      wrapCountingMethod(ctor.prototype, "getParameter", "webgl", (args) =>
        WEBGL_SURFACE_PARAMS.has(Number(args[0]))
      );
    }
    // audio fingerprint
    const offline = globalThis.OfflineAudioContext;
    if (offline && offline.prototype) {
      wrapCountingMethod(offline.prototype, "startRendering", "audio");
    }
    const audioBuffer = globalThis.AudioBuffer;
    if (audioBuffer && audioBuffer.prototype) {
      wrapCountingMethod(audioBuffer.prototype, "getChannelData", "audio");
    }
  };

  const installFontCounters = () => {
    let fontProto;
    try {
      fontProto = globalThis.FontFaceSet ? FontFaceSet.prototype : null;
      if (!fontProto && document.fonts) fontProto = Object.getPrototypeOf(document.fonts);
    } catch {}
    if (!fontProto) return;
    wrapCountingMethod(fontProto, "check", "fonts");
    wrapCountingMethod(fontProto, "load", "fonts");
    wrapCountingMethod(fontProto, "values", "fonts");
  };

  const installHardwareScreenCounters = () => {
    wrapCountingGetter(globalThis.navigator, "hardwareConcurrency", "hardware");
    wrapCountingGetter(globalThis.navigator, "deviceMemory", "hardware");
    if (globalThis.Screen && Screen.prototype) {
      for (const prop of [
        "width",
        "height",
        "availWidth",
        "availHeight",
        "colorDepth",
        "pixelDepth",
      ]) {
        wrapCountingGetter(Screen.prototype, prop, "screen");
      }
    }
    wrapCountingGetter(globalThis, "devicePixelRatio", "screen");
  };

  const installTimezoneLanguageCounters = () => {
    if (typeof globalThis.Date === "function") {
      wrapCountingMethod(Date.prototype, "getTimezoneOffset", "timezone");
    }
    if (globalThis.Intl && Intl.DateTimeFormat && Intl.DateTimeFormat.prototype) {
      wrapCountingMethod(Intl.DateTimeFormat.prototype, "resolvedOptions", "timezone");
    }
    wrapCountingGetter(globalThis.navigator, "languages", "languages");
  };

  const installStorageMediaCounters = () => {
    try {
      if (globalThis.navigator && navigator.storage) {
        wrapCountingMethod(Object.getPrototypeOf(navigator.storage), "estimate", "storage");
      }
    } catch {}
    wrapObservedConstructor("RTCPeerConnection", () => bus.device("webrtc"), true);
    try {
      if (globalThis.navigator && navigator.mediaDevices) {
        wrapCountingMethod(
          Object.getPrototypeOf(navigator.mediaDevices),
          "enumerateDevices",
          "media_devices"
        );
      }
    } catch {}
  };

  const installBatteryClientHintCounters = () => {
    wrapCountingMethod(globalThis.Navigator && Navigator.prototype, "getBattery", "battery");
    const uaDataProto = (() => {
      try {
        if (typeof globalThis.NavigatorUAData === "function") return NavigatorUAData.prototype;
        const userAgentData = globalThis.navigator && navigator.userAgentData;
        return userAgentData ? Object.getPrototypeOf(userAgentData) : null;
      } catch {
        return null;
      }
    })();
    if (uaDataProto) wrapCountingMethod(uaDataProto, "getHighEntropyValues", "client_hints");
  };

  const installPluginPermissionConnectionCounters = () => {
    wrapCountingGetter(globalThis.navigator, "plugins", "plugins");
    let permissions;
    try {
      permissions = globalThis.navigator && navigator.permissions;
    } catch {}
    if (permissions) wrapCountingMethod(Object.getPrototypeOf(permissions), "query", "permissions");
    wrapCountingGetter(globalThis.navigator, "connection", "connection");
    if (globalThis.HTMLMediaElement && HTMLMediaElement.prototype) {
      wrapCountingMethod(HTMLMediaElement.prototype, "canPlayType", "codecs");
    }
  };

  const installDeviceCounters = () => {
    installCanvasAudioCounters();
    installFontCounters();
    installHardwareScreenCounters();
    installTimezoneLanguageCounters();
    installStorageMediaCounters();
    installBatteryClientHintCounters();
    installPluginPermissionConnectionCounters();
  };

  const wrapObservedConstructor = (name, observe, after = true, observed = () => {}) => {
    const Original = globalThis[name];
    if (typeof Original !== "function" || typeof Original.prototype !== "object") return false;
    const Wrapped = function (...args) {
      if (!new.target) return Reflect.apply(Original, this, args);
      if (!after) {
        try {
          observe(args);
        } catch {}
      }
      const result = Reflect.construct(Original, args, new.target);
      try {
        if (after) observe(args);
        observed(result);
      } catch {}
      return result;
    };
    Wrapped.prototype = Original.prototype;
    // WebIDL constructors expose a non-writable .prototype descriptor.
    try {
      Object.defineProperty(Wrapped, "prototype", { writable: false });
    } catch {}
    U.alignPrototypeConstructor(Wrapped, Original);
    U.copyConstructorStatics(Wrapped, Original);
    const disguised = U.stealth(Wrapped, name, {
      length: Original.length,
      source: U.nativeSourceFor(Original, name),
    });
    try {
      Object.defineProperty(globalThis, name, {
        ...Object.getOwnPropertyDescriptor(globalThis, name),
        value: disguised,
      });
      return true;
    } catch {
      return false;
    }
  };

  // ─── User-agent sniffing ──────────────────────────────────────────────────────
  const installUaReadCounters = () => {
    for (const prop of ["appVersion", "platform", "userAgent", "userAgentData"]) {
      try {
        const found = U.descriptorOwnerFor(globalThis.navigator, prop);
        if (!found || !found.desc || typeof found.desc.get !== "function") continue;
        U.wrapGetter(found.owner, prop, (nativeGet) => ({
          get() {
            const value = nativeGet.call(this);
            bus.uaRead(1);
            return value;
          },
        }));
      } catch {}
    }
  };

  // ─── Payments / passkeys ──────────────────────────────────────────────────────
  const installPaymentRequest = () => {
    wrapObservedConstructor("PaymentRequest", () => bus.compat("payment_request"), false);
  };

  const installWebauthn = () => {
    try {
      const credentials = globalThis.navigator && navigator.credentials;
      if (!credentials) return;
      const proto = Object.getPrototypeOf(credentials);
      for (const method of ["create", "get"]) {
        let found;
        try {
          found = U.descriptorOwnerFor(proto, method);
        } catch {}
        if (!found || typeof found.desc.value !== "function") continue;
        U.wrapMethod(found.owner, method, (orig) => ({
          [method](options) {
            try {
              if (options && options.publicKey) markCompat("webauthn");
            } catch {}
            return orig.apply(this, arguments);
          },
        }));
      }
    } catch {}
  };

  // ─── Sweeps ───────────────────────────────────────────────────────────────────
  const sweep = () => {
    scanVendorGlobals();
    scanReplayGlobals();
    scanPageCompat();
    scanActions();
    scanScriptTags();
  };

  const installSweeps = () => {
    sweep();
    bus.page();
    for (const delay of MAX_SWEEP_TIMES) {
      if (delay === 0) continue;
      nativeSetTimeout(() => {
        try {
          sweep();
        } catch {}
        try {
          bus.page();
        } catch {}
      }, delay);
    }
    const listen = (target, type) => {
      try {
        nativeAddEventListener.call(target, type, () => {
          try {
            sweep();
          } catch {}
          try {
            bus.page();
          } catch {}
        });
      } catch {}
    };
    listen(document, "DOMContentLoaded");
    listen(globalThis, "load");
  };

  // ─── Install ──────────────────────────────────────────────────────────────────
  try {
    installDeviceCounters();
  } catch {}
  try {
    installUaReadCounters();
  } catch {}
  try {
    installPaymentRequest();
  } catch {}
  try {
    installWebauthn();
  } catch {}
  try {
    installPerformanceObserver();
  } catch {}
  try {
    installSweeps();
  } catch {}

  bus.ready("signals");
})();
