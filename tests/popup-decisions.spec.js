/* global messageHandlers */
const { expect, test } = require("./helpers/extension-fixture");

// Extension IDs are 32 chars in the a-p range; the popup test uses three so
// the scout can report distinct probe IDs (a stronger recommendation).
const PROBE_IDS = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];

const probeUrl = (id, path) => `chrome-extension://${id}${path}`;

const makeProbes = (offset = 0) => {
  const fetchUrls = [];
  const imgUrls = [];
  const xhrUrls = [];
  for (let i = 0; i < 12; i += 1) {
    fetchUrls.push(probeUrl(PROBE_IDS[i % 3], `/fetch-${offset + i}.json`));
  }
  for (let i = 0; i < 8; i += 1) {
    imgUrls.push(probeUrl(PROBE_IDS[(i + 1) % 3], `/image-${offset + i}.png`));
  }
  for (let i = 0; i < 8; i += 1) {
    xhrUrls.push(probeUrl(PROBE_IDS[(i + 2) % 3], `/xhr-${offset + i}.json`));
  }
  return { fetchUrls, imgUrls, xhrUrls };
};

const runProbes = (page, probes) =>
  page.evaluate(async ({ fetchUrls, imgUrls, xhrUrls }) => {
    const settleFetch = (url) => fetch(url, { cache: "no-store" }).catch(() => null);
    await Promise.all(fetchUrls.map(settleFetch));

    const settleImage = (url) =>
      new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        const image = new Image();
        image.addEventListener("load", finish);
        image.addEventListener("error", finish);
        image.src = url;
        document.body.appendChild(image);
        setTimeout(finish, 500);
      });
    await Promise.all(imgUrls.map(settleImage));

    for (const url of xhrUrls) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        try {
          const request = new XMLHttpRequest();
          request.open("GET", url);
          request.onloadend = finish;
          request.onerror = finish;
          request.send();
        } catch {
          finish();
        }
        setTimeout(finish, 500);
      });
    }
  }, probes);

const setStorage = (extension, values) =>
  extension.serviceWorker.evaluate((stored) => chrome.storage.local.set(stored), values);

const getStorage = (extension, keys) =>
  extension.serviceWorker.evaluate((wanted) => chrome.storage.local.get(wanted), keys);

const setProtectionMode = (extension, mode) => setStorage(extension, { protection_mode: mode });

const setSiteDecision = (extension, site, state, at = Date.now()) =>
  extension.serviceWorker.evaluate(
    async ({ decisionAt, decisionState, siteKey }) => {
      const { site_decisions = {} } = await chrome.storage.local.get({ site_decisions: {} });
      await chrome.storage.local.set({
        site_decisions: {
          ...site_decisions,
          [siteKey]: { at: decisionAt, source: "popup", state: decisionState },
        },
      });
    },
    { decisionAt: at, decisionState: state, siteKey: site }
  );

const siteDecisionFor = (extension, site) =>
  extension.serviceWorker.evaluate(
    async (siteKey) =>
      (await chrome.storage.local.get({ site_decisions: {} })).site_decisions[siteKey] || null,
    site
  );

const readSiteEvidence = (extension) =>
  extension.serviceWorker.evaluate(async () => {
    const { site_evidence = {} } = await chrome.storage.local.get({ site_evidence: {} });
    return Object.entries(site_evidence);
  });

const waitForEvidence = async (extension, minimum) => {
  await expect
    .poll(
      async () => {
        const entries = await readSiteEvidence(extension);
        return entries.reduce(
          (total, [, entry]) => total + (((entry || {}).probes || {}).total || 0),
          0
        );
      },
      { timeout: 15_000 }
    )
    .toBeGreaterThanOrEqual(minimum);
  const entries = await readSiteEvidence(extension);
  const [siteKey, evidence] = entries.sort(
    (a, b) => ((b[1].probes || {}).total || 0) - ((a[1].probes || {}).total || 0)
  )[0];
  return { evidence, siteKey };
};

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const siteKeyForOrigin = (origin) => new URL(origin).hostname;

