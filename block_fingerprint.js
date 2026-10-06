/* eslint-disable max-lines, max-statements -- MAIN-world fingerprint shims are safer kept contiguous */
// Static - MAIN-world opt-in device and browser signal poisoning.
(() => {
  const U = globalThis.__static_block_utils__;
  const BRIDGE_EVENT = "__perf_fingerprint_bi__";
  const MODE_MASK = "mask";
  const DEFAULT_PERSONA = {
    architecture: "x86",
    audioSeed: 0x4a17d10,
    bitness: "64",
    canvasSeed: 0x51a7c0de,
    connection: { downlink: 10, effectiveType: "4g", rtt: 50, saveData: false, type: "wifi" },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    languages: ["en-US", "en"],
    maxTouchPoints: 0,
    os: "windows",
    pdfViewerEnabled: true,
    platform: "Win32",
    screen: {
      availHeight: 1040,
      availWidth: 1920,
      colorDepth: 24,
      devicePixelRatio: 1,
      height: 1080,
      pixelDepth: 24,
      width: 1920,
    },
    storageQuota: 128 * 1024 * 1024 * 1024,
    timeZone: "America/New_York",
    uaDataPlatform: "Windows",
    uaOs: "Windows NT 10.0; Win64; x64",
    vendor: "Google Inc.",
    webglRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webglVendor: "Google Inc. (Intel)",
  };
  const WEBGL_VENDOR = 0x1f00;
  const WEBGL_RENDERER = 0x1f01;
  const UNMASKED_VENDOR_WEBGL = 0x9245;
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  const allowedModes = new Set(["off", MODE_MASK]);
  const uaDataMethodProxies = new WeakMap();
  const uaDataNavigatorProxies = new WeakMap();
  const uaDataProxies = new WeakMap();
  const explicitTimeZoneDateTimeFormats = new WeakSet();
  const poisonedAudioBuffers = new WeakSet();
  const nativeDateGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  let fingerprintMode = "off";
  let fingerprintPersona = null;
  let disabled = false;

  const finiteNumber = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  const finitePositiveInteger = (value, fallback) => {
    const number = finiteNumber(value, fallback);
    return Math.max(0, Math.round(number));
  };

  const safeObject = (value) => (value && typeof value === "object" ? value : {});

  const sanitizedScreen = (screen) => {
    const source = safeObject(screen);
    return {
      availHeight: finitePositiveInteger(source.availHeight, DEFAULT_PERSONA.screen.availHeight),
      availWidth: finitePositiveInteger(source.availWidth, DEFAULT_PERSONA.screen.availWidth),
      colorDepth: finitePositiveInteger(source.colorDepth, DEFAULT_PERSONA.screen.colorDepth),
      devicePixelRatio: finiteNumber(
        source.devicePixelRatio,
        DEFAULT_PERSONA.screen.devicePixelRatio
      ),
      height: finitePositiveInteger(source.height, DEFAULT_PERSONA.screen.height),
      pixelDepth: finitePositiveInteger(source.pixelDepth, DEFAULT_PERSONA.screen.pixelDepth),
      width: finitePositiveInteger(source.width, DEFAULT_PERSONA.screen.width),
    };
  };

  const sanitizedConnection = (connection) => {
    const source = safeObject(connection);
    return {
      downlink: finiteNumber(source.downlink, DEFAULT_PERSONA.connection.downlink),
      effectiveType: String(source.effectiveType || DEFAULT_PERSONA.connection.effectiveType),
      rtt: finitePositiveInteger(source.rtt, DEFAULT_PERSONA.connection.rtt),
      saveData: !!source.saveData,
      type: String(source.type || DEFAULT_PERSONA.connection.type),
    };
  };

  const sanitizedLanguages = (languages) => {
    if (!Array.isArray(languages)) return DEFAULT_PERSONA.languages.slice();
    const clean = languages
      .map((language) => String(language || "").trim())
      .filter(Boolean)
      .slice(0, 5);
    return clean.length ? clean : DEFAULT_PERSONA.languages.slice();
  };

  const sanitizePersona = (persona) => {
    const source = safeObject(persona);
    return {
      ...DEFAULT_PERSONA,
      architecture: String(source.architecture || DEFAULT_PERSONA.architecture),
      audioSeed: finitePositiveInteger(source.audioSeed, DEFAULT_PERSONA.audioSeed),
      bitness: String(source.bitness || DEFAULT_PERSONA.bitness),
      canvasSeed: finitePositiveInteger(source.canvasSeed, DEFAULT_PERSONA.canvasSeed),
      connection: sanitizedConnection(source.connection),
      deviceMemory: finiteNumber(source.deviceMemory, DEFAULT_PERSONA.deviceMemory),
      hardwareConcurrency: finitePositiveInteger(
        source.hardwareConcurrency,
        DEFAULT_PERSONA.hardwareConcurrency
      ),
      languages: sanitizedLanguages(source.languages),
      maxTouchPoints: finitePositiveInteger(source.maxTouchPoints, DEFAULT_PERSONA.maxTouchPoints),
      os: String(source.os || DEFAULT_PERSONA.os),
      pdfViewerEnabled:
        typeof source.pdfViewerEnabled === "boolean"
          ? source.pdfViewerEnabled
          : DEFAULT_PERSONA.pdfViewerEnabled,
      platform: String(source.platform || DEFAULT_PERSONA.platform),
      screen: sanitizedScreen(source.screen),
      storageQuota: finitePositiveInteger(source.storageQuota, DEFAULT_PERSONA.storageQuota),
      timeZone: String(source.timeZone || DEFAULT_PERSONA.timeZone),
      uaDataPlatform: String(source.uaDataPlatform || DEFAULT_PERSONA.uaDataPlatform),
      uaOs: String(source.uaOs || DEFAULT_PERSONA.uaOs),
      vendor: String(source.vendor || DEFAULT_PERSONA.vendor),
      webglRenderer: String(source.webglRenderer || DEFAULT_PERSONA.webglRenderer),
      webglVendor: String(source.webglVendor || DEFAULT_PERSONA.webglVendor),
    };
  };

  const persona = () => fingerprintPersona || DEFAULT_PERSONA;

  const isMasking = () => !disabled && fingerprintMode === MODE_MASK;

  const applyConfigUpdate = (data) => {
    if (!data || data.type !== "config_update") return;
    if (typeof data.fingerprintMode === "string") {
      fingerprintMode = allowedModes.has(data.fingerprintMode) ? data.fingerprintMode : "off";
    }
    if (data.fingerprintPersona && typeof data.fingerprintPersona === "object") {
      fingerprintPersona = sanitizePersona(data.fingerprintPersona);
    }
    if (typeof data.disabled === "boolean") {
      disabled = data.disabled;
    }
  };

  U.setupBridge(BRIDGE_EVENT, 1000, applyConfigUpdate);

  const maskedUa = (ua) => {
    const p = persona();
    const source = String(ua || "");
    if (source.includes("(") && source.includes(")")) {
      return source.replace(/\([^)]*\)/, `(${p.uaOs})`);
    }
    return `Mozilla/5.0 (${p.uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`;
  };

  const maskedAppVersion = (appVersion) => {
    const p = persona();
    const source = String(appVersion || "");
    if (source.includes("(") && source.includes(")")) {
      return source.replace(/\([^)]*\)/, `(${p.uaOs})`);
    }
    return `5.0 (${p.uaOs})`;
  };

  const navigatorValueFor = (prop, original) => {
    const p = persona();
    const navValues = {
      appVersion: maskedAppVersion(original),
      deviceMemory: p.deviceMemory,
      hardwareConcurrency: p.hardwareConcurrency,
      language: p.languages[0] || original,
      languages: p.languages.slice(),
      maxTouchPoints: p.maxTouchPoints,
      pdfViewerEnabled: p.pdfViewerEnabled,
      platform: p.platform,
      userAgent: maskedUa(original),
      vendor: p.vendor,
      webdriver: false,
    };
    return Object.prototype.hasOwnProperty.call(navValues, prop) ? navValues[prop] : original;
  };

  // Wrap a getter wherever it lives on `target`'s prototype chain so masking
  // returns maskedValue(original, receiver) instead of the native value.
  const patchGetter = (target, prop, maskedValue) => {
    const found = target && U.descriptorOwnerFor(target, prop);
    if (!found) return;
    try {
      U.wrapGetter(found.owner, prop, (nativeGet) => ({
        get() {
          const original = nativeGet.call(this);
          return isMasking() ? maskedValue(original, this) : original;
        },
      }));
    } catch {}
  };

  // Same for methods: wrap `name` wherever it lives on the prototype chain.
  const patchMethodOf = (target, name, wrap) => {
    const found = target && U.descriptorOwnerFor(target, name);
    if (found) U.wrapMethod(found.owner, name, wrap);
  };

  // Proxy `target` so the methods named in `fakes` become native-looking
  // fakes; `fakes[name](native, target, args)` runs on call. Other methods
  // read through bound to the real object.
  const proxyWithFakes = (target, fakes) => {
    if (!target) return target;
    return new Proxy(target, {
      get(t, prop) {
        const value = Reflect.get(t, prop, t);
        if (typeof value !== "function") return value;
        if (!Object.prototype.hasOwnProperty.call(fakes, prop)) return value.bind(t);
        return U.stealth(
          function () {
            return fakes[prop](value, t, arguments);
          },
          prop,
          { length: value.length, source: U.nativeSourceFor(value, prop) }
        );
      },
    });
  };

  const fakeArrayLike = (original) => {
    if (typeof original !== "object" || original == null) return null;
    const fake = Object.create(Object.getPrototypeOf(original));
    Object.defineProperty(fake, "length", {
      value: 0,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return fake;
  };

  const patchNavigatorGetters = () => {
    if (typeof Navigator === "undefined" || !Navigator.prototype) return;
    for (const prop of [
      "appVersion",
      "deviceMemory",
      "hardwareConcurrency",
      "language",
      "languages",
      "maxTouchPoints",
      "pdfViewerEnabled",
      "platform",
      "userAgent",
      "vendor",
      "webdriver",
    ]) {
      patchGetter(Navigator.prototype, prop, (original) => navigatorValueFor(prop, original));
    }
    for (const prop of ["plugins", "mimeTypes"]) {
      patchGetter(Navigator.prototype, prop, (original) => fakeArrayLike(original) || []);
    }
  };

  const screenValueFor = (prop, original) => {
    const p = persona();
    return Object.prototype.hasOwnProperty.call(p.screen, prop) ? p.screen[prop] : original;
  };

  const patchScreenGetters = () => {
    if (typeof Screen !== "undefined" && Screen.prototype) {
      for (const prop of [
        "availHeight",
        "availWidth",
        "colorDepth",
        "height",
        "pixelDepth",
        "width",
      ]) {
        patchGetter(Screen.prototype, prop, (original) => screenValueFor(prop, original));
      }
    }
    patchGetter(window, "devicePixelRatio", (original) =>
      screenValueFor("devicePixelRatio", original)
    );
    if (typeof ScreenOrientation !== "undefined" && ScreenOrientation.prototype) {
      patchGetter(ScreenOrientation.prototype, "type", () => "landscape-primary");
      patchGetter(ScreenOrientation.prototype, "angle", () => 0);
    }
  };

  const maskedBrands = (brands) => {
    if (!Array.isArray(brands)) return brands;
    return brands.map((brand) => ({ ...brand }));
  };

  const highEntropyValueFor = (hint, original) => {
    const p = persona();
    const values = {
      architecture: p.architecture,
      bitness: p.bitness,
      model: "",
      platform: p.uaDataPlatform,
      platformVersion: p.os === "windows" ? "10.0.0" : "15.0.0",
      uaFullVersion: "152.0.0.0",
      wow64: false,
    };
    return Object.prototype.hasOwnProperty.call(values, hint) ? values[hint] : original;
  };

  const maskedUaDataJson = (target) => {
    const p = persona();
    const base =
      target && typeof target.toJSON === "function"
        ? target.toJSON()
        : { brands: target && target.brands, mobile: target && target.mobile };
    return {
      ...safeObject(base),
      brands: maskedBrands(base && base.brands),
      mobile: false,
      platform: p.uaDataPlatform,
    };
  };

  const maskedHighEntropyValues = (target, hints) => {
    const wanted = typeof hints === "string" ? [hints] : Array.from(hints || []);
    const base =
      target && typeof target.getHighEntropyValues === "function"
        ? target.getHighEntropyValues(hints).catch(() => ({}))
        : Promise.resolve({});
    return Promise.resolve(base).then((values) => {
      const out = { ...safeObject(values) };
      for (const hint of wanted) out[hint] = highEntropyValueFor(hint, out[hint]);
      out.brands = maskedBrands(out.brands || (target && target.brands));
      out.mobile = false;
      out.platform = persona().uaDataPlatform;
      return out;
    });
  };

  const maskedUaData = (target, owner) => {
    if (!target || typeof target !== "object") return target;
    if (owner && (typeof owner === "object" || typeof owner === "function")) {
      const ownerCached = uaDataNavigatorProxies.get(owner);
      if (ownerCached) return ownerCached;
    }
    const cached = uaDataProxies.get(target);
    if (cached) return cached;
    const nativeValue = (prop) => Reflect.get(target, prop, target);
    const cachedMethod = (prop, build) => {
      let methods = uaDataMethodProxies.get(target);
      if (!methods) {
        methods = {};
        uaDataMethodProxies.set(target, methods);
      }
      methods[prop] ||= build();
      return methods[prop];
    };
    const proxy = new Proxy(target, {
      get(t, prop) {
        if (!isMasking()) return nativeValue(prop);
        if (prop === "brands") return maskedBrands(nativeValue(prop));
        if (prop === "mobile") return false;
        if (prop === "platform") return persona().uaDataPlatform;
        if (prop === "toJSON") {
          const orig = nativeValue(prop);
          if (typeof orig !== "function") return orig;
          return cachedMethod("toJSON", () =>
            U.stealth(
              function toJSON() {
                return maskedUaDataJson(t);
              },
              "toJSON",
              { length: 0, source: U.nativeSourceFor(orig, "toJSON") }
            )
          );
        }
        if (prop === "getHighEntropyValues") {
          const orig = nativeValue(prop);
          if (typeof orig !== "function") return orig;
          return cachedMethod("getHighEntropyValues", () =>
            U.stealth(
              function getHighEntropyValues(hints) {
                return maskedHighEntropyValues(t, hints);
              },
              "getHighEntropyValues",
              { length: 1, source: U.nativeSourceFor(orig, "getHighEntropyValues") }
            )
          );
        }
        const value = nativeValue(prop);
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
    uaDataProxies.set(target, proxy);
    if (owner && (typeof owner === "object" || typeof owner === "function")) {
      uaDataNavigatorProxies.set(owner, proxy);
    }
    return proxy;
  };

  const patchUserAgentData = () => {
    if (typeof Navigator === "undefined" || !Navigator.prototype) return;
    patchGetter(Navigator.prototype, "userAgentData", maskedUaData);
  };

  const timeZoneOffsetFor = (date, timeZone) => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        month: "2-digit",
        second: "2-digit",
        timeZone,
        year: "numeric",
      }).formatToParts(date);
      const values = {};
      for (const part of parts) {
        if (part.type !== "literal") values[part.type] = Number(part.value);
      }
      const localAsUtc = Date.UTC(
        values.year,
        values.month - 1,
        values.day,
        values.hour,
        values.minute,
        values.second
      );
      return Math.round((date.getTime() - localAsUtc) / 60000);
    } catch {
      return nativeDateGetTimezoneOffset.call(date);
    }
  };

  const trackedDateTimeFormatArgs = (args, state) => {
    const nextArgs = Array.from(args);
    const options = nextArgs[1];
    if (!options || (typeof options !== "object" && typeof options !== "function")) {
      return nextArgs;
    }
    nextArgs[1] = new Proxy(options, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "timeZone" && value != null) state.explicitTimeZone = true;
        return value;
      },
    });
    return nextArgs;
  };

  const rememberExplicitTimeZoneFormatter = (formatter, explicitTimeZone) => {
    if (
      explicitTimeZone &&
      formatter &&
      (typeof formatter === "object" || typeof formatter === "function")
    ) {
      explicitTimeZoneDateTimeFormats.add(formatter);
    }
    return formatter;
  };

  const patchDateTimeFormatConstructor = () => {
    if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") return;
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    const desc = Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat");
    const wrappedDateTimeFormat = function DateTimeFormat() {
      const state = { explicitTimeZone: false };
      const args = trackedDateTimeFormatArgs(arguments, state);
      const formatter = new.target
        ? Reflect.construct(OriginalDateTimeFormat, args, new.target)
        : OriginalDateTimeFormat.apply(this, args);
      return rememberExplicitTimeZoneFormatter(formatter, state.explicitTimeZone);
    };
    wrappedDateTimeFormat.prototype = OriginalDateTimeFormat.prototype;
    U.copyConstructorStatics(wrappedDateTimeFormat, OriginalDateTimeFormat);
    U.alignPrototypeConstructor(wrappedDateTimeFormat, OriginalDateTimeFormat);
    Object.defineProperty(Intl, "DateTimeFormat", {
      ...(desc || { configurable: true, writable: true }),
      value: U.stealth(wrappedDateTimeFormat, "DateTimeFormat", {
        length: OriginalDateTimeFormat.length,
        source: U.nativeSourceFor(OriginalDateTimeFormat, "DateTimeFormat"),
      }),
    });
  };

  const patchTimezone = () => {
    U.wrapMethod(Date.prototype, "getTimezoneOffset", (origOffset) => ({
      getTimezoneOffset() {
        if (!isMasking()) return origOffset.apply(this, arguments);
        return timeZoneOffsetFor(this, persona().timeZone);
      },
    }));
    U.wrapMethod(Intl.DateTimeFormat.prototype, "resolvedOptions", (origResolved) => ({
      resolvedOptions() {
        const options = origResolved.apply(this, arguments);
        if (!isMasking() || explicitTimeZoneDateTimeFormats.has(this)) return options;
        return { ...options, timeZone: persona().timeZone };
      },
    }));
    for (const method of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
      U.wrapMethod(Date.prototype, method, (orig) => ({
        [method](...args) {
          if (!isMasking()) return orig.apply(this, args);
          const locale = args[0];
          const options = args[1] && typeof args[1] === "object" ? { ...args[1] } : {};
          if (!options.timeZone) options.timeZone = persona().timeZone;
          return orig.call(this, locale, options);
        },
      }));
    }
  };

  const patchNetworkInformation = () => {
    let proto = null;
    try {
      proto = navigator.connection && Object.getPrototypeOf(navigator.connection);
    } catch {}
    if (!proto) return;
    for (const prop of ["downlink", "effectiveType", "rtt", "saveData", "type"]) {
      patchGetter(proto, prop, (original) => {
        const connection = persona().connection;
        return Object.prototype.hasOwnProperty.call(connection, prop) ? connection[prop] : original;
      });
    }
  };

  let cachedFakeBattery = null;
  const fakeBattery = () => {
    if (cachedFakeBattery) return cachedFakeBattery;
    const battery = {
      charging: true,
      chargingTime: 0,
      dischargingTime: Infinity,
      level: 1,
      onchargingchange: null,
      onchargingtimechange: null,
      ondischargingtimechange: null,
      onlevelchange: null,
    };
    try {
      const BatteryManager = window.BatteryManager;
      if (BatteryManager && BatteryManager.prototype) {
        Object.setPrototypeOf(battery, BatteryManager.prototype);
      }
    } catch {}
    cachedFakeBattery = battery;
    return battery;
  };

  const patchBattery = () => {
    if (typeof Navigator === "undefined") return;
    patchMethodOf(Navigator.prototype, "getBattery", (orig) => ({
      getBattery() {
        if (isMasking()) return Promise.resolve(fakeBattery());
        return orig.apply(this, arguments);
      },
    }));
  };

  const patchPerformanceMemory = () => {
    patchGetter(window.performance, "memory", () => ({
      jsHeapSizeLimit: 2197815296,
      totalJSHeapSize: 12345678,
      usedJSHeapSize: 9876543,
    }));
  };

  const patchStorageEstimate = () => {
    try {
      const proto = navigator.storage && Object.getPrototypeOf(navigator.storage);
      patchMethodOf(proto, "estimate", (orig) => ({
        estimate() {
          if (!isMasking()) return orig.apply(this, arguments);
          return Promise.resolve({ quota: persona().storageQuota, usage: 0, usageDetails: {} });
        },
      }));
    } catch {}
  };

  const PLAUSIBLE_WEBGL_EXTENSIONS = [
    "ANGLE_instanced_arrays",
    "EXT_blend_minmax",
    "EXT_color_buffer_half_float",
    "EXT_disjoint_timer_query",
    "EXT_float_blend",
    "EXT_frag_depth",
    "EXT_shader_texture_lod",
    "EXT_texture_compression_bptc",
    "EXT_texture_compression_rgtc",
    "EXT_texture_filter_anisotropic",
    "EXT_sRGB",
    "OES_element_index_uint",
    "OES_fbo_render_mipmap",
    "OES_standard_derivatives",
    "OES_texture_float",
    "OES_texture_float_linear",
    "OES_texture_half_float",
    "OES_texture_half_float_linear",
    "OES_vertex_array_object",
    "WEBGL_color_buffer_float",
    "WEBGL_compressed_texture_astc",
    "WEBGL_compressed_texture_etc",
    "WEBGL_compressed_texture_etc1",
    "WEBGL_compressed_texture_pvrtc",
    "WEBGL_compressed_texture_s3tc",
    "WEBGL_compressed_texture_s3tc_srgb",
    "WEBGL_debug_renderer_info",
    "WEBGL_debug_shaders",
    "WEBGL_depth_texture",
    "WEBGL_draw_buffers",
    "WEBGL_lose_context",
    "WEBGL_multi_draw",
  ];
  const PLAUSIBLE_WEBGL_EXTENSION_OBJECTS = new Set([
    "EXT_blend_minmax",
    "EXT_color_buffer_float",
    "EXT_color_buffer_half_float",
    "EXT_disjoint_timer_query",
    "EXT_float_blend",
    "EXT_frag_depth",
    "EXT_shader_texture_lod",
    "EXT_texture_compression_bptc",
    "EXT_texture_compression_rgtc",
    "EXT_texture_filter_anisotropic",
    "EXT_sRGB",
    "OES_element_index_uint",
    "OES_fbo_render_mipmap",
    "OES_standard_derivatives",
    "OES_texture_float",
    "OES_texture_float_linear",
    "OES_texture_half_float",
    "OES_texture_half_float_linear",
    "OES_vertex_array_object",
    "WEBGL_color_buffer_float",
    "WEBGL_compressed_texture_s3tc",
    "WEBGL_compressed_texture_s3tc_srgb",
    "WEBGL_debug_renderer_info",
    "WEBGL_debug_shaders",
    "WEBGL_depth_texture",
    "WEBGL_draw_buffers",
    "WEBGL_lose_context",
    "WEBGL_multi_draw",
  ]);
  const WEBGL_CONTEXT_ATTRIBUTES = {
    alpha: true,
    antialias: true,
    depth: true,
    desynchronized: false,
    failIfMajorPerformanceCaveat: false,
    powerPreference: "default",
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    stencil: false,
  };

  const patchWebglContext = (Ctor) => {
    if (typeof Ctor === "undefined" || !Ctor.prototype) return;
    const proto = Ctor.prototype;
    U.wrapMethod(proto, "getParameter", (orig) => ({
      getParameter(parameter) {
        if (isMasking()) {
          const numeric = Number(parameter);
          if (Number.isNaN(numeric)) return null;
          if (numeric === WEBGL_VENDOR || numeric === UNMASKED_VENDOR_WEBGL) {
            return persona().webglVendor;
          }
          if (numeric === WEBGL_RENDERER || numeric === UNMASKED_RENDERER_WEBGL) {
            return persona().webglRenderer;
          }
        }
        return orig.apply(this, arguments);
      },
    }));
    U.wrapMethod(proto, "getSupportedExtensions", (orig) => ({
      getSupportedExtensions() {
        if (!isMasking()) return orig.apply(this, arguments);
        return PLAUSIBLE_WEBGL_EXTENSIONS.slice();
      },
    }));
    U.wrapMethod(proto, "getShaderPrecisionFormat", (orig) => ({
      getShaderPrecisionFormat(_shaderType, _precisionType) {
        if (!isMasking()) return orig.apply(this, arguments);
        return { rangeMin: 127, rangeMax: 127, precision: 23 };
      },
    }));
    U.wrapMethod(proto, "getContextAttributes", (orig) => ({
      getContextAttributes() {
        if (!isMasking()) return orig.apply(this, arguments);
        return { ...WEBGL_CONTEXT_ATTRIBUTES };
      },
    }));
    U.wrapMethod(proto, "getExtension", (orig) => ({
      getExtension(name) {
        if (!isMasking()) return orig.apply(this, arguments);
        const extensionName = String(name || "");
        if (extensionName === "WEBGL_debug_renderer_info") {
          return { UNMASKED_RENDERER_WEBGL, UNMASKED_VENDOR_WEBGL };
        }
        return PLAUSIBLE_WEBGL_EXTENSION_OBJECTS.has(extensionName) ? {} : null;
      },
    }));
  };

  const patchWebgl = () => {
    patchWebglContext(globalThis.WebGLRenderingContext);
    patchWebglContext(globalThis.WebGL2RenderingContext);
  };

  const tweakPixels = (data, seed) => {
    if (!data || data.length < 4) return;
    const pixelCount = Math.max(1, Math.floor(data.length / 4));
    const tweakCount =
      pixelCount < 4 ? 1 : Math.min(5, 2 + Math.floor(Math.log2(pixelCount + 1) / 3));
    for (let t = 0; t < tweakCount; t++) {
      const pixelSeed = (Math.imul(seed ^ (t + 1), 0x01000193) + t * 0x9e3779b9) >>> 0;
      const pixel = pixelSeed % pixelCount;
      const base = pixel * 4;
      const magnitude = ((pixelSeed >>> 16) % 3) + 1;
      const delta = pixelSeed & 1 ? magnitude : -magnitude;
      for (let i = 0; i < 3; i++) {
        data[base + i] = Math.max(0, Math.min(255, data[base + i] + delta));
      }
      if (data[base + 3] === 0) data[base + 3] = 1;
    }
  };

  let nativeCanvasGetImageData = null;
  let nativeOffscreenGetImageData = null;

  // Copy `canvas` (capped at 8192px per side) and nudge one seeded pixel.
  const cloneWithNoise = (canvas, makeCanvas, nativeGetImageData) => {
    const width = Math.max(1, Math.min(canvas.width || 1, 8192));
    const height = Math.max(1, Math.min(canvas.height || 1, 8192));
    const clone = makeCanvas(width, height);
    const ctx = clone.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, width, height);
    const seed = persona().canvasSeed;
    const x = seed % width;
    const y = Math.floor(seed / Math.max(1, width)) % height;
    const imageData = (nativeGetImageData || ctx.getImageData).call(ctx, x, y, 1, 1);
    tweakPixels(imageData.data, seed);
    ctx.putImageData(imageData, x, y);
    return clone;
  };

  const newCanvas = (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };

  const cloneCanvasWithNoise = (canvas) =>
    cloneWithNoise(canvas, newCanvas, nativeCanvasGetImageData);

  const cloneOffscreenCanvasWithNoise = (canvas) =>
    cloneWithNoise(
      canvas,
      (width, height) => new OffscreenCanvas(width, height),
      nativeOffscreenGetImageData
    );

  // Export methods (toDataURL, toBlob, convertToBlob) read a noised clone.
  const patchCanvasExport = (proto, name, cloneFor) => {
    U.wrapMethod(proto, name, (orig) => ({
      [name]() {
        if (!isMasking()) return orig.apply(this, arguments);
        try {
          const clone = cloneFor(this);
          if (clone) return orig.apply(clone, arguments);
        } catch {}
        return orig.apply(this, arguments);
      },
    }));
  };

  const patchGetImageData = (proto) =>
    U.wrapMethod(proto, "getImageData", (orig) => ({
      getImageData() {
        const imageData = orig.apply(this, arguments);
        if (isMasking()) tweakPixels(imageData.data, persona().canvasSeed);
        return imageData;
      },
    }));

  const patchOffscreenCanvas = () => {
    if (typeof OffscreenCanvas === "undefined") return;
    patchCanvasExport(OffscreenCanvas.prototype, "convertToBlob", cloneOffscreenCanvasWithNoise);
    try {
      const proto = Object.getPrototypeOf(new OffscreenCanvas(1, 1).getContext("2d"));
      const sharesCanvasContext =
        typeof CanvasRenderingContext2D !== "undefined" &&
        proto.getImageData === CanvasRenderingContext2D.prototype.getImageData;
      nativeOffscreenGetImageData = sharesCanvasContext
        ? nativeCanvasGetImageData
        : patchGetImageData(proto);
    } catch {}
  };

  const patchCanvas = () => {
    if (typeof HTMLCanvasElement === "undefined") return;
    patchCanvasExport(HTMLCanvasElement.prototype, "toDataURL", cloneCanvasWithNoise);
    patchCanvasExport(HTMLCanvasElement.prototype, "toBlob", cloneCanvasWithNoise);
    if (typeof CanvasRenderingContext2D === "undefined") return;
    nativeCanvasGetImageData = patchGetImageData(CanvasRenderingContext2D.prototype);
  };

  const clampAudioSample = (value) => Math.max(-1, Math.min(1, value));

  const poisonAudioChannel = (buffer, channel, seed) => {
    const length = Math.max(0, Math.floor(buffer.length || 0));
    if (!length) return;
    const tweakCount = length < 8 ? 1 : Math.min(3, 1 + Math.floor(Math.log2(length + 1) / 6));
    const canCopy =
      typeof buffer.copyFromChannel === "function" && typeof buffer.copyToChannel === "function";
    for (let t = 0; t < tweakCount; t++) {
      const sampleSeed = (Math.imul(seed ^ (t + 1), 0x9e3779b9) + t * 0x01000193) >>> 0;
      const sample = sampleSeed % length;
      const magnitude = 0.00005 + ((sampleSeed >>> 8) % 50) / 1000000;
      const delta = sampleSeed & 1 ? magnitude : -magnitude;
      if (canCopy) {
        const segment = new Float32Array(1);
        buffer.copyFromChannel(segment, channel, sample);
        segment[0] = clampAudioSample((Number(segment[0]) || 0) + delta);
        buffer.copyToChannel(segment, channel, sample);
      } else {
        const data = buffer.getChannelData(channel);
        data[sample] = clampAudioSample((Number(data[sample]) || 0) + delta);
      }
    }
  };

  const poisonAudioBuffer = (buffer) => {
    if (!buffer || (typeof buffer !== "object" && typeof buffer !== "function")) return buffer;
    if (poisonedAudioBuffers.has(buffer)) return buffer;
    poisonedAudioBuffers.add(buffer);
    try {
      const channelCount = Math.min(Math.max(0, Math.floor(buffer.numberOfChannels || 0)), 2);
      for (let channel = 0; channel < channelCount; channel++) {
        const seed = (persona().audioSeed + Math.imul(channel + 1, 0x9e3779b9)) >>> 0;
        poisonAudioChannel(buffer, channel, seed);
      }
    } catch {}
    return buffer;
  };

  const patchAudioRendering = () => {
    if (typeof OfflineAudioContext === "undefined") return;
    U.wrapMethod(OfflineAudioContext.prototype, "startRendering", (orig) => ({
      startRendering() {
        const result = orig.apply(this, arguments);
        if (!isMasking()) return result;
        if (result && typeof result.then === "function") {
          return result.then((buffer) => poisonAudioBuffer(buffer));
        }
        return poisonAudioBuffer(result);
      },
    }));
  };

  const KEYBOARD_LAYOUT_CODES = [
    "Backquote",
    "Backslash",
    "Backspace",
    "BracketLeft",
    "BracketRight",
    "Comma",
    ...Array.from({ length: 10 }, (_, digit) => `Digit${digit}`),
    "Equal",
    "IntlBackslash",
    "IntlRo",
    "IntlYen",
    ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
    "Minus",
    "Period",
    "Quote",
    "Semicolon",
    "Slash",
  ];
  const PROMPT_PERMISSIONS = new Set([
    "camera",
    "microphone",
    "notifications",
    "clipboard-read",
    "clipboard-write",
    "midi",
    "midi-sysex",
  ]);

  const patchNavigatorObjects = () => {
    if (typeof Navigator === "undefined" || !Navigator.prototype) return;
    // Fakes resolving to a fixed primitive; array results are built per call.
    const resolve = (value) => () => Promise.resolve(value);
    patchGetter(Navigator.prototype, "keyboard", (original) =>
      proxyWithFakes(original, {
        getLayoutMap: () =>
          Promise.resolve(new Map(KEYBOARD_LAYOUT_CODES.map((code) => [code, code]))),
      })
    );
    patchGetter(Navigator.prototype, "mediaDevices", (original) =>
      proxyWithFakes(original, {
        enumerateDevices: () => Promise.resolve([]),
        getSupportedConstraints: (native, target, args) => native.apply(target, args),
      })
    );
    patchGetter(Navigator.prototype, "permissions", (original) =>
      proxyWithFakes(original, {
        query(native, target, args) {
          const permissionDesc = args[0];
          const name =
            permissionDesc && typeof permissionDesc === "object"
              ? permissionDesc.name
              : permissionDesc;
          if (PROMPT_PERMISSIONS.has(name)) return Promise.resolve({ name, state: "prompt" });
          return native.apply(target, args);
        },
      })
    );
    const plausibleMediaInfo = () =>
      Promise.resolve({ supported: true, smooth: true, powerEfficient: true });
    patchGetter(Navigator.prototype, "mediaCapabilities", (original) =>
      proxyWithFakes(original, {
        decodingInfo: plausibleMediaInfo,
        encodingInfo: plausibleMediaInfo,
      })
    );
    patchGetter(Navigator.prototype, "gpu", (original) =>
      proxyWithFakes(original, { requestAdapter: resolve(null) })
    );
    patchGetter(Navigator.prototype, "credentials", (original) =>
      proxyWithFakes(original, {
        get: resolve(null),
        create: resolve(null),
        store: resolve(null),
        preventSilentAccess: resolve(undefined),
      })
    );
    patchGetter(Navigator.prototype, "clipboard", (original) =>
      proxyWithFakes(original, {
        read: () => Promise.resolve([]),
        readText: resolve(""),
        write: resolve(undefined),
        writeText: resolve(undefined),
      })
    );
  };

  const MEDIA_QUERY_OVERRIDES = {
    "(prefers-color-scheme:dark)": false,
    "(prefers-color-scheme:light)": true,
    "(hover:hover)": true,
    "(hover:none)": false,
    "(pointer:fine)": true,
    "(pointer:coarse)": false,
    "(any-hover:hover)": true,
    "(any-hover:none)": false,
    "(any-pointer:fine)": true,
    "(any-pointer:coarse)": false,
  };

  const patchMatchMedia = () => {
    U.wrapMethod(window, "matchMedia", (orig) => ({
      matchMedia(query) {
        const result = orig.apply(this, arguments);
        if (!isMasking() || !result) return result;
        const normalized = String(query || "")
          .toLowerCase()
          .replace(/\s+/g, "");
        if (!Object.prototype.hasOwnProperty.call(MEDIA_QUERY_OVERRIDES, normalized)) return result;
        const override = MEDIA_QUERY_OVERRIDES[normalized];
        return new Proxy(result, {
          get(target, prop) {
            if (prop === "matches") return override;
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    }));
  };

  const patchHardwareAvailability = () => {
    if (typeof Navigator === "undefined" || !Navigator.prototype) return;
    for (const prop of ["bluetooth", "hid", "presentation", "serial", "usb", "wakeLock", "xr"]) {
      patchGetter(Navigator.prototype, prop, () => undefined);
    }
  };

  const patchRtcPeerConnection = () => {
    if (typeof RTCPeerConnection === "undefined") return;
    const OrigPC = RTCPeerConnection;
    const origDesc = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection") || {
      value: OrigPC,
      writable: true,
      configurable: true,
    };
    const wrapped = function RTCPeerConnection() {
      const pc = new OrigPC(...arguments);
      if (!isMasking()) return pc;
      const origAdd = pc.addEventListener.bind(pc);
      pc.addEventListener = function iceSuppressed(type, listener, options) {
        if (type !== "icecandidate") return origAdd(type, listener, options);
      };
      Object.defineProperty(pc, "onicecandidate", {
        configurable: true,
        set() {},
        get() {
          return null;
        },
      });
      return pc;
    };
    wrapped.prototype = OrigPC.prototype;
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      ...origDesc,
      value: U.stealth(wrapped, "RTCPeerConnection", {
        length: OrigPC.length,
        source: U.nativeSourceFor(OrigPC, "RTCPeerConnection"),
      }),
    });
  };

  const AUDIO_CONTEXT_VALUES = { sampleRate: 48000, baseLatency: 0.005, outputLatency: 0.01 };

  const patchAudioContextProperties = () => {
    for (const Ctor of [globalThis.AudioContext, globalThis.webkitAudioContext]) {
      if (!Ctor || !Ctor.prototype) continue;
      for (const [prop, value] of Object.entries(AUDIO_CONTEXT_VALUES)) {
        patchGetter(Ctor.prototype, prop, () => value);
      }
    }
  };

  const patchCanvasTextMetrics = () => {
    if (typeof CanvasRenderingContext2D === "undefined") return;
    U.wrapMethod(CanvasRenderingContext2D.prototype, "measureText", (orig) => ({
      measureText(_text) {
        const metrics = orig.apply(this, arguments);
        if (!isMasking()) return metrics;
        const seed = persona().canvasSeed;
        const perturb = (value, key) => {
          if (typeof value !== "number" || !Number.isFinite(value)) return value;
          const hash = (Math.imul(seed ^ (stringHash(String(key)) || 1), 0x01000193) >>> 0) % 5;
          if (hash === 0) return value;
          const delta = (hash - 2) * 0.03125;
          return value + delta;
        };
        for (const key of Object.getOwnPropertyNames(metrics)) {
          const val = metrics[key];
          if (typeof val === "number" && Number.isFinite(val)) metrics[key] = perturb(val, key);
        }
        return metrics;
      },
    }));
  };

  const PLAUSIBLE_CODECS = {
    "audio/mpeg": "probably",
    "audio/ogg": "probably",
    "audio/wav": "probably",
    "audio/webm": "probably",
    "audio/aac": "probably",
    "audio/flac": "probably",
    "video/mp4": "probably",
    "video/webm": "probably",
    "video/ogg": "probably",
  };

  const patchMediaCanPlayType = () => {
    U.wrapMethod(HTMLMediaElement.prototype, "canPlayType", (orig) => ({
      canPlayType(type) {
        if (!isMasking()) return orig.apply(this, arguments);
        const key = String(type || "")
          .toLowerCase()
          .replace(/\s+/g, "")
          .split(";")[0];
        return PLAUSIBLE_CODECS[key] || "";
      },
    }));
  };

  const PLAUSIBLE_SUPPORTS = new Set([
    "display:grid",
    "display:flex",
    "display:inline-grid",
    "display:inline-flex",
    "grid",
    "flex",
    "gap",
    "aspect-ratio",
  ]);

  const patchCssSupports = () => {
    if (typeof CSS === "undefined") return;
    U.wrapMethod(CSS, "supports", (orig) => ({
      supports() {
        if (!isMasking()) return orig.apply(this, arguments);
        const prop = String(arguments[0] || "")
          .trim()
          .toLowerCase();
        const value = String(arguments[1] || "")
          .trim()
          .toLowerCase();
        const key = arguments.length === 2 ? `${prop}:${value}` : prop;
        if (!key) return false;
        if (PLAUSIBLE_SUPPORTS.has(key) || PLAUSIBLE_SUPPORTS.has(prop)) return true;
        const hash = stringHash(key) >>> 0;
        return hash % 3 !== 0;
      },
    }));
  };

  const patchOuterWindow = () => {
    for (const [prop, value] of [
      ["outerWidth", 1920],
      ["outerHeight", 1080],
    ]) {
      patchGetter(window, prop, (original) => (typeof original === "number" ? value : original));
    }
  };

  const patchNavigatorConstants = () => {
    if (typeof Navigator === "undefined" || !Navigator.prototype) return;
    for (const [prop, value] of [
      ["productSub", "20030107"],
      ["oscpu", ""],
      ["buildID", ""],
      ["cookieEnabled", true],
      ["onLine", true],
    ]) {
      patchGetter(Navigator.prototype, prop, () => value);
    }
    patchMethodOf(Navigator.prototype, "javaEnabled", (orig) => ({
      javaEnabled() {
        if (isMasking()) return false;
        return orig.apply(this, arguments);
      },
    }));
  };

  const patchNotificationPermission = () => {
    if (typeof Notification === "undefined") return;
    patchGetter(Notification, "permission", () => "default");
  };

  const stringHash = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (Math.imul(hash, 31) + str.charCodeAt(i)) | 0;
    }
    return hash;
  };

  const PLAUSIBLE_COMMON_FONTS = new Set([
    "arial",
    "arial black",
    "arial narrow",
    "book antiqua",
    "calibri",
    "cambria",
    "candara",
    "century gothic",
    "comic sans ms",
    "consolas",
    "constantia",
    "corbel",
    "courier",
    "courier new",
    "dejavu sans",
    "dejavu serif",
    "eb garamond",
    "franklin gothic medium",
    "garamond",
    "georgia",
    "gill sans",
    "helvetica",
    "impact",
    "liberation sans",
    "liberation serif",
    "lucida console",
    "lucida sans unicode",
    "marlett",
    "microsoft sans serif",
    "modern",
    "monaco",
    "ms sans serif",
    "palatino linotype",
    "roman",
    "script",
    "segoe print",
    "segoe script",
    "segoe ui",
    "symbol",
    "system-ui",
    "tahoma",
    "times",
    "times new roman",
    "trebuchet ms",
    "verdana",
    "webdings",
    "wingdings",
  ]);

  const hashString = (str, seed) => {
    let hash = seed >>> 0;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
      hash = (Math.imul(hash ^ s.charCodeAt(i), 0x01000193) + i * 0x9e3779b9) >>> 0;
    }
    return hash >>> 0;
  };

  // Family list of a CSS font shorthand: whatever follows the font size
  // (and optional /line-height), e.g. `bold 12px/1.5 "Courier New", serif`.
  const FONT_SHORTHAND_FAMILIES_RE =
    /(?:^|\s)(?:[\d.]+(?:px|pt|pc|r?em|ex|ch|vw|vh|vmin|vmax|cm|mm|in|q|%)|(?:xx?x?-)?(?:small|large)|medium|larger|smaller)(?:\/\S+)?\s+(.+)$/i;

  // First family named by a font shorthand, lowercased and unquoted.
  const fontFamilyOf = (font) => {
    const text = String(font || "").trim();
    const match = text.match(FONT_SHORTHAND_FAMILIES_RE);
    const family = (match ? match[1] : text).split(",")[0].trim();
    return family.replace(/^["']|["']$/g, "").toLowerCase();
  };

  const isPlausibleFontFace = (face) =>
    PLAUSIBLE_COMMON_FONTS.has(face && face.family ? String(face.family).toLowerCase() : "");

  const wrapFontIterator = (all, extractFont) => {
    const filtered = all.filter((entry) => isPlausibleFontFace(extractFont(entry)));
    const iterator = filtered[Symbol.iterator]();
    const result = {};
    for (const builtin of ["next", "return", "throw"]) {
      const fn = iterator[builtin];
      if (typeof fn === "function") {
        result[builtin] = U.stealth(fn.bind(iterator), builtin, {
          length: fn.length,
          source: U.nativeSourceFor(fn, builtin),
        });
      }
    }
    Object.defineProperty(result, Symbol.iterator, {
      value: U.stealth(
        function iteratorFn() {
          return result;
        },
        "iterator",
        { length: 0 }
      ),
      configurable: true,
      enumerable: false,
      writable: true,
    });
    return result;
  };

  const patchFontFaceSet = () => {
    if (typeof FontFaceSet === "undefined" || !FontFaceSet.prototype) return;
    const proto = FontFaceSet.prototype;

    U.wrapMethod(proto, "check", (origCheck) => ({
      check(font, _text) {
        if (!isMasking()) return origCheck.apply(this, arguments);
        const family = fontFamilyOf(font);
        if (!family) return origCheck.apply(this, arguments);
        if (PLAUSIBLE_COMMON_FONTS.has(family)) return true;
        const full = String(font || "").trim();
        const hash = (Math.imul(hashString(full, persona().canvasSeed), 0x01000193) >>> 0) % 100;
        return hash < 55;
      },
    }));

    U.wrapMethod(proto, "load", (origLoad) => ({
      load(font, _text) {
        if (!isMasking() || PLAUSIBLE_COMMON_FONTS.has(fontFamilyOf(font))) {
          return origLoad.apply(this, arguments);
        }
        return Promise.resolve([]);
      },
    }));

    U.wrapGetter(proto, "ready", (nativeGet) => ({
      get() {
        const original = nativeGet.call(this);
        return isMasking() ? Promise.resolve(original) : original;
      },
    }));

    for (const method of [
      "forEach",
      "has",
      "add",
      "delete",
      "clear",
      "entries",
      "keys",
      "values",
    ]) {
      U.wrapMethod(proto, method, (orig) => ({
        [method](...args) {
          if (!isMasking()) return orig.apply(this, args);
          if (method === "forEach") {
            const callback = args[0];
            if (typeof callback !== "function") return orig.apply(this, args);
            return orig.call(
              this,
              (value, key, set) => {
                if (isPlausibleFontFace(value)) callback(value, key, set);
              },
              args[1]
            );
          }
          if (method === "entries" || method === "keys" || method === "values") {
            const all = Array.from(orig.call(this));
            const extract = method === "entries" ? (entry) => entry[1] : (entry) => entry;
            return wrapFontIterator(all, extract);
          }
          if (method === "has" && !isPlausibleFontFace(args[0])) return false;
          if (method === "add" && !isPlausibleFontFace(args[0])) return this;
          if (method === "delete" || method === "clear") return this;
          return orig.apply(this, args);
        },
      }));
    }

    U.wrapGetter(proto, "size", (nativeGet) => ({
      get() {
        if (!isMasking()) return nativeGet.call(this);
        let count = 0;
        try {
          this.forEach((face) => {
            if (isPlausibleFontFace(face)) count++;
          });
        } catch {}
        return count;
      },
    }));
  };

  const patchGamepads = () => {
    if (typeof Navigator === "undefined") return;
    patchMethodOf(Navigator.prototype, "getGamepads", (orig) => ({
      getGamepads() {
        const result = orig.apply(this, arguments);
        if (!isMasking() || !Array.isArray(result)) return result;
        return result.map(() => null);
      },
    }));
  };

  const patchScreenPosition = () => {
    for (const prop of ["screenLeft", "screenTop", "availLeft", "availTop"]) {
      patchGetter(window, prop, () => 0);
    }
    if (typeof Screen === "undefined" || !Screen.prototype) return;
    for (const prop of ["left", "top", "availLeft", "availTop"]) {
      patchGetter(Screen.prototype, prop, () => 0);
    }
    patchGetter(Screen.prototype, "isExtended", () => false);
  };

  const patchQueryLocalFonts = () => {
    U.wrapMethod(window, "queryLocalFonts", (orig) => ({
      queryLocalFonts() {
        if (isMasking()) return Promise.resolve([]);
        return orig.apply(this, arguments);
      },
    }));
  };

  const patchSpeechSynthesis = () => {
    if (!window.speechSynthesis) return;
    U.wrapMethod(Object.getPrototypeOf(window.speechSynthesis), "getVoices", (orig) => ({
      getVoices() {
        if (!isMasking()) return orig.apply(this, arguments);
        return [];
      },
    }));
  };

  try {
    patchNavigatorGetters();
    patchNavigatorConstants();
    patchScreenGetters();
    patchScreenPosition();
    patchUserAgentData();
    patchDateTimeFormatConstructor();
    patchTimezone();
    patchNetworkInformation();
    patchBattery();
    patchStorageEstimate();
    patchPerformanceMemory();
    patchWebgl();
    patchCanvas();
    patchOffscreenCanvas();
    patchAudioRendering();
    patchNavigatorObjects();
    patchMatchMedia();
    patchHardwareAvailability();
    patchRtcPeerConnection();
    patchAudioContextProperties();
    patchCanvasTextMetrics();
    patchMediaCanPlayType();
    patchCssSupports();
    patchOuterWindow();
    patchNotificationPermission();
    patchFontFaceSet();
    patchGamepads();
    patchQueryLocalFonts();
    patchSpeechSynthesis();
  } catch {}
})();
