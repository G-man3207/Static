/* eslint-disable max-lines -- the per-site matrices read best next to each other */
// Static — per-site protection end-to-end tests (spec: docs/site-protection.md).
//
// Everything here drives the real extension through the browser: mode and
// decision messages, storage writes, content-script registrations, the details
// payload, the toolbar badge, page probes and the scout's evidence log. The
// pre-v2.8 default (protection_mode "always") is seeded by the fixture; tests
// that exercise per-site mode opt in explicitly.
const { expect, test } = require("./helpers/extension-fixture");
const {
  callMessageHandler,
  clearStorage,
  getDetails,
  registeredScripts,
  resetStorage,
  setProtectionMode,
  setSiteDecision,
  setStorage,
  siteEvidence,
  staticPageTraces,
  tabIdForUrl,
} = require("./helpers/extension");
const { startFixtureServer } = require("./helpers/server");

const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const OTHER_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID_RE = /^[a-p]{32}$/;

const AMBER = [216, 128, 48];
const RED = [201, 49, 49];
const GRAY = [136, 136, 136];

const SITE = "127.0.0.1";
const LOCAL_SITE = "localhost";

// Page-world files the full stack installs. block_utils.js is shared with the
// scout, so it is not listed here.
const MASKING_SCRIPTS = [
  "block.js",
  "block_adaptive.js",
  "block_element_decoys.js",
  "block_fingerprint.js",
  "block_globals.js",
  "block_iframe_attrs.js",
  "block_replay.js",
  "block_style_vectors.js",
  "block_ua.js",
  "block_vectors.js",
];
const CORE_MAIN_SCRIPTS = [
  "block_utils.js",
  "block_ua.js",
  "block.js",
  "block_vectors.js",
  "block_iframe_attrs.js",
  "block_style_vectors.js",
  "block_element_decoys.js",
  "block_globals.js",
];
const SCOUT_MAIN_SCRIPTS = [
  "block_utils.js",
  "signals.js",
  "scout.js",
  "scout_probes.js",
  "scout_signals.js",
];

const probedUrl = (id = PROBED_ID, path = "/manifest.json") => `chrome-extension://${id}${path}`;

// Deterministic, unique, valid Chrome extension ID for index (a-p base 16).
const extensionIdFor = (index) => {
  let n = index;
  let id = "";
  for (let i = 0; i < 32; i += 1) {
    id = String.fromCharCode(97 + (n % 16)) + id;
    n = Math.floor(n / 16);
  }
  return id;
};

const portOf = (server) => new URL(server.origin).port;
const hostUrl = (server, host, filePath = "/blank.html") =>
  `http://${host}:${portOf(server)}${filePath}`;

const openPage = async (extension, url) => {
  const page = await extension.context.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
};

const activeTabId = (extension) =>
  extension.serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? tab.id : null;
  });

const detailsOf = async (extension, page) => {
  await page.bringToFront();
  const tabId = await activeTabId(extension);
  expect(typeof tabId).toBe("number");
  return { details: await getDetails(extension, tabId), tabId };
};

const badgeOf = (extension, tabId) =>
  extension.serviceWorker.evaluate(async (id) => {
    const [text, color] = await Promise.all([
      chrome.action.getBadgeText({ tabId: id }),
      chrome.action.getBadgeBackgroundColor({ tabId: id }),
    ]);
    let title;
    try {
      title = await chrome.action.getTitle({ tabId: id });
    } catch {}
    return {
      color: Array.isArray(color) ? color.slice(0, 3) : null,
      text,
      title: typeof title === "string" ? title : null,
    };
  }, tabId);

const waitForBadgeText = async (extension, tabId, text) => {
  await expect.poll(async () => (await badgeOf(extension, tabId)).text).toBe(text);
  return badgeOf(extension, tabId);
};

const storageFor = (extension, keys) =>
  extension.serviceWorker.evaluate((requested) => chrome.storage.local.get(requested), keys);

const decisionsFor = async (extension) =>
  (await storageFor(extension, "site_decisions")).site_decisions || {};
const evidenceStore = async (extension) =>
  (await storageFor(extension, "site_evidence")).site_evidence || {};

const sendProbes = (page, urls) =>
  page.evaluate((targets) => Promise.all(targets.map((url) => fetch(url).catch(() => null))), urls);

// The scout observes an unhandled rejected fetch; block.js only records the
// compatibility warning when the page does not attach a catch handler.
const sendUnhandledProbe = (page, url) =>
  page.evaluate((target) => {
    window.__staticUnhandledProbe = fetch(target);
  }, url);

const traceFiles = (traces) => [
  ...new Set([...traces.dom, ...traces.timer, ...traces.platformGetter]),
];
const maskingFiles = (traces) =>
  traceFiles(traces).filter((file) => MASKING_SCRIPTS.includes(file));

const senderFor = (url, tabId = 9001) => ({
  frameId: 0,
  origin: new URL(url).origin,
  tab: { id: tabId, url },
  url,
});

const patchEvidence = (extension, sender, payload) =>
  callMessageHandler(extension, "static_site_evidence", payload, sender);

const rawEvidence = (lastSeen, overrides = {}) => ({
  compat: {},
  device: {},
  firstSeen: Math.max(1, lastSeen - 10_000),
  lastSeen,
  pages: 1,
  probes: { ids: { [PROBED_ID]: 1 }, pathKinds: { manifest: 1 }, total: 1, vectors: { fetch: 1 } },
  replay: {},
  uaReads: 0,
  vendors: {},
  ...overrides,
});

const decisionFor = (state, at = Date.now(), extra = {}) => ({
  at,
  source: state === "on" ? "sites-page" : "popup",
  state,
  ...extra,
});

const setDecisionMessage = (extension, value, state) =>
  callMessageHandler(
    extension,
    "static_set_site_decision",
    value.includes("://") || value.startsWith("http")
      ? { origin: value, state }
      : { site: value, state }
  );

const siteScripts = async (extension) => {
  const scripts = await registeredScripts(extension);
  return {
    main: scripts.find((script) => script.id === "a-main"),
    isolated: scripts.find((script) => script.id === "b-isolated"),
    scoutMain: scripts.find((script) => script.id === "c-scout-main"),
    scoutIsolated: scripts.find((script) => script.id === "d-scout-isolated"),
    scripts,
  };
};

// =========================================================================
// Defaults (spec: modes — per_site is the default)
// =========================================================================

test("fresh storage defaults to per_site: scout-only registrations and an unmasked page", async ({
  extension,
  server,
}) => {
  await clearStorage(extension);
  expect(await storageFor(extension, "protection_mode")).toEqual({});

  const { scripts, scoutMain, scoutIsolated } = await siteScripts(extension);
  expect(scripts.map((script) => script.id).sort()).toEqual(["c-scout-main", "d-scout-isolated"]);
  expect(scoutMain).toMatchObject({
    allFrames: true,
    excludeMatches: [],
    matches: ["<all_urls>"],
    runAt: "document_start",
    world: "MAIN",
  });
  expect(scoutMain.js).toEqual(SCOUT_MAIN_SCRIPTS);
  expect(scoutIsolated.js).toEqual(["lists.js", "bridge.js"]);
  expect(scoutIsolated.world).toBe("ISOLATED");

  const page = await openPage(extension, server.url("/blank.html"));
  const traces = await staticPageTraces(page);
  // spec: an unknown site only runs the observe-only scout. The scout wraps
  // APIs (so its frames can appear in a throwing accessor's stack) but masks
  // nothing: no block_*.js code loads and timers are untouched.
  const blockFrames = traceFiles(traces).filter((file) => file.startsWith("block_"));
  expect(blockFrames).toEqual([]);
  expect(traces.timer).toEqual([]);
  expect(traces.platformGetter.every((file) => file.startsWith("scout"))).toBe(true);
  expect(traces.rtcWithoutNewThrows).toBe(true);

  const { details, tabId } = await detailsOf(extension, page);
  expect(details).toMatchObject({
    disabled: true,
    mode: "per_site",
    origin: server.origin,
    protectedHere: false,
    siteKey: SITE,
    total: 0,
  });
  expect(details.seen).toBe(0);
  expect(details.site).toMatchObject({
    decision: "undecided",
    decisionAt: null,
    evidence: null,
    history: { compatWarning: false, pausedBefore: false },
    key: SITE,
    paused: false,
    recommendation: null,
    state: "undecided",
  });
  expect(details.onboarding).toEqual({ visible: true });
  expect(details.rulesetsApply).toBe(false);
  expect(details.sitesSummary).toMatchObject({ off: 0, on: 0, paused: 0, seen: 0 });

  const badge = await badgeOf(extension, tabId);
  expect(badge.text).toBe("");
  expect(badge.title).toContain("Static is off here");

  // tabIdForUrl agrees with the active-tab helper the rest of the suite uses.
  expect(await tabIdForUrl(extension, page.url())).toBe(tabId);
});