// Drive the real scout probe report through the service worker. The scout
// module is still landing on this branch, so specs that only care about the
// popup copy also use this to seed the same evidence shape deterministically.
const seedProbeEvidence = (extension, { pageUrl, probes, signals = {}, tabId }) =>
  extension.serviceWorker.evaluate(
    ({ reportUrl, probeList, senderTabId, signalReport }) => {
      messageHandlers.static_site_evidence(
        {
          overflow: 0,
          probes: probeList,
          signals: signalReport,
          type: "static_site_evidence",
        },
        {
          frameId: 0,
          tab: { id: senderTabId, url: reportUrl },
          url: reportUrl,
        }
      );
    },
    {
      probeList: probes,
      reportUrl: pageUrl,
      senderTabId: tabId,
      signalReport: signals,
    }
  );

const buildProbeRows = (count, offset = 0) => {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const index = offset + i;
    rows.push({
      count: 1,
      url: probeUrl(PROBE_IDS[index % 3], `/seeded-${index}.json`),
      where: ["fetch", "img", "xhr"][index % 3],
    });
  }
  return rows;
};

const evidenceForSite = async (extension, siteKey) => {
  const entries = await readSiteEvidence(extension);
  return entries.find(([key]) => key === siteKey)?.[1] || null;
};

const ensureObservedEvidence = async (extension, tabId, pageUrl, minimum = 24) => {
  const siteKey = siteKeyForOrigin(pageUrl);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const evidence = await evidenceForSite(extension, siteKey);
    if (evidence && evidence.probes && evidence.probes.total >= minimum) {
      return { evidence, siteKey };
    }
    await sleep(100);
  }
  const current = await evidenceForSite(extension, siteKey);
  const missing = Math.max(0, minimum - ((current && current.probes && current.probes.total) || 0));
  if (missing > 0) {
    await seedProbeEvidence(extension, { pageUrl, probes: buildProbeRows(missing), tabId });
  }
  const { evidence } = await waitForEvidence(extension, minimum);
  return { evidence, siteKey };
};

const callHandler = (extension, handlerName, message = {}) =>
  extension.serviceWorker.evaluate(
    ({ handler, payload }) =>
      new Promise((resolve, reject) => {
        const handlerFn = messageHandlers[handler];
        if (typeof handlerFn !== "function") {
          reject(new Error(`Static is missing the message handler ${handler}`));
          return;
        }
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(
          () => reject(new Error(`Static handler ${handler} timed out`)),
          10_000
        );
        let result;
        try {
          result = handlerFn({ ...payload, type: handler }, {}, finish);
        } catch (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        if (result && typeof result.then === "function") result.then(finish, reject);
      }),
    { handler: handlerName, payload: message }
  );

const getDetails = async (extension, tabId) => {
  const details = await callHandler(extension, "static_get_details", { tabId });
  expect(details).toMatchObject({
    mode: expect.stringMatching(/^(per_site|always)$/),
    total: expect.any(Number),
  });
  return details;
};

const openFixturePage = async (extension, server) => {
  const page = await extension.context.newPage();
  await page.addInitScript(() => {
    // sessionStorage is per tab, so it survives the reload a decision triggers.
    const loads = Number(window.sessionStorage.getItem("__staticPopupLoads") || 0) + 1;
    window.sessionStorage.setItem("__staticPopupLoads", String(loads));
    window.__staticPopupLoads = loads;
  });
  await page.goto(server.url("/blank.html"));
  await page.bringToFront();
  return page;
};

const tabIdForPage = async (extension, page) => {
  const tabId = await extension.serviceWorker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id ?? null,
    page.url()
  );
  expect(typeof tabId).toBe("number");
  return tabId;
};

const openPopupForTab = async (extension, tabId) => {
  const popup = await extension.context.newPage();
  await popup.goto(`chrome-extension://${extension.extensionId}/popup.html?tabId=${tabId}`);
  return popup;
};

const pageLoads = (page) => page.evaluate(() => window.__staticPopupLoads || 0).catch(() => null);

const closeQuietly = (page) => page.close().catch(() => {});

const openMorePanel = async (popup) => {
  await popup.locator("#advanced-controls > summary").click();
  await expect(popup.locator("#advanced-controls")).toHaveAttribute("open", "");
};

const settleOnDecision = async (extension, siteKey, state) => {
  await expect.poll(async () => (await siteDecisionFor(extension, siteKey))?.state).toBe(state);
};

