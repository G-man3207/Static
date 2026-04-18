const { expect, test } = require("./helpers/extension-fixture");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const INVALID_ID = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
const probedUrl = (id = PROBED_ID, path = "/manifest.json") => `chrome-extension://${id}${path}`;

const seedNoisePersona = async (extension, origin, id = PROBED_ID) => {
  await extension.serviceWorker.evaluate(
    ({ id: personaId, pageOrigin }) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [pageOrigin]: {
            idCounts: { [personaId]: 2 },
            lastUpdated: Date.now(),
          },
        },
        user_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    { id, pageOrigin: origin }
  );
};

test("Noise decoys expose coherent fetch and XHR response details", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await seedNoisePersona(extension, server.origin);

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(
    async (manifestUrl) => {
      const response = await fetch(manifestUrl);
      const responseClone = response.clone();
      const responseText = await responseClone.text();
      const manifest = await response.json();
      const head = await fetch(new Request(manifestUrl, { method: "HEAD" }));

      const xhrText = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("loadend", () => {
          resolve({
            allHeaders: xhr.getAllResponseHeaders(),
            contentType: xhr.getResponseHeader("content-type"),
            ownGetHeader: Object.prototype.hasOwnProperty.call(xhr, "getResponseHeader"),
            ownReadyState: Object.prototype.hasOwnProperty.call(xhr, "readyState"),
            ownResponse: Object.prototype.hasOwnProperty.call(xhr, "response"),
            ownResponseText: Object.prototype.hasOwnProperty.call(xhr, "responseText"),
            ownResponseURL: Object.prototype.hasOwnProperty.call(xhr, "responseURL"),
            ownStatus: Object.prototype.hasOwnProperty.call(xhr, "status"),
            responseText: xhr.responseText,
            responseURL: xhr.responseURL,
            status: xhr.status,
          });
        });
        xhr.open("GET", manifestUrl);
        xhr.send();
      });

      const xhrJson = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("loadend", () => {
          let responseTextAccess = "ok";
          try {
            void xhr.responseText;
          } catch (error) {
            responseTextAccess = error.name;
          }
          resolve({
            ownResponse: Object.prototype.hasOwnProperty.call(xhr, "response"),
            ownResponseText: Object.prototype.hasOwnProperty.call(xhr, "responseText"),
            ownStatus: Object.prototype.hasOwnProperty.call(xhr, "status"),
            response: xhr.response,
            responseTextAccess,
            status: xhr.status,
          });
        });
        xhr.open("GET", manifestUrl);
        xhr.responseType = "json";
        xhr.send();
      });

      return {
        fetch: {
          instance: response instanceof Response,
          manifest,
          ownType: Object.prototype.hasOwnProperty.call(response, "type"),
          ownUrl: Object.prototype.hasOwnProperty.call(response, "url"),
          prototype: Object.getPrototypeOf(response) === Response.prototype,
          cloneType: responseClone.type,
          cloneUrl: responseClone.url,
          responseText,
          type: response.type,
          url: response.url,
        },
        headText: await head.text(),
        xhrJson,
        xhrText,
      };
    },
    probedUrl(PROBED_ID, "/manifest.json")
  );

  expect(result.fetch).toMatchObject({
    instance: true,
    manifest: {
      manifest_version: 3,
      name: "Browser Extension",
      version: "1.0.0",
    },
    ownType: false,
    ownUrl: false,
    prototype: true,
    cloneType: "basic",
    cloneUrl: probedUrl(PROBED_ID, "/manifest.json"),
    type: "basic",
    url: probedUrl(PROBED_ID, "/manifest.json"),
  });
  expect(JSON.parse(result.fetch.responseText)).toMatchObject({ name: "Browser Extension" });
  expect(result.headText).toBe("");
  expect(result.xhrText).toMatchObject({
    contentType: "application/json; charset=utf-8",
    ownGetHeader: false,
    ownReadyState: false,
    ownResponse: false,
    ownResponseText: false,
    ownResponseURL: false,
    ownStatus: false,
    responseURL: probedUrl(PROBED_ID, "/manifest.json"),
    status: 200,
  });
  expect(result.xhrText.allHeaders).toContain("content-type: application/json; charset=utf-8");
  expect(JSON.parse(result.xhrText.responseText)).toMatchObject({ name: "Browser Extension" });
  expect(result.xhrJson).toMatchObject({
    ownResponse: false,
    ownResponseText: false,
    ownStatus: false,
    response: {
      manifest_version: 3,
      name: "Browser Extension",
      version: "1.0.0",
    },
    responseTextAccess: "InvalidStateError",
    status: 200,
  });
});

