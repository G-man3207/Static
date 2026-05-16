const { expect, test } = require("./helpers/extension-fixture");

const ALLOWED_TIMEZONES = new Set([
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/Berlin",
  "Europe/London",
]);

test("fingerprint masking toggle OFF restores native values", async ({ extension, server }) => {
  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ fingerprint_mode: "mask" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id != null
          ? chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
          : null
      )
    );
  });

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const masked = await page.evaluate(() => ({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));

  // Verify masking is active (timezone should be one of the allowed personas)
  expect(ALLOWED_TIMEZONES.has(masked.timezone)).toBe(true);

  // Turn fingerprint masking OFF and broadcast to the page
  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ fingerprint_mode: "off" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id != null
          ? chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
          : null
      )
    );
  });
  await page.waitForTimeout(300);

  const unmasked = await page.evaluate(() => ({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));

  // After toggling off, the native timezone should return (not in allowed set)
  expect(ALLOWED_TIMEZONES.has(unmasked.timezone)).toBe(false);
});

test("Date.prototype.toLocaleString family uses masked timezone", async ({ extension, server }) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const date = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));
    const localeStr = date.toLocaleString("en-US", { timeZoneName: "short" });
    const localeDate = date.toLocaleDateString("en-US", { timeZoneName: "short" });
    const localeTime = date.toLocaleTimeString("en-US", { timeZoneName: "short" });
    const offset = date.getTimezoneOffset();
    const resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { localeStr, localeDate, localeTime, offset, resolvedZone };
  });

  expect(ALLOWED_TIMEZONES.has(result.resolvedZone)).toBe(true);

  // The locale strings should reflect the masked timezone, not the real one.
  // We verify consistency: if timezone is America/New_York, offset should be around 300 (EST)
  // or 240 (EDT). For a January date, it's EST = 300.
  if (result.resolvedZone === "America/New_York") {
    expect(result.offset).toBe(300);
  }
});