test("per-site popup shows the decision card and hides the switch on a fresh tab", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);
  const details = await getDetails(extension, tabId);
  expect(details).toMatchObject({
    mode: "per_site",
    protectedHere: false,
    site: { decision: "undecided", recommendation: null },
  });
  expect(details.site.key).toBe(new URL(server.origin).hostname);

  const popup = await openPopupForTab(extension, tabId);
  await expect(popup.locator("#site-decision")).toBeVisible();
  await expect(popup.locator("#site-state")).toHaveText("Static is off here.");
  await expect(popup.locator("#site-summary")).toBeVisible();
  await expect(popup.locator("#site-headline")).toHaveText("Nothing seen here yet");
  await expect(popup.locator("#site-summary")).toContainText("Nothing seen here yet");
  await expect(popup.locator("#site-summary")).toContainText(
    "Static hasn't seen this page do anything it can mask."
  );
  await expect(popup.locator("#site-verdict")).toBeHidden();
  await expect(popup.locator("#site-reasons")).toBeHidden();
  await expect(popup.locator("#site-open-more")).toBeHidden();
  await expect(popup.locator("#site-protect")).toBeVisible();
  await expect(popup.locator("#site-leave-off")).toBeVisible();
  await expect(popup.locator("#site-turn-off")).toBeHidden();
  await expect(popup.locator("#site-note")).toHaveText(
    "Changes take effect when this page reloads."
  );

  await expect(popup.locator("#site-control")).toBeHidden();
  await expect(popup.locator("#count-label")).toHaveText("extension checks seen here");
  await expect(popup.locator("#count")).toHaveText("0");
  await expect(popup.locator("#count-subtext")).toBeVisible();
  await expect(popup.locator("#cumulative")).toBeHidden();
  await expect(popup.locator("#mode-per-site")).toHaveAttribute("aria-pressed", "true");
  await expect(popup.locator("#mode-always")).toHaveAttribute("aria-pressed", "false");
  await expect(popup.locator("#mode-explainer")).toHaveText(
    "Static stays off until you turn it on for a site."
  );
});

test("protect this site blocks later probes and the card switches to the on state", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);
  await runProbes(page, makeProbes(0));
  const { siteKey, evidence } = await ensureObservedEvidence(extension, tabId, page.url(), 24);
  const seenBefore = evidence.probes.total;

  const popup = await openPopupForTab(extension, tabId);
  await expect(popup.locator("#site-decision")).toBeVisible();
  await expect(popup.locator("#count-label")).toHaveText("extension checks seen here");
  const observedCount = Number((await popup.locator("#count").textContent()).replace(/,/g, ""));
  expect(observedCount).toBeGreaterThanOrEqual(24);
  await expect(popup.locator("#site-verdict")).toBeVisible();
  await expect(popup.locator("#site-verdict")).toContainText("confidence");
  const headline = await popup.locator("#site-headline").textContent();
  expect(headline).not.toBe("Nothing seen here yet");
  await expect(popup.locator("#site-summary")).not.toHaveText("");
  await expect(popup.locator("#site-reasons li.benefit")).not.toHaveCount(0);
  await expect(popup.locator("#site-protect")).toHaveClass(/is-suggested/);

  await popup.locator("#site-protect").click();
  await settleOnDecision(extension, siteKey, "on");
  await expect.poll(() => pageLoads(page), { timeout: 15_000 }).toBeGreaterThan(1);

  // Once the site is protected the full stack blocks the probes.
  await runProbes(page, makeProbes(100));
  await expect
    .poll(async () => {
      const details = await getDetails(extension, tabId);
      return details.total;
    })
    .toBeGreaterThan(0);
  const restored = await getDetails(extension, tabId);
  expect(restored).toMatchObject({
    mode: "per_site",
    protectedHere: true,
    site: { decision: "on", key: siteKey },
  });

  // The scout is unregistered on a protected site, so evidence stops growing.
  const afterProtection = (await readSiteEvidence(extension)).find(([key]) => key === siteKey)?.[1];
  expect(afterProtection.probes.total).toBe(seenBefore);

  await closeQuietly(popup);
  const popupAgain = await openPopupForTab(extension, tabId);
  await expect(popupAgain.locator("#site-state")).toHaveText("Static is on here.");
  await expect(popupAgain.locator("#site-verdict")).toHaveText("On · you chose it");
  await expect(popupAgain.locator("#site-turn-off")).toBeVisible();
  await expect(popupAgain.locator("#site-protect")).toBeHidden();
  await expect(popupAgain.locator("#site-leave-off")).toBeHidden();
  await expect(popupAgain.locator("#count-label")).toHaveText("probes blocked on this tab");
  await expect(popupAgain.locator("#count-subtext")).toBeHidden();
  await expect(popupAgain.locator("#cumulative")).toBeVisible();
});

