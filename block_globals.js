// Static - MAIN-world lockout for extension bridge globals.
(() => {
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

  for (const key of STRIP_GLOBALS) {
    try {
      const existing = Object.getOwnPropertyDescriptor(window, key);
      if (existing && !existing.configurable) continue;
      Object.defineProperty(window, key, {
        configurable: false,
        enumerable: false,
        get: () => undefined,
        set: () => {},
      });
    } catch {}
  }
})();
