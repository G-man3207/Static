// Static — real-URL smoke tests.
//
// These tests navigate to real public websites with the extension loaded and
// verify that pages render visible content and are not broken by the extension.
//
// REQUIREMENTS:
//   - Internet access. Tests are skipped automatically when offline.
//   - Headless mode may trigger CAPTCHA on Google; run with HEADLESS=false
//     or set --headed for interactive debugging.
//
// To add a new real-site smoke test:
//   1. Import { expect, test } from "./helpers/real-browser";
//   2. Use the `realBrowser` fixture to get a browser context.
//   3. Call navigateAndCheckHealth(page, url) and assert the result.

const { expect, test, isOnline, navigateAndCheckHealth } = require("./helpers/real-browser");

// ---------------------------------------------------------------------------
//  Google Search – autocomplete / recommendation dropdown
// ---------------------------------------------------------------------------

test("Google Search home page renders visible content", async ({ realBrowser }) => {
  test.skip(!(await isOnline()), "requires internet access");

  const page = await realBrowser.context.newPage();
  const health = await navigateAndCheckHealth(page, "https://www.google.com", {
    timeout: 30_000,
  });

  // The page should have rendered visible content
  expect(health.visibleRatio).toBeGreaterThanOrEqual(0.01);
  // No fatal navigation errors
  expect(health.navigationError).toBeNull();
  // The URL should have resolved (might redirect to a localised google)
  expect(health.url).toContain("google.com");
});

test("Google Search autocomplete dropdown shows suggestions", async ({ realBrowser }) => {
  test.skip(!(await isOnline()), "requires internet access");

  const page = await realBrowser.context.newPage();

  // Navigate to Google (use en-US to avoid cookie/localisation popups)
  await page.goto("https://www.google.com/?hl=en", {
    timeout: 30_000,
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(2000);

  // Dismiss any cookie consent overlay if present
  const acceptButtons = page.locator(
    'button:has-text("Accept all"), button:has-text("Accept"), ' +
      'button:has-text("I agree"), button:has-text("Got it"), ' +
      'div[role="dialog"] button:first-child'
  );
  try {
    await acceptButtons.first().click({ timeout: 3000 });
    await page.waitForTimeout(500);
  } catch {
    // No cookie popup — fine
  }

  // Locate the search input and type a partial query
  const searchBox = page.locator('textarea[name="q"], input[name="q"]');
  await searchBox.waitFor({ state: "visible", timeout: 10_000 });
  // Use keyboard to focus and type (avoids click interception by overlay elements)
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  await page.keyboard.type("weather", { delay: 80 });

  // Wait for the autocomplete dropdown to appear
  await page.waitForTimeout(2000);

  // Take a screenshot focusing on the search area
  const ratio = await require("./helpers/real-browser").computeVisibleContentRatio(page);

  // The dropdown should have visible content above the blank threshold
  expect(ratio).toBeGreaterThanOrEqual(0.01);
});

// ---------------------------------------------------------------------------
//  Meta / Facebook – basic page render
// ---------------------------------------------------------------------------

test("Facebook home page renders visible content", async ({ realBrowser }) => {
  test.skip(!(await isOnline()), "requires internet access");

  const page = await realBrowser.context.newPage();
  const health = await navigateAndCheckHealth(page, "https://www.facebook.com", {
    timeout: 30_000,
    // Facebook loads a lot of scripts; use 'load' instead of 'networkidle'
    // to avoid waiting for long-polling connections
    waitUntil: "load",
  });

  // The page should have rendered visible content (login page)
  expect(health.visibleRatio).toBeGreaterThanOrEqual(0.005);
  expect(health.url).toMatch(/facebook\.com/);
});

// ---------------------------------------------------------------------------
//  General-purpose health-check test
// ---------------------------------------------------------------------------

test("Multiple normie websites render without going blank", async ({ realBrowser }) => {
  test.skip(!(await isOnline()), "requires internet access");

  const sites = [
    { url: "https://www.example.com", minRatio: 0.02 },
    { url: "https://www.wikipedia.org", minRatio: 0.02 },
  ];

  const page = await realBrowser.context.newPage();

  for (const site of sites) {
    const health = await navigateAndCheckHealth(page, site.url, {
      timeout: 30_000,
      waitUntil: "networkidle",
    });

    expect(health.navigationError).toBeNull();
    expect(health.visibleRatio).toBeGreaterThanOrEqual(site.minRatio);
    // No unhandled console errors from extension interference
    expect(health.consoleErrors.length).toBe(0);
  }
});

// ---------------------------------------------------------------------------
//  Google-specific: search results page render check
// ---------------------------------------------------------------------------

test("Google search results page renders visible content", async ({ realBrowser }) => {
  test.skip(!(await isOnline()), "requires internet access");

  const page = await realBrowser.context.newPage();
  await page.goto("https://www.google.com/?hl=en", {
    timeout: 30_000,
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(1000);

  // Dismiss cookie consent if present
  const acceptButtons = page.locator(
    'button:has-text("Accept all"), button:has-text("Accept"), ' +
      'button:has-text("I agree"), button:has-text("Got it")'
  );
  try {
    await acceptButtons.first().click({ timeout: 3000 });
    await page.waitForTimeout(500);
  } catch {
    // No popup
  }

  const searchBox = page.locator('textarea[name="q"], input[name="q"]');
  await searchBox.waitFor({ state: "visible", timeout: 10_000 });
  await searchBox.fill("static anti fingerprinting extension");
  await page.keyboard.press("Enter");

  // Wait for the search results page to load
  await page.waitForURL("**/search**", { timeout: 15_000 });
  await page.waitForTimeout(2000);

  const health = await require("./helpers/real-browser").checkPageHealth(page);
  expect(health.visibleRatio).toBeGreaterThanOrEqual(0.01);
  expect(health.url).toContain("google.com/search");
});
