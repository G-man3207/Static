/* eslint-disable max-lines -- integration coverage is easier to maintain in one fixture-backed file */
const { expect, test } = require("./helpers/extension-fixture");
const { expectApiSurface, getApiSurface } = require("./helpers/api-surface");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const OTHER_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const probedUrl = (id = PROBED_ID, path = "/manifest.json") => `chrome-extension://${id}${path}`;

test("keeps wrapped API surfaces close to native browser methods", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  expectApiSurface(expect, await getApiSurface(page));
});

test("does not expose the private bridge handshake to page listeners", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/message-listener.html"));

  const observed = await page.evaluate(async (url) => {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    await fetch(url).catch(() => {});
    return {
      messages: window.staticMessages,
      bridgeEvents: window.staticBridgeEvents,
    };
  }, probedUrl());

  expect(observed).toEqual({
    messages: [],
    bridgeEvents: [],
  });

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(() => chrome.storage.local.get(["cumulative", "probe_log"]))
    )
    .toMatchObject({ cumulative: 1 });
});

test("ignores spoofed legacy public postMessage probe events", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  await page.evaluate((url) => {
    for (let i = 0; i < 25; i++) {
      window.postMessage({ __static_probe_blocked__: true, url }, "*");
    }
  }, probedUrl());
  await page.waitForTimeout(400);

  const storage = await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.get(["cumulative", "probe_log"])
  );
  expect(storage.cumulative).toBeUndefined();
  expect(storage.probe_log).toBeUndefined();
});

test("does not leak probe activity through page-owned console hooks", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const observed = await page.evaluate(async (url) => {
    const logs = [];
    console.debug = (...args) => logs.push(args.map(String).join(" "));
    await fetch(url).catch(() => {});
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    return logs;
  }, probedUrl());

  expect(observed).toEqual([]);
});

test("blocks broad extension URL vectors and accumulates per-origin ID counts", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const expectedCount = await page.evaluate(async (url) => {
    let count = 0;
    const tick = () => {
      count++;
    };

    await fetch(url).catch(() => {});
    tick();

    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.addEventListener("error", resolve, { once: true });
      xhr.addEventListener("loadend", resolve, { once: true });
      xhr.open("GET", url);
      xhr.send();
      setTimeout(resolve, 100);
    });
    tick();

    const img = new Image();
    img.src = url;
    tick();

    const script = document.createElement("script");
    script.src = url;
    tick();

    const link = document.createElement("link");
    link.href = url;
    tick();

    const frame = document.createElement("iframe");
    frame.src = url;
    tick();

    const object = document.createElement("object");
    object.data = url;
    tick();

    const attrImg = document.createElement("img");
    attrImg.setAttribute("src", url);
    tick();

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "use");
    svg.setAttributeNS("http://www.w3.org/1999/xlink", "href", url);
    tick();

    try {
      navigator.sendBeacon(url, "");
    } catch (error) {
      if (error.name !== "TypeError") throw error;
    }
    tick();

    try {
      new Worker(url);
    } catch (error) {
      if (error.name !== "SecurityError") throw error;
    }
    tick();

    if (typeof SharedWorker === "function") {
      try {
        new SharedWorker(url);
      } catch (error) {
        if (error.name !== "SecurityError") throw error;
      }
      tick();
    }

    new EventSource(url);
    tick();

    if (navigator.serviceWorker) {
      await navigator.serviceWorker.register(url).catch(() => {});
      tick();
    }

    return count;
  }, probedUrl());

  await page.waitForTimeout(400);
  const origin = new URL(page.url()).origin;
  const storage = await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.get(["cumulative", "probe_log"])
  );

  expect(storage.cumulative).toBe(expectedCount);
  const originLog = storage.probe_log[origin];
  expect(originLog.idCounts[PROBED_ID]).toBe(expectedCount);
  const playbookWeek = Object.values(originLog.playbook.weeks)[0];
  expect(playbookWeek.total).toBe(expectedCount);
  expect(playbookWeek.pathKindCounts.manifest).toBe(expectedCount);
  expect(playbookWeek.vectorCounts.fetch).toBe(1);
  expect(playbookWeek.vectorCounts.xhr).toBe(1);
  expect(playbookWeek.vectorCounts["img.src"]).toBe(1);
  expect(playbookWeek.vectorCounts.Worker).toBe(1);
  if (typeof SharedWorker === "function") {
    expect(playbookWeek.vectorCounts.SharedWorker).toBe(1);
  }
});

