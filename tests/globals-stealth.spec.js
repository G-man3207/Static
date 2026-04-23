const { expect, test } = require("./helpers/extension-fixture");

test("runs at document_start without exposing Static config or protected globals", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(() => {
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

    return {
      before,
      reactHook: window.__REACT_DEVTOOLS_GLOBAL_HOOK__,
      reduxHook: window.__REDUX_DEVTOOLS_EXTENSION__,
      after: {
        reactDescriptor: !!Object.getOwnPropertyDescriptor(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__"),
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
