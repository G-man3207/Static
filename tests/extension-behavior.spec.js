/* eslint-disable max-lines -- integration coverage is easier to maintain in one fixture-backed file */
const http = require("http");
const { expect, test } = require("./helpers/extension-fixture");
const { expectApiSurface, getApiSurface } = require("./helpers/api-surface");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const OTHER_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const probedUrl = (id = PROBED_ID, path = "/manifest.json") => `chrome-extension://${id}${path}`;

async function startHeaderFixtureServer({ body = "ok", headers = {}, status = 200 } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      ...headers,
    });
    res.end(body);
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    url(path = "/") {
      return `${this.origin}${path}`;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

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

test("filters unsupported iframe allow tokens without browser console warnings", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(100);

  const messages = [];
  const onConsole = (msg) => messages.push({ type: msg.type(), text: msg.text() });
  page.on("console", onConsole);

  try {
    const result = await page.evaluate(() => {
      const supported = new Set(
        typeof document.featurePolicy?.allowedFeatures === "function"
          ? document.featurePolicy.allowedFeatures()
          : []
      );
      const tokens = ["fullscreen", "web-share", "speaker", "downloads", "totally-made-up-feature"];
      const iframe = document.createElement("iframe");
      iframe.setAttribute("allow", tokens.join("; "));
      return {
        allow: iframe.getAttribute("allow"),
        expected: tokens.filter((token) => supported.has(token)).join("; "),
      };
    });
    await page.waitForTimeout(100);

    expect(result.allow).toBe(result.expected);
    expect(messages.filter((message) => /Unrecognized feature:/.test(message.text))).toEqual([]);
  } finally {
    page.off("console", onConsole);
  }
});

test("normalizes iframe sandbox and legacy permission attributes without console noise", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(100);

  const messages = [];
  const onConsole = (msg) => messages.push({ type: msg.type(), text: msg.text() });
  page.on("console", onConsole);

  try {
    const result = await page.evaluate(() => {
      const supported = new Set(
        typeof document.featurePolicy?.allowedFeatures === "function"
          ? document.featurePolicy.allowedFeatures()
          : []
      );
      const expectedAllow = ["fullscreen", "payment"]
        .filter((token) => supported.has(token))
        .join("; ");

      const sandbox = document.createElement("iframe");
      sandbox.setAttribute(
        "sandbox",
        "allow-scripts allow-downloads-without-user-activation allow-downloads"
      );

      const sandboxProp = document.createElement("iframe");
      sandboxProp.sandbox = "allow-scripts allow-downloads-without-user-activation";

      const sandboxTokenAdd = document.createElement("iframe");
      sandboxTokenAdd.sandbox.add("allow-downloads-without-user-activation", "allow-scripts");

      const sandboxTokenValue = document.createElement("iframe");
      sandboxTokenValue.sandbox.value = "allow-scripts allow-downloads-without-user-activation";

      const legacy = document.createElement("iframe");
      legacy.setAttribute("allowfullscreen", "");
      legacy.setAttribute("allowpaymentrequest", "");
      legacy.setAttribute("allow", "fullscreen; payment; totally-made-up-feature");
      document.body.appendChild(legacy);

      const host = document.createElement("div");
      host.innerHTML = `<iframe sandbox="allow-scripts allow-downloads-without-user-activation" allowfullscreen allowpaymentrequest allow="fullscreen; payment; fake-feature"></iframe>`;
      document.body.appendChild(host);
      const markup = host.querySelector("iframe");

      return {
        expectedAllow,
        legacy: {
          allow: legacy.getAttribute("allow"),
          allowFullscreen: legacy.hasAttribute("allowfullscreen"),
          allowPaymentRequest: legacy.hasAttribute("allowpaymentrequest"),
        },
        markup: {
          allow: markup.getAttribute("allow"),
          allowFullscreen: markup.hasAttribute("allowfullscreen"),
          allowPaymentRequest: markup.hasAttribute("allowpaymentrequest"),
          sandbox: markup.getAttribute("sandbox"),
        },
        sandbox: sandbox.getAttribute("sandbox"),
        sandboxProp: sandboxProp.getAttribute("sandbox"),
        sandboxTokenAdd: sandboxTokenAdd.getAttribute("sandbox"),
        sandboxTokenValue: sandboxTokenValue.getAttribute("sandbox"),
      };
    });
    await page.waitForTimeout(100);

    expect(result).toEqual({
      expectedAllow: result.expectedAllow,
      legacy: {
        allow: result.expectedAllow,
        allowFullscreen: false,
        allowPaymentRequest: false,
      },
      markup: {
        allow: result.expectedAllow,
        allowFullscreen: false,
        allowPaymentRequest: false,
        sandbox: "allow-scripts",
      },
      sandbox: "allow-scripts allow-downloads",
      sandboxProp: "allow-scripts",
      sandboxTokenAdd: "allow-scripts",
      sandboxTokenValue: "allow-scripts",
    });
    expect(
      messages.filter((message) =>
        /invalid sandbox flag|allowfullscreen|allowpaymentrequest|Unrecognized feature/i.test(
          message.text
        )
      )
    ).toEqual([]);
  } finally {
    page.off("console", onConsole);
  }
});

