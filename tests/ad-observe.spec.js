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

const activeTabId = (extension) =>
  extension.serviceWorker.evaluate(() =>
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab && tab.id)
  );

const openPopupForActiveTab = async (extension, tabId) => {
  const popupPage = await extension.context.newPage();
  await popupPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  await popupPage.evaluate((activeTabIdArg) => {
    return chrome.tabs.update(activeTabIdArg, { active: true });
  }, tabId);
  await popupPage.reload({ waitUntil: "load" });
  return popupPage;
};

const openPopupAdvancedControls = async (popupPage) => {
  await popupPage.locator("#advanced-controls > summary").click();
  await expect(popupPage.locator("#advanced-controls")).toHaveAttribute("open", "");
};

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

test("popup shows current-site ad diagnostics and local-only site controls", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-observe-positive.html"));
  await expect.poll(() => page.evaluate(() => window.__adObserveDone === true)).toBe(true);
  await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("ad_playbooks").then(({ ad_playbooks = {} }) =>
      chrome.storage.local.set({
        ad_playbooks: {
          ...ad_playbooks,
          [origin]: {
            confidence: "high",
            cosmetic: [{ kind: "selector", value: ".ad-slot", score: 86, hits: 4 }],
            disabled: false,
            lastUpdated: Date.now(),
            network: [
              {
                hits: 3,
                path: "same-origin:/collect/impression/:token",
                resourceTypes: ["ping"],
                score: 91,
              },
            ],
            version: 1,
          },
        },
      })
    );
  }, server.origin);

  await page.bringToFront();
  const tabId = await activeTabId(extension);
  const popupPage = await openPopupForActiveTab(extension, tabId);

  await expect(popupPage.locator("#ad-observed")).toHaveText("Ad behavior observed: High");
  await openPopupAdvancedControls(popupPage);
  await popupPage.getByText("Ad behavior diagnostics").click();
  await expect(popupPage.locator("#ad-diagnostics")).toContainText("Confidence");
  await expect(popupPage.locator("#ad-diagnostics")).toContainText("High");
  await expect(popupPage.locator("#ad-diagnostics")).toContainText("gpt.slot");
  await expect(popupPage.locator("#ad-diagnostics")).toContainText("score 35");
  await expect(popupPage.locator("#ad-diagnostics")).toContainText(".ad-slot");
  await expect(popupPage.locator("#ad-diagnostics")).toContainText(
    "same-origin:/collect/impression/:token"
  );

  await popupPage.locator("#ad-cleanup-disabled").check();
  await expect
    .poll(() =>
      extension.serviceWorker.evaluate((origin) => {
        return chrome.storage.local.get("ad_prefs").then(({ ad_prefs }) => {
          return !!(
            ad_prefs &&
            ad_prefs.sites &&
            ad_prefs.sites[origin] &&
            ad_prefs.sites[origin].cleanupDisabled
          );
        });
      }, server.origin)
    )
    .toBe(true);
  await expect(dnrRuleCounts(extension)).resolves.toEqual({ dynamic: 0, session: 0 });

  await popupPage.locator("#clear-ad-site-data").click();
  await expect
    .poll(() =>
      extension.serviceWorker.evaluate((origin) => {
        return chrome.storage.local.get(["ad_log", "ad_playbooks"]).then((stored) => ({
          hasLog: !!(stored.ad_log && stored.ad_log[origin]),
          hasPlaybook: !!(stored.ad_playbooks && stored.ad_playbooks[origin]),
        }));
      }, server.origin)
    )
    .toEqual({ hasLog: false, hasPlaybook: false });
  await expect(popupPage.locator("#ad-observed")).toBeHidden();
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("log viewer shows ad confidence reasons and learned entries", async ({ extension }) => {
  const origin = "https://ads.example.test";
  const now = Date.now();
  await extension.serviceWorker.evaluate(
    ({ now, origin }) =>
      chrome.storage.local.set({
        ad_log: {
          [origin]: {
            confidence: "likely",
            endpoints: { "same-origin:/ads/auction": 3 },
            firstSeen: now - 1000,
            lastUpdated: now,
            reasons: { "ad_iframe.size": 2, "gpt.slot": 2 },
            score: 55,
            sources: { "script:https://ads.example.test/static/loader.js": 2 },
            total: 4,
            version: 1,
          },
        },
        ad_playbooks: {
          [origin]: {
            confidence: "likely",
            cosmetic: [{ hits: 5, kind: "selector", score: 78, value: ".ad-card" }],
            disabled: true,
            lastUpdated: now,
            network: [
              {
                hits: 3,
                kind: "endpoint",
                path: "same-origin:/ads/auction",
                resourceTypes: ["xmlhttprequest"],
                score: 82,
              },
            ],
            version: 1,
          },
        },
      }),
    { now, origin }
  );

  const logPage = await extension.context.newPage();
  await logPage.goto(`chrome-extension://${extension.extensionId}/log.html`);
  await expect(logPage.getByText("1 ad behavior origin observed")).toBeVisible();
  await expect(logPage.locator("tr.origin-row")).toContainText(origin);
  await expect(logPage.locator(".ad-cell")).toContainText("Likely");

  await logPage.getByText(origin).click();
  await expect(logPage.getByText("Ad behavior observed: Likely")).toBeVisible();
  await expect(logPage.getByText(/gpt\.slot \(2, score 35\)/)).toBeVisible();
  await expect(logPage.getByText(/ad_iframe\.size \(2, score 20\)/)).toBeVisible();
  await expect(logPage.getByText("Learned cosmetic entries")).toBeVisible();
  await expect(logPage.getByText(/\.ad-card \(selector, score 78, 5 hits\)/)).toBeVisible();
  await expect(logPage.getByText("Learned endpoint entries")).toBeVisible();
  await expect(
    logPage.getByText("same-origin:/ads/auction (endpoint, score 82, 3 hits)")
  ).toBeVisible();
  await expect(logPage.getByText("Ad cleanup is disabled for this origin.")).toBeVisible();
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
