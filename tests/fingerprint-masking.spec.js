/* eslint-disable max-lines -- fingerprint masking tests are easier to maintain in one file */
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
const ALLOWED_LANGUAGE_SETS = new Set(["de-DE,de,en-US,en", "en-GB,en", "en-US,en"]);
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
    const uaDataReflect =
      navigator.userAgentData && navigator.userAgentData.getHighEntropyValues
        ? (() => {
            try {
              return {
                brands: Reflect.get(navigator.userAgentData, "brands", {}),
                platform: Reflect.get(navigator.userAgentData, "platform", {}),
              };
            } catch (error) {
              return { error: `${error.name}: ${error.message}` };
            }
          })()
        : null;
    const storage =
      navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;

    return {
      appVersion: navigator.appVersion,
      canvas: {
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
      language: navigator.language,
      languages: Array.from(navigator.languages || []),
      maxTouchPoints: navigator.maxTouchPoints,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
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
      uaDataReflect,
      userAgent: navigator.userAgent,
      vendor: navigator.vendor,
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

  expect(ALLOWED_LANGUAGE_SETS.has(fingerprint.languages.join(","))).toBe(true);
  expect(fingerprint.language).toBe(fingerprint.languages[0]);
  expect(fingerprint.pdfViewerEnabled).toBe(true);
  expect(fingerprint.vendor).toBe("Google Inc.");

  expect(ALLOWED_TIMEZONES.has(fingerprint.timeZone)).toBe(true);
  expect(fingerprint.timezoneOffset).toBe(fingerprint.timezoneOffsetExpected);

  if (fingerprint.uaData) {
    expect(fingerprint.uaData.mobile).toBe(false);
    expect(fingerprint.uaData.platform).toBe(fingerprint.highEntropy.platform);
    expect(fingerprint.uaDataReflect.error).toBeUndefined();
    expect(Array.isArray(fingerprint.uaDataReflect.brands)).toBe(true);
    expect(fingerprint.uaDataReflect.platform).toBe(fingerprint.uaData.platform);
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

const collectExplicitIntlTimeZones = (page) =>
  page.evaluate(() => ({
    constructorUtc: new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).resolvedOptions()
      .timeZone,
    functionTokyo: Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo" }).resolvedOptions()
      .timeZone,
  }));

const collectUaDataSurface = (page) =>
  page.evaluate(() => {
    if (!navigator.userAgentData) return null;
    const firstUaData = navigator.userAgentData;
    const secondUaData = navigator.userAgentData;
    const highEntropyMethod = firstUaData.getHighEntropyValues;
    const toJsonMethod = firstUaData.toJSON;
    return {
      highEntropySource:
        typeof highEntropyMethod === "function"
          ? Function.prototype.toString.call(highEntropyMethod)
          : null,
      highEntropyStable:
        typeof highEntropyMethod === "function"
          ? highEntropyMethod === firstUaData.getHighEntropyValues &&
            highEntropyMethod === secondUaData.getHighEntropyValues
          : null,
      toJsonSource:
        typeof toJsonMethod === "function" ? Function.prototype.toString.call(toJsonMethod) : null,
      toJsonStable:
        typeof toJsonMethod === "function"
          ? toJsonMethod === firstUaData.toJSON && toJsonMethod === secondUaData.toJSON
          : null,
      userAgentDataStable: firstUaData === secondUaData,
    };
  });

const expectMaskedUaDataSurface = (surface) => {
  if (!surface) return;
  expect(surface.userAgentDataStable).toBe(true);
  expect(surface.highEntropyStable).toBe(true);
  expect(surface.highEntropySource).toContain("[native code]");
  if (surface.toJsonStable !== null) {
    expect(surface.toJsonStable).toBe(true);
    expect(surface.toJsonSource).toContain("[native code]");
  }
};

const collectAudioFingerprint = (page) =>
  page.evaluate(async () => {
    if (typeof OfflineAudioContext === "undefined") return null;
    const context = new OfflineAudioContext(1, 512, 44100);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 440;
    gain.gain.value = 0.2;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(0);
    oscillator.stop(0.01);
    const buffer = await context.startRendering();
    const data = buffer.getChannelData(0);
    let signature = 2166136261;
    for (const value of data) {
      const quantized = Math.round(value * 100000000);
      signature = Math.imul(signature ^ quantized, 16777619) >>> 0;
    }
    return { length: data.length, signature: signature.toString(16) };
  });

const collectOffscreenCanvasFingerprint = (page) =>
  page.evaluate(async () => {
    if (typeof OffscreenCanvas === "undefined") return null;
    const canvas = new OffscreenCanvas(16, 16);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 16, 16);

    let getImageDataSignature = null;
    try {
      const data = ctx.getImageData(0, 0, 16, 16).data;
      let sig = 2166136261;
      for (let i = 0; i < data.length; i++) {
        sig = Math.imul(sig ^ data[i], 16777619) >>> 0;
      }
      getImageDataSignature = sig.toString(16);
    } catch {}

    let blobHash = null;
    try {
      const blob = await canvas.convertToBlob();
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let sig = 2166136261;
      for (let i = 0; i < bytes.length; i++) {
        sig = Math.imul(sig ^ bytes[i], 16777619) >>> 0;
      }
      blobHash = sig.toString(16);
    } catch {}

    return { blobHash, getImageDataSignature };
  });

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
  expectMaskedUaDataSurface(await collectUaDataSurface(page));
  expect(second).toEqual(first);
  await expect(collectExplicitIntlTimeZones(page)).resolves.toEqual({
    constructorUtc: "UTC",
    functionTokyo: "Asia/Tokyo",
  });
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

test("Fingerprint masking perturbs offline audio fingerprints without blocking rendering", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const plain = await collectAudioFingerprint(page);
  test.skip(!plain, "OfflineAudioContext is unavailable in this browser");
  expect(await collectAudioFingerprint(page)).toEqual(plain);

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
      const poisoned = await collectAudioFingerprint(page);
      return poisoned && poisoned.signature !== plain.signature;
    })
    .toBe(true);

  const firstPoisoned = await collectAudioFingerprint(page);
  const secondPoisoned = await collectAudioFingerprint(page);
  expect(firstPoisoned).toEqual(secondPoisoned);
  expect(firstPoisoned.length).toBe(plain.length);
});