test("uses TrustedScriptURL-compatible script decoys on Trusted Types pages", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  const messages = [];
  const onConsole = (msg) => messages.push({ type: msg.type(), text: msg.text() });
  page.on("console", onConsole);

  try {
    await page.goto(server.url("/trusted-types.html"));
    await page.waitForTimeout(100);

    const result = await page.evaluate(
      (url) => {
        const assignProperty = document.createElement("script");
        const setAttribute = document.createElement("script");
        const outcomes = {};

        try {
          assignProperty.src = url;
          outcomes.property = {
            attr: assignProperty.getAttribute("src"),
            ok: true,
            src: assignProperty.src,
          };
        } catch (error) {
          outcomes.property = { message: error.message, name: error.name, ok: false };
        }

        try {
          setAttribute.setAttribute("src", url);
          outcomes.attribute = {
            attr: setAttribute.getAttribute("src"),
            ok: true,
            src: setAttribute.src,
          };
        } catch (error) {
          outcomes.attribute = { message: error.message, name: error.name, ok: false };
        }

        return outcomes;
      },
      probedUrl(PROBED_ID, "/content.js")
    );
    await page.waitForTimeout(100);

    expect(result).toEqual({
      attribute: {
        attr: probedUrl(PROBED_ID, "/content.js"),
        ok: true,
        src: probedUrl(PROBED_ID, "/content.js"),
      },
      property: {
        attr: probedUrl(PROBED_ID, "/content.js"),
        ok: true,
        src: probedUrl(PROBED_ID, "/content.js"),
      },
    });
    expect(messages.filter((message) => /TrustedScriptURL assignment/i.test(message.text))).toEqual(
      []
    );
  } finally {
    page.off("console", onConsole);
  }
});

test("suppresses unsafe-header console errors while preserving exposed XHR headers", async ({
  extension,
  server,
}) => {
  const apiServer = await startHeaderFixtureServer({
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "X-Visible-Digest",
      "x-digest-sha256": "abc",
      "x-digest-sha256-hmac": "def",
      "x-visible-digest": "visible",
    },
  });
  const page = await extension.context.newPage();

  try {
    await page.goto(server.url("/blank.html"));
    await page.waitForTimeout(100);

    const messages = [];
    const onConsole = (msg) => messages.push({ type: msg.type(), text: msg.text() });
    page.on("console", onConsole);

    try {
      const result = await page.evaluate(async (url) => {
        return await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.addEventListener("loadend", () => {
            resolve({
              allHeaders: xhr.getAllResponseHeaders(),
              digest: xhr.getResponseHeader("X-Digest-Sha256"),
              digestHmac: xhr.getResponseHeader("X-Digest-Sha256-Hmac"),
              visibleDigest: xhr.getResponseHeader("X-Visible-Digest"),
            });
          });
          xhr.open("GET", url);
          xhr.send();
        });
      }, apiServer.url("/digest.txt"));
      await page.waitForTimeout(100);

      expect(result).toMatchObject({
        digest: null,
        digestHmac: null,
        visibleDigest: "visible",
      });
      expect(result.allHeaders).toContain("x-visible-digest: visible");
      expect(
        messages.filter((message) => /Refused to get unsafe header/.test(message.text))
      ).toEqual([]);
    } finally {
      page.off("console", onConsole);
    }
  } finally {
    await page.close();
    await apiServer.close();
  }
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

const openPopupAdvancedControls = async (popupPage) => {
  await popupPage.locator("#advanced-controls > summary").click();
  await expect(popupPage.locator("#advanced-controls")).toHaveAttribute("open", "");
};