test("blocked XHR failures settle like native network failures", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(async (url) => {
    return await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const events = [];
      for (const name of ["readystatechange", "loadstart", "error", "loadend"]) {
        xhr.addEventListener(name, () => {
          events.push({
            name,
            readyState: xhr.readyState,
            status: xhr.status,
            responseURL: xhr.responseURL,
            responseText: xhr.responseText,
          });
        });
      }
      xhr.open("GET", url);
      xhr.send();
      setTimeout(() => {
        resolve({
          finalReadyState: xhr.readyState,
          finalStatus: xhr.status,
          finalResponseURL: xhr.responseURL,
          ownReadyState: Object.prototype.hasOwnProperty.call(xhr, "readyState"),
          ownResponse: Object.prototype.hasOwnProperty.call(xhr, "response"),
          ownResponseText: Object.prototype.hasOwnProperty.call(xhr, "responseText"),
          ownResponseURL: Object.prototype.hasOwnProperty.call(xhr, "responseURL"),
          ownStatus: Object.prototype.hasOwnProperty.call(xhr, "status"),
          events,
        });
      }, 100);
    });
  }, probedUrl());

  expect(result.finalReadyState).toBe(4);
  expect(result.finalStatus).toBe(0);
  expect(result.finalResponseURL).toBe("");
  expect(result.ownReadyState).toBe(false);
  expect(result.ownResponse).toBe(false);
  expect(result.ownResponseText).toBe(false);
  expect(result.ownResponseURL).toBe(false);
  expect(result.ownStatus).toBe(false);
  expect(result.events.map((event) => event.name)).toEqual([
    "readystatechange",
    "loadstart",
    "readystatechange",
    "error",
    "loadend",
  ]);
  expect(result.events.at(-1)).toMatchObject({
    readyState: 4,
    status: 0,
    responseURL: "",
    responseText: "",
  });
});

test("Noise mode decoys eligible fetch, XHR, and passive element probes", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  const origin = server.origin;

  await extension.serviceWorker.evaluate(
    ({ id, origin }) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [origin]: {
            idCounts: { [id]: 2 },
            lastUpdated: Date.now(),
          },
        },
        user_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    { id: PROBED_ID, origin }
  );

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const decoys = await page.evaluate(
    async ({ manifestUrl, imageUrl }) => {
      const response = await fetch(manifestUrl);
      const manifest = await response.json();

      const xhrResult = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("loadend", () => {
          resolve({
            status: xhr.status,
            contentType: xhr.getResponseHeader("content-type"),
            body: xhr.responseText,
          });
        });
        xhr.open("GET", manifestUrl);
        xhr.send();
      });

      const img = new Image();
      img.src = imageUrl;

      return {
        fetchStatus: response.status,
        fetchContentType: response.headers.get("content-type"),
        manifest,
        xhr: xhrResult,
        blockedImageSrc: img.getAttribute("src"),
        resolvedImageSrc: img.src,
      };
    },
    {
      manifestUrl: probedUrl(PROBED_ID, "/manifest.json"),
      imageUrl: probedUrl(PROBED_ID, "/icon.png"),
    }
  );

  expect(decoys.fetchStatus).toBe(200);
  expect(decoys.fetchContentType).toContain("application/json");
  expect(decoys.manifest).toMatchObject({
    manifest_version: 3,
    name: "Browser Extension",
    version: "1.0.0",
  });
  expect(decoys.xhr.status).toBe(200);
  expect(decoys.xhr.contentType).toContain("application/json");
  expect(JSON.parse(decoys.xhr.body)).toMatchObject({ name: "Browser Extension" });
  expect(decoys.blockedImageSrc).toBe(probedUrl(PROBED_ID, "/icon.png"));
  expect(decoys.resolvedImageSrc).toBe(probedUrl(PROBED_ID, "/icon.png"));
});

