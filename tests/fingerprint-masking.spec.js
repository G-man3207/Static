const { expect, test } = require("./helpers/extension-fixture");

const ALLOWED_PLATFORMS = new Set(["Linux x86_64", "MacIntel", "Win32"]);
const ALLOWED_SCREEN_KEYS = new Set([
  "1366x768@1",
  "1440x900@1",
  "1536x864@1.25",
  "1920x1080@1",
  "2560x1440@1",
]);
const ALLOWED_TIMEZONES = new Set([
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/Berlin",
  "Europe/London",
]);
const OS_SEGMENT_BY_PLATFORM = {
  "Linux x86_64": "X11; Linux x86_64",
  MacIntel: "Macintosh; Intel Mac OS X 10_15_7",
  Win32: "Windows NT 10.0; Win64; x64",
};

const collectFingerprint = (page) =>
  page.evaluate(async () => {
    const offsetFor = (date, timeZone) => {
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
    };

    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 16, 16);

    const glCanvas = document.createElement("canvas");
    const gl = glCanvas.getContext("webgl");
    const debugInfo = gl && gl.getExtension("WEBGL_debug_renderer_info");
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const highEntropy =
      navigator.userAgentData && navigator.userAgentData.getHighEntropyValues
        ? await navigator.userAgentData.getHighEntropyValues([
            "architecture",
            "bitness",
            "model",
            "platform",
            "platformVersion",
            "wow64",
          ])
        : null;
    const storage =
      navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;

    return {
      appVersion: navigator.appVersion,
      canvas: {
        dataUrl: canvas.toDataURL(),
        pixel: Array.from(ctx.getImageData(0, 0, 1, 1).data),
      },
      connection: navigator.connection
        ? {
            downlink: navigator.connection.downlink,
            effectiveType: navigator.connection.effectiveType,
            rtt: navigator.connection.rtt,
            saveData: navigator.connection.saveData,
            type: navigator.connection.type,
          }
        : null,
      deviceMemory: navigator.deviceMemory,
      devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      highEntropy,
      maxTouchPoints: navigator.maxTouchPoints,
      platform: navigator.platform,
      screen: {
        availHeight: screen.availHeight,
        availWidth: screen.availWidth,
        colorDepth: screen.colorDepth,
        height: screen.height,
        pixelDepth: screen.pixelDepth,
        width: screen.width,
      },
      storage,
      timeZone,
      timezoneOffset: new Date("2026-04-24T12:00:00Z").getTimezoneOffset(),
      timezoneOffsetExpected: offsetFor(new Date("2026-04-24T12:00:00Z"), timeZone),
      uaData: navigator.userAgentData
        ? {
            mobile: navigator.userAgentData.mobile,
            platform: navigator.userAgentData.platform,
          }
        : null,
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      webgl: gl
        ? {
            renderer: gl.getParameter(gl.RENDERER),
            unmaskedRenderer: gl.getParameter(
              debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : 0x9246
            ),
            unmaskedVendor: gl.getParameter(debugInfo ? debugInfo.UNMASKED_VENDOR_WEBGL : 0x9245),
            vendor: gl.getParameter(gl.VENDOR),
          }
        : null,
    };
  });

const expectMaskedFingerprint = (fingerprint) => {
  expect(ALLOWED_PLATFORMS.has(fingerprint.platform)).toBe(true);
  expect(fingerprint.userAgent).toContain(OS_SEGMENT_BY_PLATFORM[fingerprint.platform]);
  expect(fingerprint.appVersion).toContain(OS_SEGMENT_BY_PLATFORM[fingerprint.platform]);
  expect([4, 8, 12, 16]).toContain(fingerprint.hardwareConcurrency);
  expect([4, 8, 16]).toContain(fingerprint.deviceMemory);
  expect(fingerprint.maxTouchPoints).toBe(0);
  expect(fingerprint.webdriver).toBe(false);

  const screenKey = `${fingerprint.screen.width}x${fingerprint.screen.height}@${fingerprint.devicePixelRatio}`;
  expect(ALLOWED_SCREEN_KEYS.has(screenKey)).toBe(true);
  expect(fingerprint.screen.availWidth).toBe(fingerprint.screen.width);
  expect(fingerprint.screen.availHeight).toBeLessThan(fingerprint.screen.height);
  expect(fingerprint.screen.colorDepth).toBe(24);
  expect(fingerprint.screen.pixelDepth).toBe(24);

  expect(ALLOWED_TIMEZONES.has(fingerprint.timeZone)).toBe(true);
  expect(fingerprint.timezoneOffset).toBe(fingerprint.timezoneOffsetExpected);

  if (fingerprint.uaData) {
    expect(fingerprint.uaData.mobile).toBe(false);
    expect(fingerprint.uaData.platform).toBe(fingerprint.highEntropy.platform);
    expect(fingerprint.highEntropy.bitness).toBe("64");
    expect(fingerprint.highEntropy.model).toBe("");
    expect(fingerprint.highEntropy.wow64).toBe(false);
  }
  if (fingerprint.connection) {
    expect(fingerprint.connection.effectiveType).toBe("4g");
    expect(fingerprint.connection.saveData).toBe(false);
  }
  if (fingerprint.storage) {
    expect([64, 128, 256].map((gb) => gb * 1024 * 1024 * 1024)).toContain(
      fingerprint.storage.quota
    );
    expect(fingerprint.storage.usage).toBe(0);
  }
  if (fingerprint.webgl) {
    expect(fingerprint.webgl.vendor).toContain("Google Inc.");
    expect(fingerprint.webgl.unmaskedVendor).toContain("Google Inc.");
    expect(fingerprint.webgl.renderer).toContain("ANGLE");
    expect(fingerprint.webgl.unmaskedRenderer).toContain("ANGLE");
  }
};

test("Fingerprint masking returns a stable plausible per-origin device persona", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  await expect
    .poll(async () => {
      const fingerprint = await collectFingerprint(page);
      const screenKey = `${fingerprint.screen.width}x${fingerprint.screen.height}@${fingerprint.devicePixelRatio}`;
      return ALLOWED_TIMEZONES.has(fingerprint.timeZone) && ALLOWED_SCREEN_KEYS.has(screenKey);
    })
    .toBe(true);

  const first = await collectFingerprint(page);
  const second = await collectFingerprint(page);
  expectMaskedFingerprint(first);
  expect(second).toEqual(first);
});

test("Fingerprint masking can be enabled live through the extension bridge", async ({
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

  await expect
    .poll(async () => {
      const fingerprint = await collectFingerprint(page);
      const screenKey = `${fingerprint.screen.width}x${fingerprint.screen.height}@${fingerprint.devicePixelRatio}`;
      return ALLOWED_TIMEZONES.has(fingerprint.timeZone) && ALLOWED_SCREEN_KEYS.has(screenKey);
    })
    .toBe(true);
});