test("popup keeps detailed controls folded by default", async ({ extension }) => {
  const popupPage = await extension.context.newPage();
  await popupPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);

  await expect(popupPage.locator("#count")).toBeVisible();
  await expect(popupPage.getByText("probes blocked on this tab")).toBeVisible();
  await expect(popupPage.locator("#advanced-controls")).not.toHaveAttribute("open", /.*/);
  await expect(popupPage.locator("#advanced-controls > summary")).toContainText("More");
  await expect(popupPage.getByRole("heading", { name: "Always on" })).toBeHidden();
  await expect(popupPage.locator("#noise-title-text")).toBeHidden();
  await expect(popupPage.locator("#diagnostics-title-text")).toBeHidden();
  await expect(popupPage.locator("#rulesets")).toBeHidden();
  await expect(popupPage.getByText("Power diagnostics")).toBeHidden();

  await openPopupAdvancedControls(popupPage);

  await expect(popupPage.getByRole("heading", { name: "Always on" })).toBeVisible();
  await expect(popupPage.locator("#noise-title-text")).toBeVisible();
  await expect(popupPage.locator("#diagnostics-title-text")).toBeVisible();
  await expect(popupPage.locator("#rulesets")).toBeVisible();
  await expect(popupPage.getByText("Power diagnostics")).toBeVisible();
});

test("popup toggles QA diagnostics mode", async ({ extension }) => {
  const popupPage = await extension.context.newPage();
  await popupPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  await openPopupAdvancedControls(popupPage);

  await expect(popupPage.locator("#diagnostics-toggle")).not.toBeChecked();
  await popupPage.locator("#diagnostics-toggle").evaluate((input) => input.click());
  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(() => chrome.storage.local.get("diagnostics_mode"))
    )
    .toEqual({ diagnostics_mode: true });

  await popupPage.locator("#diagnostics-toggle").evaluate((input) => input.click());
  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(() => chrome.storage.local.get("diagnostics_mode"))
    )
    .toEqual({ diagnostics_mode: false });
});

test("popup shows replay blocking and poisoning indicators", async ({ extension }) => {
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  const popupPage = await extension.context.newPage();
  await popupPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  await openPopupAdvancedControls(popupPage);

  await expect(popupPage.getByText("Replay vendor blocking on")).toBeVisible();
  await expect(popupPage.getByText("Mask poisoning armed")).toBeVisible();

  await popupPage.locator("#rs_session_replay").uncheck();
  await expect(popupPage.getByText("Replay vendor blocking on")).toHaveCount(0);

  await popupPage.locator("#replay-mode").selectOption("noise");
  await expect(popupPage.getByText("Noise poisoning armed")).toBeVisible();
});

test("popup frames core defenses and groups network protections", async ({ extension }) => {
  const popupPage = await extension.context.newPage();
  await popupPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  await openPopupAdvancedControls(popupPage);

  await expect(popupPage.getByRole("heading", { name: "Always on" })).toBeVisible();
  await expect(popupPage.getByText("Extension probes")).toBeVisible();
  await expect(popupPage.getByText("DOM markers")).toBeVisible();
  await expect(popupPage.getByText("Extension globals")).toBeVisible();

  await expect(popupPage.getByRole("heading", { name: "Network protections" })).toBeVisible();
  await expect(popupPage.locator(".ruleset-group-title")).toHaveText([
    "Site telemetry",
    "Fingerprinting and access checks",
    "Replay and monitoring",
  ]);
  await expect(popupPage.locator(".ruleset-group").nth(0)).toContainText("LinkedIn telemetry");
  await expect(popupPage.locator(".ruleset-group").nth(1)).toContainText(
    "Fingerprinting and anti-bot"
  );
  await expect(popupPage.locator(".ruleset-group").nth(1)).toContainText(
    "CAPTCHA and device checks"
  );
  await expect(popupPage.locator(".ruleset-group").nth(2)).toContainText(
    "Session replay recorders"
  );
  await expect(popupPage.locator(".ruleset-group").nth(2)).toContainText(
    "Datadog browser monitoring"
  );
});

