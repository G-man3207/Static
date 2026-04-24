const { expect, test } = require("./helpers/extension-fixture");

test("Replay poisoning detects proxied PostHog lazy recorder bundles", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/posthog-replay.html"));
  await expect.poll(() => page.evaluate(() => Array.isArray(window.__posthogReplayRecords))).toBe(
    true
  );
  await page.waitForTimeout(300);
  await page.locator("#secret").fill("posthog-replay@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__posthogAppValues.at(-1),
    replayValue: window.__posthogReplayRecords.at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "posthog-replay@example.com",
    replayValue: "redacted@example.invalid",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  expect(Object.keys(replayLog.signals)).toContain(
    `listener-script:${server.url("/assets/posthog/static/lazy-recorder.js")}`
  );
});
