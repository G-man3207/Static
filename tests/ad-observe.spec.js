const { expect, test } = require("./helpers/extension-fixture");

const adLogFor = (extension, origin) =>
  extension.serviceWorker.evaluate(
    (originArg) =>
      chrome.storage.local.get("ad_log").then(({ ad_log }) => ad_log && ad_log[originArg]),
    origin
  );

const dnrRuleCounts = (extension) =>
  extension.serviceWorker.evaluate(async () => {
    const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
    const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
    return {
      dynamic: dynamicRules.length,
      session: sessionRules.length,
    };
  });

const adThresholds = (extension) =>
  extension.serviceWorker.evaluate(() => globalThis.__static_ad_signals__.thresholds);

test("correlated ad chain reaches high confidence without adding DNR rules", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-observe-positive.html"));
  await expect.poll(() => page.evaluate(() => window.__adObserveDone === true)).toBe(true);

  await expect.poll(() => adLogFor(extension, server.origin)).toBeTruthy();
  const adEntry = await adLogFor(extension, server.origin);
  const thresholds = await adThresholds(extension);
  expect(adEntry).toMatchObject({
    confidence: "high",
    reasons: expect.objectContaining({
      "ad_iframe.size": expect.any(Number),
      "gpt.slot": expect.any(Number),
      impression_beacon: expect.any(Number),
    }),
    version: 1,
  });
  expect(adEntry.score).toBeGreaterThanOrEqual(thresholds.high);
  expect(Object.keys(adEntry.endpoints)).toContain("same-origin:/collect/impression/:token");
  expect(JSON.stringify(adEntry)).not.toContain("1234567890abcdef1234567890abcdef");
  expect(JSON.stringify(adEntry)).not.toContain("secret-token");
  expect(JSON.stringify(adEntry)).not.toContain("body-should-not-store");
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("single ad-sized iframe stays low confidence", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-score-iframe-only.html"));
  await expect.poll(() => page.evaluate(() => window.__adIframeOnlyDone === true)).toBe(true);

  await expect.poll(() => adLogFor(extension, server.origin)).toBeTruthy();
  const adEntry = await adLogFor(extension, server.origin);
  const thresholds = await adThresholds(extension);
  expect(adEntry.confidence).toBe("low");
  expect(adEntry.score).toBeLessThan(thresholds.likely);
  expect(adEntry.reasons).toEqual({ "ad_iframe.size": 1 });
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("sponsored DOM alone stays low confidence", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-score-sponsored-dom-only.html"));
  await expect.poll(() => page.evaluate(() => window.__adSponsoredOnlyDone === true)).toBe(true);

  await expect.poll(() => adLogFor(extension, server.origin)).toBeTruthy();
  const adEntry = await adLogFor(extension, server.origin);
  const thresholds = await adThresholds(extension);
  expect(adEntry.confidence).toBe("low");
  expect(adEntry.score).toBeLessThan(thresholds.likely);
  expect(adEntry.reasons).toEqual({ sponsored_dom: 1 });
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("IntersectionObserver alone does not classify as ad behavior", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-score-intersection-only.html"));
  await expect.poll(() => page.evaluate(() => window.__adIntersectionOnlyDone === true)).toBe(true);
  await page.waitForTimeout(250);

  expect(await adLogFor(extension, server.origin)).toBeFalsy();
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("repeated weak signals do not promote to high confidence", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-score-repeated-weak.html"));
  await expect.poll(() => page.evaluate(() => window.__adRepeatedWeakDone === true)).toBe(true);

  await expect.poll(() => adLogFor(extension, server.origin)).toBeTruthy();
  const adEntry = await adLogFor(extension, server.origin);
  const thresholds = await adThresholds(extension);
  expect(adEntry.confidence).toBe("low");
  expect(adEntry.score).toBeLessThan(thresholds.likely);
  expect(adEntry.reasons["ad_iframe.size"]).toBeGreaterThan(1);
  expect(adEntry.reasons.sponsored_dom).toBeGreaterThan(1);
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("ordinary iframe and IntersectionObserver usage does not become high confidence", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-observe-negative.html"));
  await expect.poll(() => page.evaluate(() => window.__adNegativeDone === true)).toBe(true);

  const adEntry = await adLogFor(extension, server.origin);
  expect(adEntry).toBeTruthy();
  const thresholds = await adThresholds(extension);
  expect(adEntry.confidence).toBe("low");
  expect(adEntry.score).toBeLessThan(thresholds.likely);
  expect(adEntry.reasons["gpt.slot"]).toBeUndefined();
  expect(adEntry.reasons.impression_beacon).toBeUndefined();
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});