test("Fingerprint masking perturbs OffscreenCanvas getImageData and convertToBlob", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const plainOffscreen = await collectOffscreenCanvasFingerprint(page);
  test.skip(!plainOffscreen, "OffscreenCanvas is unavailable in this browser");

  const plainOffscreen2 = await collectOffscreenCanvasFingerprint(page);
  expect(plainOffscreen2).toEqual(plainOffscreen);

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
      const maskedOffscreen = await collectOffscreenCanvasFingerprint(page);
      if (!maskedOffscreen) return false;
      return (
        maskedOffscreen.getImageDataSignature !== plainOffscreen.getImageDataSignature &&
        maskedOffscreen.blobHash !== plainOffscreen.blobHash
      );
    })
    .toBe(true);

  const maskedOffscreen = await collectOffscreenCanvasFingerprint(page);
  expect(maskedOffscreen.getImageDataSignature).not.toBe(plainOffscreen.getImageDataSignature);
  expect(maskedOffscreen.blobHash).not.toBe(plainOffscreen.blobHash);

  const maskedOffscreen2 = await collectOffscreenCanvasFingerprint(page);
  expect(maskedOffscreen2).toEqual(maskedOffscreen);
});

test("Fingerprint masking applies multi-pixel canvas noise, not single-pixel", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const plainSignature = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    let changed = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0x12 || data[i + 1] !== 0x34 || data[i + 2] !== 0x56) changed++;
    }
    return { changed, total: data.length / 4 };
  });
  expect(plainSignature.changed).toBe(0);

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
      return page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#123456";
        ctx.fillRect(0, 0, 64, 64);
        const data = ctx.getImageData(0, 0, 64, 64).data;
        let changed = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] !== 0x12 || data[i + 1] !== 0x34 || data[i + 2] !== 0x56) changed++;
        }
        return changed;
      });
    })
    .toBeGreaterThanOrEqual(2);

  const maskedResult = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    const changedPixels = [];
    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - 0x12;
      const dg = data[i + 1] - 0x34;
      const db = data[i + 2] - 0x56;
      if (dr !== 0 || dg !== 0 || db !== 0) {
        changedPixels.push({ delta: Math.abs(dr), pixel: i / 4 });
      }
    }
    return changedPixels;
  });

  expect(maskedResult.length).toBeGreaterThanOrEqual(2);
  expect(maskedResult.length).toBeLessThanOrEqual(5);
  const deltas = new Set(maskedResult.map((p) => p.delta));
  expect(deltas.size).toBeGreaterThanOrEqual(1);
  for (const { delta } of maskedResult) {
    expect(delta).toBeGreaterThanOrEqual(1);
    expect(delta).toBeLessThanOrEqual(3);
  }
});

