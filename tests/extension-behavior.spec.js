const { expect, test } = require("@playwright/test");
const { launchExtension } = require("./helpers/extension");
const { startFixtureServer } = require("./helpers/server");

const PROBED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const probedUrl = (id = PROBED_ID, path = "/manifest.json") => `chrome-extension://${id}${path}`;

test.describe("Static extension integration", () => {
  let extension;
  let server;

  test.beforeEach(async () => {
    extension = await launchExtension();
    await extension.serviceWorker.evaluate(() => chrome.storage.local.clear());
    server = await startFixtureServer({
      "/blank.html": '<!doctype html><meta charset="utf-8"><body>blank</body>',
      "/message-listener.html": `
        <!doctype html>
        <meta charset="utf-8">
        <script>
          window.staticMessages = [];
          window.staticBridgeEvents = [];
          window.addEventListener("message", (event) => {
            if (event.data && event.data.__static_bridge_init__) {
              window.staticMessages.push({ data: event.data, ports: event.ports.length });
            }
          });
          document.addEventListener("__static_bridge_init__", (event) => {
            window.staticBridgeEvents.push({ type: event.type, ports: event.ports.length });
          });
        </script>
        <body>listener</body>
      `,
      "/dom.html": `
        <!doctype html>
        <meta charset="utf-8">
        <body>
          <div id="target" data-grammarly-extension="1" data-lastpass-root="1" class="keep grammarly-card lastpass-panel"></div>
          <grammarly-card id="custom-card"></grammarly-card>
        </body>
      `,
    });
  });

  test.afterEach(async () => {
    await extension.close();
    await server.close();
  });

  test("runs at document_start without exposing Static config in the page world", async () => {
    const page = await extension.context.newPage();
    await page.goto(server.url("/blank.html"));

    const result = await page.evaluate(() => {
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { marker: true };
      window.__REDUX_DEVTOOLS_EXTENSION__ = () => "present";

      return {
        reactHook: window.__REACT_DEVTOOLS_GLOBAL_HOOK__,
        reduxHook: window.__REDUX_DEVTOOLS_EXTENSION__,
        hasStaticConfig: Object.prototype.hasOwnProperty.call(window, "__static_config__"),
        staticConfigType: typeof window.__static_config__,
      };
    });

    expect(result).toEqual({
      reactHook: undefined,
      reduxHook: undefined,
      hasStaticConfig: false,
      staticConfigType: "undefined",
    });
  });

  test("keeps wrapped API surfaces close to native browser methods", async () => {
    const page = await extension.context.newPage();
    await page.goto(server.url("/blank.html"));

    const surface = await page.evaluate(() => ({
      fetch: {
        length: fetch.length,
        ownPrototype: Object.prototype.hasOwnProperty.call(fetch, "prototype"),
        toString: Function.prototype.toString.call(fetch),
      },
      xhrOpen: {
        length: XMLHttpRequest.prototype.open.length,
        ownPrototype: Object.prototype.hasOwnProperty.call(
          XMLHttpRequest.prototype.open,
          "prototype"
        ),
        toString: Function.prototype.toString.call(XMLHttpRequest.prototype.open),
      },
      xhrSend: {
        length: XMLHttpRequest.prototype.send.length,
        ownPrototype: Object.prototype.hasOwnProperty.call(
          XMLHttpRequest.prototype.send,
          "prototype"
        ),
        toString: Function.prototype.toString.call(XMLHttpRequest.prototype.send),
      },
      setAttribute: {
        length: Element.prototype.setAttribute.length,
        ownPrototype: Object.prototype.hasOwnProperty.call(
          Element.prototype.setAttribute,
          "prototype"
        ),
        toString: Function.prototype.toString.call(Element.prototype.setAttribute),
      },
      setAttributeNS: {
        length: Element.prototype.setAttributeNS.length,
        ownPrototype: Object.prototype.hasOwnProperty.call(
          Element.prototype.setAttributeNS,
          "prototype"
        ),
        toString: Function.prototype.toString.call(Element.prototype.setAttributeNS),
      },
      sendBeacon: {
        length: navigator.sendBeacon.length,
        ownOnNavigator: Object.prototype.hasOwnProperty.call(navigator, "sendBeacon"),
        ownPrototype: Object.prototype.hasOwnProperty.call(navigator.sendBeacon, "prototype"),
        toString: Function.prototype.toString.call(navigator.sendBeacon),
      },
      worker: {
        length: Worker.length,
        ownPrototype: Object.prototype.hasOwnProperty.call(Worker, "prototype"),
        toString: Function.prototype.toString.call(Worker),
      },
      sharedWorker:
        typeof SharedWorker === "function"
          ? {
              length: SharedWorker.length,
              ownPrototype: Object.prototype.hasOwnProperty.call(SharedWorker, "prototype"),
              toString: Function.prototype.toString.call(SharedWorker),
            }
          : null,
      eventSource: {
        length: EventSource.length,
        ownPrototype: Object.prototype.hasOwnProperty.call(EventSource, "prototype"),
        toString: Function.prototype.toString.call(EventSource),
      },
      serviceWorkerRegister: navigator.serviceWorker
        ? {
            length: navigator.serviceWorker.register.length,
            ownOnContainer: Object.prototype.hasOwnProperty.call(
              navigator.serviceWorker,
              "register"
            ),
            ownPrototype: Object.prototype.hasOwnProperty.call(
              navigator.serviceWorker.register,
              "prototype"
            ),
            toString: Function.prototype.toString.call(navigator.serviceWorker.register),
          }
        : null,
    }));

    expect(surface.fetch).toEqual({
      length: 1,
      ownPrototype: false,
      toString: "function fetch() { [native code] }",
    });
    expect(surface.xhrOpen).toEqual({
      length: 2,
      ownPrototype: false,
      toString: "function open() { [native code] }",
    });
    expect(surface.xhrSend).toEqual({
      length: 0,
      ownPrototype: false,
      toString: "function send() { [native code] }",
    });
    expect(surface.setAttribute).toEqual({
      length: 2,
      ownPrototype: false,
      toString: "function setAttribute() { [native code] }",
    });
    expect(surface.setAttributeNS).toEqual({
      length: 3,
      ownPrototype: false,
      toString: "function setAttributeNS() { [native code] }",
    });
    expect(surface.sendBeacon).toEqual({
      length: 1,
      ownOnNavigator: false,
      ownPrototype: false,
      toString: "function sendBeacon() { [native code] }",
    });
    expect(surface.worker).toEqual({
      length: 1,
      ownPrototype: true,
      toString: "function Worker() { [native code] }",
    });
    if (surface.sharedWorker) {
      expect(surface.sharedWorker).toEqual({
        length: 1,
        ownPrototype: true,
        toString: "function SharedWorker() { [native code] }",
      });
    }
    expect(surface.eventSource).toEqual({
      length: 1,
      ownPrototype: true,
      toString: "function EventSource() { [native code] }",
    });
    if (surface.serviceWorkerRegister) {
      expect(surface.serviceWorkerRegister).toEqual({
        length: 1,
        ownOnContainer: false,
        ownPrototype: false,
        toString: "function register() { [native code] }",
      });
    }
  });

  test("does not expose the private bridge handshake to page listeners", async () => {
    const page = await extension.context.newPage();
    await page.goto(server.url("/message-listener.html"));

    const observed = await page.evaluate(async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
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
        extension.serviceWorker.evaluate(() =>
          chrome.storage.local.get(["cumulative", "probe_log"])
        )
      )
      .toMatchObject({ cumulative: 1 });
  });

  test("ignores spoofed legacy public postMessage probe events", async () => {
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

  test("blocks broad extension URL vectors and accumulates per-origin ID counts", async () => {
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

      navigator.sendBeacon(url, "");
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

  test("blocked XHR failures settle like native network failures", async () => {
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
            events,
          });
        }, 100);
      });
    }, probedUrl());

    expect(result.finalReadyState).toBe(4);
    expect(result.finalStatus).toBe(0);
    expect(result.finalResponseURL).toBe("");
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

  test("Noise mode decoys eligible fetch and XHR probes but keeps element probes blocked", async () => {
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
    expect(decoys.blockedImageSrc).toBeNull();
    expect(decoys.resolvedImageSrc).toBe("");
  });

  test("Noise mode does not decoy IDs below the minimum observed count", async () => {
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

  test("blocked EventSource probes keep EventSource shape while failing closed", async () => {
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
        await new Promise((resolve) => setTimeout(resolve, 50));
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

  test("log viewer shows playbook drift indicators and reasons", async () => {
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
    await expect(
      logPage.getByText("New probe vectors appeared: EventSource, Worker.")
    ).toBeVisible();
    await expect(logPage.getByText("New path kinds appeared: image, script.")).toBeVisible();
    await expect(logPage.getByText(/One-shot ID pressure is high/)).toBeVisible();
  });

  test("scrubs extension DOM markers on initial parse and later mutations", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        dataDashlane: node.hasAttribute("data-dashlanecreated"),
        classes: [...node.classList],
      };
    });
    expect(later.dataDashlane).toBe(false);
    expect(later.classes).toEqual(["keep"]);
  });

  test("Clear log removes probe state and Noise identity while preserving preferences", async () => {
    await extension.serviceWorker.evaluate(
      ({ id }) =>
        chrome.storage.local.set({
          cumulative: 42,
          noise_enabled: true,
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
          chrome.storage.local.get(["cumulative", "noise_enabled", "probe_log", "user_secret"])
        )
      )
      .toEqual({ noise_enabled: true });
  });
});