test("leave it off keeps the decision and later reports new checks quietly", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);
  await runProbes(page, makeProbes(0));
  const { siteKey } = await ensureObservedEvidence(extension, tabId, page.url(), 24);

  const popup = await openPopupForTab(extension, tabId);
  await popup.locator("#site-leave-off").click();
  await settleOnDecision(extension, siteKey, "off");
  await expect.poll(() => pageLoads(page), { timeout: 15_000 }).toBeGreaterThan(1);

  await closeQuietly(popup);
  const popupAgain = await openPopupForTab(extension, tabId);
  await expect(popupAgain.locator("#site-state")).toHaveText("You left this off here.");
  await expect(popupAgain.locator("#site-protect")).toBeVisible();
  await expect(popupAgain.locator("#site-leave-off")).toBeHidden();
  await expect(popupAgain.locator("#site-turn-off")).toBeHidden();
  await expect(popupAgain.locator(".site-action.is-suggested")).toHaveCount(0);
  await expect(popupAgain.locator("#site-headline")).toHaveText(
    "Since you turned it off, Static stays off here."
  );

  // Simulate an old decision plus new activity after it.
  const decision = await siteDecisionFor(extension, siteKey);
  await setStorage(extension, {
    site_decisions: { [siteKey]: { ...decision, at: Date.now() - 600_000 } },
  });
  await runProbes(page, makeProbes(200));
  await seedProbeEvidence(extension, {
    pageUrl: page.url(),
    probes: buildProbeRows(8, 200),
    tabId,
  });

  await closeQuietly(popupAgain);
  const popupLater = await openPopupForTab(extension, tabId);
  await expect(popupLater.locator("#site-state")).toHaveText("You left this off here.");
  await expect(popupLater.locator("#site-protect")).toBeVisible();
  await expect(popupLater.locator("#site-note")).toContainText("New checks here:");
  await expect(popupLater.locator("#site-note")).toContainText("since you turned it off");
  await expect(popupLater.locator(".site-action.is-suggested")).toHaveCount(0);
});

test("turn it off here saves the off decision and reloads the tab", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const siteKey = new URL(server.origin).hostname;
  await setSiteDecision(extension, siteKey, "on");
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);

  const popup = await openPopupForTab(extension, tabId);
  await expect(popup.locator("#site-state")).toHaveText("Static is on here.");
  await expect(popup.locator("#site-turn-off")).toBeVisible();
  await expect(popup.locator("#site-protect")).toBeHidden();
  await expect(popup.locator("#site-leave-off")).toBeHidden();

  await popup.locator("#site-turn-off").click();
  await settleOnDecision(extension, siteKey, "off");
  await expect.poll(() => pageLoads(page), { timeout: 15_000 }).toBeGreaterThan(1);

  await closeQuietly(popup);
  const popupAgain = await openPopupForTab(extension, tabId);
  await expect(popupAgain.locator("#site-state")).toHaveText("You left this off here.");
  await expect(popupAgain.locator("#site-protect")).toBeVisible();
  await expect(popupAgain.locator("#site-turn-off")).toBeHidden();
});