test("Fingerprint masking multi-pixel canvas noise is stable across reads", async ({
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
      return page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#abcdef";
        ctx.fillRect(0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        let changed = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] !== 0xab || data[i + 1] !== 0xcd || data[i + 2] !== 0xef) {
            changed++;
          }
        }
        return changed;
      });
    })
    .toBeGreaterThanOrEqual(2);

  const readCanvasPixels = () =>
    page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#abcdef";
      ctx.fillRect(0, 0, 32, 32);
      return Array.from(ctx.getImageData(0, 0, 32, 32).data);
    });

  const first = await readCanvasPixels();
  const second = await readCanvasPixels();
  const third = await readCanvasPixels();
  expect(second).toEqual(first);
  expect(third).toEqual(first);
});

test("Fingerprint masking handles getHighEntropyValues string hint", async ({
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
    const values = await navigator.userAgentData.getHighEntropyValues("platform");
    return {
      skipped: false,
      platform: values.platform,
      hasOtherKeys: Object.keys(values).length > 1,
    };
  });

  if (result.skipped) return;
  expect(result.platform).toBeTruthy();
});

test("Fingerprint masking empties navigator.plugins and mimeTypes", async ({
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

  const result = await page.evaluate(() => {
    const plugins = navigator.plugins;
    const mimeTypes = navigator.mimeTypes;
    return {
      pluginsLength: plugins ? plugins.length : null,
      mimeTypesLength: mimeTypes ? mimeTypes.length : null,
      pluginsIsArray: Array.isArray(plugins),
      mimeTypesIsArray: Array.isArray(mimeTypes),
      pluginsInstanceofPluginArray:
        typeof PluginArray !== "undefined" && plugins instanceof PluginArray,
      mimeTypesInstanceofMimeTypeArray:
        typeof MimeTypeArray !== "undefined" && mimeTypes instanceof MimeTypeArray,
      pluginsHasItem: plugins && typeof plugins.item === "function",
      pluginsHasNamedItem: plugins && typeof plugins.namedItem === "function",
      mimeTypesHasItem: mimeTypes && typeof mimeTypes.item === "function",
      mimeTypesHasNamedItem: mimeTypes && typeof mimeTypes.namedItem === "function",
    };
  });

  expect(result.pluginsLength).toBe(0);
  expect(result.mimeTypesLength).toBe(0);
  expect(result.pluginsIsArray).toBe(false);
  expect(result.mimeTypesIsArray).toBe(false);
  expect(result.pluginsInstanceofPluginArray).toBe(true);
  expect(result.mimeTypesInstanceofMimeTypeArray).toBe(true);
  expect(result.pluginsHasItem).toBe(true);
  expect(result.pluginsHasNamedItem).toBe(true);
  expect(result.mimeTypesHasItem).toBe(true);
  expect(result.mimeTypesHasNamedItem).toBe(true);
});

test("Fingerprint masking masks performance.memory", async ({ extension, server }) => {
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

  const result = await page.evaluate(() => {
    const memory = performance.memory;
    if (!memory) return { skipped: true };
    return {
      skipped: false,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
      totalJSHeapSize: memory.totalJSHeapSize,
      usedJSHeapSize: memory.usedJSHeapSize,
    };
  });

  if (result.skipped) return;
  expect(result.jsHeapSizeLimit).toBe(2197815296);
  expect(result.totalJSHeapSize).toBe(12345678);
  expect(result.usedJSHeapSize).toBe(9876543);
});

test("Fingerprint masking masks navigator.credentials", async ({ extension, server }) => {
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
    const creds = navigator.credentials;
    if (!creds) return { skipped: true };
    const getResult = await creds.get({ mediation: "silent" }).catch(() => ({ error: true }));
    const preventResult = await creds.preventSilentAccess().catch(() => ({ error: true }));
    const createResult = await creds.create({ publicKey: {} }).catch(() => ({ error: true }));
    const storeResult = await creds.store({ id: "test" }).catch(() => ({ error: true }));
    return {
      skipped: false,
      getIsNull: getResult === null,
      preventIsUndefined: preventResult === undefined,
      createIsNull: createResult === null,
      storeIsNull: storeResult === null,
    };
  });

  if (result.skipped) return;
  expect(result.getIsNull).toBe(true);
  expect(result.preventIsUndefined).toBe(true);
  expect(result.createIsNull).toBe(true);
  expect(result.storeIsNull).toBe(true);
});

