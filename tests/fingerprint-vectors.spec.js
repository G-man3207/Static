const { expect, test } = require("./helpers/extension-fixture");

test("Fingerprint masking returns standard keyboard layout", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ fingerprint_mode: "mask" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? null
          : chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
      )
    );
  });

  const result = await page.evaluate(async () => {
    if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) {
      return { skipped: true };
    }
    const map = await navigator.keyboard.getLayoutMap();
    return {
      skipped: false,
      hasKeyA: map.has("KeyA"),
      keyA: map.get("KeyA"),
      keyZ: map.get("KeyZ"),
      key1: map.get("Digit1"),
      size: map.size,
    };
  });

  if (result.skipped) return;
  expect(result.hasKeyA).toBe(true);
  expect(result.keyA).toBe("KeyA");
  expect(result.keyZ).toBe("KeyZ");
  expect(result.key1).toBe("Digit1");
  expect(result.size).toBeGreaterThan(40);
});

test("Fingerprint masking empties media device enumeration", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ fingerprint_mode: "mask" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? null
          : chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
      )
    );
  });

  const result = await page.evaluate(async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return { skipped: true };
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      skipped: false,
      length: devices.length,
      isArray: Array.isArray(devices),
    };
  });

  if (result.skipped) return;
  expect(result.length).toBe(0);
  expect(result.isArray).toBe(true);
});

test("Fingerprint masking standardizes permissions.query responses", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ fingerprint_mode: "mask" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? null
          : chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
      )
    );
  });

  const result = await page.evaluate(async () => {
    if (!navigator.permissions || !navigator.permissions.query) {
      return { skipped: true };
    }
    const notifications = await navigator.permissions.query({ name: "notifications" });
    const clipboard = await navigator.permissions.query({ name: "clipboard-read" });
    return {
      skipped: false,
      notificationState: notifications.state,
      notificationName: notifications.name,
      clipboardState: clipboard.state,
      clipboardName: clipboard.name,
    };
  });

  if (result.skipped) return;
  expect(result.notificationState).toBe("prompt");
  expect(result.notificationName).toBe("notifications");
  expect(result.clipboardState).toBe("prompt");
  expect(result.clipboardName).toBe("clipboard-read");
});

test("Fingerprint masking aligns matchMedia with desktop persona", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ fingerprint_mode: "mask" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? null
          : chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
      )
    );
  });

  const result = await page.evaluate(() => ({
    hoverHover: window.matchMedia("(hover: hover)").matches,
    hoverNone: window.matchMedia("(hover: none)").matches,
    pointerFine: window.matchMedia("(pointer: fine)").matches,
    pointerCoarse: window.matchMedia("(pointer: coarse)").matches,
    anyHoverHover: window.matchMedia("(any-hover: hover)").matches,
    anyHoverNone: window.matchMedia("(any-hover: none)").matches,
    anyPointerFine: window.matchMedia("(any-pointer: fine)").matches,
    anyPointerCoarse: window.matchMedia("(any-pointer: coarse)").matches,
    prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
    prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  }));

  expect(result.hoverHover).toBe(true);
  expect(result.hoverNone).toBe(false);
  expect(result.pointerFine).toBe(true);
  expect(result.pointerCoarse).toBe(false);
  expect(result.anyHoverHover).toBe(true);
  expect(result.anyHoverNone).toBe(false);
  expect(result.anyPointerFine).toBe(true);
  expect(result.anyPointerCoarse).toBe(false);
  expect(result.prefersLight).toBe(true);
  expect(result.prefersDark).toBe(false);
});

test("Fingerprint masking masks uaFullVersion in high entropy values", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ fingerprint_mode: "mask" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? null
          : chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
      )
    );
  });

  const result = await page.evaluate(async () => {
    if (!navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) {
      return { skipped: true };
    }
    const values = await navigator.userAgentData.getHighEntropyValues(["uaFullVersion"]);
    return {
      skipped: false,
      uaFullVersion: values.uaFullVersion,
    };
  });

  if (result.skipped) return;
  expect(result.uaFullVersion).toBe("120.0.0.0");
});