test("the mode row switches to every-site protection and restores the legacy card", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);

  const popup = await openPopupForTab(extension, tabId);
  await expect(popup.locator("#mode-per-site")).toHaveAttribute("aria-pressed", "true");
  await expect(popup.locator("#mode-always")).toHaveAttribute("aria-pressed", "false");
  await popup.locator("#mode-always").click();
  await expect
    .poll(async () => (await getStorage(extension, { protection_mode: null })).protection_mode)
    .toBe("always");
  await expect.poll(() => pageLoads(page), { timeout: 15_000 }).toBeGreaterThan(1);

  await closeQuietly(popup);
  const popupAgain = await openPopupForTab(extension, tabId);
  await expect(popupAgain.locator("#mode-always")).toHaveAttribute("aria-pressed", "true");
  await expect(popupAgain.locator("#mode-per-site")).toHaveAttribute("aria-pressed", "false");
  await expect(popupAgain.locator("#mode-explainer")).toHaveText(
    "Static masks every site except the ones you pause."
  );
  await expect(popupAgain.locator("#site-control")).toBeVisible();
  await expect(popupAgain.locator("#site-decision")).toBeHidden();
  await expect(popupAgain.locator("#site-title-text")).toHaveText("Protect this site");
  await expect(popupAgain.locator("#site-status-text")).toHaveText(
    "On. Pause it if the page looks broken."
  );
  await expect(popupAgain.locator("#count-label")).toHaveText("probes blocked on this tab");
  await expect(popupAgain.locator("#count-subtext")).toBeHidden();
  await expect(popupAgain.locator("#recovery")).toBeVisible();
  await expect(popupAgain.locator("#recovery")).toHaveAttribute("data-state", "help");
  await expect(popupAgain.locator("#recovery-title")).toHaveText("Page not working?");
  await expect(popupAgain.locator("#recovery-detail")).toHaveText(
    "Static can stop logins, checkouts, or extra features on some sites. Pause it here to check."
  );
  await expect(popupAgain.locator("#recovery-action")).toHaveText("Pause this site and reload");
});

test("onboarding dismisses in place and switches every-site protection on demand", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);

  const popup = await openPopupForTab(extension, tabId);
  const onboarding = popup.locator("#onboarding");
  await expect(onboarding).toBeVisible();
  await expect(onboarding).toHaveAttribute("role", "note");
  await expect(popup.locator("#onboarding-title")).toHaveText("Static now asks before it masks");
  await expect(popup.locator("#onboarding-dismiss")).toHaveText("Got it");
  await expect(popup.locator("#onboarding-always")).toHaveText("Protect every site instead");

  await popup.locator("#onboarding-dismiss").click();
  await expect
    .poll(
      async () =>
        (await getStorage(extension, { onboarding_dismissed: false })).onboarding_dismissed
    )
    .toBe(true);
  await expect(onboarding).toBeHidden();
  expect(popup.isClosed()).toBe(false);

  await closeQuietly(popup);
  const popupAgain = await openPopupForTab(extension, tabId);
  await expect(popupAgain.locator("#onboarding")).toBeHidden();
});

test("onboarding protect-every-site switches mode, reloads, and disappears once decided", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);

  const popup = await openPopupForTab(extension, tabId);
  await expect(popup.locator("#onboarding")).toBeVisible();
  await popup.locator("#onboarding-always").click();
  await expect
    .poll(async () => (await getStorage(extension, { protection_mode: null })).protection_mode)
    .toBe("always");
  await expect.poll(() => pageLoads(page), { timeout: 15_000 }).toBeGreaterThan(1);
  await closeQuietly(popup);

  const popupAlways = await openPopupForTab(extension, tabId);
  await expect(popupAlways.locator("#onboarding")).toBeHidden();
  await expect(popupAlways.locator("#mode-always")).toHaveAttribute("aria-pressed", "true");
  await expect(popupAlways.locator("#site-control")).toBeVisible();
  await closeQuietly(popupAlways);

  // A first decision also ends onboarding, even without pressing Got it.
  await setProtectionMode(extension, "per_site");
  const siteKey = new URL(server.origin).hostname;
  await setSiteDecision(extension, siteKey, "on");
  const popupDecided = await openPopupForTab(extension, tabId);
  await expect(popupDecided.locator("#onboarding")).toBeHidden();
  await expect(popupDecided.locator("#site-state")).toHaveText("Static is on here.");
});

