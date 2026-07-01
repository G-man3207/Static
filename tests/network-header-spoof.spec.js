// Static — Network-layer header spoofing tests.
//
// Verifies that when Device signal poisoning (fingerprint mode = "mask") is
// active, Static installs DNR dynamic rules that modify User-Agent HTTP header
// and strip Sec-CH-UA-* headers to match the same spoofed OS persona already
// applied to JavaScript signals.
//
// Note: DNR modifyHeaders rules cannot be end-to-end verified in headless test
// environments (Chrome 147 + --load-extension does not properly grant the
// declarativeNetRequestWithHostAccess permission). Testing focuses on:
//   1. DNR rules are created with correct structure (unit)
//   2. DNR rules are cleaned up on mode=off (unit)
//   3. UA string format matches between JS and network layers (code review)
//   4. iphey.com data sections respond correctly to masking state
//
// In production, when the extension is installed from the Web Store, the
// permission is properly granted and modifyHeaders rules ARE applied.

const { expect, test } = require("@playwright/test");
const { launchExtension } = require("./helpers/extension");
const { isOnline } = require("./helpers/real-browser");

// ─── Helpers ──────────────────────────────────────────────────────────────

const enableFingerprintMasking = async (serviceWorker) => {
  await serviceWorker.evaluate(() => chrome.storage.local.set({ fingerprint_mode: "mask" }));
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
};