test("popup exposes local help text for privacy controls", async ({ extension }) => {
  const popupPage = await extension.context.newPage();
  await popupPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  await openPopupAdvancedControls(popupPage);

  await expect(popupPage.locator("#noise-toggle")).toHaveAttribute(
    "aria-labelledby",
    "noise-title-text"
  );
  await expect(popupPage.locator("#noise-toggle")).toHaveAttribute(
    "aria-describedby",
    "noise-desc"
  );
  await expect(popupPage.locator("#noise-help")).toHaveAttribute("data-tip", /local probe history/);
  await expect(popupPage.locator("#noise-help")).toHaveAttribute(
    "aria-describedby",
    "noise-help-text"
  );
  await expect(popupPage.locator("#noise-help")).not.toHaveAttribute("title", /.*/);
  await expect(popupPage.locator("#diagnostics-toggle")).toHaveAttribute(
    "aria-labelledby",
    "diagnostics-title-text"
  );
  await expect(popupPage.locator("#diagnostics-toggle")).toHaveAttribute(
    "aria-describedby",
    "diagnostics-desc"
  );
  await expect(popupPage.locator("#diagnostics-help")).toHaveAttribute(
    "data-tip",
    /compatibility testing/
  );
  await expect(popupPage.locator("#diagnostics-help")).toHaveAttribute(
    "aria-describedby",
    "diagnostics-help-text"
  );
  await expect(popupPage.locator("#diagnostics-help")).not.toHaveAttribute("title", /.*/);
  await expect(popupPage.locator("#fingerprint-mode")).toHaveAttribute(
    "aria-labelledby",
    "fingerprint-title-text"
  );
  await expect(popupPage.locator("#fingerprint-mode")).toHaveAttribute(
    "aria-describedby",
    "fingerprint-desc"
  );
  await expect(popupPage.locator("#fingerprint-help")).toHaveAttribute(
    "data-tip",
    /Signal guide surfaces/
  );
  await expect(popupPage.locator("#fingerprint-help")).toHaveAttribute(
    "aria-describedby",
    "fingerprint-help-text"
  );
  await expect(popupPage.locator("#fingerprint-help")).not.toHaveAttribute("title", /.*/);
  await expect(popupPage.locator("#replay-mode")).toHaveAttribute(
    "aria-labelledby",
    "replay-title-text"
  );
  await expect(popupPage.locator("#replay-mode")).toHaveAttribute(
    "aria-describedby",
    "replay-desc"
  );
  await expect(popupPage.locator("#replay-help")).toHaveAttribute(
    "data-tip",
    /likely recorder listeners/
  );
  await expect(popupPage.locator("#replay-help")).toHaveAttribute(
    "aria-describedby",
    "replay-help-text"
  );
  await expect(popupPage.locator("#replay-help")).not.toHaveAttribute("title", /.*/);
  await expect(popupPage.locator("#rulesets-help")).toHaveAttribute(
    "data-tip",
    /declarative rulesets/
  );
  await expect(popupPage.locator("#rulesets-help")).toHaveAttribute(
    "aria-describedby",
    "rulesets-help-text"
  );
  await expect(popupPage.locator("#rulesets-help")).not.toHaveAttribute("title", /.*/);
  await expect(popupPage.locator("#rs_fingerprint_vendors")).toHaveAttribute(
    "aria-describedby",
    "rs_fingerprint_vendors_help_text"
  );
  await expect(popupPage.locator("#rs_fingerprint_vendors_help")).toHaveAttribute(
    "data-tip",
    /fingerprinting and anti-bot vendor endpoints/
  );
  await expect(popupPage.locator("#rs_fingerprint_vendors_help")).not.toHaveAttribute(
    "title",
    /.*/
  );
  await expect(popupPage.locator("#rs_fingerprint_vendors")).not.toHaveAttribute("title", /.*/);
  await expect(popupPage.locator("label[for='rs_fingerprint_vendors']")).not.toHaveAttribute(
    "title",
    /.*/
  );
});

test("popup help tooltips stay inside the visible popup bounds", async ({ extension }) => {
  const popupPage = await extension.context.newPage();
  await popupPage.setViewportSize({ width: 320, height: 460 });
  await popupPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  await openPopupAdvancedControls(popupPage);
  await expect(popupPage.locator("#rs_datadog_rum_help")).toBeVisible();

  const helpTips = popupPage.locator(".help-tip");
  const helpTipCount = await helpTips.count();
  expect(helpTipCount).toBeGreaterThan(0);

  for (let i = 0; i < helpTipCount; i++) {
    const helpTip = helpTips.nth(i);
    await helpTip.scrollIntoViewIfNeeded();
    await helpTip.focus();

    const popover = popupPage.locator("#help-tip-popover");
    await expect(popover).toBeVisible();

    const bounds = await popover.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      };
    });
    const viewport = await popupPage.evaluate(() => ({
      height: window.innerHeight,
      width: window.innerWidth,
    }));

    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(viewport.width);
    expect(bounds.bottom).toBeLessThanOrEqual(viewport.height);
  }
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

test("Adaptive observe-only logging records environment snapshot telemetry with crypto and network", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-environment-fingerprint.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveEnvironmentDone === true))
    .toBe(true);

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => {
            const entry = adaptive_log && adaptive_log[origin];
            return entry
              ? {
                  categories: entry.categories,
                  reasons: entry.reasons,
                  scoreMax: entry.scoreMax,
                }
              : null;
          }),
        server.origin
      )
    )
    .toMatchObject({
      categories: { "anti-bot": 1 },
      reasons: expect.objectContaining({
        crypto: expect.any(Number),
        environment: expect.any(Number),
        navigator: expect.any(Number),
        network: expect.any(Number),
      }),
      scoreMax: expect.any(Number),
    });
});