test("fresh storage: probes on an unknown site are observed, never blocked", async ({
  extension,
  server,
}) => {
  await clearStorage(extension);
  const page = await openPage(extension, server.url("/blank.html"));
  const { details: before, tabId } = await detailsOf(extension, page);
  expect(before.total).toBe(0);
  expect(before.protectedHere).toBe(false);

  // spec: scout evidence — badge count is the seen count, amber, decision copy.
  await sendProbes(page, [probedUrl(), probedUrl(OTHER_ID, "/icon.png")]);
  await expect.poll(async () => (await getDetails(extension, tabId)).seen).toBe(2);

  const details = await getDetails(extension, tabId);
  expect(details.total).toBe(0);
  expect(details.protectedHere).toBe(false);
  expect(details.site.decision).toBe("undecided");
  expect(details.site.evidence).toMatchObject({
    lastSeen: expect.any(Number),
    pages: expect.any(Number),
    probeIds: 2,
    probeTotal: 2,
    probeVectors: 1,
  });
  expect(details.site.evidence.firstSeen).toBeLessThanOrEqual(details.site.evidence.lastSeen);
  expect(details.site.evidence.lastSeen).toBeGreaterThan(Date.now() - 60_000);
  expect(details.seenIds.length).toBeGreaterThan(0);
  expect(details.site.recommendation).toMatchObject({
    confidence: "low",
    decisionHint: "Your call",
    headline: "No strong signal here",
    observed: true,
    verdict: "neutral",
  });

  const badge = await waitForBadgeText(extension, tabId, "2");
  expect(badge.color).toEqual(AMBER);
  expect(badge.title).toContain("extension checks seen here");
  expect(badge.title).toContain("2");

  const evidence = await siteEvidence(extension, SITE);
  expect(evidence.probes.total).toBe(2);
  expect(Object.keys(evidence.probes.ids)).toHaveLength(2);
  const stored = JSON.stringify(evidence);
  expect(stored).not.toContain("chrome-extension");
  expect(stored).not.toContain(server.origin);
});

test("non-http tabs get no count badge and the plain Static title", async ({ extension }) => {
  await clearStorage(extension);
  const page = await openPage(extension, "about:blank");
  const tabId = await activeTabId(extension);
  expect(typeof tabId).toBe("number");

  await expect.poll(async () => (await badgeOf(extension, tabId)).text).toBe("");
  expect((await badgeOf(extension, tabId)).title).toBe("Static");
  void page;
});

// =========================================================================
// Decisions: protect / leave off flow
// =========================================================================

test("protecting a site from the popup masks it on reload and blocking shows red", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openPage(extension, server.url("/blank.html"));
  const { tabId } = await detailsOf(extension, page);
  expect(maskingFiles(await staticPageTraces(page))).toEqual([]);

  // spec: static_set_site_decision {origin} resolves the origin to its site key.
  const on = await setDecisionMessage(extension, server.origin, "on");
  expect(on).toMatchObject({ decision: "on", mode: "per_site", ok: true, site: SITE });
  expect(await decisionsFor(extension)).toMatchObject({
    [SITE]: { source: "popup", state: "on" },
  });

  await page.reload();
  const traces = await staticPageTraces(page);
  expect(traces.platformGetter).toContain("block_ua.js");
  expect(maskingFiles(traces).length).toBeGreaterThan(0);

  const details = await getDetails(extension, tabId);
  expect(details).toMatchObject({
    disabled: false,
    mode: "per_site",
    protectedHere: true,
    siteKey: SITE,
  });
  expect(details.site).toMatchObject({ decision: "on", paused: false, state: "on" });
  expect(details.site.decisionAt).toEqual(expect.any(Number));
  expect(details.site.evidence).toBeNull();

  // spec: full stack — extension probes are blocked and counted per tab.
  await sendProbes(page, [
    probedUrl(),
    probedUrl(OTHER_ID, "/icon.png"),
    probedUrl(extensionIdFor(1234), "/script.js"),
  ]);
  await expect.poll(async () => (await getDetails(extension, tabId)).total).toBe(3);
  const badge = await waitForBadgeText(extension, tabId, "3");
  expect(badge.color).toEqual(RED);
  expect(badge.title).toContain("protection on here");

  // spec: off runs only the scout again; the decision records probesAt.
  const off = await setDecisionMessage(extension, server.origin, "off");
  expect(off).toMatchObject({ decision: "off", ok: true, site: SITE });
  const offEntry = (await decisionsFor(extension))[SITE];
  expect(offEntry.state).toBe("off");
  expect(offEntry.probesAt).toBe(0);

  await page.reload();
  const offTraces = await staticPageTraces(page);
  expect(offTraces.platformGetter).not.toContain("block_ua.js");
  expect(maskingFiles(offTraces)).toEqual([]);
  await expect.poll(async () => (await getDetails(extension, tabId)).total).toBe(0);

  await sendProbes(page, [probedUrl(), probedUrl(OTHER_ID, "/icon.png")]);
  await expect.poll(async () => (await getDetails(extension, tabId)).seen).toBe(2);
  const after = await getDetails(extension, tabId);
  expect(after).toMatchObject({ disabled: true, protectedHere: false });
  expect(after.site).toMatchObject({ decision: "off", state: "off" });
  expect(after.site.seenSinceDecision).toBe(2);
  expect(after.site.evidence).toMatchObject({ probeIds: 2, probeTotal: 2 });

  // spec: badge — declined with new evidence stays quiet (no nag).
  const quiet = await waitForBadgeText(extension, tabId, "");
  expect(quiet.title).toContain("your choice");
});

test("clearing a decision returns the site to scout-only", async ({ extension, server }) => {
  await setProtectionMode(extension, "per_site");
  await setDecisionMessage(extension, server.origin, "on");
  await setDecisionMessage(extension, server.origin, "clear");
  expect(await decisionsFor(extension)).toEqual({});

  const page = await openPage(extension, server.url("/blank.html"));
  expect(maskingFiles(await staticPageTraces(page))).toEqual([]);
  const { details } = await detailsOf(extension, page);
  expect(details).toMatchObject({ disabled: true, mode: "per_site", protectedHere: false });
  expect(details.site.decision).toBe("undecided");
});

