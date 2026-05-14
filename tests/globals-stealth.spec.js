const { expect, test } = require("./helpers/extension-fixture");

test("runs at document_start without exposing Static config or protected globals", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(() => {
    const windowProto = Object.getPrototypeOf(window);
    const before = {
      reactDescriptor: !!Object.getOwnPropertyDescriptor(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__"),
      reactInWindow: "__REACT_DEVTOOLS_GLOBAL_HOOK__" in window,
      reactOwn: Object.prototype.hasOwnProperty.call(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__"),
      reduxDescriptor: !!Object.getOwnPropertyDescriptor(window, "__REDUX_DEVTOOLS_EXTENSION__"),
      reduxInWindow: "__REDUX_DEVTOOLS_EXTENSION__" in window,
      reduxOwn: Object.prototype.hasOwnProperty.call(window, "__REDUX_DEVTOOLS_EXTENSION__"),
    };
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      value: { marker: true },
      configurable: true,
    });
    Reflect.defineProperty(window, "__REDUX_DEVTOOLS_EXTENSION__", {
      value: () => "present",
      configurable: true,
    });
    window.__defineGetter__("__GRAMMARLY_DESKTOP_INTEGRATION__", () => ({ marker: true }));
    windowProto.__defineSetter__("__onePasswordExtension", () => "present");

    return {
      before,
      reactHook: window.__REACT_DEVTOOLS_GLOBAL_HOOK__,
      reduxHook: window.__REDUX_DEVTOOLS_EXTENSION__,
      legacy: {
        grammarlyDescriptor: !!Object.getOwnPropertyDescriptor(
          window,
          "__GRAMMARLY_DESKTOP_INTEGRATION__"
        ),
        grammarlyInWindow: "__GRAMMARLY_DESKTOP_INTEGRATION__" in window,
        grammarlyOwn: Object.prototype.hasOwnProperty.call(
          window,
          "__GRAMMARLY_DESKTOP_INTEGRATION__"
        ),
        grammarlyValue: window.__GRAMMARLY_DESKTOP_INTEGRATION__,
        onePasswordDescriptor: !!Object.getOwnPropertyDescriptor(window, "__onePasswordExtension"),
        onePasswordInWindow: "__onePasswordExtension" in window,
        onePasswordOwn: Object.prototype.hasOwnProperty.call(window, "__onePasswordExtension"),
        onePasswordProtoDescriptor: !!Object.getOwnPropertyDescriptor(
          windowProto,
          "__onePasswordExtension"
        ),
      },
      after: {
        reactDescriptor: !!Object.getOwnPropertyDescriptor(
          window,
          "__REACT_DEVTOOLS_GLOBAL_HOOK__"
        ),
        reactInWindow: "__REACT_DEVTOOLS_GLOBAL_HOOK__" in window,
        reactOwn: Object.prototype.hasOwnProperty.call(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__"),
        reduxDescriptor: !!Object.getOwnPropertyDescriptor(window, "__REDUX_DEVTOOLS_EXTENSION__"),
        reduxInWindow: "__REDUX_DEVTOOLS_EXTENSION__" in window,
        reduxOwn: Object.prototype.hasOwnProperty.call(window, "__REDUX_DEVTOOLS_EXTENSION__"),
      },
      hasStaticConfig: Object.prototype.hasOwnProperty.call(window, "__static_config__"),
      staticConfigType: typeof window.__static_config__,
    };
  });

  expect(result).toEqual({
    before: {
      reactDescriptor: false,
      reactInWindow: false,
      reactOwn: false,
      reduxDescriptor: false,
      reduxInWindow: false,
      reduxOwn: false,
    },
    reactHook: undefined,
    reduxHook: undefined,
    legacy: {
      grammarlyDescriptor: false,
      grammarlyInWindow: false,
      grammarlyOwn: false,
      grammarlyValue: undefined,
      onePasswordDescriptor: false,
      onePasswordInWindow: false,
      onePasswordOwn: false,
      onePasswordProtoDescriptor: false,
    },
    after: {
      reactDescriptor: false,
      reactInWindow: false,
      reactOwn: false,
      reduxDescriptor: false,
      reduxInWindow: false,
      reduxOwn: false,
    },
    hasStaticConfig: false,
    staticConfigType: "undefined",
  });
});

test("blocks protected globals set via Object.assign, Reflect.set, and Object.defineProperties", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(() => {
    Object.assign(window, {
      __GRAMMARLY_DESKTOP_INTEGRATION__: { source: "assign" },
      __honeyExtensionInstalled: true,
    });

    Reflect.set(window, "__keeper_extension_installed", { source: "reflect" });

    Object.defineProperties(window, {
      __dashlaneExtensionInstalled: { value: true, configurable: true },
      __nordpassExtensionInstalled: { value: true, configurable: true },
    });

    return {
      grammarly: window.__GRAMMARLY_DESKTOP_INTEGRATION__,
      honey: window.__honeyExtensionInstalled,
      keeper: window.__keeper_extension_installed,
      dashlane: window.__dashlaneExtensionInstalled,
      nordpass: window.__nordpassExtensionInstalled,
    };
  });

  expect(result).toEqual({
    grammarly: undefined,
    honey: undefined,
    keeper: undefined,
    dashlane: undefined,
    nordpass: undefined,
  });
});