test("Adaptive observe-only logging records WebSocket network corroboration", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  const surface = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 8, 8);
    canvas.toDataURL();
    void navigator.hardwareConcurrency;
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("persistent-transport"));

    const endpoint = `${location.origin.replace(
      /^http/,
      "ws"
    )}/socket/user-1234567890abcdef1234567890abcdef`;
    try {
      const socket = new WebSocket(endpoint);
      socket.addEventListener("error", () => {});
      setTimeout(() => socket.close(), 0);
    } catch {}

    return {
      constants: [WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED],
      name: WebSocket.name,
      toString: Function.prototype.toString.call(WebSocket),
    };
  });
  expect(surface).toEqual({
    constants: [0, 1, 2, 3],
    name: "WebSocket",
    toString: "function WebSocket() { [native code] }",
  });

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => {
            const entry = adaptive_log && adaptive_log[origin];
            return entry
              ? {
                  categories: entry.categories,
                  endpoints: entry.endpoints,
                  reasons: entry.reasons,
                  scoreMax: entry.scoreMax,
                }
              : null;
          }),
        server.origin
      )
    )
    .toMatchObject({
      categories: { "anti-bot": 1 },
      endpoints: expect.objectContaining({
        [`${server.origin.replace(/^http/, "ws")}/socket/:token`]: 1,
      }),
      reasons: expect.objectContaining({
        "WebSocket:0": 1,
        canvas: expect.any(Number),
        crypto: expect.any(Number),
        navigator: expect.any(Number),
        network: expect.any(Number),
      }),
      scoreMax: expect.any(Number),
    });
});

test("Adaptive observe-only logging ignores ordinary environment reads with network only", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-environment-app.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveEnvironmentAppDone === true))
    .toBe(true);
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
        [`${server.origin}/js/`]: 1,
      }),
      reasons: expect.objectContaining({
        "vendor:DataDome": 1,
        "vendor:Fingerprint": 1,
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

test("Adaptive runtime detection recognizes Fingerprint v4 start endpoints", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-signatures-fingerprint-v4.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveVendorFingerprintV4Done === true))
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
      categories: {
        fingerprinting: 1,
      },
      endpoints: expect.objectContaining({
        [`${server.origin}/fp/v4`]: 1,
      }),
      reasons: expect.objectContaining({
        "api:start": 1,
        "config:apiKey": 1,
        "config:endpoints": 1,
        "vendor:Fingerprint": 1,
      }),
      scoreMax: 9,
    });
});

test("Adaptive runtime detection recognizes versioned first-party DataDome routes", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-signatures-versioned-datadome.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveVendorVersionedDatadomeDone === true))
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
      categories: {
        "anti-bot": 1,
      },
      endpoints: expect.objectContaining({
        [`${server.origin}/js/`]: 1,
      }),
      reasons: expect.objectContaining({
        "config:endpoint": 1,
        "global:ddjskey": 1,
        "script:tags.js": 1,
        "vendor:DataDome": 1,
      }),
      scoreMax: 9,
      sources: expect.objectContaining({
        [`${server.origin}/v5.1.13/tags.js`]: 1,
      }),
    });
});

test("Adaptive runtime detection recognizes custom DataDome tag paths with explicit endpoints", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-signatures-custom-datadome.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveVendorCustomDatadomeDone === true))
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
      categories: {
        "anti-bot": 1,
      },
      endpoints: expect.objectContaining({
        [`${server.origin}/dd/custom-js/`]: 1,
      }),
      reasons: expect.objectContaining({
        "config:endpoint": 1,
        "global:ddjskey": 1,
        "global:ddoptions": 1,
        "script:custom-path": 1,
        "vendor:DataDome": 1,
      }),
      scoreMax: 9,
      sources: expect.objectContaining({
        [`${server.origin}/assets/datadome-tag.js`]: 1,
      }),
    });
});

test("Adaptive runtime detection recognizes HUMAN default first-party sensor routes", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-signatures-human-first-party.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveVendorHumanFirstPartyDone === true))
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
      categories: {
        "anti-bot": 1,
      },
      endpoints: expect.objectContaining({
        [`${server.origin}/:num/init.js`]: 1,
      }),
      reasons: expect.objectContaining({
        "global:_pxAppId": 1,
        "script:init.js": 1,
        "vendor:HUMAN": 1,
      }),
      scoreMax: 9,
      sources: expect.objectContaining({
        [`${server.origin}/:num/init.js`]: 1,
      }),
    });
});

