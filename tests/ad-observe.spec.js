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

test("Ad observe-only logging records a GPT slot, ad iframe, and impression beacon", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-observe-positive.html"));
  await expect.poll(() => page.evaluate(() => window.__adObserveDone === true)).toBe(true);

  await expect.poll(() => adLogFor(extension, server.origin)).toBeTruthy();
  await expect.poll(() => adLogFor(extension, server.origin)).toBeTruthy();
  const adEntry = await adLogFor(extension, server.origin);
  expect(adEntry).toMatchObject({
    confidence: "high",
    reasons: expect.objectContaining({
      "ad_iframe.size": expect.any(Number),
      "gpt.slot": expect.any(Number),
      impression_beacon: expect.any(Number),
    }),
    version: 1,
  });
  expect(adEntry.score).toBeGreaterThanOrEqual(10);
  expect(Object.keys(adEntry.endpoints)).toContain("same-origin:/collect/impression/:token");
  expect(JSON.stringify(adEntry)).not.toContain("1234567890abcdef1234567890abcdef");
  expect(JSON.stringify(adEntry)).not.toContain("secret-token");
  expect(JSON.stringify(adEntry)).not.toContain("body-should-not-store");
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
  expect(adEntry.confidence).not.toBe("high");
  expect(adEntry.score).toBeLessThan(10);
  expect(adEntry.reasons["gpt.slot"]).toBeUndefined();
  expect(adEntry.reasons.impression_beacon).toBeUndefined();
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});