test("Noise decoys are consistent for passive resource elements", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await seedNoisePersona(extension, server.origin);

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(
    async ({ cssUrl, imageUrl, scriptUrl }) => {
      const waitForLoad = async (el, start) => {
        const eventPromise = new Promise((resolve) => {
          el.addEventListener("load", () => resolve("load"), { once: true });
          el.addEventListener("error", () => resolve("error"), { once: true });
          setTimeout(() => resolve("timeout"), 1000);
        });
        start();
        return await eventPromise;
      };

      const img = new Image();
      const imgEvent = await waitForLoad(img, () => {
        img.src = imageUrl;
        document.body.appendChild(img);
      });
      let decodeResult = "resolved";
      try {
        await img.decode();
      } catch (error) {
        decodeResult = error.name;
      }

      const script = document.createElement("script");
      const scriptEvent = await waitForLoad(script, () => {
        script.src = scriptUrl;
        document.head.appendChild(script);
      });

      const link = document.createElement("link");
      link.rel = "stylesheet";
      const linkEvent = await waitForLoad(link, () => {
        link.href = cssUrl;
        document.head.appendChild(link);
      });

      return {
        img: {
          attr: img.getAttribute("src"),
          complete: img.complete,
          currentSrc: img.currentSrc,
          decodeResult,
          event: imgEvent,
          naturalHeight: img.naturalHeight,
          naturalWidth: img.naturalWidth,
          src: img.src,
        },
        link: {
          attr: link.getAttribute("href"),
          cssRulesLength: link.sheet ? link.sheet.cssRules.length : null,
          event: linkEvent,
          href: link.href,
          sheetHref: link.sheet && link.sheet.href,
        },
        script: { attr: script.getAttribute("src"), event: scriptEvent, src: script.src },
      };
    },
    {
      cssUrl: probedUrl(PROBED_ID, "/style.css"),
      imageUrl: probedUrl(PROBED_ID, "/icon.png"),
      scriptUrl: probedUrl(PROBED_ID, "/content.js"),
    }
  );

  expect(result).toMatchObject({
    img: {
      attr: probedUrl(PROBED_ID, "/icon.png"),
      complete: true,
      currentSrc: probedUrl(PROBED_ID, "/icon.png"),
      decodeResult: "resolved",
      event: "load",
      naturalHeight: 1,
      naturalWidth: 1,
      src: probedUrl(PROBED_ID, "/icon.png"),
    },
    link: {
      attr: probedUrl(PROBED_ID, "/style.css"),
      cssRulesLength: 0,
      event: "load",
      href: probedUrl(PROBED_ID, "/style.css"),
      sheetHref: probedUrl(PROBED_ID, "/style.css"),
    },
    script: {
      attr: probedUrl(PROBED_ID, "/content.js"),
      event: "load",
      src: probedUrl(PROBED_ID, "/content.js"),
    },
  });

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("probe_log").then(({ probe_log }) => {
            const weeks =
              probe_log &&
              probe_log[origin] &&
              probe_log[origin].playbook &&
              probe_log[origin].playbook.weeks;
            return weeks && Object.values(weeks)[0].vectorCounts;
          }),
        server.origin
      )
    )
    .toMatchObject({
      "img.src": 1,
      "link.href": 1,
      "script.src": 1,
    });
});

test("Noise keeps frame probes fail-closed and logs attribute vectors", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await seedNoisePersona(extension, server.origin);

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(
    ({ frameUrl, imageUrl }) => {
      const frame = document.createElement("iframe");
      frame.src = frameUrl;
      document.body.appendChild(frame);

      const attrFrame = document.createElement("iframe");
      attrFrame.setAttribute("src", frameUrl);

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "use");
      svg.setAttributeNS("http://www.w3.org/1999/xlink", "href", imageUrl);

      return {
        frame: {
          attr: frame.getAttribute("src"),
          attrFrameSrc: attrFrame.getAttribute("src"),
          src: frame.src,
        },
        svgHref: svg.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
      };
    },
    {
      frameUrl: probedUrl(PROBED_ID, "/page.html"),
      imageUrl: probedUrl(PROBED_ID, "/icon.png"),
    }
  );

  expect(result).toEqual({
    frame: {
      attr: null,
      attrFrameSrc: null,
      src: "",
    },
    svgHref: probedUrl(PROBED_ID, "/icon.png"),
  });

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("probe_log").then(({ probe_log }) => {
            const weeks =
              probe_log &&
              probe_log[origin] &&
              probe_log[origin].playbook &&
              probe_log[origin].playbook.weeks;
            return weeks && Object.values(weeks)[0].vectorCounts;
          }),
        server.origin
      )
    )
    .toMatchObject({
      "iframe.src": 1,
      setAttribute: 1,
      "setAttributeNS-href": 1,
    });
});