test("invalid decision input fails cleanly and keeps the stored decisions", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  await setDecisionMessage(extension, server.origin, "on");

  const badState = await callMessageHandler(extension, "static_set_site_decision", {
    origin: server.origin,
    state: "maybe",
  });
  expect(badState).toMatchObject({ ok: false });

  const empty = await callMessageHandler(extension, "static_set_site_decision", {
    origin: "",
    site: "",
    state: "on",
  });
  expect(empty).toMatchObject({ ok: false });

  const fileUrl = await callMessageHandler(extension, "static_set_site_decision", {
    origin: "file:///tmp/a.html",
    state: "on",
  });
  expect(fileUrl).toMatchObject({ ok: false });

  expect(await decisionsFor(extension)).toMatchObject({ [SITE]: { state: "on" } });
});

test("the raw decision helper registers the same decision as the popup message", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  await setSiteDecision(extension, SITE, "on");
  expect(await decisionsFor(extension)).toMatchObject({
    [SITE]: { source: "popup", state: "on" },
  });
  const page = await openPage(extension, server.url("/blank.html"));
  expect(maskingFiles(await staticPageTraces(page)).length).toBeGreaterThan(0);

  await setSiteDecision(extension, SITE, "clear");
  expect(await decisionsFor(extension)).toEqual({});
});

test("onboarding dismissal is persisted and reflected in details", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openPage(extension, server.url("/blank.html"));
  const { details: before } = await detailsOf(extension, page);
  expect(before.onboarding).toEqual({ visible: true });

  const dismissed = await callMessageHandler(extension, "static_dismiss_onboarding", {});
  expect(dismissed).toMatchObject({ dismissed: true, ok: true });
  expect((await storageFor(extension, "onboarding_dismissed")).onboarding_dismissed).toBe(true);

  const { details: after } = await detailsOf(extension, page);
  expect(after.onboarding).toEqual({ visible: false });

  // spec: always mode never shows the per-site onboarding card, dismissed or not.
  await clearStorage(extension);
  await resetStorage(extension);
  await setProtectionMode(extension, "always");
  const { details: always } = await detailsOf(extension, page);
  expect(always.onboarding.visible).toBe(false);
});

// =========================================================================
// Site identity (spec: sites, not origins)
// =========================================================================

test("a decision on static-fixture.test covers its subdomains and registers site patterns", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const on = await setDecisionMessage(
    extension,
    hostUrl(server, "a.static-fixture.test", "/blank.html"),
    "on"
  );
  expect(on).toMatchObject({ decision: "on", ok: true, site: "static-fixture.test" });
  expect(await decisionsFor(extension)).toMatchObject({
    "static-fixture.test": { state: "on" },
  });

  const { main, scoutMain, scoutIsolated } = await siteScripts(extension);
  expect(main.matches).toEqual(["*://*.static-fixture.test/*", "*://static-fixture.test/*"]);
  expect(main.matches).toEqual([...main.matches].sort());
  expect(scoutMain.excludeMatches).toEqual(main.matches);
  expect(scoutIsolated.excludeMatches).toEqual(main.matches);
  expect(main.excludeMatches).toEqual([]);

  for (const host of ["static-fixture.test", "a.static-fixture.test"]) {
    const page = await openPage(extension, hostUrl(server, host));
    const traces = await staticPageTraces(page);
    expect(traces.platformGetter, host).toContain("block_ua.js");
    const { details } = await detailsOf(extension, page);
    expect(details, host).toMatchObject({
      protectedHere: true,
      siteKey: "static-fixture.test",
    });
    expect(details.site.decision).toBe("on");
  }
});

test("127.0.0.1 and localhost are different sites; a decision covers every port", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  await setDecisionMessage(extension, server.origin, "on");

  const loopback = await openPage(extension, server.url("/blank.html"));
  expect((await staticPageTraces(loopback)).platformGetter).toContain("block_ua.js");

  const localhost = await openPage(extension, hostUrl(server, LOCAL_SITE));
  const localhostTraces = await staticPageTraces(localhost);
  expect(localhostTraces.platformGetter).not.toContain("block_ua.js");
  expect(maskingFiles(localhostTraces)).toEqual([]);
  const { details: localhostDetails } = await detailsOf(extension, localhost);
  expect(localhostDetails).toMatchObject({
    protectedHere: false,
    siteKey: LOCAL_SITE,
  });
  expect(localhostDetails.site.decision).toBe("undecided");

  const otherPort = await startFixtureServer({
    "/blank.html": '<!doctype html><meta charset="utf-8"><body>other port</body>',
  });
  try {
    const other = await openPage(extension, otherPort.url("/blank.html"));
    expect((await staticPageTraces(other)).platformGetter).toContain("block_ua.js");
    const { details } = await detailsOf(extension, other);
    expect(details).toMatchObject({ protectedHere: true, siteKey: SITE });
    expect(details.site.decision).toBe("on");
  } finally {
    await otherPort.close();
  }
});

test("site keys normalize scheme, ports, subdomains, ccTLDs, tenants and IDNs", async ({
  extension,
}) => {
  await setProtectionMode(extension, "per_site");
  const cases = [
    ["https://www.paypal.com/login?x=1", "paypal.com"],
    ["http://a.b.example.co.uk:8443/", "example.co.uk"],
    ["http://alice.github.io/", "alice.github.io"],
    ["http://bob.github.io/", "bob.github.io"],
    ["http://bucket.s3.amazonaws.com/key", "bucket.s3.amazonaws.com"],
    ["http://docs.internal/", "docs.internal"],
    ["http://127.0.0.1:9999/", "127.0.0.1"],
    ["http://localhost:3000/", "localhost"],
    ["http://example.com./page", "example.com"],
    ["http://bücher.example/", "xn--bcher-kva.example"],
    ["http://[::1]:8080/", "[::1]"],
  ];
  for (const [origin, site] of cases) {
    const response = await callMessageHandler(extension, "static_set_site_decision", {
      origin,
      state: "on",
    });
    expect(response, origin).toMatchObject({ ok: true, site });
  }

  const decisions = await decisionsFor(extension);
  for (const site of cases.map(([, expected]) => expected)) {
    expect(decisions[site], site).toMatchObject({ state: "on" });
  }
  expect(decisions["www.paypal.com"]).toBeUndefined();
  expect(decisions["a.b.example.co.uk"]).toBeUndefined();

  const { main } = await siteScripts(extension);
  expect(main.matches).toEqual(
    expect.arrayContaining(["*://*.paypal.com/*", "*://xn--bcher-kva.example/*"])
  );
  // IPv6 literals cannot be match patterns; the decision survives without one.
  expect(main.matches.some((pattern) => pattern.includes("[::1]"))).toBe(false);
});

test("registration patterns are unique, sorted and bounded by the decision cap", async ({
  extension,
}) => {
  await setProtectionMode(extension, "per_site");
  const seeded = {};
  for (let index = 0; index < 250; index += 1) {
    seeded[`s${index}.example`] = decisionFor("on", 1000 + index);
  }
  await setStorage(extension, { site_decisions: seeded });
  const { main, scoutMain } = await siteScripts(extension);
  expect(main.matches).toHaveLength(500);
  expect(main.matches).toEqual([...main.matches].sort());
  expect(new Set(main.matches).size).toBe(500);
  expect(scoutMain.excludeMatches).toEqual(main.matches);

  // spec: MAX_SITE_DECISIONS — the oldest on decision is evicted on insert.
  const inserted = await callMessageHandler(extension, "static_set_site_decision", {
    site: "newest.example",
    state: "on",
  });
  expect(inserted).toMatchObject({ ok: true, site: "newest.example" });
  const decisions = await decisionsFor(extension);
  const onSites = Object.entries(decisions).filter(([, entry]) => entry.state === "on");
  expect(onSites).toHaveLength(250);
  expect(decisions["newest.example"]).toBeTruthy();
  expect(decisions["s0.example"]).toBeUndefined();
  expect(decisions["s1.example"]).toBeTruthy();
});

// =========================================================================
// Mode switching (spec: switching modes takes effect on reload)
// =========================================================================

