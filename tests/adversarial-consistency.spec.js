const { expect, test } = require("./helpers/extension-fixture");
const {
  buildAdversarialReport,
  getProbeVectorCounts,
  runAdversarialProbe,
  seedNoisePersona,
} = require("./helpers/adversarial-probe");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const probedUrl = (path = "/manifest.json") => `chrome-extension://${PROBED_ID}${path}`;

const makeProbeUrls = () => ({
  cssUrl: probedUrl("/style.css"),
  eventsUrl: probedUrl("/events"),
  frameUrl: probedUrl("/page.html"),
  htmlUrl: probedUrl("/page.html"),
  imageUrl: probedUrl("/icon.png"),
  manifestUrl: probedUrl("/manifest.json"),
  scriptUrl: probedUrl("/content.js"),
  workerUrl: probedUrl("/worker.js"),
});

test("adversarial Noise harness finds no cross-vector contradictions", async ({
  extension,
  server,
}, testInfo) => {
  const page = await extension.context.newPage();
  const urls = makeProbeUrls();

  await seedNoisePersona(extension, server.origin, PROBED_ID);
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const probe = await runAdversarialProbe(page, urls);
  const report = buildAdversarialReport(probe, urls);
  await testInfo.attach("adversarial-report", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });

  expect(report.failed).toEqual([]);
  expect(report.passed).toBe(report.total);
  expect(report.checks).toEqual({
    activeSurfacesFailClosed: true,
    apiSurfaceNativeLike: true,
    attributeVectorsCoherent: true,
    networkVectorsAgree: true,
    passiveElementVectorsAgree: true,
  });

  const expectedVectors = {
    EventSource: 1,
    Worker: 1,
    "embed.src": 1,
    fetch: 2,
    "iframe.src": 1,
    "img.src": 1,
    "link.href": 1,
    "object.data": 1,
    "script.src": 1,
    sendBeacon: 1,
    "serviceWorker.register": 1,
    setAttribute: 1,
    "setAttribute-src": 1,
    "setAttributeNS-href": 1,
    "source.src": 1,
    xhr: 1,
  };

  await expect
    .poll(() => getProbeVectorCounts(extension, server.origin))
    .toMatchObject(
      probe.active.sharedWorker === "SecurityError"
        ? { ...expectedVectors, SharedWorker: 1 }
        : expectedVectors
    );
});
