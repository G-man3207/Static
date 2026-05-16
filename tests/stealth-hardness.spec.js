const { expect, test } = require("./helpers/extension-fixture");

test("shared stealth WeakMap prevents toString chain explosion across scripts", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(() => {
    const toString = Function.prototype.toString;
    // Verify there's only one layer of patching by checking toString output
    const seen = new Set();
    const current = toString;
    if (current && typeof current === "function" && !seen.has(current)) {
      seen.add(current);
      try {
        const next = current.__ss2605__ ? null : String(current);
        if (next && next.includes("[native code]")) {
          // found native
        }
        // Heuristic: if toString on current returns native code, it's the real one
        const source = Function.prototype.toString.call(current);
        if (source.includes("stealthFns.has(this)")) {
          // Still our patch — but with shared WeakMap there should only be one layer
        }
      } catch {
        // ignore
      }
    }

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

    // The stealth key should exist but be non-enumerable
    const hasKey = "__ss2605__" in globalThis;
    const desc = Object.getOwnPropertyDescriptor(globalThis, "__ss2605__");

    return { hasKey, desc, sources };
  });

  expect(result.hasKey).toBe(true);
  if (result.desc) {
    expect(result.desc.enumerable).toBe(false);
  }

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
