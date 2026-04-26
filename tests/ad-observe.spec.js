const { expect, test } = require("./helpers/extension-fixture");

const adLogFor = (extension, origin) =>
  extension.serviceWorker.evaluate(
    (originArg) =>
      chrome.storage.local.get("ad_log").then(({ ad_log }) => ad_log && ad_log[originArg]),
    origin
  );

const adPlaybookFor = (extension, origin) =>
  extension.serviceWorker.evaluate(
    (originArg) =>
      chrome.storage.local
        .get("ad_playbooks")
        .then(({ ad_playbooks }) => ad_playbooks && ad_playbooks[originArg]),
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

const dnrSessionRules = (extension) =>
  extension.serviceWorker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());

const dnrDynamicRules = (extension) =>
  extension.serviceWorker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());

const adDynamicState = (extension) =>
  extension.serviceWorker.evaluate(() =>
    chrome.storage.local
      .get({ ad_dynamic_rules: {} })
      .then(({ ad_dynamic_rules }) => ad_dynamic_rules)
  );

const adThresholds = (extension) =>
  extension.serviceWorker.evaluate(() => globalThis.__static_ad_signals__.thresholds);

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

const sendExtensionMessage = async (extension, message) => {
  const extensionPage = await extension.context.newPage();
  try {
    await extensionPage.goto(`chrome-extension://${extension.extensionId}/popup.html`);
    return await extensionPage.evaluate((msg) => chrome.runtime.sendMessage(msg), message);
  } finally {
    await extensionPage.close();
  }
};

const rotateAdBrowserSession = (extension) =>
  extension.serviceWorker.evaluate(() => {
    if (!chrome.storage.session) return null;
    const next = `test-session-${Date.now()}-${Math.random()}`;
    return chrome.storage.session.set({ ad_browser_session_id: next }).then(() => next);
  });

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

test("repeated high-confidence observations learn a capped versioned playbook", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  for (let i = 0; i < 2; i++) {
    await page.goto(server.url("/ad-observe-positive.html"));
    await expect.poll(() => page.evaluate(() => window.__adObserveDone === true)).toBe(true);
  }

  await expect.poll(() => adPlaybookFor(extension, server.origin)).toBeTruthy();
  const playbook = await adPlaybookFor(extension, server.origin);
  expect(playbook.version).toBe(1);
  expect(playbook.confidence).toBe("high");
  expect(playbook.cosmetic.length).toBeLessThanOrEqual(24);
  expect(playbook.network.length).toBeLessThanOrEqual(24);
  expect(playbook.scripts.length).toBeLessThanOrEqual(16);
  expect(playbook.cosmetic).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        diagnosticOnly: false,
        kind: "selector",
        value: "#ad-slot",
      }),
      expect.objectContaining({
        diagnosticOnly: false,
        kind: "structure",
        value: expect.stringContaining("iframe:300x250"),
      }),
    ])
  );
  expect(playbook.scripts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "source",
        value: expect.stringContaining("/assets/ad/:token.js"),
      }),
    ])
  );
  expect(playbook.network).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "endpoint",
        path: "same-origin:/collect/impression/:token",
        resourceTypes: ["ping"],
      }),
    ])
  );
  expect(JSON.stringify(playbook)).not.toContain("1234567890abcdef1234567890abcdef");
  expect(JSON.stringify(playbook)).not.toContain("secret-token");
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("session DNR quarantine creates narrow temporary rules only after repeated opt-in evidence", async ({
  extension,
  server,
}) => {
  await setCleanupMode(extension, "cosmetic");
  const page = await extension.context.newPage();

  await page.goto(server.url("/ad-dnr-fetch.html"));
  await expect.poll(() => page.evaluate(() => window.__adDnrFetchDone === true)).toBe(true);
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });

  await page.goto(server.url("/ad-dnr-fetch.html"));
  await expect.poll(() => page.evaluate(() => window.__adDnrFetchDone === true)).toBe(true);
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 1 });

  const [rule] = await dnrSessionRules(extension);
  const host = new URL(server.origin).hostname;
  expect(rule).toMatchObject({
    action: { type: "block" },
    condition: {
      initiatorDomains: [host],
      requestDomains: [host],
      resourceTypes: ["xmlhttprequest"],
    },
    priority: 1,
  });
  expect(rule.condition.urlFilter).toBe(`|${server.origin}/collect/impression/`);
  expect(rule.condition.urlFilter).not.toContain("1234567890abcdef1234567890abcdef");
  expect(rule.condition.urlFilter).not.toContain("secret-token");

  await page.goto(server.url("/ad-dnr-fetch-check.html"));
  await expect.poll(() => page.evaluate(() => window.__adDnrFetchStatus)).toBe("blocked");

  await page.goto(server.url("/ad-dnr-fetch.html"));
  await expect.poll(() => page.evaluate(() => window.__adDnrFetchDone === true)).toBe(true);
  await page.bringToFront();
  const tabId = await activeTabId(extension);
  const popupPage = await openPopupForActiveTab(extension, tabId);
  await openPopupAdvancedControls(popupPage);
  await popupPage.getByText("Ad behavior diagnostics").click();
  await expect(popupPage.locator("#ad-diagnostics")).toContainText("Session blocks");
  await expect(popupPage.locator("#ad-diagnostics")).toContainText(
    "same-origin:/collect/impression/*"
  );

  const logPage = await extension.context.newPage();
  await logPage.goto(`chrome-extension://${extension.extensionId}/log.html`);
  await expect(logPage.getByText(server.origin)).toBeVisible();
  await logPage.getByText(server.origin).click();
  await expect(logPage.getByText("Session network blocks")).toBeVisible();
  await expect(logPage.getByText("same-origin:/collect/impression/*")).toBeVisible();
});