test("per_site -> always switches to two global registrations and masks every host", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  await setDecisionMessage(extension, "decided.example", "on");
  expect((await registeredScripts(extension)).map((script) => script.id).sort()).toEqual([
    "a-main",
    "b-isolated",
    "c-scout-main",
    "d-scout-isolated",
  ]);

  const page = await openPage(extension, server.url("/blank.html"));
  expect(maskingFiles(await staticPageTraces(page))).toEqual([]);

  const response = await callMessageHandler(extension, "static_set_protection_mode", {
    mode: "always",
  });
  expect(response).toMatchObject({ mode: "always", ok: true });
  expect((await storageFor(extension, "protection_mode")).protection_mode).toBe("always");

  const scripts = await registeredScripts(extension);
  expect(scripts.map((script) => script.id).sort()).toEqual(["a-main", "b-isolated"]);
  for (const script of scripts) {
    expect(script.matches).toEqual(["<all_urls>"]);
    expect(script.excludeMatches).toEqual([]);
  }

  // Decisions survive the mode round-trip.
  expect(await decisionsFor(extension)).toMatchObject({
    "decided.example": { state: "on" },
  });

  await page.reload();
  const traces = await staticPageTraces(page);
  expect(traces.platformGetter).toContain("block_ua.js");
  expect(maskingFiles(traces).length).toBeGreaterThan(0);
  const { details } = await detailsOf(extension, page);
  expect(details).toMatchObject({ disabled: false, mode: "always", protectedHere: true });
  expect(details.site.decision).toBe("undecided");
  expect(details.site.evidence).toBeNull();

  // Per-site decisions are not consulted in always mode.
  const wildcard = await openPage(extension, hostUrl(server, "a.static-fixture.test"));
  expect((await staticPageTraces(wildcard)).platformGetter).toContain("block_ua.js");
});

test("always -> per_site restores scout registrations, keeps pauses and masks tapped sites", async ({
  extension,
  server,
}) => {
  await setStorage(extension, { disabled_origins: { [server.origin]: true } });
  const page = await openPage(extension, server.url("/blank.html"));
  expect((await staticPageTraces(page)).dom).toEqual([]);

  const response = await callMessageHandler(extension, "static_set_protection_mode", {
    mode: "per_site",
  });
  expect(response).toMatchObject({ mode: "per_site", ok: true });
  expect((await storageFor(extension, "disabled_origins")).disabled_origins).toEqual({
    [server.origin]: true,
  });
  expect((await registeredScripts(extension)).map((script) => script.id).sort()).toEqual([
    "c-scout-main",
    "d-scout-isolated",
  ]);

  // spec: in per_site pause entries no longer mask, but details still reports them.
  await page.reload();
  const unscouted = await staticPageTraces(page);
  expect(unscouted.platformGetter).not.toContain("block_ua.js");
  expect(unscouted.dom.filter((file) => MASKING_SCRIPTS.includes(file))).toEqual([]);
  const { details: pausedDetails } = await detailsOf(extension, page);
  expect(pausedDetails).toMatchObject({
    disabled: true,
    mode: "per_site",
    paused: true,
    protectedHere: false,
  });
  expect(pausedDetails.site.decision).toBe("undecided");
  expect(pausedDetails.site.paused).toBe(true);

  await setDecisionMessage(extension, server.origin, "on");
  const scripts = await registeredScripts(extension);
  expect(scripts.map((script) => script.id).sort()).toEqual([
    "a-main",
    "b-isolated",
    "c-scout-main",
    "d-scout-isolated",
  ]);
  expect((await storageFor(extension, "disabled_origins")).disabled_origins).toEqual({
    [server.origin]: true,
  });

  await page.reload();
  expect((await staticPageTraces(page)).platformGetter).toContain("block_ua.js");
  const { details } = await detailsOf(extension, page);
  expect(details).toMatchObject({ disabled: false, paused: true, protectedHere: true });
  expect(details.site.decision).toBe("on");
});

test("setting the current mode again is a no-op success", async ({ extension }) => {
  expect((await storageFor(extension, "protection_mode")).protection_mode).toBe("always");
  const same = await callMessageHandler(extension, "static_set_protection_mode", {
    mode: "always",
  });
  expect(same).toMatchObject({ mode: "always", ok: true, unchanged: true });
  expect((await registeredScripts(extension)).map((script) => script.id).sort()).toEqual([
    "a-main",
    "b-isolated",
  ]);

  const bad = await callMessageHandler(extension, "static_set_protection_mode", { mode: "nope" });
  expect(bad).toMatchObject({ ok: false });
  expect((await storageFor(extension, "protection_mode")).protection_mode).toBe("always");
});

// =========================================================================
// Evidence store (spec: Evidence + static_site_evidence)
// =========================================================================

test("page probes accumulate capped, sanitized evidence for the current site", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const page = await openPage(extension, server.url("/blank.html"));
  const { tabId } = await detailsOf(extension, page);
  // The scout must not read page content, but make some available anyway.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "email";
    input.autocomplete = "email";
    input.value = "FORM_SECRET_123";
    document.body.appendChild(input);
  });

  const urlWithQuery = `${probedUrl(OTHER_ID, "/icon-48.png")}?ref=${encodeURIComponent(
    "http://page.example/secret"
  )}&token=QUERY_SECRET_456`;
  await sendProbes(page, [probedUrl(), probedUrl(PROBED_ID, "/x.css"), urlWithQuery]);
  await expect.poll(async () => (await getDetails(extension, tabId)).seen).toBe(3);

  const evidence = await siteEvidence(extension, SITE);
  expect(evidence.probes.total).toBe(3);
  expect(Object.keys(evidence.probes.ids)).toHaveLength(2);
  expect(evidence.probes.ids[PROBED_ID]).toBeGreaterThanOrEqual(2);
  expect(evidence.probes.ids[OTHER_ID]).toBe(1);
  expect(evidence.probes.vectors.fetch).toBe(3);
  expect(evidence.probes.pathKinds.manifest).toBeGreaterThanOrEqual(1);
  expect(evidence.probes.pathKinds.style).toBeGreaterThanOrEqual(1);
  expect(evidence.pages).toBeGreaterThanOrEqual(1);

  for (const id of Object.keys(evidence.probes.ids)) expect(id).toMatch(ID_RE);

  // spec: evidence never stores page URLs, query strings, text or form values.
  const stored = JSON.stringify(evidence);
  expect(stored).not.toContain("chrome-extension");
  expect(stored).not.toContain(server.origin);
  expect(stored).not.toContain("FORM_SECRET_123");
  expect(stored).not.toContain("QUERY_SECRET_456");
  expect(stored).not.toContain("page.example");
  expect(stored.length).toBeLessThan(4000);
});

test("evidence deltas accumulate totals, ids, vectors and path kinds", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const sender = senderFor(server.url("/blank.html"));
  const first = await patchEvidence(extension, sender, {
    overflow: 0,
    probes: [{ count: 2, url: probedUrl(), where: "fetch" }],
  });
  expect(first).toBeUndefined();

  let evidence = await siteEvidence(extension, SITE);
  expect(evidence.probes.total).toBe(2);
  expect(evidence.probes.ids[PROBED_ID]).toBe(2);
  expect(evidence.probes.vectors.fetch).toBe(2);
  expect(evidence.probes.pathKinds.manifest).toBe(2);
  expect(evidence.pages).toBeGreaterThanOrEqual(1);
  const firstSeen = evidence.firstSeen;

  await patchEvidence(extension, sender, {
    overflow: 2,
    probes: [{ count: 3, url: probedUrl(PROBED_ID, "/icon.png"), where: "img" }],
  });
  evidence = await siteEvidence(extension, SITE);
  expect(evidence.probes.total).toBe(2 + 3 + 2);
  expect(evidence.probes.ids[PROBED_ID]).toBe(2 + 3);
  expect(evidence.probes.vectors).toMatchObject({ fetch: 2, img: 3 });
  expect(evidence.probes.pathKinds).toMatchObject({ image: 3, manifest: 2 });
  expect(evidence.firstSeen).toBe(firstSeen);
  expect(evidence.lastSeen).toBeGreaterThanOrEqual(evidence.firstSeen);
  expect(evidence.pages).toBeLessThanOrEqual(2);
});