test("Noise mode does not decoy IDs below the minimum observed count", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(
    ({ id, origin }) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [origin]: {
            idCounts: { [id]: 1 },
            lastUpdated: Date.now(),
          },
        },
      }),
    { id: OTHER_ID, origin: server.origin }
  );

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(async (url) => {
    try {
      await fetch(url);
      return "resolved";
    } catch (error) {
      return error.name;
    }
  }, probedUrl(OTHER_ID));

  expect(result).toBe("TypeError");
});

test("Noise mode requires stronger evidence for unknown extension-shaped IDs", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(
    ({ id, origin }) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [origin]: {
            idCounts: { [id]: 2 },
            lastUpdated: Date.now(),
          },
        },
      }),
    { id: OTHER_ID, origin: server.origin }
  );

  const firstPage = await extension.context.newPage();
  await firstPage.goto(server.url("/blank.html"));
  await firstPage.waitForTimeout(300);
  const lowEvidence = await firstPage.evaluate(async (url) => {
    try {
      await fetch(url);
      return "resolved";
    } catch (error) {
      return error.name;
    }
  }, probedUrl(OTHER_ID));
  expect(lowEvidence).toBe("TypeError");

  await extension.serviceWorker.evaluate(
    ({ id, origin }) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [origin]: {
            idCounts: { [id]: 20 },
            lastUpdated: Date.now(),
          },
        },
      }),
    { id: OTHER_ID, origin: server.origin }
  );

  const secondPage = await extension.context.newPage();
  await secondPage.goto(server.url("/blank.html"));
  await secondPage.waitForTimeout(300);
  const highEvidence = await secondPage.evaluate(async (url) => {
    const response = await fetch(url);
    return response.status;
  }, probedUrl(OTHER_ID));
  expect(highEvidence).toBe(200);
});

test("Replay mask mode redacts replay listener values without breaking page handlers", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/replay.html"));
  await expect.poll(() => page.evaluate(() => Array.isArray(window.__replayRecords))).toBe(true);
  await page.waitForTimeout(300);
  await page.locator("#secret").fill("person@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__appValues.at(-1),
    replayValue: window.__replayRecords.filter((record) => record.type === "input").at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "person@example.com",
    replayValue: "redacted@example.invalid",
  });

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("replay_log").then(({ replay_log }) => {
            const entry = replay_log && replay_log[origin];
            return !!(entry && entry.total > 0);
          }),
        server.origin
      )
    )
    .toBe(true);
});

test("Replay noise mode jitters coordinates for replay listeners only", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "noise" }));

  await page.goto(server.url("/replay.html"));
  await expect.poll(() => page.evaluate(() => Array.isArray(window.__replayRecords))).toBe(true);
  await page.waitForTimeout(300);

  const observed = await page.evaluate(() => {
    window.__replayRecords.length = 0;
    window.__appMoves.length = 0;
    for (let i = 0; i < 12; i++) {
      document.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 100,
          clientY: 120,
          screenX: 100,
          screenY: 120,
        })
      );
    }
    return {
      appMoves: window.__appMoves,
      replayMoves: window.__replayRecords.filter((record) => record.type === "mousemove"),
    };
  });

  expect(observed.appMoves).toHaveLength(12);
  expect(observed.appMoves.every((move) => move.clientX === 100 && move.clientY === 120)).toBe(
    true
  );
  expect(observed.replayMoves).toHaveLength(12);
  expect(observed.replayMoves.some((move) => move.clientX !== 100 || move.clientY !== 120)).toBe(
    true
  );
});

