const { expect, test } = require("./helpers/extension-fixture");

test("Replay poisoning detects Datadog Session Replay auto-start init", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/datadog-replay-auto.html"));
  await expect
    .poll(() => page.evaluate(() => Array.isArray(window.__datadogReplayRecords)))
    .toBe(true);
  await page.waitForTimeout(300);
  await page.locator("#secret").fill("dd-auto@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__ddAppValues.at(-1),
    replayValue: window.__datadogReplayRecords.at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "dd-auto@example.com",
    replayValue: "redacted@example.invalid",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  expect(Object.keys(replayLog.signals)).toContain("global:DD_RUM.sessionReplaySampleRate");
});

test("Replay poisoning detects Datadog Session Replay manual start", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/datadog-replay-manual.html"));
  await expect
    .poll(() => page.evaluate(() => Array.isArray(window.__datadogReplayRecords)))
    .toBe(true);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.DD_RUM.startSessionReplayRecording());
  await page.locator("#secret").fill("dd-manual@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__ddAppValues.at(-1),
    replayValue: window.__datadogReplayRecords.at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "dd-manual@example.com",
    replayValue: "redacted@example.invalid",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  expect(Object.keys(replayLog.signals)).toContain("global:DD_RUM.startSessionReplayRecording");
});

test("Replay poisoning leaves Datadog RUM listeners real before manual replay start", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/datadog-replay-manual.html"));
  await expect
    .poll(() => page.evaluate(() => Array.isArray(window.__datadogRumRecords)))
    .toBe(true);
  await page.locator("#secret").fill("dd-rum-only@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__ddAppValues.at(-1),
    replayCount: window.__datadogReplayRecords.length,
    rumValue: window.__datadogRumRecords.at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "dd-rum-only@example.com",
    replayCount: 0,
    rumValue: "dd-rum-only@example.com",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log?.[origin]);
  }, server.origin);
  expect(replayLog).toBeUndefined();
});