test("session DNR quarantine skips unsafe API-looking endpoints", async ({ extension, server }) => {
  await setCleanupMode(extension, "cosmetic");
  const page = await extension.context.newPage();
  for (let i = 0; i < 2; i++) {
    await page.goto(server.url("/ad-dnr-api.html"));
    await expect.poll(() => page.evaluate(() => window.__adDnrApiDone === true)).toBe(true);
  }

  const playbook = await adPlaybookFor(extension, server.origin);
  expect(playbook && playbook.network).toEqual([]);
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("persistent local promotion requires repeated endpoint evidence across browser sessions", async ({
  extension,
  server,
}) => {
  await setCleanupMode(extension, "cosmetic");
  const page = await extension.context.newPage();

  for (let i = 0; i < 4; i++) {
    await page.goto(server.url("/ad-dnr-fetch.html"));
    await expect.poll(() => page.evaluate(() => window.__adDnrFetchDone === true)).toBe(true);
  }
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 1 });

  await rotateAdBrowserSession(extension);
  await page.goto(server.url("/ad-dnr-fetch.html"));
  await expect.poll(() => page.evaluate(() => window.__adDnrFetchDone === true)).toBe(true);
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 1, session: 1 });

  const [rule] = await dnrDynamicRules(extension);
  const host = new URL(server.origin).hostname;
  expect(rule).toMatchObject({
    action: { type: "block" },
    condition: {
      initiatorDomains: [host],
      requestDomains: [host],
      resourceTypes: ["xmlhttprequest"],
    },
    priority: 1,
  });
  expect(rule.condition.urlFilter).toBe(`|${server.origin}/collect/impression/`);
  expect(rule.condition.urlFilter).not.toContain("1234567890abcdef1234567890abcdef");
  expect(rule.condition.urlFilter).not.toContain("secret-token");

  const dynamicState = await adDynamicState(extension);
  const [meta] = Object.values(dynamicState.rules || {}).filter(
    (entry) => entry.origin === server.origin
  );
  expect(meta).toMatchObject({
    hits: expect.any(Number),
    kind: "endpoint",
    path: "same-origin:/collect/impression/:token",
    resourceTypes: ["xmlhttprequest"],
    sessionCount: 2,
    status: "persistent",
  });
  expect(meta.hits).toBeGreaterThanOrEqual(4);

  await page.bringToFront();
  const tabId = await activeTabId(extension);
  const popupPage = await openPopupForActiveTab(extension, tabId);
  await openPopupAdvancedControls(popupPage);
  await popupPage.getByText("Ad behavior diagnostics").click();
  await expect(popupPage.locator("#ad-diagnostics")).toContainText("Persistent blocks");
  await expect(popupPage.locator("#ad-diagnostics")).toContainText(
    "same-origin:/collect/impression/*"
  );

  const logPage = await extension.context.newPage();
  await logPage.goto(`chrome-extension://${extension.extensionId}/log.html`);
  await logPage.getByText(server.origin).click();
  await expect(logPage.getByText("Persistent network blocks")).toBeVisible();
  await expect(
    logPage.getByText(/same-origin:\/collect\/impression\/\* \(dynamic-rule/)
  ).toBeVisible();

  await popupPage.locator("#clear-ad-persistent-network").click();
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 1 });
  const clearedDynamicState = await adDynamicState(extension);
  expect(
    Object.values(clearedDynamicState.rules || {}).some((entry) => entry.origin === server.origin)
  ).toBe(false);
});

test("disable and clear site data remove persistent learned ad DNR rules", async ({
  extension,
  server,
}) => {
  await setCleanupMode(extension, "cosmetic");
  const page = await extension.context.newPage();
  for (let i = 0; i < 4; i++) {
    await page.goto(server.url("/ad-dnr-fetch.html"));
    await expect.poll(() => page.evaluate(() => window.__adDnrFetchDone === true)).toBe(true);
  }
  await rotateAdBrowserSession(extension);
  await page.goto(server.url("/ad-dnr-fetch.html"));
  await expect.poll(() => page.evaluate(() => window.__adDnrFetchDone === true)).toBe(true);
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 1, session: 1 });

  await sendExtensionMessage(extension, {
    disabled: true,
    origin: server.origin,
    type: "static_set_ad_cleanup_disabled",
  });
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });

  await sendExtensionMessage(extension, {
    disabled: false,
    origin: server.origin,
    type: "static_set_ad_cleanup_disabled",
  });
  await page.goto(server.url("/ad-dnr-fetch.html"));
  await expect.poll(() => page.evaluate(() => window.__adDnrFetchDone === true)).toBe(true);
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 1 });

  await sendExtensionMessage(extension, {
    origin: server.origin,
    type: "static_clear_ad_site_data",
  });
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
  const dynamicState = await adDynamicState(extension);
  expect(
    Object.values(dynamicState.rules || {}).some((entry) => entry.origin === server.origin)
  ).toBe(false);
});