test("Adaptive runtime detection recognizes HUMAN custom first-party prefixes", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-signatures-human-custom-prefix.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveVendorHumanCustomPrefixDone === true))
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
      categories: {
        "anti-bot": 1,
      },
      endpoints: expect.objectContaining({
        [`${server.origin}/botdefense/xhr/`]: 1,
      }),
      reasons: expect.objectContaining({
        "global:_pxAppId": 1,
        "global:_pxHostUrl": 1,
        "script:prefix-init.js": 1,
        "vendor:HUMAN": 1,
      }),
      scoreMax: 9,
      sources: expect.objectContaining({
        [`${server.origin}/botdefense/init.js`]: 1,
      }),
    });
});

test("Adaptive runtime detection recognizes HUMAN ABR custom sensor endpoints from exact globals", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-signatures-human-abr-custom-endpoint.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveVendorHumanAbrDone === true))
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
      categories: {
        "anti-bot": 1,
      },
      endpoints: expect.objectContaining({
        [`${server.origin}/abr-shield/xhr/`]: 1,
      }),
      reasons: expect.objectContaining({
        "global:_pxAppId": 1,
        "global:_pxHostUrl": 1,
        "global:_pxJsClientSrc": 1,
        "vendor:HUMAN": 1,
      }),
      scoreMax: 9,
      sources: expect.objectContaining({
        [`${server.origin}/abr-shield/sensor.js`]: 1,
      }),
    });
});

test("Adaptive runtime detection ignores HUMAN ABR lookalikes without exact jsClientSrc globals", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-benign-human-abr-lookalike.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveVendorHumanAbrLookalikeDone === true))
    .toBe(true);
  await page.waitForTimeout(500);

  const storage = await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.get("adaptive_log")
  );
  expect(storage.adaptive_log).toBeUndefined();
});

test("Adaptive runtime detection ignores HUMAN init.js lookalikes without matching xhr prefixes", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-benign-human-prefix-lookalike.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveVendorHumanPrefixLookalikeDone === true))
    .toBe(true);
  await page.waitForTimeout(500);

  const storage = await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.get("adaptive_log")
  );
  expect(storage.adaptive_log).toBeUndefined();
});

test("Adaptive runtime detection ignores partial vendor lookalikes", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-runtime-benign.html"));
  await expect
    .poll(() => page.evaluate(() => window.__adaptiveVendorBenignDone === true))
    .toBe(true);
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
    return chrome.storage.local
      .get("adaptive_log")
      .then(({ adaptive_log }) => adaptive_log[origin]);
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
    return chrome.storage.local
      .get("adaptive_log")
      .then(({ adaptive_log }) => adaptive_log[origin]);
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
    return chrome.storage.local
      .get("adaptive_log")
      .then(({ adaptive_log }) => adaptive_log[origin]);
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

test("Adaptive behavior logging attributes postMessage listener objects by registration source", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-message-listener.html"));
  await expect.poll(() => page.evaluate(() => window.__adaptiveMessageDone === true)).toBe(true);

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
        [`${server.origin}/listener-collect`]: 1,
      }),
      sources: expect.objectContaining({
        [`${server.origin}/assets/:token.js`]: expect.any(Number),
      }),
    });

  const adaptiveEntry = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local
      .get("adaptive_log")
      .then(({ adaptive_log }) => adaptive_log[origin]);
  }, server.origin);

  expect(adaptiveEntry.reasons).toEqual(
    expect.objectContaining({
      canvas: expect.any(Number),
      navigator: expect.any(Number),
      network: expect.any(Number),
    })
  );
  const serialized = JSON.stringify(adaptiveEntry);
  expect(serialized).not.toContain("event-listener-1234567890abcdef1234567890abcdef.js");
  expect(serialized).not.toContain("secret-token");
});

test("Adaptive behavior logging attributes onmessage handlers through runtime source context", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-onmessage-runtime.html"));
  await expect.poll(() => page.evaluate(() => window.__adaptiveOnmessageDone === true)).toBe(true);

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
        [`${server.origin}/onmessage-collect`]: 1,
      }),
      sources: expect.objectContaining({
        "runtime:settimeout": expect.any(Number),
      }),
    });

  const adaptiveEntry = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local
      .get("adaptive_log")
      .then(({ adaptive_log }) => adaptive_log[origin]);
  }, server.origin);
  expect(adaptiveEntry.sources["inline-or-runtime"]).toBeUndefined();
});