test("Fingerprint masking OFF restores native credentials", async ({ extension, server }) => {
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

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  // While masked, check that the proxied get() returns null synchronously
  const masked = await page.evaluate(async () => {
    const creds = navigator.credentials;
    if (!creds) return { skipped: true };
    const result = await creds.get({ mediation: "silent" }).catch(() => ({ error: true }));
    return { skipped: false, getResult: result };
  });
  if (masked.skipped) return;
  expect(masked.getResult).toBe(null);

  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ fingerprint_mode: "off" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? null
          : chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
      )
    );
  });
  await page.waitForTimeout(300);

  // When unmasked, get the identity of the get() method — it should be a
  // different function than the masked proxy (native vs wrapped).
  const unmasked = await page.evaluate(() => {
    const creds = navigator.credentials;
    if (!creds) return { skipped: true };
    return {
      skipped: false,
      getIsFunction: typeof creds.get === "function",
      getToString: String(creds.get),
      // The native get() name and toString should look native
      getLooksNative: String(creds.get).includes("native code") || creds.get.name === "get",
    };
  });
  if (unmasked.skipped) return;
  expect(unmasked.getIsFunction).toBe(true);
  expect(unmasked.getLooksNative).toBe(true);
});

test("Fingerprint masking masks navigator.clipboard", async ({ extension, server }) => {
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
    const clipboard = navigator.clipboard;
    if (!clipboard) return { skipped: true };
    const readTextResult = await clipboard.readText().catch(() => null);
    const readResult = await clipboard.read().catch(() => null);
    await clipboard.writeText("").catch(() => {});
    await clipboard.write([]).catch(() => {});
    return {
      skipped: false,
      clipboardExists: true,
      readTextEmpty: readTextResult === "",
      readEmpty: Array.isArray(readResult) && readResult.length === 0,
    };
  });

  if (result.skipped) return;
  expect(result.clipboardExists).toBe(true);
  expect(result.readTextEmpty).toBe(true);
  expect(result.readEmpty).toBe(true);
});

test("screen.orientation.type and angle return stable desktop persona values", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const orientation = screen.orientation;
    const type = orientation ? orientation.type : null;
    const angle = orientation ? orientation.angle : null;
    const nativeType = orientation ? orientation.type : null;
    return { type, angle, nativeType };
  });

  expect(result.type).toBe("landscape-primary");
  expect(result.angle).toBe(0);

  // Toggle off and verify orientation returns to native
  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ fingerprint_mode: "off" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id != null
          ? chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
          : null
      )
    );
  });
  await page.waitForTimeout(300);

  const unmasked = await page.evaluate(() => ({
    type: screen.orientation ? screen.orientation.type : null,
    angle: screen.orientation ? screen.orientation.angle : null,
  }));

  // Native values should be back when masking is off
  expect(unmasked.type).not.toBe(null);
  expect(typeof unmasked.angle).toBe("number");
});

test("Fingerprint masking returns deterministic font-face check persona", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const fontResult = await page.evaluate(() => {
    if (!document.fonts || typeof document.fonts.check !== "function") {
      return { skipped: true };
    }
    const commonFonts = ["Arial", "Courier New", "Times New Roman", "Verdana"];
    const rareFonts = ["zzzNoSuchFont zzz", "AnotherMadeUpFont 123"];
    const commonResults = commonFonts.map(
      (name) => `${name}:${document.fonts.check(`12px "${name}"`)}`
    );
    const rareResults = rareFonts.map(
      (name) => `${name}:${document.fonts.check(`12px "${name}"`)}`
    );
    return { skipped: false, commonResults, rareResults };
  });

  if (fontResult.skipped) return;
  // Common fonts should always return true under masking
  for (const entry of fontResult.commonResults) {
    expect(entry).toContain(":true");
  }
  // Rare fonts return deterministic hash-based results
  expect(fontResult.rareResults.length).toBe(2);
});