test("Replay poisoning detects Sentry Replay bundle signatures", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/sentry-replay.html"));
  await expect
    .poll(() => page.evaluate(() => Array.isArray(window.__sentryReplayRecords)))
    .toBe(true);
  await page.waitForTimeout(300);
  await page.locator("#secret").fill("sentry@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__appValues.at(-1),
    replayValue: window.__sentryReplayRecords.filter((record) => record.type === "input").at(-1)
      .value,
  }));

  expect(observed).toEqual({
    appValue: "sentry@example.com",
    replayValue: "redacted@example.invalid",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  expect(Object.keys(replayLog.signals)).toContain(
    `listener-script:${server.url("/assets/sentry/bundle.tracing.replay.min.js")}`
  );
});

test("popup shows replay blocking and poisoning indicators", async ({ extension }) => {
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  const popupPage = await extension.context.newPage();
  await popupPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);

  await expect(popupPage.getByText("Replay vendor blocking on")).toBeVisible();
  await expect(popupPage.getByText("Mask poisoning armed")).toBeVisible();

  await popupPage.locator("#rs_session_replay").uncheck();
  await expect(popupPage.getByText("Replay vendor blocking on")).toHaveCount(0);

  await popupPage.locator("#replay-mode").selectOption("noise");
  await expect(popupPage.getByText("Noise poisoning armed")).toBeVisible();
});

test("Adaptive observe-only logging records multi-signal collectors without adding DNR rules", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-positive.html"));
  await expect.poll(() => page.evaluate(() => window.__adaptiveDone === true)).toBe(true);

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => {
            const entry = adaptive_log && adaptive_log[origin];
            return entry
              ? {
                  scoreMax: entry.scoreMax,
                  categories: entry.categories,
                  reasons: entry.reasons,
                }
              : null;
          }),
        server.origin
      )
    )
    .toMatchObject({
      scoreMax: expect.any(Number),
      categories: { "anti-bot": 1 },
      reasons: expect.objectContaining({
        canvas: expect.any(Number),
        navigator: expect.any(Number),
        crypto: expect.any(Number),
        network: expect.any(Number),
      }),
    });

  const dynamicRules = await extension.serviceWorker.evaluate(() =>
    chrome.declarativeNetRequest.getDynamicRules()
  );
  const sessionRules = await extension.serviceWorker.evaluate(() =>
    chrome.declarativeNetRequest.getSessionRules()
  );
  expect(dynamicRules).toEqual([]);
  expect(sessionRules).toEqual([]);
});

test("Adaptive observe-only logging ignores canvas-heavy apps without corroborating signals", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-canvas-app.html"));
  await expect.poll(() => page.evaluate(() => window.__canvasAppDone === true)).toBe(true);
  await page.waitForTimeout(400);

  const storage = await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.get("adaptive_log")
  );
  expect(storage.adaptive_log).toBeUndefined();
});

test("Adaptive runtime detection logs proxied vendor signatures without behavior scoring", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-signatures.html"));
  await expect.poll(() => page.evaluate(() => window.__adaptiveVendorDone === true)).toBe(true);

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => adaptive_log[origin]),
        server.origin
      )
    )
    .toMatchObject({
      categories: {
        "anti-bot": 2,
        fingerprinting: 2,
      },
      endpoints: expect.objectContaining({
        [`${server.origin}/fp/result`]: 1,
        [`${server.origin}/px/collector`]: 1,
        [`${server.origin}/tags.js`]: 1,
      }),
      reasons: expect.objectContaining({
        "vendor:DataDome": 1,
        "vendor:FingerprintJS": 1,
        "vendor:HUMAN": 1,
        "vendor:Sift": 1,
      }),
      scoreMax: 9,
    });

  const dynamicRules = await extension.serviceWorker.evaluate(() =>
    chrome.declarativeNetRequest.getDynamicRules()
  );
  const sessionRules = await extension.serviceWorker.evaluate(() =>
    chrome.declarativeNetRequest.getSessionRules()
  );
  expect(dynamicRules).toEqual([]);
  expect(sessionRules).toEqual([]);
});

