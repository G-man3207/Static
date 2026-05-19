const { expect, test } = require("./helpers/extension-fixture");

test("local stealth WeakMaps leave no detectable global key and toString chain works", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(() => {
    // All wrapped functions should return [native code] under toString
    const wrapped = [
      window.fetch,
      XMLHttpRequest.prototype.open,
      XMLHttpRequest.prototype.send,
      Element.prototype.setAttribute,
      Element.prototype.getAttribute,
      EventTarget.prototype.addEventListener,
      EventTarget.prototype.removeEventListener,
    ];

    const sources = {};
    for (const fn of wrapped) {
      if (typeof fn === "function") {
        sources[fn.name || "anonymous"] = {
          direct: fn.toString(),
          called: Function.prototype.toString.call(fn),
        };
      }
    }

    // No obvious stealth key should exist on globalThis
    const hasLegacyKey = "__ss2605__" in globalThis;
    const stealthKeys = Reflect.ownKeys(globalThis).filter(
      (key) =>
        (typeof key === "string" && key.includes("ss2605")) ||
        (typeof key === "string" && key.includes("__static"))
    );

    return { hasLegacyKey, sources, stealthKeys };
  });

  expect(result.hasLegacyKey).toBe(false);
  expect(result.stealthKeys).toEqual([]);

  for (const [name, { direct, called }] of Object.entries(result.sources)) {
    expect(direct, `${name} direct toString`).toContain("[native code]");
    expect(called, `${name} toString.call`).toContain("[native code]");
    expect(direct, `${name} direct toString must not expose wrapper`).not.toContain("stealthFns");
    expect(called, `${name} toString.call must not expose wrapper`).not.toContain("stealthFns");
  }
});

test("setAttribute and getAttribute preserve native toString source", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(() => {
    const setAttr = Element.prototype.setAttribute;
    const getAttr = Element.prototype.getAttribute;
    const setAttrNS = Element.prototype.setAttributeNS;
    return {
      setAttr: setAttr.toString(),
      getAttr: getAttr.toString(),
      setAttrNS: setAttrNS.toString(),
    };
  });

  for (const [name, source] of Object.entries(result)) {
    expect(source, `${name} toString`).toContain("[native code]");
    expect(source, `${name} toString`).not.toContain("stealthFns");
  }
});
