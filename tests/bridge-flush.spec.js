const { expect, test } = require("./helpers/extension-fixture");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const probedUrl = (path = "/manifest.json") => `chrome-extension://${PROBED_ID}${path}`;

test("flushes pending probe batches when a page navigates away immediately", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  await page.evaluate(
    ({ nextUrl, url }) => {
      fetch(url).catch(() => {});
      setTimeout(() => {
        location.href = nextUrl;
      }, 0);
    },
    {
      nextUrl: server.url("/dom.html"),
      url: probedUrl(),
    }
  );

  await page.waitForURL(server.url("/dom.html"));

  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(() => chrome.storage.local.get(["cumulative", "probe_log"]))
    )
    .toMatchObject({
      cumulative: 1,
      probe_log: {
        [server.origin]: {
          idCounts: {
            [PROBED_ID]: 1,
          },
        },
      },
    });
});
