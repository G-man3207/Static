const { expect, test } = require("./helpers/extension-fixture");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const probedUrl = (path = "/manifest.json") => `chrome-extension://${PROBED_ID}${path}`;

test("replay detection does not fire while per-site disabled", async ({ extension, server }) => {
  await extension.serviceWorker.evaluate(
    (origin) =>
      chrome.storage.local.set({
        disabled_origins: { [origin]: true },
        replay_mode: "mask",
      }),
    server.origin
  );

  const page = await extension.context.newPage();
  await page.goto(server.url("/replay.html"));
  await page.waitForTimeout(500);

  // Script src setter should not trigger replay detection when disabled
  await page.evaluate((url) => {
    const script = document.createElement("script");
    script.src = url;
    document.head.appendChild(script);
  }, probedUrl("/logrocket-recorder.js"));

  await page.waitForTimeout(300);

  const replayLog = await extension.serviceWorker.evaluate((origin) => {
    return chrome.storage.local.get("replay_log").then(({ replay_log }) => replay_log?.[origin]);
  }, server.origin);

  expect(replayLog).toBeUndefined();
});

test("replay chaos mode delivers decoy events to replay listeners only", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ replay_mode: "chaos" }));

  const page = await extension.context.newPage();
  await page.goto(server.url("/replay.html"));
  await page.waitForTimeout(800);

  const beforeChaos = await page.evaluate(() => ({
    appMoves: window.__appMoves.length,
    replayMoves: window.__replayRecords.filter((r) => r.type === "mousemove").length,
  }));

  // Wait for chaos loop to fire a few times
  await page.waitForTimeout(3000);

  const afterChaos = await page.evaluate(() => ({
    appMoves: window.__appMoves.length,
    replayMoves: window.__replayRecords.filter((r) => r.type === "mousemove").length,
  }));

  // App handlers should NOT see chaos events (they're delivered directly to replay listeners)
  expect(afterChaos.appMoves).toBe(beforeChaos.appMoves);
  // Replay handlers SHOULD see additional chaos mousemove events
  expect(afterChaos.replayMoves).toBeGreaterThan(beforeChaos.replayMoves);
});
