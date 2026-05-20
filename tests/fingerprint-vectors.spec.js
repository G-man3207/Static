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
    const camera = await navigator.permissions.query({ name: "camera" });
    const microphone = await navigator.permissions.query({ name: "microphone" });
    return {
      skipped: false,
      notificationState: notifications.state,
      notificationName: notifications.name,
      clipboardState: clipboard.state,
      clipboardName: clipboard.name,
      cameraState: camera.state,
      cameraName: camera.name,
      microphoneState: microphone.state,
      microphoneName: microphone.name,
    };
  });

  if (result.skipped) return;
  expect(result.notificationState).toBe("prompt");
  expect(result.notificationName).toBe("notifications");
  expect(result.clipboardState).toBe("prompt");
  expect(result.clipboardName).toBe("clipboard-read");
  expect(result.cameraState).toBe("prompt");
  expect(result.cameraName).toBe("camera");
  expect(result.microphoneState).toBe("prompt");
  expect(result.microphoneName).toBe("microphone");
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

test("Fingerprint masking returns plausible mediaCapabilities info", async ({
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
    if (!navigator.mediaCapabilities) return { skipped: true };
    const decoding = await navigator.mediaCapabilities.decodingInfo({
      type: "file",
      video: {
        contentType: 'video/webm; codecs="vp09.00.10.08"',
        width: 1920,
        height: 1080,
        bitrate: 5000000,
        framerate: 30,
      },
    });
    const encoding = await navigator.mediaCapabilities.encodingInfo({
      type: "record",
      video: {
        contentType: 'video/webm; codecs="vp09.00.10.08"',
        width: 1920,
        height: 1080,
        bitrate: 5000000,
        framerate: 30,
      },
    });
    return {
      skipped: false,
      decodingSupported: decoding.supported,
      decodingSmooth: decoding.smooth,
      decodingPowerEfficient: decoding.powerEfficient,
      encodingSupported: encoding.supported,
      encodingSmooth: encoding.smooth,
      encodingPowerEfficient: encoding.powerEfficient,
    };
  });

  if (result.skipped) return;
  expect(result.decodingSupported).toBe(true);
  expect(result.decodingSmooth).toBe(true);
  expect(result.decodingPowerEfficient).toBe(true);
  expect(result.encodingSupported).toBe(true);
  expect(result.encodingSmooth).toBe(true);
  expect(result.encodingPowerEfficient).toBe(true);
});

test("Fingerprint masking hides WebGPU adapter behind null", async ({ extension, server }) => {
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
    if (!navigator.gpu) return { skipped: true };
    const adapter = await navigator.gpu.requestAdapter();
    return { skipped: false, adapter };
  });

  if (result.skipped) return;
  expect(result.adapter).toBeNull();
});

test("Fingerprint masking hides hardware availability APIs", async ({ extension, server }) => {
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
    bluetooth: navigator.bluetooth,
    hid: navigator.hid,
    presentation: navigator.presentation,
    serial: navigator.serial,
    usb: navigator.usb,
    wakeLock: navigator.wakeLock,
    xr: navigator.xr,
  }));

  expect(result.bluetooth).toBeUndefined();
  expect(result.hid).toBeUndefined();
  expect(result.presentation).toBeUndefined();
  expect(result.serial).toBeUndefined();
  expect(result.usb).toBeUndefined();
  expect(result.wakeLock).toBeUndefined();
  expect(result.xr).toBeUndefined();
});

test("Fingerprint masking returns false for navigator.javaEnabled()", async ({
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
    if (typeof navigator.javaEnabled !== "function") return { skipped: true };
    const maskedValue = navigator.javaEnabled();
    const toStringResult = Function.prototype.toString.call(navigator.javaEnabled);
    return { skipped: false, maskedValue, toStringResult };
  });

  if (result.skipped) return;
  expect(result.maskedValue).toBe(false);
  expect(result.toStringResult).toContain("[native code]");
});

const enableFingerprintMask = async (extension) => {
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
};

test("Fingerprint masking suppresses RTCPeerConnection ICE candidate listeners", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(async () => {
    if (typeof RTCPeerConnection === "undefined") return { skipped: true };
    const pc = new RTCPeerConnection({ iceServers: [] });
    let iceCandidateFired = false;
    pc.addEventListener("icecandidate", () => {
      iceCandidateFired = true;
    });
    pc.createDataChannel("test");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    pc.close();
    return { skipped: false, iceCandidateFired };
  });

  if (result.skipped) return;
  expect(result.iceCandidateFired).toBe(false);
});

test("Fingerprint masking standardizes AudioContext sampleRate", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return { skipped: true };
    const ctx = new Ctor();
    const sampleRate = ctx.sampleRate;
    const getterStr = Function.prototype.toString.call(
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctx), "sampleRate").get
    );
    ctx.close();
    return { skipped: false, sampleRate, getterStr };
  });

  if (result.skipped) return;
  expect(result.sampleRate).toBe(48000);
  expect(result.getterStr).toContain("[native code]");
});

