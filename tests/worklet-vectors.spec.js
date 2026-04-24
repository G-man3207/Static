const { expect, test } = require("./helpers/extension-fixture");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const probedUrl = (path = "/processor.js") => `chrome-extension://${PROBED_ID}${path}`;

const vectorCountsFor = (extension, origin) =>
  extension.serviceWorker.evaluate(
    (pageOrigin) =>
      chrome.storage.local.get("probe_log").then(({ probe_log }) => {
        const weeks =
          probe_log &&
          probe_log[pageOrigin] &&
          probe_log[pageOrigin].playbook &&
          probe_log[pageOrigin].playbook.weeks;
        return (weeks && Object.values(weeks)[0].vectorCounts) || {};
      }),
    origin
  );

test("worklet module loaders fail closed for extension script URLs", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));

  const result = await page.evaluate(async (workletUrl) => {
    const rejectedOutcome = (error) => ({
      ctor: error && error.constructor && error.constructor.name,
      message: error && error.message,
      name: error && error.name,
      status: "rejected",
    });
    const loadWorklet = async (worklet) => {
      if (!worklet || typeof worklet.addModule !== "function") return { status: "unavailable" };
      try {
        await worklet.addModule(workletUrl);
        return { status: "resolved" };
      } catch (error) {
        return rejectedOutcome(error);
      }
    };
    const loadAudioWorklet = async () => {
      const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof AudioCtx !== "function") return { status: "unavailable" };
      let audioContext = null;
      try {
        audioContext = new AudioCtx();
        return await loadWorklet(audioContext.audioWorklet);
      } catch (error) {
        return { ...rejectedOutcome(error), status: "outer-error" };
      } finally {
        try {
          if (audioContext && typeof audioContext.close === "function") await audioContext.close();
        } catch {}
      }
    };
    const surface =
      typeof Worklet !== "undefined" && Worklet.prototype
        ? {
            length: Worklet.prototype.addModule.length,
            source: Function.prototype.toString.call(Worklet.prototype.addModule),
          }
        : null;

    return {
      audio: await loadAudioWorklet(),
      paint: await loadWorklet(globalThis.CSS && CSS.paintWorklet),
      surface,
    };
  }, probedUrl());

  const outcomes = [result.paint, result.audio];
  const availableCount = outcomes.filter((outcome) => outcome.status !== "unavailable").length;
  expect(availableCount).toBeGreaterThan(0);
  for (const outcome of outcomes) {
    if (outcome.status === "unavailable") continue;
    expect(outcome).toMatchObject({
      ctor: "DOMException",
      name: "AbortError",
      status: "rejected",
    });
    expect(outcome.message).toContain("worklet");
  }
  expect(result.surface).toMatchObject({
    length: 1,
    source: "function addModule() { [native code] }",
  });

  await expect
    .poll(() => vectorCountsFor(extension, server.origin))
    .toMatchObject({
      "Worklet.addModule": availableCount,
    });
});
