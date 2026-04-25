const { expect, test } = require("./helpers/extension-fixture");

test("Replay poisoning detects proxied Hotjar recorder bundles", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/hotjar-replay.html"));
  await expect
    .poll(() => page.evaluate(() => Array.isArray(window.__hotjarReplayRecords)))
    .toBe(true);
  await page.locator("#secret").fill("hotjar-replay@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__hotjarAppValues.at(-1),
    replayValue: window.__hotjarReplayRecords.at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "hotjar-replay@example.com",
    replayValue: "redacted@example.invalid",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  expect(Object.keys(replayLog.signals)).toContain(
    `listener-script:${server.url("/assets/hotjar/hotjar-123456.js")}`
  );
});
