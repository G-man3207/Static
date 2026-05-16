const { expect, test } = require("./helpers/extension-fixture");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const probedUrl = (path = "/manifest.json") => `chrome-extension://${PROBED_ID}${path}`;

test("innerHTML serialization restores original URLs for single-quoted attributes", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(
    (origin, probedId) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [origin]: {
            idCounts: { [probedId]: 2 },
            lastUpdated: Date.now(),
          },
        },
        user_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    [server.origin, PROBED_ID]
  );

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

test("innerHTML serialization restores original URLs for unquoted attributes", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(
    (origin, probedId) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [origin]: {
            idCounts: { [probedId]: 2 },
            lastUpdated: Date.now(),
          },
        },
        user_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    [server.origin, PROBED_ID]
  );

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