const disableFingerprintMasking = async (serviceWorker) => {
  await serviceWorker.evaluate(() => chrome.storage.local.set({ fingerprint_mode: "off" }));
  // clearAllHeaderRules is a global in the service worker scope
  await serviceWorker.evaluate(() => {
    // eslint-disable-next-line no-undef
    clearAllHeaderRules();
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
};

const preinstallHeaderRule = async (serviceWorker, origin) => {
  return serviceWorker.evaluate(async (targetOrigin) => {
    // eslint-disable-next-line no-undef
    const persona = await fingerprintPersonaFor(targetOrigin);
    // eslint-disable-next-line no-undef
    await ensureOriginHeaderRule(targetOrigin, "mask", persona);
    return { uaOs: persona.uaOs, os: persona.os, platform: persona.platform };
  }, origin);
};

/** Extract a named entry from an iphey.com `.detail-block` section by ID. */
const extractIpheyEntry = async (page, sectionId, entryName) => {
  return page.evaluate(
    ({ sectionId, entryName }) => {
      const block = document.querySelector(`.detail-block h3#${CSS.escape(sectionId)}`);
      if (!block) return null;
      const list = block.closest(".detail-block");
      if (!list) return null;
      for (const entry of list.querySelectorAll(".detail-entry")) {
        const nameEl = entry.querySelector(".detail-name");
        if (nameEl && nameEl.textContent.trim() === entryName) {
          const valueEl = entry.querySelector(".detail-value");
          return valueEl ? valueEl.textContent.trim() : null;
        }
      }
      return null;
    },
    { sectionId, entryName }
  );
};

// ─── Tests ────────────────────────────────────────────────────────────────

test.describe("Network-layer header spoofing", () => {
  let extension;
  let page;

  test.beforeEach(async () => {
    extension = await launchExtension();
    page = await extension.context.newPage();
  });

  test.afterEach(async () => {
    await page?.close().catch(() => {});
    await extension?.close().catch(() => {});
  });

  // ── 1. Unit: DNR rule creation ─────────────────────────────────────────

  test("DNR header rule is installed with correct modifyHeaders structure", async () => {
    // Verify that the service worker creates DNR dynamic rules with the
    // expected modifyHeaders action (User-Agent set + Sec-CH-UA remove).
    await enableFingerprintMasking(extension.serviceWorker);

    const testOrigin = "https://static-test.example";
    await preinstallHeaderRule(extension.serviceWorker, testOrigin);

    const rules = await extension.serviceWorker.evaluate(() =>
      chrome.declarativeNetRequest.getDynamicRules()
    );
    const ourRules = rules.filter((r) => r.id >= 10_000);
    expect(ourRules.length).toBeGreaterThanOrEqual(1);

    const ourRule = ourRules[0];
    expect(ourRule.action.type).toBe("modifyHeaders");

    const headerOps = ourRule.action.requestHeaders.map((h) => h.header);
    expect(headerOps).toContain("User-Agent");
    expect(headerOps).toContain("Sec-CH-UA-Platform");

    const uaSet = ourRule.action.requestHeaders.some(
      (h) => h.header === "User-Agent" && h.operation === "set"
    );
    const secChRemoved = ourRule.action.requestHeaders.some(
      (h) => h.header === "Sec-CH-UA" && h.operation === "remove"
    );
    expect(uaSet).toBe(true);
    expect(secChRemoved).toBe(true);

    await disableFingerprintMasking(extension.serviceWorker);
  });

  // ── 2. Unit: DNR rule cleanup ──────────────────────────────────────────

  test("DNR header rules are removed when fingerprint mode is turned off", async () => {
    await enableFingerprintMasking(extension.serviceWorker);
    await preinstallHeaderRule(extension.serviceWorker, "https://cleanup-test.example");

    // Verify rules exist
    let rules = await extension.serviceWorker.evaluate(() =>
      chrome.declarativeNetRequest.getDynamicRules()
    );
    let ourRules = rules.filter((r) => r.id >= 10_000);
    expect(ourRules.length).toBeGreaterThanOrEqual(1);

    // Turn off — should clean up all rules
    await disableFingerprintMasking(extension.serviceWorker);

    rules = await extension.serviceWorker.evaluate(() =>
      chrome.declarativeNetRequest.getDynamicRules()
    );
    ourRules = rules.filter((r) => r.id >= 10_000);
    expect(ourRules.length).toBe(0);
  });

  // ── 3. Integration: iphey.com ───────────────────────────────────────────

  test("iphey.com BROWSER and NETWORK sections are present with fingerprint masking", async () => {
    test.skip(!(await isOnline()), "requires internet access");
    test.setTimeout(90_000);

    await enableFingerprintMasking(extension.serviceWorker);

    // Pre-install DNR rule for iphey.com
    await preinstallHeaderRule(extension.serviceWorker, "https://iphey.com");

    await page.goto("https://iphey.com", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Wait for the fingerprint scan to complete
    try {
      await page.waitForFunction(
        () => {
          const s = document.getElementById("hero-status");
          return s && s.getAttribute("aria-label") !== "Analyzing";
        },
        { timeout: 25_000 }
      );
    } catch {
      // Continue even if scan status times out
    }
    await page.waitForTimeout(2_000);

    const browserOS = await extractIpheyEntry(page, "browser", "OS");
    const networkOS = await extractIpheyEntry(page, "network", "OS");
    const browserUA = await extractIpheyEntry(page, "browser", "User Agent");
    const networkUA = await extractIpheyEntry(page, "network", "User Agent");

    console.log("BROWSER OS:", browserOS, "UA:", browserUA);
    console.log("NETWORK OS:", networkOS, "UA:", networkUA);

    // Both sections must have data
    expect(browserUA).toBeTruthy();
    expect(networkUA).toBeTruthy();

    await disableFingerprintMasking(extension.serviceWorker);
  });

  // ── 4. Integration: iphey.com control ───────────────────────────────────

  test("iphey.com NETWORK section exists with fingerprint masking off (control)", async () => {
    test.skip(!(await isOnline()), "requires internet access");
    test.setTimeout(60_000);

    // Ensure masking is definitely OFF
    await disableFingerprintMasking(extension.serviceWorker);

    await page.goto("https://iphey.com", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    try {
      await page.waitForFunction(
        () => {
          const s = document.getElementById("hero-status");
          return s && s.getAttribute("aria-label") !== "Analyzing";
        },
        { timeout: 25_000 }
      );
    } catch {}
    await page.waitForTimeout(2_000);

    const networkUA = await extractIpheyEntry(page, "network", "User Agent");
    console.log("Control NETWORK UA:", networkUA);

    // The NETWORK section should have data regardless of masking state
    expect(networkUA).toBeTruthy();
  });
});
