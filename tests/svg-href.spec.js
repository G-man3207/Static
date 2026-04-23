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

const vectorCountsFor = (extension, origin) =>
  extension.serviceWorker.evaluate(
    (pageOrigin) =>
      chrome.storage.local.get("probe_log").then(({ probe_log }) => {
        const weeks =
          probe_log &&
          probe_log[pageOrigin] &&
          probe_log[pageOrigin].playbook &&
          probe_log[pageOrigin].playbook.weeks;
        return (weeks && Object.values(weeks)[0].vectorCounts) || {};
      }),
    origin
  );

test("Noise handles SVG namespaced href and animated href probes consistently", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await seedNoisePersona(extension, server.origin);

  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate((imageUrl) => {
    const svgNs = "http://www.w3.org/2000/svg";
    const xlinkNs = "http://www.w3.org/1999/xlink";
    const use = document.createElementNS(svgNs, "use");
    use.setAttributeNS(xlinkNs, "xlink:href", imageUrl);

    const image = document.createElementNS(svgNs, "image");
    image.href.baseVal = imageUrl;
    const imageHref = image.href;

    const anchor = document.createElementNS(svgNs, "a");
    anchor.setAttributeNS(xlinkNs, "xlink:href", imageUrl);

    const useHref = use.href;
    return {
      anchor: {
        attr: anchor.getAttribute("xlink:href"),
        attrNS: anchor.getAttributeNS(xlinkNs, "href"),
        baseVal: anchor.href.baseVal,
      },
      image: {
        attr: image.getAttribute("href"),
        attrNS: image.getAttributeNS(xlinkNs, "href"),
        baseVal: imageHref.baseVal,
        hrefInstance: imageHref instanceof SVGAnimatedString,
        sameHrefObject: imageHref === image.href,
      },
      use: {
        attr: use.getAttribute("xlink:href"),
        attrNS: use.getAttributeNS(xlinkNs, "href"),
        baseVal: useHref.baseVal,
        hrefAttr: use.getAttribute("href"),
        hrefInstance: useHref instanceof SVGAnimatedString,
        sameHrefObject: useHref === use.href,
      },
    };
  }, probedUrl(PROBED_ID, "/icon.png"));

  expect(result).toEqual({
    anchor: {
      attr: null,
      attrNS: null,
      baseVal: "",
    },
    image: {
      attr: probedUrl(PROBED_ID, "/icon.png"),
      attrNS: null,
      baseVal: probedUrl(PROBED_ID, "/icon.png"),
      hrefInstance: true,
      sameHrefObject: true,
    },
    use: {
      attr: probedUrl(PROBED_ID, "/icon.png"),
      attrNS: probedUrl(PROBED_ID, "/icon.png"),
      baseVal: probedUrl(PROBED_ID, "/icon.png"),
      hrefAttr: null,
      hrefInstance: true,
      sameHrefObject: true,
    },
  });

  await expect.poll(() => vectorCountsFor(extension, server.origin)).toMatchObject({
    "setAttributeNS-href": 1,
    "svg.image.href": 1,
    setAttributeNS: 1,
  });
});
