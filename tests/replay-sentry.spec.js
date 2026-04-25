const { expect, test } = require("./helpers/extension-fixture");

test("Replay poisoning detects Sentry Replay init configuration", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/sentry-global-replay.html"));
  await expect.poll(() => page.evaluate(() => window.Sentry.isRecording())).toBe(true);
  await page.locator("#secret").fill("sentry-global@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__sentryAppValues.at(-1),
    replayValue: window.__sentryGlobalRecords.at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "sentry-global@example.com",
    replayValue: "redacted@example.invalid",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  expect(Object.keys(replayLog.signals)).toContain("global:Sentry.replaysSessionSampleRate");
});

test("Replay poisoning detects lazy Sentry Replay addIntegration setup", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/sentry-global-lazy-replay.html"));
  await expect.poll(() => page.evaluate(() => window.Sentry.isRecording())).toBe(true);
  await page.locator("#secret").fill("sentry-lazy@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__sentryAppValues.at(-1),
    replayValue: window.__sentryGlobalRecords.at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "sentry-lazy@example.com",
    replayValue: "redacted@example.invalid",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  expect(Object.keys(replayLog.signals)).toContain(
    "global:Sentry.addIntegration.replayIntegration"
  );
});

test("Replay poisoning ignores regular Sentry error monitoring without Replay", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/sentry-global-no-replay.html"));
  await page.waitForTimeout(300);
  await page.locator("#secret").fill("sentry-errors@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__sentryAppValues.at(-1),
    replayCount: window.__sentryGlobalRecords.length,
    replayStarted: window.Sentry.isRecording(),
  }));

  expect(observed).toEqual({
    appValue: "sentry-errors@example.com",
    replayCount: 0,
    replayStarted: false,
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log?.[origin]);
  }, server.origin);
  expect(replayLog).toBeUndefined();
});