test("blocked passive element probes keep native-like visible URLs and error events", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(
    async ({ cssUrl, imageUrl, scriptUrl }) => {
      const waitForOutcome = async (el, start) => {
        const eventPromise = new Promise((resolve) => {
          el.addEventListener("load", () => resolve("load"), { once: true });
          el.addEventListener("error", () => resolve("error"), { once: true });
          setTimeout(() => resolve("timeout"), 1000);
        });
        start();
        return eventPromise;
      };

      const img = new Image();
      const imgEvent = await waitForOutcome(img, () => {
        img.src = imageUrl;
        document.body.appendChild(img);
      });

      const script = document.createElement("script");
      const scriptEvent = await waitForOutcome(script, () => {
        script.src = scriptUrl;
        document.head.appendChild(script);
      });

      const link = document.createElement("link");
      link.rel = "stylesheet";
      const linkEvent = await waitForOutcome(link, () => {
        link.href = cssUrl;
        document.head.appendChild(link);
      });

      return {
        img: {
          attr: img.getAttribute("src"),
          complete: img.complete,
          currentSrc: img.currentSrc,
          event: imgEvent,
          naturalWidth: img.naturalWidth,
          src: img.src,
        },
        link: {
          attr: link.getAttribute("href"),
          event: linkEvent,
          href: link.href,
          hasHref: link.hasAttribute("href"),
          sheetHref: link.sheet && link.sheet.href,
        },
        script: {
          attr: script.getAttribute("src"),
          event: scriptEvent,
          hasSrc: script.hasAttribute("src"),
          src: script.src,
        },
      };
    },
    {
      cssUrl: probedUrl(PROBED_ID, "/style.css"),
      imageUrl: probedUrl(PROBED_ID, "/icon.png"),
      scriptUrl: probedUrl(PROBED_ID, "/content.js"),
    }
  );

  expect(result).toMatchObject({
    img: {
      attr: probedUrl(PROBED_ID, "/icon.png"),
      complete: true,
      currentSrc: probedUrl(PROBED_ID, "/icon.png"),
      event: "error",
      naturalWidth: 0,
      src: probedUrl(PROBED_ID, "/icon.png"),
    },
    link: {
      attr: probedUrl(PROBED_ID, "/style.css"),
      event: "error",
      href: probedUrl(PROBED_ID, "/style.css"),
      hasHref: true,
      sheetHref: probedUrl(PROBED_ID, "/style.css"),
    },
    script: {
      attr: probedUrl(PROBED_ID, "/content.js"),
      event: "error",
      hasSrc: true,
      src: probedUrl(PROBED_ID, "/content.js"),
    },
  });
});

test("invalid Chrome extension IDs are blocked but not logged or decoyed", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const blocked = await page.evaluate(async (url) => {
    try {
      await fetch(url);
      return "resolved";
    } catch (error) {
      return error.name;
    }
  }, probedUrl(INVALID_ID));
  expect(blocked).toBe("TypeError");

  await page.waitForTimeout(300);
  const firstLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("probe_log").then(({ probe_log }) => probe_log[origin]);
  }, server.origin);
  expect(firstLog.idCounts[INVALID_ID]).toBeUndefined();
  expect(Object.keys(firstLog.idCounts)).toEqual([]);

  await extension.serviceWorker.evaluate(
    ({ id, origin }) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [origin]: {
            idCounts: { [id]: 99 },
            lastUpdated: Date.now(),
          },
        },
      }),
    { id: INVALID_ID, origin: server.origin }
  );

  const secondPage = await extension.context.newPage();
  await secondPage.goto(server.url("/blank.html"));
  await secondPage.waitForTimeout(300);
  const seededInvalid = await secondPage.evaluate(async (url) => {
    try {
      await fetch(url);
      return "resolved";
    } catch (error) {
      return error.name;
    }
  }, probedUrl(INVALID_ID));
  expect(seededInvalid).toBe("TypeError");
});

