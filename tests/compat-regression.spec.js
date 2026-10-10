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

    // Pattern 4: null (innerHTML treats null as an empty string)
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
  expect(result[3]).toBe("null -> ");
});

// ---------------------------------------------------------------------------
//  Dynamic DOM fixture - attribute cycling (DOM scrubber interaction)
// ---------------------------------------------------------------------------

test("attribute updates scrub markers without scheduling subtree rescans", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(1300);

  const result = await page.evaluate(async () => {
    const waitUntilQuiet = async () => {
      const deadline = performance.now() + 6000;
      while (performance.now() < deadline) {
        const beat = performance.now();
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        if (performance.now() - beat > 20) continue;
        const gap = performance.now();
        await new Promise((resolve) => {
          setTimeout(resolve, 80);
        });
        if (performance.now() - gap < 110) return;
      }
    };

    const nodes = [];
    const app = document.createElement("div");
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 4000; i++) {
      const el = document.createElement("div");
      el.className = "item";
      el.setAttribute("data-id", String(i));
      el.textContent = "n";
      fragment.appendChild(el);
      nodes.push(el);
    }
    app.appendChild(fragment);
    document.body.appendChild(app);
    // Insertion still schedules delayed shadow walks. Let those finish so
    // they are not counted as attribute-update work.
    await waitUntilQuiet();

    const marker = nodes[0];
    marker.classList.add("keep", "grammarly-card");
    marker.setAttribute("data-grammarly-extension", "1");
    marker.setAttribute("data-route", "inbox");

    const host = document.createElement("div");
    app.appendChild(host);
    host.setAttribute("data-ready", "1");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<span id="inside" class="keep lastpass-panel" data-lastpass-root="1"></span>';
    // Host insertion has its own delayed walk. Drain it so the timer queue
    // measured below is only the attribute updates.
    await waitUntilQuiet();

    const start = performance.now();
    for (const el of nodes) el.setAttribute("aria-rowindex", "1");
    document.documentElement.classList.add("theme-dark");
    let spins = 0;
    let maxBeat = 0;
    while (performance.now() - start < 1500) {
      const beat = performance.now();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      maxBeat = Math.max(maxBeat, performance.now() - beat);
      spins += 1;
      if (performance.now() - beat < 12 && spins > 3) break;
    }

    const inside = root.querySelector("#inside");
    return {
      busyMs: performance.now() - start,
      hostReady: host.getAttribute("data-ready"),
      insideClass: inside ? [...inside.classList] : null,
      insideData: inside ? inside.hasAttribute("data-lastpass-root") : null,
      markerClass: [...marker.classList],
      markerData: marker.hasAttribute("data-grammarly-extension"),
      markerRoute: marker.getAttribute("data-route"),
      maxBeat,
      rootClass: document.documentElement.classList.contains("theme-dark"),
      spins,
    };
  });

  expect(result.markerData).toBe(false);
  expect(result.markerClass).toEqual(["item", "keep"]);
  expect(result.markerRoute).toBe("inbox");
  expect(result.insideData).toBe(false);
  expect(result.insideClass).toEqual(["keep"]);
  expect(result.hostReady).toBe("1");
  expect(result.rootClass).toBe(true);
  // Old path: each of the 4,000 attribute records scheduled four subtree
  // walks. This test measured ~300ms of follow-up timer work (and ~120ms /
  // a ~70ms beat in a tighter harness). The fixed path has nothing to drain
  // (measured ~8-15ms), so 70ms still fails the old path on a much faster
  // machine without tripping on a slow setTimeout(0).
  expect(result.busyMs).toBeLessThan(70);
  expect(result.maxBeat).toBeLessThan(50);
});

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