test("listener wrapping preserves removeEventListener for callbacks and listener objects", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(async () => {
    let functionCount = 0;
    let objectCount = 0;
    function onMessage() {
      functionCount++;
    }
    const listenerObject = {
      handleEvent() {
        objectCount++;
      },
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("message", listenerObject);
    window.removeEventListener("message", onMessage);
    window.removeEventListener("message", listenerObject);
    window.postMessage({ kind: "noop" }, "*");

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    return { functionCount, objectCount };
  });

  expect(result).toEqual({ functionCount: 0, objectCount: 0 });
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

test("log viewer ranks origins by severity and explains adaptive reason tokens", async ({
  extension,
}) => {
  const now = Date.now();
  await extension.serviceWorker.evaluate(
    ({ now, otherId, probedId }) =>
      chrome.storage.local.set({
        adaptive_log: {
          "https://severe.test": {
            total: 2,
            scoreMax: 9,
            categories: { "session-replay": 2 },
            reasons: {
              dom_observer: 2,
              input_hooks: 2,
              "listener.keydown": 1,
              "listener.mousemove": 1,
              "mutation.subtree": 1,
              navigator: 1,
              "navigator.deviceMemory": 1,
            },
            endpoints: {},
            sources: { "inline-or-runtime": 2 },
            lastUpdated: now,
          },
        },
        probe_log: {
          "https://low.test": {
            idCounts: { [probedId]: 1, [otherId]: 1 },
            lastUpdated: now - 1000,
          },
        },
      }),
    { now, otherId: OTHER_ID, probedId: PROBED_ID }
  );

  const logPage = await extension.context.newPage();
  await logPage.goto(`chrome-extension://${extension.extensionId}/log.html`);

  await expect(logPage.getByText("ranked by severity")).toBeVisible();
  const rows = logPage.locator("tr.origin-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("https://severe.test");
  await expect(rows.nth(0)).toContainText("High");
  await expect(rows.nth(1)).toContainText("https://low.test");

  await logPage.getByText("https://severe.test").click();
  await expect(logPage.getByText("Signal guide")).toBeVisible();
  await expect(logPage.getByText(/DOM observer/)).toBeVisible();
  await expect(logPage.getByText(/Input hooks/)).toBeVisible();
  await expect(logPage.getByText(/Global keydown listener/)).toBeVisible();
  await expect(logPage.getByText(/Device memory read/)).toBeVisible();
  await expect(logPage.getByText(/Whole-page mutation watch/)).toBeVisible();
  await expect(
    logPage
      .getByText(/Device signal poisoning can weaken this surface without blocking the read/)
      .first()
  ).toBeVisible();
  await expect(
    logPage.getByText(/Replay poisoning can mask detected recorder listeners/).first()
  ).toBeVisible();
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

test("QA diagnostics mode records local behavior and builds anonymized issue reports", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ diagnostics_mode: true })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(100);
  await page.evaluate(
    async (url) => {
      await fetch(url).catch(() => {});
    },
    probedUrl(PROBED_ID, "/manifest.json?secret=should-not-export")
  );

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate((origin) => {
        return chrome.storage.local
          .get("diagnostic_log")
          .then(({ diagnostic_log }) => diagnostic_log && diagnostic_log[origin]);
      }, server.origin)
    )
    .toMatchObject({
      totals: { probe: 1 },
      events: [
        {
          action: "blocked",
          extensionId: PROBED_ID,
          extensionPath: "/manifest.json",
          pathKind: "manifest",
          type: "probe",
          vector: "fetch",
        },
      ],
    });

  const diagnosticEntry = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local
      .get("diagnostic_log")
      .then(({ diagnostic_log }) => diagnostic_log && diagnostic_log[origin]);
  }, server.origin);

  const serializedDiagnostic = JSON.stringify(diagnosticEntry);
  expect(serializedDiagnostic).toContain(PROBED_ID);
  expect(serializedDiagnostic).not.toContain("should-not-export");

  const logPage = await extension.context.newPage();
  await logPage.goto(`chrome-extension://${extension.extensionId}/log.html`);
  await expect(logPage.getByText(server.origin)).toBeVisible();
  await logPage.getByText(server.origin).click();
  await expect(logPage.locator(".drift-detail-title").getByText("QA diagnostics")).toBeVisible();
  await expect(logPage.getByText(/probe blocked/)).toBeVisible();
  await expect(
    logPage.locator(".id-entry span").getByText(PROBED_ID, { exact: true })
  ).toBeVisible();

  const issueReport = await logPage.evaluate("buildIssueReport(fullData)");
  const serializedIssue = JSON.stringify(issueReport);
  expect(issueReport.schema).toBe("static.issue-diagnostics.v1");
  expect(issueReport.diagnosticsMode).toBe(true);
  expect(issueReport.summary.diagnosticEvents).toBe(1);
  expect(serializedIssue).not.toContain(server.origin);
  expect(serializedIssue).not.toContain(PROBED_ID);
  expect(serializedIssue).not.toContain("should-not-export");
  expect(issueReport.origins[0].originHash).toMatch(/^[0-9a-f]{64}$/);
  expect(issueReport.origins[0].diagnostics.events[0]).toMatchObject({
    action: "blocked",
    extensionPath: "/manifest.json",
    pathKind: "manifest",
    type: "probe",
    vector: "fetch",
  });
  expect(issueReport.origins[0].diagnostics.events[0].extensionIdHash).toMatch(/^[0-9a-f]{64}$/);
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

test("DOM marker scrubber hides transient markers from page MutationObservers", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(async () => {
    const records = [];
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        records.push({
          added: [...(mutation.addedNodes || [])]
            .filter((node) => node.nodeType === Node.ELEMENT_NODE)
            .map((node) => ({
              attr: node.getAttribute("data-grammarly-extension"),
              className: node.className,
              id: node.id,
              tag: node.tagName,
            })),
          attributeName: mutation.attributeName,
          oldValue: mutation.oldValue,
          targetClass: mutation.target && mutation.target.className,
          targetId: mutation.target && mutation.target.id,
          targetTag: mutation.target && mutation.target.tagName,
          type: mutation.type,
        });
      }
    });
    observer.observe(document.documentElement, {
      attributeOldValue: true,
      attributes: true,
      childList: true,
      subtree: true,
    });

    const marker = document.createElement("grammarly-card");
    marker.id = "direct-marker";
    marker.setAttribute("data-grammarly-extension", "1");
    marker.className = "grammarly-card keep";
    document.body.appendChild(marker);

    const markedAttr = document.createElement("div");
    markedAttr.id = "marked-attr";
    document.body.appendChild(markedAttr);
    markedAttr.setAttribute("data-dashlanecreated", "1");
    markedAttr.className = "keep onepassword-pill";

    const safe = document.createElement("div");
    safe.id = "safe-observed";
    document.body.appendChild(safe);

    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    observer.disconnect();

    return {
      markedAttrClasses: [...markedAttr.classList],
      markedAttrHasData: markedAttr.hasAttribute("data-dashlanecreated"),
      markerConnected: marker.isConnected,
      records,
      safeSeen: records.some((record) => record.added.some((node) => node.id === "safe-observed")),
    };
  });

  expect(result.markerConnected).toBe(false);
  expect(result.markedAttrHasData).toBe(false);
  expect(result.markedAttrClasses).toEqual(["keep"]);
  expect(result.safeSeen).toBe(true);

  const serialized = JSON.stringify(result.records);
  expect(serialized).not.toContain("GRAMMARLY-CARD");
  expect(serialized).not.toContain("data-grammarly-extension");
  expect(serialized).not.toContain("data-dashlanecreated");
  expect(serialized).not.toContain("grammarly-card");
  expect(serialized).not.toContain("onepassword-pill");
});