test("signal deltas merge with catalog caps and ignore unknown ids", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const sender = senderFor(server.url("/blank.html"));
  // spec: scout signals — uaReads plus vendor/device/replay/compat counters.
  await patchEvidence(extension, sender, {
    signals: {
      compat: { bot_challenge: 2, not_a_compat: 9, password_field: 1 },
      device: { canvas: 4, not_a_surface: 9 },
      replay: { logrocket: 1, not_an_sdk: 9 },
      uaReads: 3,
      vendors: { datadome: 1, fingerprintjs: 2, not_a_vendor: 9 },
    },
  });
  const evidence = await siteEvidence(extension, SITE);
  expect(evidence.uaReads).toBe(3);
  expect(evidence.vendors).toMatchObject({ datadome: 1, fingerprintjs: 2 });
  expect(evidence.vendors.not_a_vendor).toBeUndefined();
  expect(evidence.device).toMatchObject({ canvas: 4 });
  expect(evidence.device.not_a_surface).toBeUndefined();
  expect(evidence.replay).toMatchObject({ logrocket: 1 });
  expect(evidence.replay.not_an_sdk).toBeUndefined();
  expect(evidence.compat).toMatchObject({ bot_challenge: 2, password_field: 1 });
  expect(evidence.compat.not_a_compat).toBeUndefined();

  // spec: uaReads and per-key counters are clamped, not unbounded.
  await patchEvidence(extension, sender, {
    signals: { compat: { password_field: 500 }, uaReads: 1_000_000_000 },
  });
  const clamped = await siteEvidence(extension, SITE);
  expect(clamped.uaReads).toBeLessThanOrEqual(1_000_000);
  expect(clamped.compat.password_field).toBeLessThanOrEqual(100);
});

test("duplicate ids accumulate counts and ids are stored lowercase", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const sender = senderFor(server.url("/blank.html"));
  await patchEvidence(extension, sender, {
    probes: [
      { count: 2, url: probedUrl(OTHER_ID, "/manifest.json"), where: "fetch" },
      { count: 3, url: probedUrl(OTHER_ID, "/icon.png"), where: "fetch" },
    ],
  });
  let evidence = await siteEvidence(extension, SITE);
  expect(evidence.probes.ids[OTHER_ID]).toBe(5);
  expect(evidence.probes.total).toBe(5);
  expect(evidence.probes.vectors.fetch).toBe(5);

  const upperId = extensionIdFor(4321).toUpperCase();
  await patchEvidence(extension, sender, {
    probes: [{ count: 1, url: probedUrl(upperId, "/manifest.json") }],
  });
  evidence = await siteEvidence(extension, SITE);
  const keys = Object.keys(evidence.probes.ids);
  expect(keys).toContain(upperId.toLowerCase());
  for (const id of keys) expect(id).toMatch(ID_RE);
});

test("per-message caps keep 200 probe entries and 300 extension ids", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const sender = senderFor(server.url("/blank.html"));

  // 250 entries in one message: 200 enumerated + 50 counted in total.
  const repeated = Array.from({ length: 250 }, () => ({
    count: 1,
    url: probedUrl(PROBED_ID, "/manifest.json"),
    where: "fetch",
  }));
  await patchEvidence(extension, sender, { probes: repeated });
  let evidence = await siteEvidence(extension, SITE);
  expect(evidence.probes.ids[PROBED_ID]).toBe(200);
  expect(evidence.probes.total).toBe(250);
  expect(evidence.probes.vectors.fetch).toBe(200);

  // 400 distinct ids across two messages: the merge keeps 300.
  await clearStorage(extension);
  await setProtectionMode(extension, "per_site");
  const batch = (start) =>
    Array.from({ length: 200 }, (_, offset) => ({
      count: 1,
      url: probedUrl(extensionIdFor(start + offset)),
      where: "fetch",
    }));
  await patchEvidence(extension, sender, { probes: batch(0) });
  await patchEvidence(extension, sender, { probes: batch(200) });
  evidence = await siteEvidence(extension, SITE);
  expect(Object.keys(evidence.probes.ids)).toHaveLength(300);
  expect(evidence.probes.total).toBe(400);

  // Additional ids do not grow the enumeration past the cap.
  await patchEvidence(extension, sender, { probes: batch(500) });
  evidence = await siteEvidence(extension, SITE);
  expect(Object.keys(evidence.probes.ids)).toHaveLength(300);
  expect(evidence.probes.total).toBe(600);
});

test("vector enumeration is capped at 24 per site", async ({ extension, server }) => {
  await setProtectionMode(extension, "per_site");
  const sender = senderFor(server.url("/blank.html"));
  const probes = Array.from({ length: 30 }, (_, index) => ({
    count: 1,
    url: probedUrl(extensionIdFor(index)),
    where: `vector-${String(index).padStart(2, "0")}`,
  }));
  await patchEvidence(extension, sender, { probes });
  const evidence = await siteEvidence(extension, SITE);
  expect(Object.keys(evidence.probes.vectors)).toHaveLength(24);
  expect(evidence.probes.total).toBe(30);
});

test("evidence keeps at most 200 sites, evicting the least recently seen", async ({
  extension,
}) => {
  await setProtectionMode(extension, "per_site");
  const stored = {};
  for (let index = 0; index < 210; index += 1) {
    stored[`old-${String(index).padStart(3, "0")}.example`] = rawEvidence(1000 + index);
  }
  await setStorage(extension, { site_evidence: stored });

  const sender = senderFor("http://fresh.example/blank.html", 77);
  await patchEvidence(extension, sender, {
    probes: [{ count: 1, url: probedUrl(), where: "fetch" }],
  });

  const evidence = await evidenceStore(extension);
  const sites = Object.keys(evidence);
  expect(sites).toHaveLength(200);
  expect(evidence["fresh.example"]).toBeTruthy();
  expect(evidence["fresh.example"].lastSeen).toBeGreaterThan(2100);
  expect(evidence["old-000.example"]).toBeUndefined();
  expect(evidence["old-009.example"]).toBeUndefined();
  expect(evidence["old-209.example"]).toBeTruthy();
});

