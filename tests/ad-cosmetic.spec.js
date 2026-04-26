const { expect, test } = require("./helpers/extension-fixture");

const dnrRuleCounts = (extension) =>
  extension.serviceWorker.evaluate(async () => {
    const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
    const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
    return {
      dynamic: dynamicRules.length,
      session: sessionRules.length,
    };
  });

const cosmeticEntry = (kind, value, score = 95) => ({
  diagnosticOnly: false,
  firstSeen: Date.now() - 1000,
  hits: 4,
  kind,
  lastSeen: Date.now(),
  score,
  value,
});

const storeCosmeticPlaybook = (extension, origin, entries, mode = "off") =>
  extension.serviceWorker.evaluate(
    ({ entries, mode, origin }) =>
      chrome.storage.local.set({
        ad_playbooks: {
          [origin]: {
            confidence: "high",
            cosmetic: entries,
            cosmeticSafe: true,
            disabled: false,
            lastUpdated: Date.now(),
            network: [],
            scripts: [],
            version: 1,
          },
        },
        ad_prefs: {
          lastUpdated: Date.now(),
          mode,
          sites: {},
          version: 1,
        },
      }),
    { entries, mode, origin }
  );

const setCleanupMode = (extension, mode) =>
  extension.serviceWorker.evaluate(
    (nextMode) =>
      chrome.storage.local.get({ ad_prefs: {} }).then(({ ad_prefs }) =>
        chrome.storage.local.set({
          ad_prefs: {
            ...ad_prefs,
            lastUpdated: Date.now(),
            mode: nextMode,
            version: 1,
          },
        })
      ),
    mode
  );

const setSiteCleanupDisabled = (extension, origin, disabled) =>
  extension.serviceWorker.evaluate(
    ({ disabled, origin }) =>
      chrome.storage.local.get({ ad_prefs: {} }).then(({ ad_prefs }) => {
        const sites = { ...(ad_prefs.sites || {}) };
        if (disabled) {
          sites[origin] = { cleanupDisabled: true, lastUpdated: Date.now() };
        } else {
          delete sites[origin];
        }
        return chrome.storage.local.set({
          ad_prefs: {
            ...ad_prefs,
            lastUpdated: Date.now(),
            sites,
            version: 1,
          },
        });
      }),
    { disabled, origin }
  );

const sendExtensionMessage = async (extension, message) => {
  const extensionPage = await extension.context.newPage();
  try {
    await extensionPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);
    return await extensionPage.evaluate((msg) => chrome.runtime.sendMessage(msg), message);
  } finally {
    await extensionPage.close();
  }
};

const adPlaybookFor = (extension, origin) =>
  extension.serviceWorker.evaluate(
    (originArg) =>
      chrome.storage.local
        .get("ad_playbooks")
        .then(({ ad_playbooks }) => ad_playbooks && ad_playbooks[originArg]),
    origin
  );

const adLogFor = (extension, origin) =>
  extension.serviceWorker.evaluate(
    (originArg) =>
      chrome.storage.local.get("ad_log").then(({ ad_log }) => ad_log && ad_log[originArg]),
    origin
  );

const elementState = (page, selector) =>
  page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      display: style.display,
      height: rect.height,
      marker: element.getAttribute("data-static-ad-cleanup"),
      top: rect.top,
      visibility: style.visibility,
    };
  });