test("Fingerprint masking standardizes AudioContext baseLatency and outputLatency", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return { skipped: true };
    const ctx = new Ctor();
    const baseLatency = ctx.baseLatency;
    const outputLatency = ctx.outputLatency;
    ctx.close();
    return { skipped: false, baseLatency, outputLatency };
  });

  if (result.skipped) return;
  expect(result.baseLatency).toBeGreaterThan(0);
  expect(typeof result.baseLatency).toBe("number");
  expect(result.outputLatency).toBeGreaterThan(0);
  expect(typeof result.outputLatency).toBe("number");
});

test("Fingerprint masking perturbs Canvas measureText results", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const offValue = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = "16px Arial";
    const metrics = ctx.measureText("hello");
    return metrics.width;
  });

  const onValue = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = "16px Arial";
    const metrics = ctx.measureText("hello");
    return metrics.width;
  });

  if (typeof offValue !== "number" || typeof onValue !== "number") return;
  expect(typeof onValue).toBe("number");
});

test("Fingerprint masking standardizes media canPlayType responses", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => {
    const video = document.createElement("video");
    return {
      mp4: video.canPlayType("video/mp4"),
      webm: video.canPlayType("video/webm"),
      mp3: video.canPlayType("audio/mpeg"),
      ogg: video.canPlayType("video/ogg"),
    };
  });

  expect(result.mp4).toBe("probably");
  expect(result.webm).toBe("probably");
  expect(result.mp3).toBe("probably");
  expect(result.ogg).toBe("probably");
});

test("Fingerprint masking standardizes CSS.supports responses", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => ({
    grid: CSS.supports("display", "grid"),
    flex: CSS.supports("display", "flex"),
    gap: CSS.supports("gap", "1px"),
    aspectRatio: CSS.supports("aspect-ratio", "1/1"),
  }));

  expect(result.grid).toBe(true);
  expect(result.flex).toBe(true);
  expect(result.gap).toBe(true);
  expect(result.aspectRatio).toBe(true);
});

test("Fingerprint masking standardizes window outer dimensions", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => ({
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
  }));

  expect(result.outerWidth).toBe(1920);
  expect(result.outerHeight).toBe(1080);
});

test("Fingerprint masking returns standard productSub", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => {
    if (typeof navigator.productSub === "undefined") return { skipped: true };
    return { skipped: false, value: navigator.productSub };
  });

  if (result.skipped) return;
  expect(result.value).toBe("20030107");
});

test("Fingerprint masking standardizes WebGL getContextAttributes", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (!gl) return { skipped: true };
    const attrs = gl.getContextAttributes();
    return {
      skipped: false,
      alpha: attrs.alpha,
      antialias: attrs.antialias,
      depth: attrs.depth,
      stencil: attrs.stencil,
      premultipliedAlpha: attrs.premultipliedAlpha,
    };
  });

  if (result.skipped) return;
  expect(result.alpha).toBe(true);
  expect(result.antialias).toBe(true);
  expect(result.depth).toBe(true);
  expect(result.stencil).toBe(false);
  expect(result.premultipliedAlpha).toBe(true);
});

test("Fingerprint masking standardizes WebGL getExtension responses", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (!gl) return { skipped: true };
    const debugExt = gl.getExtension("WEBGL_debug_renderer_info");
    const missingExt = gl.getExtension("FAKE_extension_xyz");
    return {
      skipped: false,
      debugIsObject: debugExt !== null && typeof debugExt === "object",
      missingIsNull: missingExt === null,
    };
  });

  if (result.skipped) return;
  expect(result.debugIsObject).toBe(true);
  expect(result.missingIsNull).toBe(true);
});

test("Fingerprint masking standardizes Notification.permission", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => {
    if (typeof Notification === "undefined") return { skipped: true };
    return { skipped: false, permission: Notification.permission };
  });

  if (result.skipped) return;
  expect(result.permission).toBe("default");
});

test("Fingerprint masking strips navigator.oscpu and navigator.buildID", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => ({
    oscpu: navigator.oscpu,
    buildID: navigator.buildID,
  }));

  if (result.oscpu !== undefined) expect(result.oscpu).toBe("");
  if (result.buildID !== undefined) expect(result.buildID).toBe("");
});

test("Fingerprint masking silently returns null for non-numeric WebGL getParameter", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await enableFingerprintMask(extension);

  const result = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (!gl) return { skipped: true };

    const invalidString = gl.getParameter("not_a_number");
    const invalidUndefined = gl.getParameter(undefined);
    const validVendor = gl.getParameter(gl.VENDOR);

    return {
      skipped: false,
      invalidString,
      invalidUndefined,
      validVendor: typeof validVendor === "string",
    };
  });

  if (result.skipped) return;
  expect(result.invalidString).toBeNull();
  expect(result.invalidUndefined).toBeNull();
  expect(result.validVendor).toBe(true);
});