test("malformed evidence payloads never throw and never leak page strings", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  const sender = senderFor(server.url("/blank.html?q=FORM_TEXT_999"));
  const longPath = "a".repeat(5000);
  const junk = [
    null,
    "junk",
    42,
    {},
    { count: 1 },
    { count: "3", url: 123, where: null },
    { count: -4, url: probedUrl(), where: "fetch" },
    { count: 0, url: probedUrl(), where: "fetch" },
    { count: 1, url: "https://page.example/collect?secret=FORM_TEXT_999", where: "fetch" },
    { count: 1, url: `chrome-extension://short/manifest.json`, where: "fetch" },
    { count: 1, url: `chrome-extension://${"z".repeat(32)}/manifest.json`, where: "fetch" },
    {
      count: 1,
      url: `chrome-extension://${PROBED_ID.toUpperCase()}/manifest.json`,
      where: "fetch",
    },
    {
      count: 1,
      url: `${probedUrl(PROBED_ID)}?q=${encodeURIComponent("http://page.example/secret")}#frag`,
      where: "fetch",
    },
    { count: 1, url: probedUrl(OTHER_ID, `/${longPath}.js`), where: "script" },
    { count: 12.7, url: probedUrl(OTHER_ID, "/icon-48.png"), where: "img" },
  ];
  const responses = [
    { overflow: -5, probes: junk },
    { overflow: 1e12, probes: junk, signals: { uaReads: -3 } },
    { probes: "not-an-array", signals: { compat: "nope", device: [1, 2], vendors: null } },
    { probes: null, signals: { uaReads: 2.7, vendors: { fingerprintjs: -2 } } },
    {},
  ];
  for (const payload of responses) {
    await expect(patchEvidence(extension, sender, payload)).resolves.toBeUndefined();
  }

  const evidence = await siteEvidence(extension, SITE);
  expect(evidence).toBeTruthy();
  expect(evidence.probes.total).toBeGreaterThanOrEqual(1);
  expect(evidence.probes.total).toBeLessThanOrEqual(1_000_000_000);
  expect(evidence.uaReads).toBeGreaterThanOrEqual(2);
  expect(Number.isInteger(evidence.uaReads)).toBe(true);
  for (const [id, count] of Object.entries(evidence.probes.ids)) {
    expect(id).toMatch(ID_RE);
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThan(0);
  }
  expect(evidence.probes.ids[PROBED_ID]).toBeGreaterThanOrEqual(1);

  const stored = JSON.stringify(evidence);
  expect(stored).not.toContain("chrome-extension");
  expect(stored).not.toContain("https://");
  expect(stored).not.toContain("http://");
  expect(stored).not.toContain("page.example");
  expect(stored).not.toContain("FORM_TEXT_999");
  expect(stored).not.toContain("secret");
  expect(stored).not.toContain("frag");
  expect(stored).not.toContain("a".repeat(5000));
  expect(stored.length).toBeLessThan(20_000);
});

test("a page that probes before any decision seeds evidence for the site", async ({
  extension,
  server,
}) => {
  await resetStorage(extension);
  await setProtectionMode(extension, "per_site");
  const page = await openPage(extension, server.url("/blank.html"));
  await sendProbes(page, [
    probedUrl(),
    probedUrl(OTHER_ID, "/icon.png"),
    probedUrl(extensionIdFor(42), "/script.js"),
  ]);
  const tabId = await activeTabId(extension);
  await expect.poll(async () => (await getDetails(extension, tabId)).seen).toBe(3);

  const evidence = await siteEvidence(extension, SITE);
  expect(evidence).toBeTruthy();
  expect(evidence.probes.total).toBe(3);
  expect(evidence.probes.ids[PROBED_ID]).toBeGreaterThanOrEqual(1);
  expect(evidence.probes.vectors.fetch).toBe(3);
  expect(evidence.pages).toBeGreaterThanOrEqual(1);
  expect(evidence.firstSeen).toBeGreaterThan(Date.now() - 60_000);
  expect(evidence.firstSeen).toBeLessThanOrEqual(evidence.lastSeen);
});

test("the probe log seeds site evidence when switching to per_site mode", async ({
  extension,
  server,
}) => {
  // spec: migration — always-mode probe history seeds site_evidence so a fresh
  // per_site install does not start blind, and a second switch does not double-count.
  await resetStorage(extension);
  const page = await openPage(extension, server.url("/blank.html"));
  const tabId = await activeTabId(extension);
  await sendProbes(page, [probedUrl(), probedUrl(OTHER_ID, "/icon.png")]);
  await expect.poll(async () => (await getDetails(extension, tabId)).total).toBe(2);
  const probeLog = await storageFor(extension, "probe_log");
  expect(probeLog.probe_log[server.origin]).toBeTruthy();
  expect(await siteEvidence(extension, SITE)).toBeNull();

  await callMessageHandler(extension, "static_set_protection_mode", { mode: "per_site" });
  await expect
    .poll(async () => {
      const seeded = await siteEvidence(extension, SITE);
      return seeded ? seeded.probes.total : 0;
    })
    .toBeGreaterThanOrEqual(2);
  const seeded = await siteEvidence(extension, SITE);
  expect(Object.keys(seeded.probes.ids).length).toBeGreaterThanOrEqual(1);
  for (const id of Object.keys(seeded.probes.ids)) expect(id).toMatch(ID_RE);
  expect(seeded.pages).toBeGreaterThanOrEqual(1);
  // The 2.7 probe log only carries ids/counts, so vectors/pathKinds stay optional.
  const seededTotal = seeded.probes.total;

  // Round-trip the mode again: the already-observed site must not be counted twice.
  await callMessageHandler(extension, "static_set_protection_mode", { mode: "always" });
  await callMessageHandler(extension, "static_set_protection_mode", { mode: "per_site" });
  const second = await siteEvidence(extension, SITE);
  expect(second.probes.total).toBe(seededTotal);
  expect(second.probes.ids[PROBED_ID]).toBe(seeded.probes.ids[PROBED_ID]);
  // The 2.7 log itself keeps its own count.
  expect((await storageFor(extension, "probe_log")).probe_log[server.origin]).toBeTruthy();
});

// =========================================================================
// Badge semantics (spec: Badge and action title)
// =========================================================================

test("seen badges cap their count at 99+", async ({ extension, server }) => {
  await clearStorage(extension);
  await setProtectionMode(extension, "per_site");
  const page = await openPage(extension, server.url("/blank.html"));
  const { tabId } = await detailsOf(extension, page);

  const urls = Array.from({ length: 120 }, (_, index) =>
    probedUrl(extensionIdFor(index), "/manifest.json")
  );
  await sendProbes(page, urls);
  await expect.poll(async () => (await getDetails(extension, tabId)).seen).toBe(120);

  const badge = await waitForBadgeText(extension, tabId, "99+");
  expect(badge.color).toEqual(AMBER);
  expect(badge.title).toContain("120 extension checks seen here");
  expect((await getDetails(extension, tabId)).total).toBe(0);
});

test("always-mode badge counts blocked probes red and paused origins OFF gray", async ({
  extension,
  server,
}) => {
  const page = await openPage(extension, server.url("/blank.html"));
  const { tabId } = await detailsOf(extension, page);
  await sendProbes(page, [probedUrl(), probedUrl(OTHER_ID, "/icon.png")]);
  const count = await waitForBadgeText(extension, tabId, "2");
  expect(count.color).toEqual(RED);
  expect(count.title).toContain("probes blocked here");

  const paused = await callMessageHandler(extension, "static_set_site_disabled", {
    disabled: true,
    origin: server.origin,
  });
  expect(paused).toMatchObject({ ok: true });
  await expect.poll(async () => (await badgeOf(extension, tabId)).text).toBe("OFF");
  expect((await badgeOf(extension, tabId)).color).toEqual(GRAY);
  expect((await badgeOf(extension, tabId)).title).toContain("paused here");

  const resumed = await callMessageHandler(extension, "static_set_site_disabled", {
    disabled: false,
    origin: server.origin,
  });
  expect(resumed).toMatchObject({ ok: true });
  await page.reload();
  await sendProbes(page, [probedUrl()]);
  const again = await waitForBadgeText(extension, tabId, "1");
  expect(again.color).toEqual(RED);
});

test("declining a site with no probes leaves an empty badge and the choice title", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  await setDecisionMessage(extension, server.origin, "off");
  const page = await openPage(extension, server.url("/blank.html"));
  const { details, tabId } = await detailsOf(extension, page);
  expect(details).toMatchObject({ protectedHere: false });
  expect(details.site.decision).toBe("off");
  const badge = await waitForBadgeText(extension, tabId, "");
  expect(badge.title).toContain("your choice");
});

