const { expect, test } = require("./helpers/extension-fixture");

test("Replay poisoning detects proxied PostHog lazy recorder bundles", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/posthog-replay.html"));
  await expect
    .poll(() => page.evaluate(() => Array.isArray(window.__posthogReplayRecords)))
    .toBe(true);
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

test("Replay poisoning detects documented PostHog global recording starts", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/posthog-global-replay.html"));
  await expect.poll(() => page.evaluate(() => window.posthog.sessionRecordingStarted())).toBe(true);
  await page.locator("#secret").fill("posthog-global@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__posthogAppValues.at(-1),
    replayValue: window.__posthogReplayRecords.at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "posthog-global@example.com",
    replayValue: "redacted@example.invalid",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  expect(Object.keys(replayLog.signals)).toContain("global:posthog.startSessionRecording");
});

test("Replay poisoning detects default PostHog replay starts during init", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/posthog-global-auto.html"));
  await expect.poll(() => page.evaluate(() => window.posthog.sessionRecordingStarted())).toBe(true);
  await page.locator("#secret").fill("posthog-auto@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__posthogAppValues.at(-1),
    replayValue: window.__posthogReplayRecords.at(-1).value,
  }));

  expect(observed).toEqual({
    appValue: "posthog-auto@example.com",
    replayValue: "redacted@example.invalid",
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log[origin]);
  }, server.origin);
  expect(Object.keys(replayLog.signals)).toContain("global:posthog.init.sessionReplay");
});

test("Replay poisoning respects PostHog disable_session_recording init config", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/posthog-global-disabled.html"));
  await page.locator("#secret").fill("posthog-disabled@example.com");

  const observed = await page.evaluate(() => ({
    appValue: window.__posthogAppValues.at(-1),
    replayCount: window.__posthogReplayRecords.length,
    replayStarted: window.posthog.sessionRecordingStarted(),
  }));

  expect(observed).toEqual({
    appValue: "posthog-disabled@example.com",
    replayCount: 0,
    replayStarted: false,
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log?.[origin]);
  }, server.origin);
  expect(replayLog).toBeUndefined();
});

test("Replay poisoning respects PostHog flags-disabled init config", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "mask" }));

  await page.goto(server.url("/posthog-global-flags-disabled.html"));
  await page.locator("#secret").fill("posthog-flags-off@example.com");

  const observed = await page.evaluate(() => ({
    analyticsValue: window.__posthogAnalyticsRecords.at(-1).value,
    appValue: window.__posthogAppValues.at(-1),
    replayCount: window.__posthogReplayRecords.length,
    replayStarted: window.posthog.sessionRecordingStarted(),
  }));

  expect(observed).toEqual({
    analyticsValue: "posthog-flags-off@example.com",
    appValue: "posthog-flags-off@example.com",
    replayCount: 0,
    replayStarted: false,
  });

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log?.[origin]);
  }, server.origin);
  expect(replayLog).toBeUndefined();
});
