const { expect, test } = require("./helpers/extension-fixture");

test("Replay poisoning detects documented OpenReplay global recording starts", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/openreplay-global-replay.html"));
  await expect.poll(() => page.evaluate(() => window.OpenReplay.isActive())).toBe(true);
  await page.locator("#secret").fill("openreplay-global@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__orAppValues.at(-1),
    replayValue: window.__orRecords.at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "openreplay-global@example.com",
    replayValue: "redacted@example.invalid",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  expect(Object.keys(replayLog.signals)).toContain("global:OpenReplay.start");
});