test("Clear log removes probe state and Noise identity while preserving preferences", async ({
  extension,
}) => {
  await extension.serviceWorker.evaluate(
    ({ id }) =>
      chrome.storage.local.set({
        cumulative: 42,
        diagnostics_mode: true,
        fingerprint_mode: "mask",
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
        ad_log: {
          "https://example.test": {
            confidence: "high",
            endpoints: { "same-origin:/ads/:token": 1 },
            firstSeen: Date.now(),
            lastUpdated: Date.now(),
            reasons: { "gpt.slot": 1, "ad_iframe.size": 1, impression_beacon: 1 },
            score: 11,
            sources: { "inline-or-runtime": 1 },
            total: 3,
            version: 1,
          },
        },
        diagnostic_log: {
          "https://example.test": {
            events: [
              {
                action: "blocked",
                at: Date.now(),
                extensionId: id,
                extensionPath: "/manifest.json",
                pathKind: "manifest",
                type: "probe",
                vector: "fetch",
              },
            ],
            lastUpdated: Date.now(),
            totals: { probe: 1 },
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
          "diagnostic_log",
          "diagnostics_mode",
          "fingerprint_mode",
          "noise_enabled",
          "replay_mode",
          "probe_log",
          "replay_log",
          "adaptive_log",
          "ad_log",
          "user_secret",
        ])
      )
    )
    .toEqual({
      diagnostics_mode: true,
      fingerprint_mode: "mask",
      noise_enabled: true,
      replay_mode: "chaos",
    });
});
