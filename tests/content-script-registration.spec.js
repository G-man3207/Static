/* global messageHandlers, syncContentScripts */
// Static — on-demand content-script registration (spec:
// docs/superpowers/specs/2026-10-08-on-demand-content-scripts-design.md).
const { expect, test } = require("./helpers/extension-fixture");
const { staticPageTraces } = require("./helpers/extension");
const { startFixtureServer } = require("./helpers/server");

const registeredMain = (extension) =>
  extension.serviceWorker.evaluate(async () =>
    (await chrome.scripting.getRegisteredContentScripts()).find((script) => script.id === "a-main")
  );

test("default settings register only the core content scripts", async ({ extension, server }) => {
  const main = await registeredMain(extension);
  expect(main.js.map((file) => file.replace(/^\//, ""))).toEqual([
    "block_utils.js",
    "block.js",
    "block_vectors.js",
    "block_iframe_attrs.js",
    "block_style_vectors.js",
    "block_element_decoys.js",
    "block_globals.js",
  ]);

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  const traces = await staticPageTraces(page);
  expect(traces.dom.length).toBeGreaterThan(0);
  expect(traces.platformGetter).not.toContain("block_fingerprint.js");
  expect(traces.rtcWithoutNewThrows).toBe(true);
  expect(traces.timer).toEqual([]);
});

test("switching poisoning and research logging on loads their scripts", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask", research_logging: true })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  const traces = await staticPageTraces(page);
  expect(traces.platformGetter).toContain("block_fingerprint.js");
  expect(traces.timer).toContain("block_adaptive.js");
});

test("a paused site gets no Static page code while other sites keep it", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(
    (origin) =>
      chrome.storage.local.set({
        disabled_origins: { [origin]: true },
        fingerprint_mode: "mask",
        replay_mode: "mask",
        research_logging: true,
      }),
    server.origin
  );
  const paused = await extension.context.newPage();
  await paused.goto(server.url("/blank.html"));
  expect(await staticPageTraces(paused)).toEqual({
    dom: [],
    platformGetter: [],
    rtcWithoutNewThrows: true,
    timer: [],
  });

  // The same server under another hostname is a different, unpaused origin.
  const other = await extension.context.newPage();
  await other.goto(server.url("/blank.html").replace("127.0.0.1", "localhost"));
  const traces = await staticPageTraces(other);
  expect(traces.dom.length).toBeGreaterThan(0);
  expect(traces.timer).toContain("block_adaptive.js");
});

test("pausing one port pauses the host, and the popup state and resume follow the host", async ({
  extension,
  server,
}) => {
  const other = await startFixtureServer({ "/blank.html": "<!doctype html><body>other</body>" });
  try {
    await extension.serviceWorker.evaluate(
      (origin) => chrome.storage.local.set({ disabled_origins: { [origin]: true } }),
      server.origin
    );
    const page = await extension.context.newPage();
    await page.goto(other.url("/blank.html"));
    expect((await staticPageTraces(page)).dom).toEqual([]);

    const tabId = await extension.serviceWorker.evaluate(
      async (url) => (await chrome.tabs.query({ url }))[0].id,
      other.url("/blank.html")
    );
    const details = await extension.serviceWorker.evaluate(
      (id) =>
        new Promise((resolve) => {
          messageHandlers.static_get_details({ tabId: id }, {}, resolve);
        }),
      tabId
    );
    expect(details.disabled).toBe(true);
    await expect
      .poll(() =>
        extension.serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)
      )
      .toBe("OFF");

    // Resuming from the other port resumes the whole host.
    await extension.serviceWorker.evaluate(
      (origin) =>
        new Promise((resolve) => {
          messageHandlers.static_set_site_disabled({ disabled: false, origin }, {}, resolve);
        }),
      other.origin
    );
    expect(
      await extension.serviceWorker.evaluate(
        async () => (await chrome.storage.local.get({ disabled_origins: {} })).disabled_origins
      )
    ).toEqual({});
    await page.reload();
    expect((await staticPageTraces(page)).dom.length).toBeGreaterThan(0);
  } finally {
    await other.close();
  }
});

test("the sync restores registrations after the browser drops them", async ({ extension }) => {
  const ids = await extension.serviceWorker.evaluate(async () => {
    await chrome.scripting.unregisterContentScripts();
    await syncContentScripts();
    return (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id);
  });
  expect(ids.sort()).toEqual(["a-main", "b-isolated"]);
});

test("resuming the last paused site clears the exclusion", async ({ extension, server }) => {
  await extension.serviceWorker.evaluate(
    (origin) => chrome.storage.local.set({ disabled_origins: { [origin]: true } }),
    server.origin
  );
  expect((await registeredMain(extension)).excludeMatches).toEqual(["http://127.0.0.1/*"]);
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ disabled_origins: {} }));
  expect((await registeredMain(extension)).excludeMatches || []).toEqual([]);
});

test("hundreds of paused sites and unpatternable entries still register", async ({ extension }) => {
  const disabled = { "http://[::1]:8080": true, garbage: true };
  for (let i = 0; i < 300; i += 1) disabled[`https://site${i}.example`] = true;
  await extension.serviceWorker.evaluate(
    (origins) => chrome.storage.local.set({ disabled_origins: origins }),
    disabled
  );
  const main = await registeredMain(extension);
  expect(main.excludeMatches).toHaveLength(300);
  expect(main.excludeMatches).toContain("https://site0.example/*");
});

test("research logging message saves the setting and loads the logger", async ({ extension }) => {
  // Calls the service worker's own handler, as the popup's message would.
  const saved = await extension.serviceWorker.evaluate(
    () =>
      new Promise((resolve) => {
        messageHandlers.static_set_research_logging({ enabled: true }, {}, resolve);
      })
  );
  expect(saved).toEqual({ enabled: true, ok: true });
  expect((await registeredMain(extension)).js).toContain("block_adaptive.js");
});