test("seen counts reset when the tab leaves the site and comes back", async ({
  extension,
  server,
}) => {
  await clearStorage(extension);
  await setProtectionMode(extension, "per_site");
  const page = await openPage(extension, server.url("/blank.html"));
  const { tabId } = await detailsOf(extension, page);
  await sendProbes(page, [probedUrl(), probedUrl(OTHER_ID, "/icon.png")]);
  await expect.poll(async () => (await getDetails(extension, tabId)).seen).toBe(2);
  await waitForBadgeText(extension, tabId, "2");

  await page.goto(hostUrl(server, LOCAL_SITE));
  await expect.poll(async () => (await badgeOf(extension, tabId)).text).toBe("");
  expect((await getDetails(extension, tabId)).seen).toBe(0);

  await page.goto(server.url("/blank.html"));
  expect((await getDetails(extension, tabId)).seen).toBe(0);
  await sendProbes(page, [probedUrl(), probedUrl(OTHER_ID, "/icon.png")]);
  await expect.poll(async () => (await getDetails(extension, tabId)).seen).toBe(2);
  await waitForBadgeText(extension, tabId, "2");
});

// =========================================================================
// Compatibility warning override (spec: Recommendation overrides)
// =========================================================================

test("a fresh compatibility warning forces skip, marks history and shows !", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  await setDecisionMessage(extension, server.origin, "on");

  // Strong probe evidence alone recommends protect (benefit 45, risk 0).
  const strongEvidence = rawEvidence(Date.now(), {
    probes: {
      ids: Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [extensionIdFor(1000 + index), 50])
      ),
      pathKinds: { manifest: 750, image: 750 },
      total: 6000,
      vectors: { fetch: 3000, img: 1500, xhr: 1000, script: 500 },
    },
  });
  await setStorage(extension, { site_evidence: { [SITE]: strongEvidence } });

  const page = await openPage(extension, server.url("/blank.html"));
  const { tabId } = await detailsOf(extension, page);
  expect((await getDetails(extension, tabId)).site.recommendation.verdict).toBe("protect");

  await sendUnhandledProbe(page, probedUrl());
  await expect.poll(async () => (await getDetails(extension, tabId)).compatWarning).not.toBeNull();

  const details = await getDetails(extension, tabId);
  expect(details.compatWarning).toMatchObject({
    kinds: expect.arrayContaining([["unhandled_blocked_fetch", 1]]),
    total: 1,
  });
  expect(details.site.history.compatWarning).toBe(true);
  expect(details.site.recommendation).toMatchObject({
    caution: false,
    confidence: "high",
    decisionHint: "Leave it off",
    headline: "We suggest leaving masking off here",
    observed: true,
    verdict: "skip",
  });
  expect(details.site.recommendation.benefit).toBeGreaterThanOrEqual(
    details.site.recommendation.risk
  );
  expect(details.site.recommendation.risks[0].key).toBe("compat_warning");

  const badge = await waitForBadgeText(extension, tabId, "!");
  expect(badge.color).toEqual(AMBER);
  expect(badge.title).toContain("protection broke");
});

// =========================================================================
// Export and clear (spec: static_export_log / static_clear_log)
// =========================================================================

test("per_site export includes the mode, decisions and evidence without page URLs", async ({
  extension,
}) => {
  await setProtectionMode(extension, "per_site");
  await setDecisionMessage(extension, "export-site.example", "on");
  await patchEvidence(
    extension,
    senderFor("http://export-site.example/private/path.html?q=PAGE_TEXT_123", 8),
    { probes: [{ count: 2, url: probedUrl(), where: "fetch" }] }
  );

  const exported = await callMessageHandler(extension, "static_export_log", {});
  expect(exported).toMatchObject({
    schema: "static.probe-log.v1",
    protectionMode: "per_site",
    siteDecisions: {
      // spec: messages that carry `site` (sites page) are recorded as sites-page.
      "export-site.example": { source: "sites-page", state: "on" },
    },
  });
  expect(exported.siteEvidence["export-site.example"].probes.total).toBe(2);
  expect(exported.rulesetPrefs).toEqual({
    captcha_vendors: false,
    fingerprint_vendors: true,
  });
  for (const key of [
    "adaptiveSignals",
    "compatibilityWarnings",
    "cumulative",
    "diagnostics",
    "diagnosticsMode",
    "exportedAt",
    "fingerprintMode",
    "origins",
    "replayDetections",
  ]) {
    expect(exported, key).toHaveProperty(key);
  }

  const sitePart = JSON.stringify({
    siteDecisions: exported.siteDecisions,
    siteEvidence: exported.siteEvidence,
  });
  expect(sitePart).not.toContain("http");
  expect(sitePart).not.toContain("PAGE_TEXT_123");
  expect(sitePart).not.toContain("/private/path");
});

test("always-mode export keeps the v2.7 shape", async ({ extension }) => {
  await resetStorage(extension);
  const exported = await callMessageHandler(extension, "static_export_log", {});
  for (const key of [
    "adaptiveSignals",
    "compatibilityWarnings",
    "cumulative",
    "diagnostics",
    "diagnosticsMode",
    "fingerprintMode",
    "origins",
    "replayDetections",
    "schema",
    "exportedAt",
  ]) {
    expect(exported, key).toHaveProperty(key);
  }
  expect(exported.protectionMode).toBeUndefined();
  expect(exported.siteDecisions).toBeUndefined();
  expect(exported.siteEvidence).toBeUndefined();
});

test("clearing the log drops evidence but keeps decisions and the mode", async ({
  extension,
  server,
}) => {
  await setProtectionMode(extension, "per_site");
  await setDecisionMessage(extension, server.origin, "on");
  await setStorage(extension, {
    adaptive_log: { "http://x.test": { total: 1 } },
    compat_log: { "http://x.test": { total: 1 } },
    cumulative: 12,
    diagnostic_log: { "http://x.test": { events: [] } },
    probe_log: { "http://x.test": { idCounts: { [PROBED_ID]: 2 } } },
    replay_log: { "http://x.test": { total: 1 } },
    site_evidence: { [SITE]: rawEvidence(Date.now()) },
    tab_seen: { 7: { at: Date.now(), ids: [], total: 3 } },
    user_secret: "deadbeef",
  });
  expect((await decisionsFor(extension))[SITE].state).toBe("on");

  const response = await callMessageHandler(extension, "static_clear_log", {});
  expect(response).toMatchObject({ ok: true });

  const stored = await storageFor(extension, [
    "adaptive_log",
    "compat_log",
    "cumulative",
    "diagnostic_log",
    "probe_log",
    "replay_log",
    "site_decisions",
    "site_evidence",
    "tab_seen",
    "user_secret",
  ]);
  for (const key of ["adaptive_log", "compat_log", "diagnostic_log", "probe_log", "replay_log"]) {
    expect(stored[key], key).toBeUndefined();
  }
  expect(stored.cumulative).toBeUndefined();
  expect(stored.user_secret).toBeUndefined();
  expect(stored.site_evidence).toBeUndefined();
  expect(stored.tab_seen).toBeUndefined();
  expect(stored.site_decisions[SITE].state).toBe("on");
  expect((await storageFor(extension, "protection_mode")).protection_mode).toBe("per_site");
});

// =========================================================================
// Sites overview (spec: static_get_sites_overview)
// =========================================================================

const overviewFor = (extension) => callMessageHandler(extension, "static_get_sites_overview", {});

