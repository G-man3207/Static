const { expect, test } = require("./helpers/extension-fixture");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const probedUrl = (path = "/manifest.json") => `chrome-extension://${PROBED_ID}${path}`;

const seedNoisePersona = async (extension, origin) => {
  await extension.serviceWorker.evaluate(
    ({ pageOrigin, probedId }) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [pageOrigin]: {
            idCounts: { [probedId]: 2 },
            lastUpdated: Date.now(),
          },
        },
        user_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    { pageOrigin: origin, probedId: PROBED_ID }
  );
};

const vectorCountsFor = (extension, origin) =>
  extension.serviceWorker.evaluate(
    (pageOrigin) =>
      chrome.storage.local.get("probe_log").then(({ probe_log }) => {
        const weeks = probe_log?.[pageOrigin]?.playbook?.weeks;
        return weeks && Object.values(weeks)[0].vectorCounts;
      }),
    origin
  );

test("innerHTML serialization restores original URLs for single-quoted attributes", async ({
  extension,
  server,
}) => {
  await seedNoisePersona(extension, server.origin);

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate((url) => {
    const img = document.createElement("img");
    img.setAttribute("src", url);
    document.body.appendChild(img);

    const container = document.createElement("div");
    container.innerHTML = `<img src='${url}'>`;
    document.body.appendChild(container);

    return {
      directInnerHTML: img.outerHTML,
      parsedInnerHTML: container.innerHTML,
    };
  }, probedUrl("/icon.png"));

  expect(result.directInnerHTML).toContain(probedUrl("/icon.png"));
  expect(result.parsedInnerHTML).toContain(probedUrl("/icon.png"));
});

test("innerHTML decoys srcset probes with descriptors without leaking data URLs", async ({
  extension,
  server,
}) => {
  await seedNoisePersona(extension, server.origin);

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const imageUrl = probedUrl("/icon.png");
  const result = await page.evaluate(async (srcsetUrl) => {
    const snapshotImage = (img, event) => ({
      attr: img.getAttribute("srcset"),
      complete: img.complete,
      currentSrc: img.currentSrc,
      event,
      naturalHeight: img.naturalHeight,
      naturalWidth: img.naturalWidth,
      outerHTML: img.outerHTML,
      srcset: img.srcset,
    });
    const waitForImage = (img) =>
      new Promise((resolve) => {
        const finish = (event) => resolve(snapshotImage(img, event));
        if (img.complete) {
          queueMicrotask(() => finish(img.naturalWidth > 0 ? "load" : "error"));
          return;
        }
        img.addEventListener("load", () => finish("load"), { once: true });
        img.addEventListener("error", () => finish("error"), { once: true });
        setTimeout(() => finish("timeout"), 1000);
      });

    const singleHost = document.createElement("div");
    document.body.appendChild(singleHost);
    singleHost.innerHTML = `<img srcset="${srcsetUrl} 1x">`;
    const single = await waitForImage(singleHost.querySelector("img"));

    const mixedHost = document.createElement("div");
    document.body.appendChild(mixedHost);
    const mixedOriginal = `/local-fallback.png 1x, ${srcsetUrl} 2x`;
    mixedHost.innerHTML = `<img srcset="${mixedOriginal}">`;
    const mixed = mixedHost.querySelector("img");

    return {
      mixed: snapshotImage(mixed, "not-waited"),
      mixedOriginal,
      single,
    };
  }, imageUrl);

  expect(result.single).toMatchObject({
    attr: `${imageUrl} 1x`,
    complete: true,
    currentSrc: imageUrl,
    event: "load",
    naturalHeight: 1,
    naturalWidth: 1,
    srcset: `${imageUrl} 1x`,
  });
  expect(result.single.outerHTML).toContain(`${imageUrl} 1x`);
  expect(result.single.outerHTML).not.toContain("data:image");
  expect(result.mixed).toMatchObject({
    attr: result.mixedOriginal,
    srcset: result.mixedOriginal,
  });
  expect(result.mixed.outerHTML).toContain(result.mixedOriginal);
  expect(result.mixed.outerHTML).not.toContain("data:image");

  await expect
    .poll(() => vectorCountsFor(extension, server.origin))
    .toMatchObject({ innerHTML: 2 });
});

test("innerHTML serialization restores original URLs for unquoted attributes", async ({
  extension,
  server,
}) => {
  await seedNoisePersona(extension, server.origin);

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate((url) => {
    // Use DOMParser to create an element with an unquoted attribute
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<img src=${url}>`, "text/html");
    const img = doc.body.firstChild;
    document.body.appendChild(img);
    return img.outerHTML;
  }, probedUrl("/icon.png"));

  expect(result).toContain(probedUrl("/icon.png"));
});