test("per-site disable and clear learned ad data remove session DNR quarantine rules", async ({
  extension,
  server,
}) => {
  await setCleanupMode(extension, "cosmetic");
  const page = await extension.context.newPage();
  for (let i = 0; i < 2; i++) {
    await page.goto(server.url("/ad-dnr-fetch.html"));
    await expect.poll(() => page.evaluate(() => window.__adDnrFetchDone === true)).toBe(true);
  }
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 1 });

  await sendExtensionMessage(extension, {
    disabled: true,
    origin: server.origin,
    type: "static_set_ad_cleanup_disabled",
  });
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });

  await sendExtensionMessage(extension, {
    disabled: false,
    origin: server.origin,
    type: "static_set_ad_cleanup_disabled",
  });
  await page.goto(server.url("/ad-dnr-fetch.html"));
  await expect.poll(() => page.evaluate(() => window.__adDnrFetchDone === true)).toBe(true);
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 1 });

  await sendExtensionMessage(extension, {
    origin: server.origin,
    type: "static_clear_ad_site_data",
  });
  await expect.poll(() => dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("broad cosmetic selectors stay diagnostics-only while structures can be learned", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  for (let i = 0; i < 2; i++) {
    await page.goto(server.url("/ad-playbook-broad-selector.html"));
    await expect.poll(() => page.evaluate(() => window.__adBroadSelectorDone === true)).toBe(true);
  }

  await expect.poll(() => adPlaybookFor(extension, server.origin)).toBeTruthy();
  const playbook = await adPlaybookFor(extension, server.origin);
  const broadSelector = playbook.cosmetic.find((entry) => entry.value === "div.ad");
  expect(broadSelector).toMatchObject({
    diagnosticOnly: true,
    kind: "selector",
    reason: "broad-selector",
  });
  expect(
    playbook.cosmetic.some(
      (entry) => entry.kind === "selector" && entry.value === "div.ad" && !entry.diagnosticOnly
    )
  ).toBe(false);
  expect(playbook.cosmetic).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        diagnosticOnly: false,
        kind: "structure",
        value: expect.stringContaining("iframe:300x250"),
      }),
    ])
  );
  expect(playbook.network).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "endpoint",
        path: "same-origin:/collect/impression/:token",
      }),
    ])
  );
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("per-site ad cleanup disable prevents new playbook learning", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.set({
      ad_prefs: {
        sites: {
          [origin]: {
            cleanupDisabled: true,
            lastUpdated: Date.now(),
          },
        },
        version: 1,
      },
    });
  }, server.origin);

  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-observe-positive.html"));
  await expect.poll(() => page.evaluate(() => window.__adObserveDone === true)).toBe(true);

  await expect.poll(() => adLogFor(extension, server.origin)).toBeTruthy();
  const playbook = await adPlaybookFor(extension, server.origin);
  expect(playbook).toBeFalsy();
  expect(await dnrRuleCounts(extension)).toEqual({ dynamic: 0, session: 0 });
});

test("stale playbook entries demote to diagnostics-only on later observations", async ({
  extension,
  server,
}) => {
  const staleSeenAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
  await extension.serviceWorker.evaluate(
    ({ origin, staleSeenAt }) =>
      chrome.storage.local.set({
        ad_playbooks: {
          [origin]: {
            confidence: "high",
            cosmetic: [
              {
                diagnosticOnly: false,
                firstSeen: staleSeenAt,
                hits: 6,
                kind: "selector",
                lastSeen: staleSeenAt,
                score: 95,
                value: "#old-ad-slot",
              },
            ],
            disabled: false,
            lastUpdated: staleSeenAt,
            network: [],
            scripts: [],
            version: 1,
          },
        },
      }),
    { origin: server.origin, staleSeenAt }
  );

  const page = await extension.context.newPage();
  await page.goto(server.url("/ad-observe-positive.html"));
  await expect.poll(() => page.evaluate(() => window.__adObserveDone === true)).toBe(true);

  await expect.poll(() => adPlaybookFor(extension, server.origin)).toBeTruthy();
  const playbook = await adPlaybookFor(extension, server.origin);
  const staleEntry = playbook.cosmetic.find((entry) => entry.value === "#old-ad-slot");
  expect(staleEntry).toMatchObject({
    diagnosticOnly: true,
    reason: "stale",
    status: "stale",
  });
  expect(staleEntry.score).toBeLessThan(50);
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
