// Static — Real-browser test helper.
//
// Provides a reusable test fixture for navigating to real (or local) URLs with
// the extension loaded and asserting basic page health: visible content, no
// blank screens, no unhandled console errors.
//
// All functions that interact with the page accept a Playwright Page object and
// are designed to compose cleanly with Playwright's test/expect API.

const { chromium } = require("@playwright/test");
const http = require("http");
const { extensionPath } = require("./extension");
const { visibleContentRatio } = require("./png");

/** Minimum visible-content ratio below which a page is considered blank. */
const MIN_VISIBLE_CONTENT_RATIO = 0.01;

/** Time (ms) to wait after navigation for async rendering to settle. */
const RENDER_SETTLE_MS = 2000;

// ---------------------------------------------------------------------------
//  Online check
// ---------------------------------------------------------------------------

/**
 * Return true if we can reach a known internet host.
 * Uses a minimal HEAD request to google.com with a short timeout.
 * Suitable for conditionally skipping real-URL tests in offline CI.
 */
async function isOnline() {
  try {
    const response = await fetch("https://www.google.com/favicon.ico", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
//  Console-error capture
// ---------------------------------------------------------------------------

/**
 * Start capturing console errors on a page.
 *
 * Returns `{ errors, stop }`:
 *   errors  – array of `{ type, text, location }` objects collected so far
 *   stop()  – removes the listener and returns the final error array
 */
function captureConsoleErrors(page) {
  const errors = [];
  const handler = (msg) => {
    if (msg.type() === "error" || msg.type() === "crash") {
      errors.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
      });
    }
  };
  page.on("console", handler);
  return {
    errors,
    /** Stop listening and return the captured errors. */
    stop() {
      page.removeListener("console", handler);
      return errors;
    },
  };
}

// ---------------------------------------------------------------------------
//  Visible-content helpers (screenshot-based)
// ---------------------------------------------------------------------------

/**
 * Take a full-page screenshot and compute the fraction of non-blank pixels.
 * Returns a number between 0 (fully blank) and 1 (fully visible).
 */
async function computeVisibleContentRatio(page) {
  const screenshot = await page.screenshot({ type: "png", fullPage: true });
  return visibleContentRatio(screenshot);
}

/**
 * Assert that a page has at least a minimum ratio of visible (non-blank) pixels.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} options
 * @param {number}  [options.minRatio=MIN_VISIBLE_CONTENT_RATIO]
 * @param {string}  [options.name='page']  – label used in error messages
 * @param {string}  [options.screenshotPath] – optional path to dump a screenshot on failure
 * @throws {Error} if the visible-content ratio is below the threshold.
 */
async function assertPageHasVisibleContent(
  page,
  { minRatio = MIN_VISIBLE_CONTENT_RATIO, name = "page", screenshotPath } = {},
) {
  const ratio = await computeVisibleContentRatio(page);
  if (ratio < minRatio) {
    const path = screenshotPath || `/tmp/static-blank-${Date.now()}.png`;
    await page.screenshot({ path, type: "png", fullPage: true });
    throw new Error(
      `${name} appears blank or nearly blank: visible content ratio ` +
        `${(ratio * 100).toFixed(2)}% (threshold: ${(minRatio * 100).toFixed(2)}%). ` +
        `Screenshot saved to ${path}`,
    );
  }
}

/**
 * Assert that no unhandled JavaScript errors were logged by the page.
 *
 * @param {Array<{type:string,text:string,location:object}>} errors
 *        – output of `captureConsoleErrors` (the `.errors` or `.stop()` return).
 * @param {object} options
 * @param {string} [options.name='page']
 * @throws {Error} if errors is non-empty.
 */
function assertNoUnhandledErrors(errors, { name = "page" } = {}) {
  if (errors.length > 0) {
    const details = errors.map((e) => `  [${e.type}] ${e.text}`).join("\n");
    throw new Error(`${name} had ${errors.length} unhandled console error(s):\n${details}`);
  }
}

// ---------------------------------------------------------------------------
//  Element visibility helpers
// ---------------------------------------------------------------------------

/**
 * Assert that an element matching `selector` is visible on the page.
 * Throws a descriptive error if the element does not exist or is not visible.
 */
async function assertElementVisible(page, selector, { name, timeout = 5000 } = {}) {
  const label = name || selector;
  const el = await page.$(selector);
  if (!el) {
    throw new Error(`Element "${label}" not found in the DOM of "${page.url()}"`);
  }
  const visible = await el.isVisible();
  if (!visible) {
    throw new Error(`Element "${label}" exists but is not visible on "${page.url()}"`);
  }
  // Also check bounding box has positive dimensions
  const box = await el.boundingBox();
  if (!box || box.width === 0 || box.height === 0) {
    throw new Error(
      `Element "${label}" has zero dimensions (${box ? `${box.width}×${box.height}` : "null"}) ` +
        `on "${page.url()}"`,
    );
  }
}

// ---------------------------------------------------------------------------
//  High-level health checks
// ---------------------------------------------------------------------------

/**
 * Navigate to a URL with the extension active and return a health report.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string}  url
 * @param {object}  [options]
 * @param {number}  [options.timeout=30_000]
 * @param {string}  [options.waitUntil='networkidle']
 * @returns {Promise<{
 *   url: string,
 *   visibleRatio: number,
 *   consoleErrors: Array<{type:string,text:string,location:object}>,
 *   navigationError: string | null,
 * }>}
 */
async function navigateAndCheckHealth(
  page,
  url,
  { timeout = 30_000, waitUntil = "networkidle" } = {},
) {
  const capture = captureConsoleErrors(page);
  let navigationError = null;

  try {
    await page.goto(url, { timeout, waitUntil });
  } catch (err) {
    navigationError = err.message;
  }

  // Give the page time to finish rendering async content
  await page.waitForTimeout(RENDER_SETTLE_MS);

  const visibleRatio = await computeVisibleContentRatio(page);
  const errors = capture.stop();

  return {
    url: page.url(),
    visibleRatio,
    consoleErrors: errors,
    navigationError,
  };
}

/**
 * Check health of the *current* page (no navigation). Useful after
 * interacting with a page that was already navigated.
 */
async function checkPageHealth(page) {
  await page.waitForTimeout(RENDER_SETTLE_MS);
  const visibleRatio = await computeVisibleContentRatio(page);
  return {
    url: page.url(),
    visibleRatio,
    hasVisibleContent: visibleRatio >= MIN_VISIBLE_CONTENT_RATIO,
  };
}

// ---------------------------------------------------------------------------
//  Launch helper (thin wrapper around extension.js)
// ---------------------------------------------------------------------------

/**
 * Launch a Chromium browser with the Static extension loaded and return
 * an object with `{ context, extensionId, serviceWorker, close }`.
 *
 * This is a convenience alias for `launchExtension()` from `./extension.js`
 * so callers can import everything from this module.
 */
async function launchRealBrowser({ headless = false } = {}) {
  const { launchExtension } = require("./extension");
  // launchExtension already uses headless:false and loads the extension
  return launchExtension();
}

// ---------------------------------------------------------------------------
//  Playwright test fixture extension
// ---------------------------------------------------------------------------

/**
 * Create a Playwright test fixture that provides a `realBrowser` context
 * for real-URL tests (no local fixture server).
 *
 * Usage in a spec file:
 * ```
 * const { expect, test } = require('./helpers/real-browser');
 * test('google search is not blank', async ({ realBrowser }) => { ... });
 * ```
 */
const realBrowserTest = require("@playwright/test").test.extend({
  realBrowser: async ({}, use) => {
    const ext = await launchRealBrowser();
    try {
      await ext.serviceWorker.evaluate(() => chrome.storage.local.clear());
      await use(ext);
    } finally {
      await ext.close();
    }
  },
});

module.exports = {
  MIN_VISIBLE_CONTENT_RATIO,
  assertElementVisible,
  assertNoUnhandledErrors,
  assertPageHasVisibleContent,
  captureConsoleErrors,
  checkPageHealth,
  computeVisibleContentRatio,
  isOnline,
  launchRealBrowser,
  navigateAndCheckHealth,
  test: realBrowserTest,
  expect: require("@playwright/test").expect,
};
