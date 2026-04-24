const { expect, test } = require("./helpers/extension-fixture");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
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

const manifestUrl = () => probedUrl(PROBED_ID, "/manifest.json");

const collectNoiseNetworkDetails = (page) =>
  page.evaluate(async (url) => {
    const own = (object, prop) => Object.prototype.hasOwnProperty.call(object, prop);
    const readXhr = (xhr) => {
      let responseText = "";
      let responseTextAccess = "ok";
      try {
        responseText = xhr.responseText;
      } catch (error) {
        responseTextAccess = error.name;
      }
      return {
        allHeaders: xhr.getAllResponseHeaders(),
        contentType: xhr.getResponseHeader("content-type"),
        readyState: xhr.readyState,
        response: xhr.response,
        responseText,
        responseTextAccess,
        responseURL: xhr.responseURL,
        status: xhr.status,
      };
    };
    const readXhrOwnFlags = (xhr) => ({
      ownGetHeader: own(xhr, "getResponseHeader"),
      ownReadyState: own(xhr, "readyState"),
      ownResponse: own(xhr, "response"),
      ownResponseText: own(xhr, "responseText"),
      ownResponseURL: own(xhr, "responseURL"),
      ownStatus: own(xhr, "status"),
    });
    const xhrAsync = (method, responseType = "") =>
      new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("loadend", () => {
          resolve({ ...readXhr(xhr), ...readXhrOwnFlags(xhr) });
        });
        xhr.open(method, url);
        xhr.responseType = responseType;
        xhr.send();
      });
    const xhrSyncHead = () => {
      const xhr = new XMLHttpRequest();
      xhr.open("HEAD", url, false);
      xhr.send();
      return readXhr(xhr);
    };

    const response = await fetch(url);
    const responseClone = response.clone();
    const head = await fetch(new Request(url, { method: "HEAD" }));
    return {
      fetch: {
        cloneType: responseClone.type,
        cloneUrl: responseClone.url,
        instance: response instanceof Response,
        manifest: await response.json(),
        ownType: own(response, "type"),
        ownUrl: own(response, "url"),
        prototype: Object.getPrototypeOf(response) === Response.prototype,
        responseText: await responseClone.text(),
        type: response.type,
        url: response.url,
      },
      headText: await head.text(),
      xhrHead: await xhrAsync("HEAD"),
      xhrJson: await xhrAsync("GET", "json"),
      xhrSyncHead: xhrSyncHead(),
      xhrText: await xhrAsync("GET"),
    };
  }, manifestUrl());

const expectHeadXhr = (xhrHead) => {
  expect(xhrHead).toMatchObject({
    contentType: "application/json; charset=utf-8",
    readyState: 4,
    response: "",
    responseText: "",
    responseURL: manifestUrl(),
    status: 200,
  });
  expect(xhrHead.allHeaders).toContain("content-type: application/json; charset=utf-8");
};

const probeFetch = (page) =>
  page.evaluate(async (url) => {
    try {
      const response = await fetch(url);
      return { status: response.status };
    } catch (error) {
      return { error: error.name };
    }
  }, manifestUrl());

const clearLogFromExtensionPage = async (extension) => {
  const extensionPage = await extension.context.newPage();
  try {
    await extensionPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);
    await extensionPage.evaluate(() => chrome.runtime.sendMessage({ type: "static_clear_log" }));
  } finally {
    await extensionPage.close();
  }
};

test("Noise decoys expose coherent fetch and XHR response details", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await seedNoisePersona(extension, server.origin);
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await collectNoiseNetworkDetails(page);

  expect(result.fetch).toMatchObject({
    cloneType: "basic",
    cloneUrl: manifestUrl(),
    instance: true,
    manifest: {
      manifest_version: 3,
      name: "Browser Extension",
      version: "1.0.0",
    },
    ownType: false,
    ownUrl: false,
    prototype: true,
    type: "basic",
    url: manifestUrl(),
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
    responseURL: manifestUrl(),
    status: 200,
  });
  expect(result.xhrText.allHeaders).toContain("content-type: application/json; charset=utf-8");
  expect(JSON.parse(result.xhrText.responseText)).toMatchObject({ name: "Browser Extension" });
  expectHeadXhr(result.xhrHead);
  expectHeadXhr(result.xhrSyncHead);
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

test("Noise setting changes refresh existing pages without reload", async ({ extension, server }) => {
  await seedNoisePersona(extension, server.origin);
  const pageOne = await extension.context.newPage();
  const pageTwo = await extension.context.newPage();

  await Promise.all([
    pageOne.goto(server.url("/blank.html")),
    pageTwo.goto(server.url("/blank.html")),
  ]);
  await pageOne.waitForTimeout(300);

  await expect(probeFetch(pageOne)).resolves.toEqual({ status: 200 });
  await expect(probeFetch(pageTwo)).resolves.toEqual({ status: 200 });

  const extensionPage = await extension.context.newPage();
  await extensionPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  await extensionPage.evaluate(() =>
    chrome.runtime.sendMessage({ type: "static_set_noise", enabled: false })
  );
  await extensionPage.close();

  await expect
    .poll(async () => [await probeFetch(pageOne), await probeFetch(pageTwo)])
    .toEqual([{ error: "TypeError" }, { error: "TypeError" }]);
});

test("clearing logs disarms existing-page Noise personas without reload", async ({
  extension,
  server,
}) => {
  await seedNoisePersona(extension, server.origin);
  const page = await extension.context.newPage();

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);
  await expect(probeFetch(page)).resolves.toEqual({ status: 200 });

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        (origin) =>
          chrome.storage.local.get(["probe_log", "user_secret"]).then((stored) => ({
            hasOriginLog: !!(stored.probe_log && stored.probe_log[origin]),
            hasSecret: typeof stored.user_secret === "string",
          })),
        server.origin
      )
    )
    .toEqual({ hasOriginLog: true, hasSecret: true });

  await clearLogFromExtensionPage(extension);

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(() =>
        chrome.storage.local.get(["cumulative", "probe_log", "user_secret"])
      )
    )
    .toEqual({});
  await expect.poll(() => probeFetch(page)).toEqual({ error: "TypeError" });

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(
        ({ id, origin }) =>
          chrome.storage.local.get(["probe_log", "user_secret"]).then((stored) => ({
            blockedProbeCount:
              (stored.probe_log && stored.probe_log[origin]?.idCounts?.[id]) || 0,
            hasSecret: typeof stored.user_secret === "string",
          })),
        { id: PROBED_ID, origin: server.origin }
      )
    )
    .toEqual({ blockedProbeCount: 1, hasSecret: false });
});