test("cosmetic cleanup stays opt-in and restores when global mode turns off", async ({
  extension,
  server,
}) => {
  await storeCosmeticPlaybook(extension, server.origin, [
    cosmeticEntry("selector", "#ad-slot"),
    cosmeticEntry("selector", "#sticky-ad"),
  ]);

  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-cosmetic-slot.html"));
  const initialBelowTop = (await elementState(page, "#below")).top;

  expect(await elementState(page, "#ad-slot")).toMatchObject({
    marker: null,
    visibility: "visible",
  });

  await setCleanupMode(extension, "diagnostic");
  await page.waitForTimeout(150);
  expect(await elementState(page, "#ad-slot")).toMatchObject({
    marker: null,
    visibility: "visible",
  });

  await setCleanupMode(extension, "cosmetic");
  await expect
    .poll(() => elementState(page, "#ad-slot"))
    .toMatchObject({
      marker: "hide",
      visibility: "hidden",
    });
  const hiddenSlot = await elementState(page, "#ad-slot");
  expect(hiddenSlot.height).toBeGreaterThanOrEqual(240);
  expect((await elementState(page, "#below")).top).toBeCloseTo(initialBelowTop, 0);
  await expect
    .poll(() => elementState(page, "#sticky-ad"))
    .toMatchObject({
      display: "none",
      marker: "collapse",
    });

  await setCleanupMode(extension, "off");
  await expect
    .poll(() => elementState(page, "#ad-slot"))
    .toMatchObject({
      marker: null,
      visibility: "visible",
    });
  await expect
    .poll(() => elementState(page, "#sticky-ad"))
    .toMatchObject({
      display: "block",
      marker: null,
    });
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("per-site ad cleanup disable restores hidden elements without reload", async ({
  extension,
  server,
}) => {
  await storeCosmeticPlaybook(
    extension,
    server.origin,
    [cosmeticEntry("selector", "#ad-slot")],
    "cosmetic"
  );

  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-cosmetic-slot.html"));
  await expect
    .poll(() => elementState(page, "#ad-slot"))
    .toMatchObject({
      marker: "hide",
      visibility: "hidden",
    });

  await setSiteCleanupDisabled(extension, server.origin, true);
  await expect
    .poll(() => elementState(page, "#ad-slot"))
    .toMatchObject({
      marker: null,
      visibility: "visible",
    });
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("same-session fast learning hides learned slots on later same-origin navigation", async ({
  extension,
  server,
}) => {
  await setCleanupMode(extension, "cosmetic");

  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-session-first.html"));
  await expect.poll(() => page.evaluate(() => window.__adSessionDone === true)).toBe(true);
  await expect
    .poll(() => adLogFor(extension, server.origin).then((entry) => entry && entry.confidence))
    .toBe("high");

  await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get({ ad_playbooks: {} }).then(({ ad_playbooks }) => {
      delete ad_playbooks[origin];
      return chrome.storage.local.set({ ad_playbooks });
    });
  }, server.origin);
  await expect.poll(() => adPlaybookFor(extension, server.origin)).toBeFalsy();

  await page.goto(server.url("/ad-session-second.html"));
  await expect
    .poll(() => elementState(page, "#session-slot"))
    .toMatchObject({
      marker: "hide",
      visibility: "hidden",
    });
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("per-site disable ignores same-session learned cosmetic entries", async ({
  extension,
  server,
}) => {
  await setCleanupMode(extension, "cosmetic");

  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-observe-positive.html"));
  await expect.poll(() => page.evaluate(() => window.__adObserveDone === true)).toBe(true);
  await expect
    .poll(() => adLogFor(extension, server.origin).then((entry) => entry && entry.confidence))
    .toBe("high");

  await page.goto(server.url("/ad-cosmetic-slot.html"));
  await expect
    .poll(() => elementState(page, "#ad-slot"))
    .toMatchObject({
      marker: "hide",
      visibility: "hidden",
    });

  await sendExtensionMessage(extension, {
    disabled: true,
    origin: server.origin,
    type: "static_set_ad_cleanup_disabled",
  });

  await expect
    .poll(() => elementState(page, "#ad-slot"))
    .toMatchObject({
      marker: null,
      visibility: "visible",
    });

  await page.goto(server.url("/ad-cosmetic-slot.html"));
  await page.waitForTimeout(150);
  expect(await elementState(page, "#ad-slot")).toMatchObject({
    marker: null,
    visibility: "visible",
  });
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("empty learned ad iframes collapse only in cosmetic mode", async ({ extension, server }) => {
  await storeCosmeticPlaybook(
    extension,
    server.origin,
    [cosmeticEntry("selector", "#empty-ad-slot")],
    "cosmetic"
  );

  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-cosmetic-empty-frame.html"));

  await expect
    .poll(() => elementState(page, "#empty-ad-frame"))
    .toMatchObject({
      display: "none",
      marker: "collapse",
    });
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("cosmetic cleanup avoids common false-positive boundaries", async ({ extension, server }) => {
  const boundarySelectors = [
    "#comments-widget",
    "#product-card",
    "#video-card",
    "#dashboard-panel",
    "#sticky-nav",
    "#cookie-banner",
    "#recommendations",
    "#legit-300x250",
  ];
  await storeCosmeticPlaybook(
    extension,
    server.origin,
    [
      ...boundarySelectors.map((selector) => cosmeticEntry("selector", selector, 99)),
      cosmeticEntry("structure", "iframe:300x250,parent:section", 99),
    ],
    "cosmetic"
  );

  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-cosmetic-false-positives.html"));
  await page.waitForTimeout(250);

  await expect(page.locator("[data-static-ad-cleanup]")).toHaveCount(0);
  for (const selector of boundarySelectors) {
    await expect(page.locator(selector)).toBeVisible();
  }
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});