test("Adaptive runtime detection ignores partial vendor lookalikes", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-benign.html"));
  await expect.poll(() => page.evaluate(() => window.__adaptiveVendorBenignDone === true)).toBe(
    true
  );
  await page.waitForTimeout(500);

  const storage = await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.get("adaptive_log")
  );
  expect(storage.adaptive_log).toBeUndefined();
});

test("Adaptive behavior logging attributes external collector bundles by script source", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-module-runtime.html"));
  await expect.poll(() => page.evaluate(() => window.__adaptiveModuleDone === true)).toBe(true);

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => adaptive_log[origin]),
        server.origin
      )
    )
    .toMatchObject({
      categories: { fingerprinting: 1 },
      endpoints: expect.objectContaining({
        [`${server.origin}/module-collect`]: 1,
      }),
      sources: expect.objectContaining({
        [`${server.origin}/assets/:token.js`]: expect.any(Number),
      }),
    });

  const adaptiveEntry = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => adaptive_log[origin]);
  }, server.origin);

  expect(adaptiveEntry.reasons).toEqual(
    expect.objectContaining({
      canvas: expect.any(Number),
      navigator: expect.any(Number),
      network: expect.any(Number),
    })
  );
  const serialized = JSON.stringify(adaptiveEntry);
  expect(serialized).not.toContain("collector-1234567890abcdef1234567890abcdef.js");
  expect(serialized).not.toContain("secret-token");
});

test("Adaptive behavior logging attributes dynamic module collectors by redacted blob source", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-dynamic-import.html"));
  await expect.poll(() => page.evaluate(() => window.__adaptiveDynamicDone === true)).toBe(true);

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => adaptive_log[origin]),
        server.origin
      )
    )
    .toMatchObject({
      categories: { fingerprinting: 1 },
      endpoints: expect.objectContaining({
        [`${server.origin}/dynamic-collect`]: 1,
      }),
      sources: expect.objectContaining({
        [`${server.origin}/:uuid`]: expect.any(Number),
      }),
    });

  const adaptiveEntry = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => adaptive_log[origin]);
  }, server.origin);

  expect(adaptiveEntry.reasons).toEqual(
    expect.objectContaining({
      canvas: expect.any(Number),
      navigator: expect.any(Number),
      network: expect.any(Number),
    })
  );
  expect(adaptiveEntry.sources["inline-or-runtime"]).toBeUndefined();
  expect(JSON.stringify(adaptiveEntry)).not.toContain("blob:");
});

test("Adaptive behavior logging falls back to runtime labels when async collectors have no URL source", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-fallback.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveRuntimeFallbackDone === true))
    .toBe(true);

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => adaptive_log[origin]),
        server.origin
      )
    )
    .toMatchObject({
      categories: { fingerprinting: 1 },
      endpoints: expect.objectContaining({
        [`${server.origin}/runtime-collect`]: 1,
      }),
      sources: expect.objectContaining({
        "runtime:settimeout": expect.any(Number),
      }),
    });

  const adaptiveEntry = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => adaptive_log[origin]);
  }, server.origin);

  expect(adaptiveEntry.reasons).toEqual(
    expect.objectContaining({
      canvas: expect.any(Number),
      navigator: expect.any(Number),
      network: expect.any(Number),
    })
  );
  expect(adaptiveEntry.sources["inline-or-runtime"]).toBeUndefined();
});

