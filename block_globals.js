// Static - MAIN-world lockout for extension bridge globals.
(() => {
  const U = globalThis.__static_block_utils__;
  const STRIP_GLOBALS = [
    "__REACT_DEVTOOLS_GLOBAL_HOOK__",
    "__REDUX_DEVTOOLS_EXTENSION__",
    "__REDUX_DEVTOOLS_EXTENSION_COMPOSE__",
    "__VUE_DEVTOOLS_GLOBAL_HOOK__",
    "__MOBX_DEVTOOLS_GLOBAL_HOOK__",
    "__APOLLO_DEVTOOLS_GLOBAL_HOOK__",
    "__GRAMMARLY_DESKTOP_INTEGRATION__",
    "__grammarlyGlobalSessionId",
    "__onePasswordExtension",
    "__1passwordExtension",
    "__dashlaneExtensionInstalled",
    "__isDashlaneExtensionInstalled",
    "__honeyExtensionInstalled",
    "__keeper_extension_installed",
    "__nordpassExtensionInstalled",
    "__roboformExtensionInstalled",
  ];
  const STRIP_SET = new Set(STRIP_GLOBALS);
  const WINDOW_PROTO = Object.getPrototypeOf(window);
  const SCRUB_TARGETS = [window, WINDOW_PROTO].filter(Boolean);
  const FAST_SCRUB_MS = 25;
  const FAST_SCRUB_TICKS = 200;
  const BRIDGE_EVENT = "__perf_probe_bi__";
  let disabled = false;

  const applyConfigUpdate = (data) => {
    if (data && data.type === "config_update" && typeof data.disabled === "boolean") {
      disabled = data.disabled;
    }
  };

  U.setupBridge(BRIDGE_EVENT, 1000, applyConfigUpdate);

  const isProtectedKey = (prop) => typeof prop === "string" && STRIP_SET.has(prop);

  const isProtectedTarget = (target) => SCRUB_TARGETS.includes(target);

  const scrubOwnProp = (target, key) => {
    if (!target || !isProtectedKey(key)) return;
    try {
      const desc = Object.getOwnPropertyDescriptor(target, key);
      if (!desc) return;
      if (desc.configurable) {
        delete target[key];
        return;
      }
      if ("value" in desc && desc.writable) {
        target[key] = undefined;
      }
    } catch {}
  };

  const scrubGlobals = () => {
    if (disabled) return;
    for (const target of SCRUB_TARGETS) {
      for (const key of STRIP_GLOBALS) scrubOwnProp(target, key);
    }
  };

  const filterDescriptors = (target, descriptors) => {
    if (disabled) return descriptors;
    if (!isProtectedTarget(target) || !descriptors || typeof descriptors !== "object") {
      return descriptors;
    }
    const allowed = {};
    let blocked = false;
    for (const [key, value] of Object.entries(descriptors)) {
      if (isProtectedKey(key)) {
        scrubOwnProp(target, key);
        blocked = true;
        continue;
      }
      allowed[key] = value;
    }
    if (!blocked) return descriptors;
    return allowed;
  };

  const patchObjectDefineProperty = () => {
    const desc = Object.getOwnPropertyDescriptor(Object, "defineProperty");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      defineProperty(target, key) {
        if (disabled) return orig.apply(this, arguments);
        if (isProtectedTarget(target) && isProtectedKey(key)) {
          scrubOwnProp(target, key);
          return target;
        }
        return orig.apply(this, arguments);
      },
    }.defineProperty;
    Object.defineProperty(Object, "defineProperty", {
      ...desc,
      value: U.stealth(wrapped, "defineProperty", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "defineProperty"),
      }),
    });
  };

  const patchObjectDefineProperties = () => {
    const desc = Object.getOwnPropertyDescriptor(Object, "defineProperties");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      defineProperties(target, descriptors) {
        if (disabled) return orig.call(this, target, descriptors);
        const filtered = filterDescriptors(target, descriptors);
        return orig.call(this, target, filtered);
      },
    }.defineProperties;
    Object.defineProperty(Object, "defineProperties", {
      ...desc,
      value: U.stealth(wrapped, "defineProperties", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "defineProperties"),
      }),
    });
  };

  const patchObjectAssign = () => {
    const desc = Object.getOwnPropertyDescriptor(Object, "assign");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      assign(target) {
        if (disabled) return orig.apply(this, arguments);
        if (!isProtectedTarget(target)) return orig.apply(this, arguments);
        const sources = [];
        for (let i = 1; i < arguments.length; i++) {
          const source = arguments[i];
          if (!source || typeof source !== "object") {
            sources.push(source);
            continue;
          }
          const filtered = {};
          for (const [key, value] of Object.entries(source)) {
            if (isProtectedKey(key)) {
              scrubOwnProp(target, key);
              continue;
            }
            filtered[key] = value;
          }
          sources.push(filtered);
        }
        return orig.call(this, target, ...sources);
      },
    }.assign;
    Object.defineProperty(Object, "assign", {
      ...desc,
      value: U.stealth(wrapped, "assign", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "assign"),
      }),
    });
  };

  const patchReflectDefineProperty = () => {
    if (typeof Reflect === "undefined") return;
    const desc = Object.getOwnPropertyDescriptor(Reflect, "defineProperty");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      defineProperty(target, key, attributes) {
        if (disabled) return orig.call(this, target, key, attributes);
        if (isProtectedTarget(target) && isProtectedKey(key)) {
          scrubOwnProp(target, key);
          return true;
        }
        return orig.call(this, target, key, attributes);
      },
    }.defineProperty;
    Object.defineProperty(Reflect, "defineProperty", {
      ...desc,
      value: U.stealth(wrapped, "defineProperty", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "defineProperty"),
      }),
    });
  };

  const patchReflectSet = () => {
    if (typeof Reflect === "undefined") return;
    const desc = Object.getOwnPropertyDescriptor(Reflect, "set");
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      set(target, key) {
        if (disabled) return orig.apply(this, arguments);
        if (isProtectedTarget(target) && isProtectedKey(key)) {
          scrubOwnProp(target, key);
          return true;
        }
        return orig.apply(this, arguments);
      },
    }.set;
    Object.defineProperty(Reflect, "set", {
      ...desc,
      value: U.stealth(wrapped, "set", {
        length: orig.length,
        source: U.nativeSourceFor(orig, "set"),
      }),
    });
  };

  const patchLegacyDefineAccessor = (name) => {
    const proto = Object.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, name);
    const orig = desc && desc.value;
    if (typeof orig !== "function") return;
    const wrapped = {
      [name](key) {
        if (disabled) return orig.apply(this, arguments);
        if (isProtectedTarget(this) && isProtectedKey(key)) {
          scrubOwnProp(this, key);
          return undefined;
        }
        return orig.apply(this, arguments);
      },
    }[name];
    Object.defineProperty(proto, name, {
      ...desc,
      value: U.stealth(wrapped, name, {
        length: orig.length,
        source: U.nativeSourceFor(orig, name),
      }),
    });
  };

  scrubGlobals();
  patchObjectDefineProperty();
  patchObjectDefineProperties();
  patchObjectAssign();
  patchReflectDefineProperty();
  patchReflectSet();
  patchLegacyDefineAccessor("__defineGetter__");
  patchLegacyDefineAccessor("__defineSetter__");

  let scrubTimer = null;
  let scrubTicks = 0;

  const maybeStopScrubTimer = () => {
    if (scrubTimer) {
      clearInterval(scrubTimer);
      scrubTimer = null;
    }
  };

  const startScrubTimer = () => {
    if (disabled) return;
    scrubTimer = setInterval(() => {
      if (disabled) {
        maybeStopScrubTimer();
        return;
      }
      scrubGlobals();
      scrubTicks++;
      if (scrubTicks >= FAST_SCRUB_TICKS) maybeStopScrubTimer();
    }, FAST_SCRUB_MS);
  };

  scrubGlobals();
  startScrubTimer();

  addEventListener(
    "DOMContentLoaded",
    () => {
      scrubGlobals();
      // After DOMContentLoaded, slow the scrub to every 50ms for half the remaining ticks
      const remaining = FAST_SCRUB_TICKS - scrubTicks;
      if (remaining > 0) {
        scrubTicks = Math.max(scrubTicks, FAST_SCRUB_TICKS - Math.ceil(remaining / 2));
      }
    },
    { once: true }
  );
  addEventListener("load", scrubGlobals, { once: true });
})();