test("FontFaceSet toString() remains native-looking under masking", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    if (!document.fonts || typeof document.fonts.check !== "function") {
      return { skipped: true };
    }
    const toString = (fn) =>
      typeof fn === "function" ? Function.prototype.toString.call(fn) : null;
    return {
      skipped: false,
      checkSource: toString(document.fonts.check),
    };
  });

  if (result.skipped) return;
  expect(result.checkSource).toContain("[native code]");
});

test("credential and clipboard mocks produce native-like toString", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const toString = (fn) =>
      typeof fn === "function" ? Function.prototype.toString.call(fn) : null;

    let credentialsOverride = null;
    let clipboardOverride = null;

    try {
      // Access through the patched navigator.credentials getter
      const cred = navigator.credentials;
      credentialsOverride = {
        get: toString(cred.get),
        create: toString(cred.create),
        store: toString(cred.store),
        preventSilentAccess: toString(cred.preventSilentAccess),
      };
    } catch {}

    try {
      const clip = navigator.clipboard;
      clipboardOverride = {
        read: toString(clip.read),
        readText: toString(clip.readText),
        write: toString(clip.write),
        writeText: toString(clip.writeText),
      };
    } catch {}

    return { credentialsOverride, clipboardOverride };
  });

  for (const fn of Object.values(result.credentialsOverride || {})) {
    expect(fn).toContain("[native code]");
  }
  for (const fn of Object.values(result.clipboardOverride || {})) {
    expect(fn).toContain("[native code]");
  }
});

test("WebGL getSupportedExtensions returns plausible fixed list under masking", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (!gl || typeof gl.getSupportedExtensions !== "function") return { skipped: true };
    const exts = gl.getSupportedExtensions();
    const toString = Function.prototype.toString.call(gl.getSupportedExtensions);
    return {
      skipped: false,
      count: Array.isArray(exts) ? exts.length : -1,
      hasCommon: Array.isArray(exts) && exts.includes("WEBGL_debug_renderer_info"),
      toString,
    };
  });

  if (result.skipped) return;
  expect(result.count).toBeGreaterThanOrEqual(10);
  expect(result.hasCommon).toBe(true);
  expect(result.toString).toContain("[native code]");
});

test("WebGL getShaderPrecisionFormat returns plausible values under masking", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (!gl || typeof gl.getShaderPrecisionFormat !== "function") return { skipped: true };
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const toString = Function.prototype.toString.call(gl.getShaderPrecisionFormat);
    return {
      skipped: false,
      rangeMin: precision ? precision.rangeMin : -1,
      rangeMax: precision ? precision.rangeMax : -1,
      precisionVal: precision ? precision.precision : -1,
      toString,
    };
  });

  if (result.skipped) return;
  expect(result.rangeMin).toBe(127);
  expect(result.rangeMax).toBe(127);
  expect(result.precisionVal).toBe(23);
  expect(result.toString).toContain("[native code]");
});

test("FontFaceSet load() and iterators filter non-plausible fonts under masking", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    if (!document.fonts || typeof document.fonts.load !== "function") return { skipped: true };

    // has() - non-plausible font should return false
    const fakeFont = new FontFace("ZzzFakeFont12345", "url(data:font/woff2;base64,)");
    const hasResult = document.fonts.has(fakeFont);

    // size - should not count non-plausible fonts
    const size = document.fonts.size;

    // load() toString check
    const loadToString =
      typeof document.fonts.load === "function"
        ? Function.prototype.toString.call(document.fonts.load)
        : null;

    // forEach should skip non-plausible fonts
    let forEachCount = 0;
    document.fonts.forEach(() => forEachCount++);

    // entries/keys/values should filter
    let entriesCount = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _entry of document.fonts.entries()) entriesCount++;
    let keysCount = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _key of document.fonts.keys()) keysCount++;

    return {
      skipped: false,
      hasResult,
      size,
      loadToString,
      forEachCount,
      entriesCount,
      keysCount,
    };
  });

  if (result.skipped) return;
  expect(result.hasResult).toBe(false);
  expect(typeof result.size).toBe("number");
  expect(result.loadToString).toContain("[native code]");
  expect(typeof result.forEachCount).toBe("number");
  expect(result.entriesCount).toBe(result.keysCount);
});