test("blocked EventSource probes keep EventSource shape while failing closed", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(
    async (url) => {
      const source = new EventSource(url);
      const initial = {
        instance: source instanceof EventSource,
        prototype: Object.getPrototypeOf(source) === EventSource.prototype,
        ownReadyState: Object.prototype.hasOwnProperty.call(source, "readyState"),
        ownUrl: Object.prototype.hasOwnProperty.call(source, "url"),
        readyState: source.readyState,
        url: source.url,
      };
      let onerrorThisIsSource = false;
      let listenerErrors = 0;
      let listenerThisIsSource = false;
      let listenerTargetIsSource = false;
      source.onerror = function () {
        onerrorThisIsSource = this === source;
      };
      source.addEventListener("error", function (event) {
        listenerErrors++;
        listenerThisIsSource = this === source;
        listenerTargetIsSource = event.target === source;
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      return {
        ...initial,
        finalReadyState: source.readyState,
        listenerErrors,
        listenerThisIsSource,
        listenerTargetIsSource,
        onerrorThisIsSource,
      };
    },
    probedUrl(PROBED_ID, "/events")
  );

  expect(result).toEqual({
    instance: true,
    prototype: true,
    ownReadyState: false,
    ownUrl: false,
    readyState: 0,
    url: probedUrl(PROBED_ID, "/events"),
    finalReadyState: 2,
    listenerErrors: 1,
    listenerThisIsSource: true,
    listenerTargetIsSource: true,
    onerrorThisIsSource: true,
  });
});

test("log viewer shows playbook drift indicators and reasons", async ({ extension }) => {
  const baselineIds = {};
  const currentIds = {};
  for (let i = 0; i < 12; i++) baselineIds[`base${i}`] = 3;
  for (let i = 0; i < 8; i++) currentIds[`new${i}`] = 3;
  for (let i = 0; i < 10; i++) currentIds[`canary${i}`] = 1;

  await extension.serviceWorker.evaluate(
    ({ baselineIds, currentIds }) =>
      chrome.storage.local.set({
        cumulative: 120,
        probe_log: {
          "https://drift.test": {
            idCounts: { ...baselineIds, ...currentIds },
            lastUpdated: Date.now(),
            playbook: {
              weeks: {
                "2026-W14": {
                  total: 60,
                  vectorCounts: { fetch: 60 },
                  pathKindCounts: { manifest: 60 },
                  idCounts: baselineIds,
                  firstSeen: 1,
                  lastSeen: 2,
                },
                "2026-W15": {
                  total: 60,
                  vectorCounts: { fetch: 20, Worker: 20, EventSource: 20 },
                  pathKindCounts: { image: 30, script: 30 },
                  idCounts: currentIds,
                  firstSeen: 3,
                  lastSeen: 4,
                },
              },
            },
          },
        },
      }),
    { baselineIds, currentIds }
  );

  const logPage = await extension.context.newPage();
  await logPage.goto(`chrome-extension://${extension.extensionId}/log.html`);
  await expect(logPage.getByText("High drift")).toBeVisible();
  await logPage.getByText("https://drift.test").click();
  await expect(logPage.getByText("New probe vectors appeared: EventSource, Worker.")).toBeVisible();
  await expect(logPage.getByText("New path kinds appeared: image, script.")).toBeVisible();
  await expect(logPage.getByText(/One-shot ID pressure is high/)).toBeVisible();
  await expect(logPage.getByText("Probe playbook")).toBeVisible();
  await expect(logPage.getByText(/EventSource 20/)).toBeVisible();
  await expect(logPage.getByText(/Worker 20/)).toBeVisible();
  await expect(logPage.getByText(/fetch 20/)).toBeVisible();
  await expect(logPage.getByText("image 30, script 30")).toBeVisible();
});

test("log viewer shows local Noise readiness diagnostics", async ({ extension }) => {
  const knownOne = "nngceckbapebfimnlniiiahkandclblb";
  const knownTwo = "cjpalhdlnbpafiamejdnhcphjbkeiagm";
  const unknown = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await extension.serviceWorker.evaluate(
    ({ knownOne, knownTwo, unknown }) =>
      chrome.storage.local.set({
        probe_log: {
          "https://noise.test": {
            idCounts: {
              [knownOne]: 2,
              [knownTwo]: 4,
              [unknown]: 20,
              bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 1,
            },
            lastUpdated: Date.now(),
          },
        },
      }),
    { knownOne, knownTwo, unknown }
  );

  const logPage = await extension.context.newPage();
  await logPage.goto(`chrome-extension://${extension.extensionId}/log.html`);
  await logPage.getByText("https://noise.test").click();
  await expect(logPage.getByText("Noise readiness")).toBeVisible();
  await expect(logPage.getByText("3 IDs (2 known-list, 1 repeated unknown)")).toBeVisible();
  await expect(
    logPage.getByText("known IDs need 2 probes; unknown IDs need 20 probes")
  ).toBeVisible();
  await expect(logPage.getByText(/1 one-shot IDs out of 4 unique/)).toBeVisible();
  await expect(logPage.locator(".id-entry span").getByText(unknown, { exact: true })).toBeVisible();
});

test("scrubs extension DOM markers on initial parse and later mutations", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/dom.html"));
  await expect.poll(() => page.locator("grammarly-card").count()).toBe(0);

  const initial = await page.evaluate(() => {
    const target = document.getElementById("target");
    return {
      dataGrammarly: target.hasAttribute("data-grammarly-extension"),
      dataLastpass: target.hasAttribute("data-lastpass-root"),
      classes: [...target.classList],
    };
  });
  expect(initial.dataGrammarly).toBe(false);
  expect(initial.dataLastpass).toBe(false);
  expect(initial.classes).toEqual(["keep"]);

  const later = await page.evaluate(async () => {
    const node = document.createElement("div");
    node.id = "later";
    node.className = "keep dashlane-panel onepassword-pill";
    node.setAttribute("data-dashlanecreated", "1");
    document.body.appendChild(node);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    return {
      dataDashlane: node.hasAttribute("data-dashlanecreated"),
      classes: [...node.classList],
    };
  });
  expect(later.dataDashlane).toBe(false);
  expect(later.classes).toEqual(["keep"]);
});

