/* global messageHandlers, syncContentScripts */
// Static — on-demand content-script registration (spec:
// docs/superpowers/specs/2026-10-08-on-demand-content-scripts-design.md).
const { expect, test } = require("./helpers/extension-fixture");
const {
  registeredScripts,
  setProtectionMode,
  setSiteDecision,
  setStorage,
  staticPageTraces,
} = require("./helpers/extension");
const { startFixtureServer } = require("./helpers/server");

const registeredMain = (extension) =>
  extension.serviceWorker.evaluate(async () =>
    (await chrome.scripting.getRegisteredContentScripts()).find((script) => script.id === "a-main")
  );

test("default settings register only the core content scripts", async ({ extension, server }) => {
  const main = await registeredMain(extension);
  expect(main.js.map((file) => file.replace(/^\//, ""))).toEqual([
    "block_utils.js",
    "block_ua.js",
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
  expect(traces.platformGetter).toContain("block_ua.js");
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
  expect(traces.platformGetter).toContain("block_ua.js");
  expect(traces.platformGetter).not.toContain("block_fingerprint.js");
  expect(traces.timer).toContain("block_adaptive.js");
  const hardwareFrames = await page.evaluate(() => {
    const getter = Object.getOwnPropertyDescriptor(Navigator.prototype, "hardwareConcurrency").get;
    try {
      getter.call({});
    } catch (error) {
      return [...String(error.stack).matchAll(/chrome-extension:\/\/[a-p]{32}\/([\w.]+\.js)/g)].map(
        (match) => match[1]
      );
    }
    return [];
  });
  expect(hardwareFrames).toContain("block_fingerprint.js");
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

// =========================================================================
// v2.8 per-site registrations (spec: Content-script registrations)
// =========================================================================

test("per_site decisions register the full stack on site patterns and scout elsewhere", async ({
  extension,
}) => {
  await setProtectionMode(extension, "per_site");
  await setSiteDecision(extension, "left-off.example", "off");
  let scripts = await registeredScripts(extension);
  expect(scripts.map((script) => script.id)).toEqual(["c-scout-main", "d-scout-isolated"]);

  await setSiteDecision(extension, "127.0.0.1", "on");
  scripts = await registeredScripts(extension);
  expect(scripts.map((script) => script.id)).toEqual([
    "a-main",
    "b-isolated",
    "c-scout-main",
    "d-scout-isolated",
  ]);
  const [main, isolated, scoutMain, scoutIsolated] = scripts;
  expect(main.matches).toEqual(["*://127.0.0.1/*"]);
  expect(isolated.matches).toEqual(main.matches);
  expect(scoutMain.matches).toEqual(["<all_urls>"]);
  expect(scoutIsolated.matches).toEqual(["<all_urls>"]);
  expect(scoutMain.excludeMatches).toEqual(main.matches);
  expect(scoutIsolated.excludeMatches).toEqual(main.matches);
  // An off decision is not a full-stack match and does not exclude the scout.
  expect(main.matches.some((pattern) => pattern.includes("left-off.example"))).toBe(false);
  expect(scoutMain.excludeMatches).not.toContain("*://left-off.example/*");
});

test("per_site ignores always-mode pause entries until the site is decided on", async ({
  extension,
  server,
}) => {
  await setStorage(extension, { disabled_origins: { [server.origin]: true } });
  await setProtectionMode(extension, "per_site");
  let scripts = await registeredScripts(extension);
  expect(scripts.map((script) => script.id)).toEqual(["c-scout-main", "d-scout-isolated"]);
  expect(scripts[0].excludeMatches).toEqual([]);

  await setProtectionMode(extension, "always");
  scripts = await registeredScripts(extension);
  const main = scripts.find((script) => script.id === "a-main");
  expect(main.excludeMatches).toEqual(["http://127.0.0.1/*"]);
});

test("per_site registrations stay sorted, unique and complete for 250 decided sites", async ({
  extension,
}) => {
  const decisions = {};
  for (let index = 0; index < 250; index += 1) {
    decisions[`s${index}.example`] = { at: index + 1, source: "sites-page", state: "on" };
  }
  decisions["[::1]"] = { at: 1, source: "popup", state: "on" };
  decisions["-bad.example"] = { at: 2, source: "popup", state: "on" };
  await setStorage(extension, { protection_mode: "per_site", site_decisions: decisions });

  const scripts = await registeredScripts(extension);
  expect(scripts.map((script) => script.id)).toEqual([
    "a-main",
    "b-isolated",
    "c-scout-main",
    "d-scout-isolated",
  ]);
  const matches = scripts[0].matches;
  expect(matches).toHaveLength(500);
  expect(new Set(matches).size).toBe(500);
  expect(matches).toEqual([...matches].sort());
  expect(matches).toContain("*://s0.example/*");
  expect(matches).toContain("*://*.s249.example/*");
  expect(matches).not.toContain("*://[::1]/*");
  expect(matches).not.toContain("*://-bad.example/*");
  expect(scripts[2].excludeMatches).toEqual(matches);
  expect(scripts[3].excludeMatches).toEqual(matches);
});