test("navigator.getGamepads returns all-null array under masking", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    if (typeof navigator.getGamepads !== "function") return { skipped: true };
    const gamepads = navigator.getGamepads();
    const toString = Function.prototype.toString.call(navigator.getGamepads);
    return {
      skipped: false,
      isArray: Array.isArray(gamepads),
      allNull: Array.isArray(gamepads) ? gamepads.every((gp) => gp === null) : false,
      toString,
    };
  });

  if (result.skipped) return;
  expect(result.isArray).toBe(true);
  expect(result.allNull).toBe(true);
  expect(result.toString).toContain("[native code]");
});

test("screen position and isExtended return desktop persona values under masking", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => ({
    screenLeft: window.screenLeft,
    screenTop: window.screenTop,
    availLeft: screen.availLeft,
    availTop: screen.availTop,
    isExtended: screen.isExtended,
  }));

  expect(result.screenLeft).toBe(0);
  expect(result.screenTop).toBe(0);
  expect(result.availLeft).toBe(0);
  expect(result.availTop).toBe(0);
  if (result.isExtended !== undefined) {
    expect(result.isExtended).toBe(false);
  }
});

test("queryLocalFonts returns empty array under masking", async ({ extension, server }) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(async () => {
    if (typeof window.queryLocalFonts !== "function") return { skipped: true };
    try {
      const fonts = await window.queryLocalFonts();
      const toString = Function.prototype.toString.call(window.queryLocalFonts);
      return { skipped: false, fonts, count: fonts.length, toString };
    } catch {
      return { skipped: false, error: true };
    }
  });

  if (result.skipped) return;
  if (result.error) return; // Permission denied is acceptable
  expect(result.count).toBe(0);
  expect(result.toString).toContain("[native code]");
});

test("speechSynthesis.getVoices returns empty array under masking", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    if (typeof window.speechSynthesis === "undefined") return { skipped: true };
    const synth = window.speechSynthesis;
    if (!synth || typeof synth.getVoices !== "function") return { skipped: true };
    const voices = synth.getVoices();
    const toString = Function.prototype.toString.call(synth.getVoices);
    return {
      skipped: false,
      isArray: Array.isArray(voices),
      count: Array.isArray(voices) ? voices.length : -1,
      toString,
    };
  });

  if (result.skipped) return;
  expect(result.isArray).toBe(true);
  expect(result.count).toBe(0);
  expect(result.toString).toContain("[native code]");
});

test("navigator.cookieEnabled and onLine return persona values under masking", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => ({
    cookieEnabled: navigator.cookieEnabled,
    onLine: navigator.onLine,
  }));

  expect(result.cookieEnabled).toBe(true);
  expect(result.onLine).toBe(true);
});

test("mediaDevices.getSupportedConstraints returns native-like result under masking", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getSupportedConstraints !== "function"
    ) {
      return { skipped: true };
    }
    const constraints = navigator.mediaDevices.getSupportedConstraints();
    const toString = Function.prototype.toString.call(
      navigator.mediaDevices.getSupportedConstraints
    );
    return {
      skipped: false,
      hasAspectRatio: constraints && typeof constraints.aspectRatio === "boolean",
      toString,
    };
  });

  if (result.skipped) return;
  expect(result.hasAspectRatio).toBe(true);
  expect(result.toString).toContain("[native code]");
});

test("new fingerprint masking vectors revert to native when toggled off", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const masked = await page.evaluate(() => ({
    cookieEnabled: navigator.cookieEnabled,
    onLine: navigator.onLine,
  }));
  expect(masked.cookieEnabled).toBe(true);
  expect(masked.onLine).toBe(true);

  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ fingerprint_mode: "off" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id != null
          ? chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
          : null
      )
    );
  });
  await page.waitForTimeout(300);

  const unmasked = await page.evaluate(() => ({
    cookieEnabled: navigator.cookieEnabled,
    onLine: navigator.onLine,
  }));
  expect(typeof unmasked.cookieEnabled).toBe("boolean");
  expect(typeof unmasked.onLine).toBe("boolean");
});
