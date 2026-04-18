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

const vectorCountsFor = (extension, origin) => {
  return extension.serviceWorker.evaluate(
    (pageOrigin) =>
      chrome.storage.local.get("probe_log").then(({ probe_log }) => {
        const weeks =
          probe_log &&
          probe_log[pageOrigin] &&
          probe_log[pageOrigin].playbook &&
          probe_log[pageOrigin].playbook.weeks;
        return weeks && Object.values(weeks)[0].vectorCounts;
      }),
    origin
  );
};

test("Noise decoys srcset probes without exposing the replacement URL", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await seedNoisePersona(extension, server.origin);

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const imageUrl = probedUrl(PROBED_ID, "/icon.png");
  const result = await page.evaluate(async (srcsetUrl) => {
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
      img.srcset = `${srcsetUrl} 1x`;
      document.body.appendChild(img);
    });

    const attrImg = new Image();
    attrImg.setAttribute("srcset", `${srcsetUrl} 1x`);

    const source = document.createElement("source");
    source.srcset = `${srcsetUrl} 1x`;

    return {
      attrImageSrcset: attrImg.getAttribute("srcset"),
      image: {
        complete: img.complete,
        currentSrc: img.currentSrc,
        event: imgEvent,
        naturalHeight: img.naturalHeight,
        naturalWidth: img.naturalWidth,
        srcset: img.srcset,
      },
      sourceSrcset: source.srcset,
    };
  }, imageUrl);

  expect(result).toEqual({
    attrImageSrcset: `${imageUrl} 1x`,
    image: {
      complete: true,
      currentSrc: imageUrl,
      event: "load",
      naturalHeight: 1,
      naturalWidth: 1,
      srcset: `${imageUrl} 1x`,
    },
    sourceSrcset: `${imageUrl} 1x`,
  });

  await expect.poll(() => vectorCountsFor(extension, server.origin)).toMatchObject({
    "img.srcset": 1,
    "setAttribute-srcset": 1,
    "source.srcset": 1,
  });
});

test("Noise mode fails closed for non-GET method canaries", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await seedNoisePersona(extension, server.origin);

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(async (manifestUrl) => {
    const fetchPost = await fetch(manifestUrl, { method: "POST" }).then(
      () => "resolved",
      (error) => error.name
    );
    const xhrPost = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.addEventListener("loadend", () => {
        resolve({
          responseURL: xhr.responseURL,
          status: xhr.status,
        });
      });
      xhr.open("POST", manifestUrl);
      xhr.send("canary");
    });

    return { fetchPost, xhrPost };
  }, probedUrl(PROBED_ID, "/manifest.json"));

  expect(result).toEqual({
    fetchPost: "TypeError",
    xhrPost: {
      responseURL: "",
      status: 0,
    },
  });
});

test("Noise mode fails closed for unsupported path canaries", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await seedNoisePersona(extension, server.origin);

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(async (canaryUrl) => {
    const fetchGet = await fetch(canaryUrl).then(
      () => "resolved",
      (error) => error.name
    );
    const xhrGet = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.addEventListener("loadend", () => {
        resolve({
          responseURL: xhr.responseURL,
          status: xhr.status,
        });
      });
      xhr.open("GET", canaryUrl);
      xhr.send();
    });

    return { fetchGet, xhrGet };
  }, probedUrl(PROBED_ID, "/canary-probe.bin"));

  expect(result).toEqual({
    fetchGet: "TypeError",
    xhrGet: {
      responseURL: "",
      status: 0,
    },
  });
});

test("Noise XHR decoys expose a native-like readyState progression", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await seedNoisePersona(extension, server.origin);

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(
    (manifestUrl) =>
      new Promise((resolve) => {
        const events = [];
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("loadstart", () => {
          events.push({ event: "loadstart", readyState: xhr.readyState, status: xhr.status });
        });
        xhr.addEventListener("readystatechange", () => {
          events.push({
            event: "readystatechange",
            readyState: xhr.readyState,
            responseURL: xhr.responseURL,
            status: xhr.status,
          });
        });
        xhr.addEventListener("loadend", () => {
          events.push({
            event: "loadend",
            readyState: xhr.readyState,
            responseURL: xhr.responseURL,
            status: xhr.status,
          });
          resolve(events);
        });
        xhr.open("GET", manifestUrl);
        xhr.send();
      }),
    probedUrl(PROBED_ID, "/manifest.json")
  );

  expect(result).toEqual([
    { event: "readystatechange", readyState: 1, responseURL: "", status: 0 },
    { event: "loadstart", readyState: 1, status: 0 },
    {
      event: "readystatechange",
      readyState: 2,
      responseURL: probedUrl(PROBED_ID, "/manifest.json"),
      status: 200,
    },
    {
      event: "readystatechange",
      readyState: 3,
      responseURL: probedUrl(PROBED_ID, "/manifest.json"),
      status: 200,
    },
    {
      event: "readystatechange",
      readyState: 4,
      responseURL: probedUrl(PROBED_ID, "/manifest.json"),
      status: 200,
    },
    {
      event: "loadend",
      readyState: 4,
      responseURL: probedUrl(PROBED_ID, "/manifest.json"),
      status: 200,
    },
  ]);
});

test("style setProperty and cssText URL probes are fail-closed", async ({ extension, server }) => {
  const page = await extension.context.newPage();

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const imageUrl = probedUrl(PROBED_ID, "/icon.png");
  const result = await page.evaluate(async (styleUrl) => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    el.style.setProperty("cursor", `url("${styleUrl}"), auto`);
    const cursor = el.style.cursor;

    el.style.cssText = `background-image: url("${styleUrl}"); list-style-image: url("${styleUrl}")`;
    const cssText = el.style.cssText;

    const direct = document.createElement("div");
    document.body.appendChild(direct);
    direct.style.backgroundImage = `url("${styleUrl}")`;

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    return {
      cssText,
      cursor,
      directBackgroundImage: direct.style.backgroundImage,
      hasStyleUrl:
        cursor.includes(styleUrl) ||
        cssText.includes(styleUrl) ||
        direct.style.backgroundImage.includes(styleUrl),
    };
  }, imageUrl);

  expect(result).toEqual({
    cssText: "",
    cursor: "",
    directBackgroundImage: "",
    hasStyleUrl: false,
  });

  await expect.poll(() => vectorCountsFor(extension, server.origin)).toMatchObject({
    "style.attribute": 1,
    "style.cssText": 1,
    "style.setProperty": 1,
  });
});