test("adaptive logs redact high-entropy endpoint path segments", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/adaptive-private.html"));
  await expect.poll(() => page.evaluate(() => window.__adaptivePrivateDone === true)).toBe(true);

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("adaptive_log").then(({ adaptive_log }) => {
            return adaptive_log && adaptive_log[origin];
          }),
        server.origin
      )
    )
    .not.toBeNull();

  const adaptiveEntry = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local
      .get("adaptive_log")
      .then(({ adaptive_log }) => adaptive_log[origin]);
  }, server.origin);
  const serialized = JSON.stringify(adaptiveEntry);
  expect(serialized).not.toContain("user-1234567890abcdef1234567890abcdef");
  expect(serialized).not.toContain("secret-token");
  expect(Object.keys(adaptiveEntry.endpoints)).toContain(`${server.origin}/collect/:token`);
});

test("replay detection logs redact high-entropy script path segments", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  const page = await extension.context.newPage();
  await page.goto(server.url("/replay-private.html"));
  await expect
    .poll(() => page.evaluate(() => Array.isArray(window.__privateReplayRecords)))
    .toBe(true);
  await page.locator("#secret").fill("private@example.com");

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get("replay_log").then(({ replay_log }) => {
            return replay_log && replay_log[origin];
          }),
        server.origin
      )
    )
    .not.toBeNull();

  const stored = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  const serialized = JSON.stringify(stored);
  expect(serialized).not.toContain("logrocket-1234567890abcdef1234567890abcdef.js");
  expect(serialized).not.toContain("secret-token");
  expect(Object.keys(stored.signals)).toContain(
    `listener-script:${server.origin}/assets/replay/:token.js`
  );
});

test("shareable export hashes origin and extension ID labels", async ({ extension }) => {
  const origin = "https://sensitive.example";
  const ids = [
    "nngceckbapebfimnlniiiahkandclblb",
    "cjpalhdlnbpafiamejdnhcphjbkeiagm",
    "kbfnbcaeplbcioakkpcpgfkobkghlhen",
  ];
  await extension.serviceWorker.evaluate(
    ({ ids, origin }) =>
      chrome.storage.local.set({
        probe_log: {
          [origin]: {
            idCounts: {
              [ids[0]]: 2,
              [ids[1]]: 7,
              [ids[2]]: 25,
            },
            lastUpdated: Date.now(),
          },
        },
      }),
    { ids, origin }
  );

  const logPage = await extension.context.newPage();
  await logPage.goto(`chrome-extension://${extension.extensionId}/log.html`);
  await expect(logPage.getByText(origin)).toBeVisible();

  const first = await logPage.evaluate("buildShareableExport(fullData)");
  const second = await logPage.evaluate("buildShareableExport(fullData)");
  const serialized = JSON.stringify(first);
  const firstOriginHash = Object.keys(first.origins)[0];
  const secondOriginHash = Object.keys(second.origins)[0];
  const firstIdHashes = Object.keys(first.origins[firstOriginHash].idBuckets);

  expect(first.schema).toBe("static.probe-log.shareable.v1");
  expect(firstOriginHash).toMatch(/^[0-9a-f]{64}$/);
  expect(secondOriginHash).toMatch(/^[0-9a-f]{64}$/);
  expect(firstOriginHash).not.toBe(secondOriginHash);
  expect(firstIdHashes).toHaveLength(3);
  expect(firstIdHashes.every((idHash) => /^[0-9a-f]{64}$/.test(idHash))).toBe(true);
  expect(serialized).not.toContain(origin);
  for (const id of ids) expect(serialized).not.toContain(id);
  expect(Object.values(first.origins[firstOriginHash].idBuckets).sort()).toEqual([
    "2-5",
    "21-100",
    "6-20",
  ]);
});

test("DOM scrubber follows open shadow roots", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/shadow-dom.html"));
  await expect.poll(() => page.evaluate(() => window.__shadowDone === true)).toBe(true);

  const result = await page.evaluate(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const root = document.getElementById("host").shadowRoot;
    const inside = root.getElementById("inside");
    const later = root.getElementById("later");
    return {
      insideClasses: [...inside.classList],
      insideData: inside.hasAttribute("data-grammarly-extension"),
      laterClasses: [...later.classList],
      laterData: later.hasAttribute("data-dashlanecreated"),
      shadowCardCount: root.querySelectorAll("grammarly-card").length,
    };
  });

  expect(result).toEqual({
    insideClasses: ["keep"],
    insideData: false,
    laterClasses: ["keep"],
    laterData: false,
    shadowCardCount: 0,
  });
});