test("the recovery card follows the mode, the compatibility warning, and protection", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const siteKey = new URL(server.origin).hostname;
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);

  // Unprotected per-site pages have no recovery card.
  const popupUnprotected = await openPopupForTab(extension, tabId);
  await expect(popupUnprotected.locator("#recovery")).toBeHidden();
  await expect(popupUnprotected.locator("#recovery-section")).toBeHidden();
  await closeQuietly(popupUnprotected);

  await setSiteDecision(extension, siteKey, "on");
  const popupHelp = await openPopupForTab(extension, tabId);
  await expect(popupHelp.locator("#recovery")).toBeVisible();
  await expect(popupHelp.locator("#recovery")).toHaveAttribute("data-state", "help");
  await expect(popupHelp.locator("#recovery-title")).toHaveText("Page not working?");
  await expect(popupHelp.locator("#recovery-detail")).toHaveText(
    "Static can stop logins, checkouts, or extra features on this site. Turn it off here to check."
  );
  await expect(popupHelp.locator("#recovery-action")).toHaveText("Turn protection off here");
  await closeQuietly(popupHelp);

  await setStorage(extension, {
    compat_log: {
      [server.origin]: {
        kinds: { unhandled_blocked_fetch: 1 },
        lastUpdated: Date.now(),
        pathKinds: { manifest: 1 },
        total: 1,
        vectors: { fetch: 1 },
      },
    },
  });
  const popupWarning = await openPopupForTab(extension, tabId);
  await expect(popupWarning.locator("#recovery")).toHaveAttribute("data-state", "warning");
  await expect(popupWarning.locator("#recovery-title")).toHaveText(
    "This site may be broken by Static"
  );
  await expect(popupWarning.locator("#recovery-detail")).toHaveText(
    "Static interrupted a request this page expected. Turn protection off here to see if that fixes it."
  );
  await expect(popupWarning.locator("#recovery-action")).toHaveText(
    "Turn protection off here and reload"
  );

  await popupWarning.locator("#recovery-action").click();
  await settleOnDecision(extension, siteKey, "off");
  await expect.poll(() => pageLoads(page), { timeout: 15_000 }).toBeGreaterThan(1);

  await closeQuietly(popupWarning);
  const popupAfter = await openPopupForTab(extension, tabId);
  await expect(popupAfter.locator("#recovery")).toBeHidden();
  await expect(popupAfter.locator("#recovery-section")).toBeHidden();
});

test("the ruleset lists reflect prefs and the paused-note copy in both modes", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  await setStorage(extension, {
    ruleset_prefs: { captcha_vendors: false, fingerprint_vendors: true },
    ruleset_prefs_captured: true,
  });
  const siteKey = new URL(server.origin).hostname;
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);

  const popup = await openPopupForTab(extension, tabId);
  await openMorePanel(popup);
  const pausedNote = popup.locator("#rulesets-paused-note");
  await expect(pausedNote).toBeVisible();
  await expect(pausedNote).toHaveText(
    "Static is off on this site, so these lists only apply to the sites you protect."
  );
  await expect(popup.locator("#rs_fingerprint_vendors")).toBeChecked();
  await expect(popup.locator("#rs_captcha_vendors")).not.toBeChecked();
  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())
    )
    .toEqual([]);

  await popup.locator("#rs_captcha_vendors").click();
  await expect
    .poll(async () => (await getStorage(extension, { ruleset_prefs: null })).ruleset_prefs)
    .toMatchObject({ captcha_vendors: true, fingerprint_vendors: true });
  await popup.locator("#rs_fingerprint_vendors").click();
  await expect
    .poll(async () => (await getStorage(extension, { ruleset_prefs: null })).ruleset_prefs)
    .toMatchObject({ captcha_vendors: true, fingerprint_vendors: false });
  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())
    )
    .toEqual([]);

  // A protected site hides the per-site note.
  await setSiteDecision(extension, siteKey, "on");
  await closeQuietly(popup);
  const popupProtected = await openPopupForTab(extension, tabId);
  await openMorePanel(popupProtected);
  await expect(popupProtected.locator("#rulesets-paused-note")).toBeHidden();
  await expect(popupProtected.locator("#rs_captcha_vendors")).toBeChecked();
  await closeQuietly(popupProtected);

  // always + paused keeps today's text.
  await setProtectionMode(extension, "always");
  await setStorage(extension, { disabled_origins: { [server.origin]: true } });
  const popupPaused = await openPopupForTab(extension, tabId);
  await openMorePanel(popupPaused);
  await expect(popupPaused.locator("#rulesets-paused-note")).toBeVisible();
  await expect(popupPaused.locator("#rulesets-paused-note")).toHaveText(
    "Static is paused on this site, so these lists don't apply to this site."
  );
});

