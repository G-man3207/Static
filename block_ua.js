// Static - MAIN-world user-agent scrubbing. Always loaded on protected sites.
// Owns navigator user-agent identity. Device signal poisoning must not wrap
// these same getters.
(() => {
  const U = globalThis.__static_block_utils__;
  const BRIDGE_EVENT = "__perf_ua_bi__";
  const DEFAULT_PERSONA = {
    architecture: "x86",
    bitness: "64",
    os: "windows",
    platform: "Win32",
    uaDataPlatform: "Windows",
    uaOs: "Windows NT 10.0; Win64; x64",
  };
  const BRANDS = [
    { brand: "Chromium", version: "152" },
    { brand: "Google Chrome", version: "152" },
    { brand: "Not.A/Brand", version: "24" },
  ];
  const FULL_VERSION_LIST = [
    { brand: "Chromium", version: "152.0.0.0" },
    { brand: "Google Chrome", version: "152.0.0.0" },
    { brand: "Not.A/Brand", version: "24.0.0.0" },
  ];
  let disabled = false;
  let fingerprintPersona = null;

  const safeObject = (value) => (value && typeof value === "object" ? value : {});

  const sanitizePersona = (persona) => {
    const source = safeObject(persona);
    return {
      architecture: String(source.architecture || DEFAULT_PERSONA.architecture),
      bitness: String(source.bitness || DEFAULT_PERSONA.bitness),
      os: String(source.os || DEFAULT_PERSONA.os),
      platform: String(source.platform || DEFAULT_PERSONA.platform),
      uaDataPlatform: String(source.uaDataPlatform || DEFAULT_PERSONA.uaDataPlatform),
      uaOs: String(source.uaOs || DEFAULT_PERSONA.uaOs),
    };
  };

  const persona = () => fingerprintPersona || DEFAULT_PERSONA;
  const isActive = () => !disabled;

  const applyConfigUpdate = (data) => {
    if (!data || data.type !== "config_update") return;
    if (data.fingerprintPersona && typeof data.fingerprintPersona === "object") {
      fingerprintPersona = sanitizePersona(data.fingerprintPersona);
    }
    if (typeof data.disabled === "boolean") disabled = data.disabled;
  };

  U.setupBridge(BRIDGE_EVENT, 1000, applyConfigUpdate);

  const userAgentFor = (p) =>
    `Mozilla/5.0 (${p.uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`;

  const appVersionFor = (p) =>
    `5.0 (${p.uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`;

  const platformVersionFor = (p) => (p.os === "windows" ? "10.0.0" : "15.0.0");

  const copyBrands = (list) =>
    list.map((brand) => ({ brand: brand.brand, version: brand.version }));

  const highEntropyFor = (hint, p) => {
    const values = {
      architecture: p.architecture,
      bitness: p.bitness,
      brands: copyBrands(BRANDS),
      formFactors: ["Desktop"],
      fullVersionList: copyBrands(FULL_VERSION_LIST),
      mobile: false,
      model: "",
      platform: p.uaDataPlatform,
      platformVersion: platformVersionFor(p),
      uaFullVersion: "152.0.0.0",
      wow64: false,
    };
    return Object.prototype.hasOwnProperty.call(values, hint) ? values[hint] : undefined;
  };

  const patchGetter = (target, prop, maskedValue) => {
    const found = target && U.descriptorOwnerFor(target, prop);
    if (!found) return;
    try {
      U.wrapGetter(found.owner, prop, (nativeGet) => ({
        get() {
          const original = nativeGet.call(this);
          return isActive() ? maskedValue(original, this) : original;
        },
      }));
    } catch {
      // A non-configurable getter stays native. Nothing else on this surface
      // can be patched if defineProperty throws.
    }
  };

  const patchNavigator = (prop, maskedValue) => {
    if (typeof Navigator === "undefined" || !Navigator.prototype) return;
    patchGetter(Navigator.prototype, prop, maskedValue);
  };

  let uaDataObject = null;
  let highEntropyMethod = null;
  let toJsonMethod = null;

  const highEntropyValues = (hints) => {
    const wanted = typeof hints === "string" ? [hints] : Array.from(hints || []);
    const p = persona();
    const out = {
      brands: copyBrands(BRANDS),
      mobile: false,
      platform: p.uaDataPlatform,
    };
    for (const hint of wanted) {
      if (!Object.prototype.hasOwnProperty.call(out, hint)) {
        const value = highEntropyFor(hint, p);
        if (value !== undefined) out[hint] = value;
      }
    }
    return Promise.resolve(out);
  };

  const syntheticUaData = (native) => {
    if (!highEntropyMethod) {
      const nativeHigh =
        native && typeof native.getHighEntropyValues === "function"
          ? native.getHighEntropyValues
          : function getHighEntropyValues() {};
      highEntropyMethod = U.stealth(
        function getHighEntropyValues(hints) {
          return highEntropyValues(hints);
        },
        "getHighEntropyValues",
        { length: 1, source: U.nativeSourceFor(nativeHigh, "getHighEntropyValues") }
      );
    }
    if (!toJsonMethod) {
      const nativeJson =
        native && typeof native.toJSON === "function" ? native.toJSON : function toJSON() {};
      toJsonMethod = U.stealth(
        function toJSON() {
          const p = persona();
          return {
            brands: copyBrands(BRANDS),
            mobile: false,
            platform: p.uaDataPlatform,
          };
        },
        "toJSON",
        { length: 0, source: U.nativeSourceFor(nativeJson, "toJSON") }
      );
    }
    if (uaDataObject) return uaDataObject;
    const target = native && typeof native === "object" ? native : {};
    uaDataObject = new Proxy(target, {
      get(_t, prop) {
        if (!isActive()) {
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        if (prop === "brands") return copyBrands(BRANDS);
        if (prop === "mobile") return false;
        if (prop === "platform") return persona().uaDataPlatform;
        if (prop === "toJSON") return toJsonMethod;
        if (prop === "getHighEntropyValues") return highEntropyMethod;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return uaDataObject;
  };

  patchNavigator("userAgent", () => userAgentFor(persona()));
  patchNavigator("appVersion", () => appVersionFor(persona()));
  patchNavigator("platform", () => persona().platform);
  patchNavigator("oscpu", () => persona().uaOs);
  patchNavigator("buildID", () => "");
  patchNavigator("userAgentData", (original) => syntheticUaData(original));
})();
