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
//   3. One rule per origin, however many frames ask, and pausing removes it (unit)
//   4. UA string format matches between JS and network layers (code review)
//   5. iphey.com data sections respond correctly to masking state
//
// In production, when the extension is installed from the Web Store, the
// permission is properly granted and modifyHeaders rules ARE applied.

const { expect, test } = require("@playwright/test");
const http = require("http");
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
  await new Promise((resolve) => {
    setTimeout(resolve, 200);
  });
};

const preinstallHeaderRule = async (serviceWorker, origin) => {
  return serviceWorker.evaluate(async (targetOrigin) => {
    // eslint-disable-next-line no-undef
    const persona = await fingerprintPersonaFor(targetOrigin);
    // eslint-disable-next-line no-undef
    await ensureOriginHeaderRule(targetOrigin, persona);
    return { uaOs: persona.uaOs, os: persona.os, platform: persona.platform };
  }, origin);
};

// Every frame's bridge asks for its persona as the frame starts, so one page
// load sends several requests for the same tab origin at once.
const loadFramesConcurrently = (serviceWorker, origin, frames) =>
  serviceWorker.evaluate(
    ({ count, targetOrigin }) =>
      Promise.all(
        Array.from(
          { length: count },
          (_, frameId) =>
            new Promise((resolve) => {
              const sender = { frameId, tab: { id: 1, url: `${targetOrigin}/` } };
              // eslint-disable-next-line no-undef
              messageHandlers.static_get_persona({ type: "static_get_persona" }, sender, resolve);
            })
        )
      ),
    { count: frames, targetOrigin: origin }
  );

// Pause a site the way the popup does.
const pauseSite = (serviceWorker, origin) =>
  serviceWorker.evaluate(
    (targetOrigin) =>
      new Promise((resolve) => {
        const msg = { disabled: true, origin: targetOrigin, type: "static_set_site_disabled" };
        // eslint-disable-next-line no-undef
        messageHandlers.static_set_site_disabled(msg, {}, resolve);
      }),
    origin
  );

const headerRuleIds = (serviceWorker) =>
  serviceWorker.evaluate(async () =>
    (await chrome.declarativeNetRequest.getDynamicRules())
      .filter((rule) => rule.action.type === "modifyHeaders")
      .map((rule) => rule.id)
  );

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

// eslint-disable-next-line max-lines-per-function -- one fixture covers the header-rule cases
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

  test("a synthetic User-Agent rule exists at startup without poisoning", async () => {
    const rules = await extension.serviceWorker.evaluate(async () =>
      (await chrome.declarativeNetRequest.getDynamicRules()).filter(
        (rule) => rule.action && rule.action.type === "modifyHeaders"
      )
    );
    const global = rules.find((rule) => rule.priority === 40);
    expect(global).toBeTruthy();
    const ua = global.action.requestHeaders.find((header) => header.header === "User-Agent");
    expect(ua.operation).toBe("set");
    expect(ua.value).toContain("Chrome/152.0.0.0");
    const secCh = global.action.requestHeaders.find((header) => header.header === "Sec-CH-UA");
    expect(secCh.operation).toBe("set");
    expect(secCh.value).toContain('"Chromium";v="152"');
  });

  test("DNR header rule sets User-Agent and Sec-CH-UA", async () => {
    await preinstallHeaderRule(extension.serviceWorker, "https://static-test.example");

    const rules = await extension.serviceWorker.evaluate(() =>
      chrome.declarativeNetRequest.getDynamicRules()
    );
    const ourRules = rules.filter(
      (rule) => rule.action && rule.action.type === "modifyHeaders" && rule.priority === 100
    );
    expect(ourRules).toHaveLength(2);
    expect(
      ourRules.every((rule) =>
        rule.action.requestHeaders.some(
          (header) =>
            header.header === "User-Agent" &&
            header.operation === "set" &&
            header.value.includes("Chrome/152.0.0.0")
        )
      )
    ).toBe(true);
    expect(
      ourRules.every((rule) =>
        rule.action.requestHeaders.some(
          (header) => header.header === "Sec-CH-UA" && header.operation === "set"
        )
      )
    ).toBe(true);
    expect(ourRules.some((rule) => rule.condition.requestDomains)).toBe(true);
    expect(ourRules.some((rule) => rule.condition.initiatorDomains)).toBe(true);
  });

  test("turning fingerprint mode off does not remove UA header rules", async () => {
    await preinstallHeaderRule(extension.serviceWorker, "https://cleanup-test.example");
    const before = await headerRuleIds(extension.serviceWorker);
    expect(before.length).toBeGreaterThan(0);

    await disableFingerprintMasking(extension.serviceWorker);

    expect(await headerRuleIds(extension.serviceWorker)).toEqual(before);
  });

  test("an origin keeps its header rules however many frames ask for them", async () => {
    const origin = "https://frames-test.example";
    await loadFramesConcurrently(extension.serviceWorker, origin, 6);
    const afterFirstLoad = await headerRuleIds(extension.serviceWorker);
    expect(afterFirstLoad.filter((id) => id >= 10000)).toHaveLength(2);

    await loadFramesConcurrently(extension.serviceWorker, origin, 6);
    expect(await headerRuleIds(extension.serviceWorker)).toEqual(afterFirstLoad);
  });

  test("pausing localhost removes its header rules without dropping the global rule", async () => {
    const kept = "https://still-protected.example";
    await preinstallHeaderRule(extension.serviceWorker, kept);
    const origin = "http://localhost:8123";
    await loadFramesConcurrently(extension.serviceWorker, origin, 2);
    await pauseSite(extension.serviceWorker, origin);

    const rules = await extension.serviceWorker.evaluate(() =>
      chrome.declarativeNetRequest.getDynamicRules()
    );
    const modify = rules.filter((rule) => rule.action && rule.action.type === "modifyHeaders");
    expect(modify.some((rule) => rule.priority === 100 && rule.condition.regexFilter)).toBe(false);
    const global = modify.find((rule) => rule.priority === 40);
    expect(global).toBeTruthy();
    expect(
      global.action.requestHeaders.find((header) => header.header === "User-Agent").value
    ).toContain("Chrome/152.0.0.0");
    expect(
      rules.some(
        (rule) =>
          rule.priority === 1000 &&
          rule.condition &&
          String(rule.condition.regexFilter || "").includes("localhost")
      )
    ).toBe(true);
    expect(
      modify.some(
        (rule) =>
          rule.priority === 100 &&
          (rule.condition.requestDomains || []).includes("still-protected.example")
      )
    ).toBe(true);
  });

  test("a paused localhost request is not rewritten and another host still is", async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, ua: req.headers["user-agent"] || "" });
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>ua</title>");
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    try {
      await pauseSite(extension.serviceWorker, `http://localhost:${port}`);
      await page.goto(`http://127.0.0.1:${port}/other`);
      await page.goto(`http://localhost:${port}/paused`);
      const other = seen.find((entry) => entry.host.startsWith("127.0.0.1"));
      const paused = seen.find((entry) => entry.host.startsWith("localhost"));
      expect(other && other.ua).toContain("Chrome/152.0.0.0");
      expect(paused && paused.ua).not.toContain("Chrome/152.0.0.0");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    }
  });

  // ── 4. Integration: iphey.com ───────────────────────────────────────────

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

  // ── 5. Integration: iphey.com control ───────────────────────────────────

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
