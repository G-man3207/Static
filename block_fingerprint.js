/* eslint-disable max-lines, max-statements -- MAIN-world fingerprint shims are safer kept contiguous */
// Static - MAIN-world opt-in device and browser signal poisoning.
(() => {
  const BRIDGE_EVENT = "__static_fingerprint_bridge_init__";
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
  const uaDataProxies = new WeakMap();
  const explicitTimeZoneDateTimeFormats = new WeakSet();
  const poisonedAudioBuffers = new WeakSet();
  const nativeDateGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  let bridgePort = null;
  let fingerprintMode = "off";
  let fingerprintPersona = null;

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
        writable: true,
        configurable: true,
        enumerable: false,
      };
      Object.defineProperty(proto, "constructor", {
        ...desc,
        value: wrapped,
      });
    } catch {}
  };

  const copyConstructorStatics = (wrapped, original) => {
    for (const key of Reflect.ownKeys(original)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      try {
        const desc = Object.getOwnPropertyDescriptor(original, key);
        if (desc) Object.defineProperty(wrapped, key, desc);
      } catch {}
    }
  };

  const descriptorOwnerFor = (target, prop) => {
    let cursor = target;
    while (cursor) {
      const desc = Object.getOwnPropertyDescriptor(cursor, prop);
      if (desc) return { desc, owner: cursor };
      cursor = Object.getPrototypeOf(cursor);
    }
    return null;
  };

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

  const isMasking = () => fingerprintMode === MODE_MASK;

  const applyConfigUpdate = (data) => {
    if (!data || data.type !== "config_update") return;
    if (typeof data.fingerprintMode === "string") {
      fingerprintMode = allowedModes.has(data.fingerprintMode) ? data.fingerprintMode : "off";
    }
    if (data.fingerprintPersona && typeof data.fingerprintPersona === "object") {
      fingerprintPersona = sanitizePersona(data.fingerprintPersona);
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
    document.removeEventListener(BRIDGE_EVENT, onBridgeInit);
  };
  document.addEventListener(BRIDGE_EVENT, onBridgeInit);

  const maskedUa = (ua) => {
    const p = persona();
    const source = String(ua || "");
    if (source.includes("(") && source.includes(")")) {
      return source.replace(/\([^)]*\)/, `(${p.uaOs})`);
    }
    return `Mozilla/5.0 (${p.uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`;
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

  const patchGetter = (target, prop, nativeName, maskedValue) => {
    if (!target) return;
    const found = descriptorOwnerFor(target, prop);
    if (!found || !found.desc || typeof found.desc.get !== "function") return;
    const { desc, owner } = found;
    try {
      Object.defineProperty(owner, prop, {
        ...desc,
        get: stealth(
          function get() {
            const original = desc.get.call(this);
            return isMasking() ? maskedValue(original, this) : original;
          },
          nativeName,
          { length: 0, source: nativeSourceFor(desc.get, nativeName) }
        ),
      });
    } catch {}
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
      patchGetter(Navigator.prototype, prop, `get ${prop}`, (original) =>
        navigatorValueFor(prop, original)
      );
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
        patchGetter(Screen.prototype, prop, `get ${prop}`, (original) =>
          screenValueFor(prop, original)
        );
      }
    }
    patchGetter(window, "devicePixelRatio", "get devicePixelRatio", (original) =>
      screenValueFor("devicePixelRatio", original)
    );
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
    const wanted = Array.from(hints || []);
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

  const maskedUaData = (target) => {
    if (!target || typeof target !== "object") return target;
    const cached = uaDataProxies.get(target);
    if (cached) return cached;
    const nativeValue = (prop) => Reflect.get(target, prop, target);
    const proxy = new Proxy(target, {
      get(t, prop) {
        if (!isMasking()) return nativeValue(prop);
        if (prop === "brands") return maskedBrands(nativeValue(prop));
        if (prop === "mobile") return false;
        if (prop === "platform") return persona().uaDataPlatform;
        if (prop === "toJSON") {
          const orig = nativeValue(prop);
          return stealth(
            function toJSON() {
              return maskedUaDataJson(t);
            },
            "toJSON",
            { length: 0, source: nativeSourceFor(orig, "toJSON") }
          );
        }
        if (prop === "getHighEntropyValues") {
          const orig = nativeValue(prop);
          return stealth(
            function getHighEntropyValues(hints) {
              return maskedHighEntropyValues(t, hints);
            },
            "getHighEntropyValues",
            { length: 1, source: nativeSourceFor(orig, "getHighEntropyValues") }
          );
        }
        const value = nativeValue(prop);
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
    uaDataProxies.set(target, proxy);
    return proxy;
  };

  const patchUserAgentData = () => {
    if (typeof Navigator === "undefined" || !Navigator.prototype) return;
    patchGetter(Navigator.prototype, "userAgentData", "get userAgentData", (original) =>
      maskedUaData(original)
    );
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
    copyConstructorStatics(wrappedDateTimeFormat, OriginalDateTimeFormat);
    alignPrototypeConstructor(wrappedDateTimeFormat, OriginalDateTimeFormat);
    Object.defineProperty(Intl, "DateTimeFormat", {
      ...(desc || { configurable: true, writable: true }),
      value: stealth(wrappedDateTimeFormat, "DateTimeFormat", {
        length: OriginalDateTimeFormat.length,
        source: nativeSourceFor(OriginalDateTimeFormat, "DateTimeFormat"),
      }),
    });
  };

  const patchTimezone = () => {
    const dateDesc = Object.getOwnPropertyDescriptor(Date.prototype, "getTimezoneOffset");
    const origOffset = dateDesc && dateDesc.value;
    if (typeof origOffset === "function") {
      const wrappedOffset = {
        getTimezoneOffset() {
          if (!isMasking()) return origOffset.apply(this, arguments);
          return timeZoneOffsetFor(this, persona().timeZone);
        },
      }.getTimezoneOffset;
      Object.defineProperty(Date.prototype, "getTimezoneOffset", {
        ...dateDesc,
        value: stealth(wrappedOffset, "getTimezoneOffset", {
          length: origOffset.length,
          source: nativeSourceFor(origOffset, "getTimezoneOffset"),
        }),
      });
    }

    const intlProto = Intl && Intl.DateTimeFormat && Intl.DateTimeFormat.prototype;
    const resolvedDesc = intlProto && Object.getOwnPropertyDescriptor(intlProto, "resolvedOptions");
    const origResolved = resolvedDesc && resolvedDesc.value;
    if (typeof origResolved !== "function") return;
    const wrappedResolved = {
      resolvedOptions() {
        const options = origResolved.apply(this, arguments);
        if (!isMasking() || explicitTimeZoneDateTimeFormats.has(this)) return options;
        return { ...options, timeZone: persona().timeZone };
      },
    }.resolvedOptions;
    Object.defineProperty(intlProto, "resolvedOptions", {
      ...resolvedDesc,
      value: stealth(wrappedResolved, "resolvedOptions", {
        length: origResolved.length,
        source: nativeSourceFor(origResolved, "resolvedOptions"),
      }),
    });
  };

  const patchNetworkInformation = () => {
    let proto = null;
    try {
      proto = navigator.connection && Object.getPrototypeOf(navigator.connection);
    } catch {}
    if (!proto) return;
    for (const prop of ["downlink", "effectiveType", "rtt", "saveData", "type"]) {
      patchGetter(proto, prop, `get ${prop}`, (original) => {
        const connection = persona().connection;
        return Object.prototype.hasOwnProperty.call(connection, prop) ? connection[prop] : original;
      });
    }
  };

  const fakeBattery = () => ({
    charging: true,
    chargingTime: 0,
    dischargingTime: Infinity,
    dispatchEvent: () => false,
    level: 1,
    onchargingchange: null,
    onchargingtimechange: null,
    ondischargingtimechange: null,
    onlevelchange: null,
    removeEventListener: () => {},
    addEventListener: () => {},
  });

  const patchBattery = () => {
    if (typeof Navigator === "undefined" || !Navigator.prototype) return;
    const found = descriptorOwnerFor(Navigator.prototype, "getBattery");
    const desc = found && found.desc;
    const orig = desc && desc.value;
    if (!found || typeof orig !== "function") return;
    const wrapped = {
      getBattery() {
        if (isMasking()) return Promise.resolve(fakeBattery());
        return orig.apply(this, arguments);
      },
    }.getBattery;
    Object.defineProperty(found.owner, "getBattery", {
      ...desc,
      value: stealth(wrapped, "getBattery", {
        length: orig.length,
        source: nativeSourceFor(orig, "getBattery"),
      }),
    });
  };

  const patchStorageEstimate = () => {
    let proto = null;
    try {
      proto = navigator.storage && Object.getPrototypeOf(navigator.storage);
    } catch {}
    const found = proto && descriptorOwnerFor(proto, "estimate");
    const desc = found && found.desc;
    const orig = desc && desc.value;
    if (!found || typeof orig !== "function") return;
    const wrapped = {
      estimate() {
        if (!isMasking()) return orig.apply(this, arguments);
        return Promise.resolve({
          quota: persona().storageQuota,
          usage: 0,
          usageDetails: {},
        });
      },
    }.estimate;
    Object.defineProperty(found.owner, "estimate", {
      ...desc,
      value: stealth(wrapped, "estimate", {
        length: orig.length,
        source: nativeSourceFor(orig, "estimate"),
      }),
    });
  };

  const patchWebglCtor = (Ctor) => {
    if (typeof Ctor === "undefined" || !Ctor.prototype) return;
    const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, "getParameter");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      getParameter(parameter) {
        if (isMasking()) {
          const numeric = Number(parameter);
          if (numeric === WEBGL_VENDOR || numeric === UNMASKED_VENDOR_WEBGL) {
            return persona().webglVendor;
          }
          if (numeric === WEBGL_RENDERER || numeric === UNMASKED_RENDERER_WEBGL) {
            return persona().webglRenderer;
          }
        }
        return orig.apply(this, arguments);
      },
    }.getParameter;
    Object.defineProperty(Ctor.prototype, "getParameter", {
      ...desc,
      value: stealth(wrapped, "getParameter", {
        length: orig.length,
        source: nativeSourceFor(orig, "getParameter"),
      }),
    });
  };

  const patchWebgl = () => {
    patchWebglCtor(globalThis.WebGLRenderingContext);
    patchWebglCtor(globalThis.WebGL2RenderingContext);
  };

  const tweakPixel = (data, seed) => {
    if (!data || data.length < 4) return;
    const pixelCount = Math.max(1, Math.floor(data.length / 4));
    const pixel = seed % pixelCount;
    const base = pixel * 4;
    const delta = seed % 2 === 0 ? 1 : -1;
    for (let i = 0; i < 3; i++) {
      const value = data[base + i];
      data[base + i] = Math.max(0, Math.min(255, value + delta));
    }
    if (data[base + 3] === 0) data[base + 3] = 1;
  };

  const cloneCanvasWithNoise = (canvas) => {
    const width = Math.max(1, Math.min(canvas.width || 1, 8192));
    const height = Math.max(1, Math.min(canvas.height || 1, 8192));
    const clone = document.createElement("canvas");
    clone.width = width;
    clone.height = height;
    const ctx = clone.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, width, height);
    const x = persona().canvasSeed % width;
    const y = Math.floor(persona().canvasSeed / Math.max(1, width)) % height;
    const imageData = ctx.getImageData(x, y, 1, 1);
    tweakPixel(imageData.data, persona().canvasSeed);
    ctx.putImageData(imageData, x, y);
    return clone;
  };

  const patchCanvas = () => {
    if (typeof HTMLCanvasElement === "undefined") return;
    const toDataUrlDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "toDataURL");
    const origToDataUrl = toDataUrlDesc && toDataUrlDesc.value;
    if (typeof origToDataUrl === "function") {
      const wrappedToDataUrl = {
        toDataURL() {
          if (!isMasking()) return origToDataUrl.apply(this, arguments);
          try {
            const clone = cloneCanvasWithNoise(this);
            if (clone) return origToDataUrl.apply(clone, arguments);
          } catch {}
          return origToDataUrl.apply(this, arguments);
        },
      }.toDataURL;
      Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
        ...toDataUrlDesc,
        value: stealth(wrappedToDataUrl, "toDataURL", {
          length: origToDataUrl.length,
          source: nativeSourceFor(origToDataUrl, "toDataURL"),
        }),
      });
    }

    const toBlobDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "toBlob");
    const origToBlob = toBlobDesc && toBlobDesc.value;
    if (typeof origToBlob === "function") {
      const wrappedToBlob = {
        toBlob() {
          if (!isMasking()) return origToBlob.apply(this, arguments);
          try {
            const clone = cloneCanvasWithNoise(this);
            if (clone) return origToBlob.apply(clone, arguments);
          } catch {}
          return origToBlob.apply(this, arguments);
        },
      }.toBlob;
      Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
        ...toBlobDesc,
        value: stealth(wrappedToBlob, "toBlob", {
          length: origToBlob.length,
          source: nativeSourceFor(origToBlob, "toBlob"),
        }),
      });
    }

    if (typeof CanvasRenderingContext2D === "undefined") return;
    const imageDesc = Object.getOwnPropertyDescriptor(
      CanvasRenderingContext2D.prototype,
      "getImageData"
    );
    const origGetImageData = imageDesc && imageDesc.value;
    if (typeof origGetImageData !== "function") return;
    const wrappedGetImageData = {
      getImageData() {
        const imageData = origGetImageData.apply(this, arguments);
        if (isMasking()) tweakPixel(imageData.data, persona().canvasSeed);
        return imageData;
      },
    }.getImageData;
    Object.defineProperty(CanvasRenderingContext2D.prototype, "getImageData", {
      ...imageDesc,
      value: stealth(wrappedGetImageData, "getImageData", {
        length: origGetImageData.length,
        source: nativeSourceFor(origGetImageData, "getImageData"),
      }),
    });
  };

  const clampAudioSample = (value) => Math.max(-1, Math.min(1, value));

  const poisonAudioChannel = (buffer, channel, seed) => {
    const length = Math.max(0, Math.floor(buffer.length || 0));
    if (!length) return;
    const sample = seed % length;
    const delta = (seed & 1 ? 1 : -1) * (0.00005 + ((seed >>> 8) % 50) / 1000000);
    if (
      typeof buffer.copyFromChannel === "function" &&
      typeof buffer.copyToChannel === "function"
    ) {
      const data = new Float32Array(length);
      buffer.copyFromChannel(data, channel);
      data[sample] = clampAudioSample((Number(data[sample]) || 0) + delta);
      buffer.copyToChannel(data, channel);
      return;
    }
    const data = buffer.getChannelData(channel);
    data[sample] = clampAudioSample((Number(data[sample]) || 0) + delta);
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
    if (typeof OfflineAudioContext === "undefined" || !OfflineAudioContext.prototype) return;
    const desc = Object.getOwnPropertyDescriptor(OfflineAudioContext.prototype, "startRendering");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      startRendering() {
        const result = orig.apply(this, arguments);
        if (!isMasking()) return result;
        if (result && typeof result.then === "function") {
          return result.then((buffer) => poisonAudioBuffer(buffer));
        }
        return poisonAudioBuffer(result);
      },
    }.startRendering;
    Object.defineProperty(OfflineAudioContext.prototype, "startRendering", {
      ...desc,
      value: stealth(wrapped, "startRendering", {
        length: orig.length,
        source: nativeSourceFor(orig, "startRendering"),
      }),
    });
  };

  try {
    patchNavigatorGetters();
    patchScreenGetters();
    patchUserAgentData();
    patchDateTimeFormatConstructor();
    patchTimezone();
    patchNetworkInformation();
    patchBattery();
    patchStorageEstimate();
    patchWebgl();
    patchCanvas();
    patchAudioRendering();
  } catch {}
})();