test("sites overview returns sorted, counted lists and caps without page content", async ({
  extension,
}) => {
  const now = Date.now();
  const evidence = {};
  for (let index = 0; index < 60; index += 1) {
    evidence[`seen-${String(index).padStart(2, "0")}.example`] = rawEvidence(
      now - (60 - index) * 1000
    );
  }
  evidence["protected-one.example"] = rawEvidence(now - 500);
  evidence["paused-a.example"] = rawEvidence(now - 400);

  const decisions = {
    "protected-one.example": decisionFor("on", now - 3000),
    "protected-two.example": decisionFor("on", now - 2000),
    "off-one.example": decisionFor("off", now - 1000),
    "seen-59.example": decisionFor("on", now - 500),
  };
  evidence["off-one.example"] = rawEvidence(now - 600);
  evidence["seen-59.example"] = rawEvidence(now - 700);

  await setStorage(extension, {
    disabled_origins: {
      "http://paused-a.example": true,
      "https://paused-b.example:8080": true,
    },
    onboarding_dismissed: false,
    protection_mode: "per_site",
    site_decisions: decisions,
    site_evidence: evidence,
  });

  const overview = await overviewFor(extension);
  expect(overview.mode).toBe("per_site");
  expect(overview.onboardingDismissed).toBe(false);
  expect(overview.caps).toMatchObject({ evidence: 200, protected: 250, seen: 50 });
  expect(overview.caps.paused).toBe(2);
  expect(overview.prefs).toEqual({ captcha_vendors: false, fingerprint_vendors: true });

  // spec: Protected sites — rows sorted by decision time desc.
  expect(overview.protected.map((row) => row.site)).toEqual([
    "seen-59.example",
    "protected-two.example",
    "protected-one.example",
  ]);
  expect(overview.protected[0]).toMatchObject({
    at: now - 500,
    site: "seen-59.example",
    state: "on",
  });
  expect(overview.protected[0].evidence).toMatchObject({ probeTotal: 1 });
  expect(overview.protected[0].recommendation).toMatchObject({ verdict: "neutral" });
  expect(overview.protected[1]).toMatchObject({ at: now - 2000, site: "protected-two.example" });
  expect(overview.protected[1].recommendation).toBeNull();
  expect(overview.protected[1].evidence).toBeNull();

  expect(overview.declined.map((row) => row.site)).toEqual(["off-one.example"]);
  expect(overview.declined[0]).toMatchObject({ site: "off-one.example", state: "off" });
  expect(overview.declined[0].evidence).toMatchObject({ probeTotal: 1 });
  expect(overview.declined[0].recommendation).toMatchObject({ verdict: "neutral" });

  expect(overview.seen).toHaveLength(50);
  expect(overview.seen[0].site).toBe("seen-58.example");
  expect(overview.seen.at(-1).site).toBe("seen-09.example");
  expect(overview.seen[0].evidence).toMatchObject({ probeTotal: 1 });
  expect(overview.seen[0].lastSeen).toBe(now - 2000);
  const seenSites = overview.seen.map((row) => row.site);
  expect(seenSites).not.toContain("protected-one.example");
  expect(seenSites).not.toContain("off-one.example");
  expect(seenSites).not.toContain("paused-a.example");
  const lastSeens = overview.seen.map((row) => row.lastSeen);
  expect(lastSeens).toEqual([...lastSeens].sort((a, b) => b - a));

  expect(overview.paused).toEqual(
    ["http://paused-a.example", "https://paused-b.example:8080"].sort()
  );

  // spec: overview carries counts and catalog keys, never page text.
  const serialized = JSON.stringify(overview);
  expect(serialized).not.toContain("http://127.0.0.1");
  expect(serialized).not.toContain("blank");
  expect(serialized).not.toContain("PAGE_TEXT");
});

test("always-mode overview lists paused origins and keeps the same caps", async ({ extension }) => {
  await setStorage(extension, {
    disabled_origins: {
      "http://a.example": true,
      "https://b.example:8443": true,
      "https://disabled.example": false,
    },
    protection_mode: "always",
  });
  const overview = await overviewFor(extension);
  expect(overview.mode).toBe("always");
  expect(overview.paused).toEqual(["http://a.example", "https://b.example:8443"]);
  expect(overview.caps).toMatchObject({ evidence: 200, protected: 250, seen: 50 });
  expect(overview.prefs).toEqual({ captcha_vendors: false, fingerprint_vendors: true });
});

// =========================================================================
// Always-mode regressions (spec: always is v2.7 behavior, byte for byte)
// =========================================================================

test("always mode blocks extension probes on an arbitrary fixture origin", async ({
  extension,
}) => {
  const otherServer = await startFixtureServer({
    "/blank.html": '<!doctype html><meta charset="utf-8"><body>arbitrary</body>',
  });
  try {
    const page = await openPage(extension, otherServer.url("/blank.html"));
    const { tabId, details } = await detailsOf(extension, page);
    expect(details).toMatchObject({
      disabled: false,
      mode: "always",
      protectedHere: true,
      siteKey: SITE,
    });
    expect(details.site).toMatchObject({
      decision: "undecided",
      evidence: null,
      paused: false,
      recommendation: null,
    });
    expect(details.rulesetsApply).toBe(true);
    expect(details.rulesetPrefs).toEqual({ captcha_vendors: false, fingerprint_vendors: true });

    await sendProbes(page, [probedUrl(), probedUrl(OTHER_ID, "/icon.png")]);
    await expect.poll(async () => (await getDetails(extension, tabId)).total).toBe(2);
    const { probe_log: probeLog } = await storageFor(extension, "probe_log");
    expect(probeLog[otherServer.origin].idCounts[PROBED_ID]).toBeGreaterThanOrEqual(1);
    expect(probeLog[otherServer.origin].idCounts[OTHER_ID]).toBeGreaterThanOrEqual(1);
  } finally {
    await otherServer.close();
  }
});

test("always mode pause endpoint keeps excluding the origin from the page code", async ({
  extension,
  server,
}) => {
  const page = await openPage(extension, server.url("/blank.html"));
  expect(maskingFiles(await staticPageTraces(page)).length).toBeGreaterThan(0);
  const { tabId } = await detailsOf(extension, page);

  await callMessageHandler(extension, "static_set_site_disabled", {
    disabled: true,
    origin: server.origin,
  });
  expect((await storageFor(extension, "disabled_origins")).disabled_origins).toEqual({
    [server.origin]: true,
  });
  const { main, isolated } = await siteScripts(extension);
  expect(main.excludeMatches).toEqual(["http://127.0.0.1/*"]);
  expect(isolated.excludeMatches).toEqual(main.excludeMatches);

  await page.reload();
  const pausedTraces = await staticPageTraces(page);
  expect(pausedTraces.dom).toEqual([]);
  expect(pausedTraces.platformGetter).toEqual([]);
  expect(pausedTraces.timer).toEqual([]);
  expect((await getDetails(extension, tabId)).paused).toBe(true);

  await callMessageHandler(extension, "static_set_site_disabled", {
    disabled: false,
    origin: server.origin,
  });
  expect((await storageFor(extension, "disabled_origins")).disabled_origins).toEqual({});
  expect((await siteScripts(extension)).main.excludeMatches).toEqual([]);
  await page.reload();
  expect(maskingFiles(await staticPageTraces(page)).length).toBeGreaterThan(0);
});

test("feature scripts stay gated by their own settings in always mode", async ({
  extension,
  server,
}) => {
  await resetStorage(extension);
  const defaults = await registeredScripts(extension);
  expect(defaults.find((script) => script.id === "a-main").js).toEqual(CORE_MAIN_SCRIPTS);

  await setStorage(extension, {
    fingerprint_mode: "mask",
    replay_mode: "noise",
    research_logging: true,
  });
  expect((await siteScripts(extension)).main.js).toEqual([
    "block_utils.js",
    "block_ua.js",
    "block_adaptive.js",
    "block.js",
    "block_vectors.js",
    "block_iframe_attrs.js",
    "block_style_vectors.js",
    "block_fingerprint.js",
    "block_replay.js",
    "block_element_decoys.js",
    "block_globals.js",
  ]);

  const page = await openPage(extension, server.url("/blank.html"));
  const traces = await staticPageTraces(page);
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