test("the footer link manages sites and its stats follow the summary", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);
  await setStorage(extension, {
    site_decisions: {
      "example.com": { at: Date.now() - 2000, source: "popup", state: "on" },
      "off.example": { at: Date.now() - 1000, source: "popup", state: "off" },
    },
  });

  const popup = await openPopupForTab(extension, tabId);
  await openMorePanel(popup);
  const link = popup.locator("#view-sites");
  await expect(link).toHaveText(/Manage protected sites/);
  await expect(link).toHaveAttribute("href", "sites.html");
  await expect(popup.locator("#sites-stats")).toHaveText("1 on · 1 off");

  const [sitesPage] = await Promise.all([extension.context.waitForEvent("page"), link.click()]);
  await sitesPage.waitForURL((url) => url.toString().endsWith("/sites.html"), { timeout: 10_000 });
  expect(sitesPage.url()).toBe(`chrome-extension://${extension.extensionId}/sites.html`);
  await expect(sitesPage.locator("body")).toContainText("Site protection");

  await setProtectionMode(extension, "always");
  await setStorage(extension, {
    disabled_origins: { "https://one.example": true, "https://two.example": true },
  });
  await closeQuietly(sitesPage);
  const popupAlways = await openPopupForTab(extension, tabId);
  await openMorePanel(popupAlways);
  await expect(popupAlways.locator("#sites-stats")).toHaveText("2 paused");
  await expect(popupAlways.locator("#view-sites")).toHaveText(/Manage protected sites/);
});

test("the popup renders on an extension target with no site and never throws", async ({
  extension,
}) => {
  const blank = await extension.context.newPage();
  await blank.goto("about:blank");
  await blank.bringToFront();

  const errors = [];
  const popup = await extension.context.newPage();
  popup.on("pageerror", (error) => errors.push(error.message));
  await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  await expect(popup.locator("#mode-row")).toBeVisible();
  await expect(popup.locator("#mode-always")).toHaveAttribute("aria-pressed", "true");
  await expect(popup.locator("#mode-per-site")).toHaveAttribute("aria-pressed", "false");
  await expect(popup.locator("#site-decision")).toBeHidden();
  await expect(popup.locator("#site-control")).toBeHidden();
  await expect(popup.locator("#onboarding")).toBeHidden();
  await expect(popup.locator("#recovery")).toBeHidden();
  await expect(popup.locator("#count-label")).toHaveText("probes blocked on this tab");
  await expect(popup.locator("#site-toggle")).toBeAttached();
  expect(errors).toEqual([]);
});

test("recommendation notes open the More panel at the control that is off", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openFixturePage(extension, server);
  const tabId = await tabIdForPage(extension, page);
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    context.fillStyle = "#123456";
    context.fillRect(0, 0, 32, 32);
    canvas.toDataURL();
    void navigator.hardwareConcurrency;
    void screen.width;
  });
  await seedProbeEvidence(extension, {
    pageUrl: page.url(),
    probes: buildProbeRows(2),
    signals: { device: { canvas: 1 } },
    tabId,
  });
  await expect
    .poll(async () => {
      const entries = await readSiteEvidence(extension);
      return entries.some(([, entry]) => entry && entry.device && entry.device.canvas > 0);
    })
    .toBe(true);

  const popup = await openPopupForTab(extension, tabId);
  await expect(popup.locator("#site-open-more")).toBeVisible();
  await expect(popup.locator("#site-reasons li.note")).not.toHaveCount(0);
  await expect(popup.locator("#advanced-controls")).not.toHaveAttribute("open", "");
  await popup.locator("#site-open-more").click();
  await expect(popup.locator("#advanced-controls")).toHaveAttribute("open", "");
  const focused = await popup.evaluate(() => document.activeElement && document.activeElement.id);
  expect(["fingerprint-mode", "replay-mode", "rs_fingerprint_vendors"]).toContain(focused);
  await expect(popup.locator("#fingerprint-title-text")).toBeInViewport();
});