test("Clear log removes probe state and Noise identity while preserving preferences", async ({
  extension,
}) => {
  await extension.serviceWorker.evaluate(
    ({ id }) =>
      chrome.storage.local.set({
        cumulative: 42,
        noise_enabled: true,
        replay_mode: "chaos",
        replay_log: {
          "https://example.test": {
            total: 2,
            signals: { "global:LogRocket": 2 },
            lastUpdated: Date.now(),
          },
        },
        adaptive_log: {
          "https://example.test": {
            total: 1,
            scoreMax: 9,
            categories: { "anti-bot": 1 },
            reasons: { canvas: 1, crypto: 1, network: 1 },
            endpoints: { "https://example.test/collect": 1 },
            sources: { "inline-or-runtime": 1 },
            lastUpdated: Date.now(),
          },
        },
        user_secret: "secret",
        probe_log: {
          "https://example.test": {
            idCounts: { [id]: 3 },
            lastUpdated: Date.now(),
          },
        },
      }),
    { id: PROBED_ID }
  );

  const logPage = await extension.context.newPage();
  logPage.on("dialog", (dialog) => dialog.accept());
  await logPage.goto(`chrome-extension://${extension.extensionId}/log.html`);
  await logPage.getByRole("button", { name: "Clear log" }).click();

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(() =>
        chrome.storage.local.get([
          "cumulative",
          "noise_enabled",
          "replay_mode",
          "probe_log",
          "replay_log",
          "adaptive_log",
          "user_secret",
        ])
      )
    )
    .toEqual({ noise_enabled: true, replay_mode: "chaos" });
});
