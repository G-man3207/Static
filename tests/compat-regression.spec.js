// Static — compatibility regression tests.
//
// These tests verify that the extension does not break common web platform
// patterns used by real websites. They run against enriched local fixture
// pages that exercise realistic dynamic DOM/CSS/async behavior.

const { expect, test } = require("./helpers/extension-fixture");

// ---------------------------------------------------------------------------
//  innerHTML set to object with custom toString (Google autocomplete pattern)
// ---------------------------------------------------------------------------

test("innerHTML set with an object (custom toString) renders correctly", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(() => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    // Simulate Google's autocomplete pattern: object with custom toString
    // that returns HTML with suggestions
    const suggestionObj = {
      text: "weather",
      toString() {
        return '<span class="suggestion">weather <b>forecast</b></span>';
      },
    };

    container.innerHTML = suggestionObj;

    const span = container.querySelector(".suggestion");
    const text = span ? span.textContent : "NO SPAN";
    document.body.removeChild(container);
    return text;
  });

  expect(result).toBe("weather forecast");
});

// ---------------------------------------------------------------------------
//  insertAdjacentHTML with object (similar pattern)
// ---------------------------------------------------------------------------

test("insertAdjacentHTML with an object (custom toString) renders correctly", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(() => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const obj = {
      text: "test",
      toString() {
        return '<span id="ins-adj">inserted</span>';
      },
    };

    container.insertAdjacentHTML("beforeend", obj);

    const span = container.querySelector("#ins-adj");
    const text = span ? span.textContent : "NO SPAN";
    document.body.removeChild(container);
    return text;
  });

  expect(result).toBe("inserted");
});

// ---------------------------------------------------------------------------
//  Realistic autocomplete fixture renders visible content
// ---------------------------------------------------------------------------

test("realistic autocomplete fixture renders visible content", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/realistic-autocomplete.html"));
  await page.waitForTimeout(500);

  // The fixture should have loaded
  const ready = await page.evaluate(() => window.__fixtureReady);
  expect(ready).toBe(true);

  // Click the search input and type
  const input = page.locator("#searchInput");
  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.fill("weath");

  // Wait for suggestions
  await page.waitForTimeout(1500);

  // Suggestions should render
  const suggestions = page.locator(".suggestion");
  const count = await suggestions.count();
  expect(count).toBeGreaterThan(0);

  // Each suggestion should have visible text
  const firstText = await suggestions.first().textContent();
  expect(firstText.trim().length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
//  Realistic dashboard fixture renders visible content
// ---------------------------------------------------------------------------

test("realistic dashboard fixture renders visible content", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/realistic-dashboard.html"));
  await page.waitForTimeout(500);

  const ready = await page.evaluate(() => window.__fixtureReady);
  expect(ready).toBe(true);

  // Stats should load with animation
  await page.waitForTimeout(3000);

  const stat1 = page.locator("#stat1");
  await expect(stat1).not.toHaveText("--");

  // Feed items should be rendered
  const feedItems = page.locator(".feed-item");
  const count = await feedItems.count();
  expect(count).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
//  Object-based HTML rendering (React-like innerHTML pattern)
// ---------------------------------------------------------------------------

test("innerHTML with React-like object pattern renders content correctly", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  // Simulate a framework that passes structured objects to innerHTML
  // (similar to how some React-internal paths or DOM helpers work)
  const result = await page.evaluate(() => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    // Test multiple patterns in sequence
    const patterns = [];

    // Pattern 1: Object with toString (like Google's autocomplete)
    const obj1 = {
      toString() {
        return '<div data-testid="obj1"><span>rendered from object</span></div>';
      },
    };
    root.innerHTML = obj1;
    patterns.push(document.querySelector("[data-testid=obj1]")?.textContent?.trim() || "FAIL");

    // Pattern 2: Array coerced to string (like some React paths)
    root.innerHTML = ["<p>array content</p>"];
    patterns.push(root.querySelector("p")?.textContent?.trim() || "FAIL");

    // Pattern 3: Number coerced to string
    root.innerHTML = 42;
    patterns.push(root.textContent?.trim() || "FAIL");

    // Pattern 4: null/undefined (should not throw, native converts to "null"/"undefined")
    try {
      root.innerHTML = null;
      patterns.push(`null -> ${root.textContent}`);
    } catch (e) {
      patterns.push(`null threw: ${e.message}`);
    }

    document.body.removeChild(root);
    return patterns;
  });

  expect(result[0]).toBe("rendered from object");
  expect(result[1]).toBe("array content");
  expect(result[2]).toBe("42");
  expect(result[3]).toBe("null -> null");
});

// ---------------------------------------------------------------------------
//  Dynamic DOM fixture - attribute cycling (DOM scrubber interaction)
// ---------------------------------------------------------------------------

test("dynamic DOM fixture handles attribute cycling without losing content", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/realistic-dynamic.html"));
  await page.waitForTimeout(500);

  const ready = await page.evaluate(() => window.__fixtureReady);
  expect(ready).toBe(true);

  // Add items
  await page.locator("#addBtn").click();
  await page.waitForTimeout(100);

  const items = page.locator(".item");
  const beforeCount = await items.count();
  expect(beforeCount).toBeGreaterThan(2);

  // Toggle attribute cycling (tests DOM scrubber interaction)
  await page.locator("#toggleAttrBtn").click();
  await page.waitForTimeout(1500);

  // Items should still have content after attribute cycling
  const afterCount = await items.count();
  expect(afterCount).toBeGreaterThanOrEqual(2);

  // Stop attribute cycling
  await page.locator("#toggleAttrBtn").click();

  // Verify content isn't blank
  const firstItem = items.first();
  const text = await firstItem.textContent();
  expect(text.trim().length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
//  postMessage fixture
// ---------------------------------------------------------------------------

test("messaging fixture receives postMessage events", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/realistic-messaging.html"));
  await page.waitForTimeout(500);

  const ready = await page.evaluate(() => window.__fixtureReady);
  expect(ready).toBe(true);

  // Wait for incoming messages
  await page.waitForTimeout(5000);

  // Messages should have been received
  const messages = page.locator(".msg");
  const count = await messages.count();
  expect(count).toBeGreaterThan(2);

  // Check for system message
  const systemMsg = page.locator(".msg.system");
  await expect(systemMsg.first()).toBeVisible();
});
