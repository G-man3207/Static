// Sites page — per-site protection management (sites.html).
//
// The page reads everything from the service worker's
// "static_get_sites_overview" message and writes decisions back through the
// existing site-decision / protection-mode / paused-origin messages, so these
// tests seed chrome.storage.local and drive the real page.
const { expect, test } = require("./helpers/extension-fixture");

const NOW = Date.now();
const LONG_SITE = `${"a".repeat(60)}.example`;
// Storage sanitizes to Chromium/Firefox extension-ID shapes before the overview
// is built, so evidence fixtures use real-length IDs or probeIds drops to zero.
const extensionId = (letter) => letter.repeat(32);

const sitesUrl = (extension) => `chrome-extension://${extension.extensionId}/sites.html`;

// One full Evidence record (the storage shape) with easy per-test overrides.
const evidenceFor = (overrides = {}) => ({
  compat: {},
  device: {},
  firstSeen: NOW - 3_600_000,
  lastSeen: NOW - 60_000,
  pages: 2,
  probes: { ids: {}, pathKinds: {}, total: 40, vectors: {} },
  replay: {},
  uaReads: 2,
  vendors: {},
  ...overrides,
});

const probeEvidence = ({ compat = {}, device = {}, ids = {}, total, vendors = {} }) =>
  evidenceFor({
    compat,
    device,
    probes: { ids, pathKinds: {}, total, vectors: { fetch: 1 } },
    vendors,
  });

const decision = (state, at = NOW - 120_000) => ({ at, source: "popup", state });

const seedStorage = (extension, values) =>
  extension.serviceWorker.evaluate((data) => chrome.storage.local.set(data), values);

const readSettings = (page) =>
  page.evaluate(() =>
    chrome.storage.local.get({
      disabled_origins: {},
      protection_mode: "per_site",
      site_decisions: {},
      site_evidence: {},
    })
  );

const siteDecisions = async (page) => (await readSettings(page)).site_decisions;
const siteEvidence = async (page) => (await readSettings(page)).site_evidence;
const pausedOrigins = async (page) => (await readSettings(page)).disabled_origins;

const expectOverviewLoaded = async (page) => {
  await expect(page.locator("#loading")).toBeHidden();
  await expect(page.locator("#error-card")).toBeHidden();
  await expect(page.locator("#site-lists")).toBeVisible();
};

const openSites = async (extension, seed = {}) => {
  await seedStorage(extension, {
    protection_mode: "per_site",
    site_decisions: {},
    site_evidence: {},
    ...seed,
  });
  const page = await extension.context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(sitesUrl(extension));
  await expectOverviewLoaded(page);
  return { errors, page };
};

test("per-site mode with no decisions renders guided empty sections and the recommended default", async ({
  extension,
}) => {
  const { errors, page } = await openSites(extension);

  await expect(page.locator("#mode-per-site")).toBeChecked();
  await expect(page.locator("#mode-always")).not.toBeChecked();
  await expect(page.locator("#summary")).toHaveText("0 sites protected · 0 left off · 0 seen");

  await expect(page.locator("#section-on")).toBeVisible();
  await expect(page.locator("#section-off")).toBeVisible();
  await expect(page.locator("#section-seen")).toBeVisible();
  await expect(page.locator("#section-paused")).toBeHidden();

  await expect(page.locator("#empty-on")).toBeVisible();
  await expect(page.locator("#empty-on")).toContainText("No sites protected yet");
  await expect(page.locator("#empty-off")).toBeVisible();
  await expect(page.locator("#empty-off")).toContainText("No sites left off");
  await expect(page.locator("#empty-seen")).toBeVisible();
  await expect(page.locator("#empty-seen")).toContainText("No undecided sites");

  await expect(page.locator("#caps-note")).toContainText("250 site decisions");
  await expect(page.locator("#caps-note")).toContainText("200 most recent sites");
  await expect(page.locator("#clear-seen")).toHaveText("Forget undecided sites");
  await expect(page.locator("#clear-all")).toHaveText("Clear all decisions");
  expect(errors).toEqual([]);
});

test("per-site decisions and evidence render protected, left-off and seen sections", async ({
  extension,
}) => {
  const { page } = await openSites(extension, {
    protection_mode: "per_site",
    site_decisions: {
      "a.example": decision("on"),
      "b.example": decision("off", NOW - 240_000),
    },
    site_evidence: {
      "a.example": probeEvidence({
        compat: { password_field: 1 },
        device: { canvas: 1 },
        ids: { [extensionId("a")]: 2, [extensionId("b")]: 1, [extensionId("c")]: 1 },
        total: 4500,
        vendors: { fingerprintjs: 1 },
      }),
      "b.example": probeEvidence({
        compat: { password_field: 1 },
        ids: { [extensionId("a")]: 1, [extensionId("b")]: 1 },
        total: 12,
      }),
      "c.example": probeEvidence({
        device: { webgl: 1 },
        ids: { [extensionId("d")]: 1 },
        total: 34,
        vendors: { datadome: 2 },
      }),
    },
  });

  const onRow = page.locator('#section-on tr[data-site="a.example"]');
  await expect(onRow).toHaveAttribute("data-state", "on");
  await expect(onRow.locator(".site-meta")).toContainText("Protected since");
  await expect(onRow.locator(".site-evidence")).toContainText("4,500 extension checks");
  await expect(onRow.locator(".site-evidence")).toContainText("3 IDs");
  await expect(onRow.locator(".site-evidence")).toContainText("FingerprintJS");
  await expect(onRow.locator(".site-evidence")).toContainText("sign-in form");
  await expect(onRow.locator('[data-action="unprotect"]')).toHaveText("Turn off");

  const offRow = page.locator('#section-off tr[data-site="b.example"]');
  await expect(offRow).toHaveAttribute("data-state", "off");
  await expect(offRow.locator(".site-meta")).toContainText("Left off");
  await expect(offRow.locator(".site-evidence")).toContainText("12 extension checks");
  await expect(offRow.locator(".site-evidence")).toContainText("2 IDs");
  await expect(offRow.locator('[data-action="protect"]')).toHaveText("Protect");

  const seenRow = page.locator('#section-seen tr[data-site="c.example"]');
  await expect(seenRow).toHaveAttribute("data-state", "seen");
  await expect(seenRow.locator(".site-meta")).toContainText("Last seen");
  await expect(seenRow.locator(".site-meta")).toContainText("34 checks");
  await expect(seenRow.locator(".site-evidence")).toContainText("DataDome");
  await expect(seenRow.locator('[data-action="protect"]')).toHaveText("Protect");
  await expect(seenRow.locator('[data-action="leave-off"]')).toHaveText("Leave off");

  await expect(page.locator("#summary")).toHaveText("1 site protected · 1 left off · 1 seen");
  await expect(page.locator("#empty-on")).toBeHidden();
  await expect(page.locator("#empty-off")).toBeHidden();
  await expect(page.locator("#empty-seen")).toBeHidden();
  await expect(page.locator("#section-paused")).toBeHidden();
});

test("search filters rows by site, keeps section headings and shows a no-match state", async ({
  extension,
}) => {
  const { page } = await openSites(extension, {
    protection_mode: "per_site",
    site_decisions: {
      "alpha.example": decision("on"),
      "beta.example": decision("off"),
    },
    site_evidence: {
      "alpha.example": probeEvidence({ ids: { a: 1 }, total: 10 }),
      "beta.example": probeEvidence({ ids: { b: 1 }, total: 4 }),
      "gamma.example": probeEvidence({ ids: { c: 1 }, total: 7 }),
    },
  });

  await page.fill("#search", "alpha.example");
  await expect(page.locator('tr[data-site="alpha.example"]')).toBeVisible();
  await expect(page.locator('tr[data-site="beta.example"]')).toBeHidden();
  await expect(page.locator('tr[data-site="gamma.example"]')).toBeHidden();
  await expect(page.locator("#heading-on")).toBeVisible();
  await expect(page.locator("#heading-off")).toBeVisible();
  await expect(page.locator("#heading-seen")).toBeVisible();
  await expect(page.locator("#no-match")).toBeHidden();

  await page.fill("#search", "ALPHA");
  await expect(page.locator('tr[data-site="alpha.example"]')).toBeVisible();
  await expect(page.locator('tr[data-site="gamma.example"]')).toBeHidden();

  await page.fill("#search", "zzz-nothing");
  await expect(page.locator("#no-match")).toBeVisible();
  await expect(page.locator("#no-match")).toContainText("No sites match");
  await expect(page.locator('tr[data-site="alpha.example"]')).toBeHidden();

  await page.fill("#search", "");
  await expect(page.locator("#no-match")).toBeHidden();
  await expect(page.locator('tr[data-site="alpha.example"]')).toBeVisible();
  await expect(page.locator('tr[data-site="beta.example"]')).toBeVisible();
  await expect(page.locator('tr[data-site="gamma.example"]')).toBeVisible();
});

test("row actions update storage and move rows between sections", async ({ extension }) => {
  const { page } = await openSites(extension, {
    protection_mode: "per_site",
    site_decisions: {
      "a.example": decision("on"),
      "b.example": decision("off"),
    },
    site_evidence: {
      "a.example": probeEvidence({ ids: { x: 1 }, total: 20 }),
      "b.example": probeEvidence({ ids: { y: 1 }, total: 6 }),
      "c.example": probeEvidence({ ids: { z: 1 }, total: 9 }),
    },
  });

  await page.locator('#section-on tr[data-site="a.example"] [data-action="unprotect"]').click();
  await expect(page.locator('#section-off tr[data-site="a.example"]')).toBeVisible();
  await expect(page.locator('#section-on tr[data-site="a.example"]')).toHaveCount(0);
  await expect.poll(async () => (await siteDecisions(page))["a.example"].state).toBe("off");

  await page.locator('#section-off tr[data-site="b.example"] [data-action="protect"]').click();
  await expect(page.locator('#section-on tr[data-site="b.example"]')).toBeVisible();
  await expect(page.locator('#section-off tr[data-site="b.example"]')).toHaveCount(0);
  await expect.poll(async () => (await siteDecisions(page))["b.example"].state).toBe("on");

  await page.locator('#section-seen tr[data-site="c.example"] [data-action="leave-off"]').click();
  await expect(page.locator('#section-off tr[data-site="c.example"]')).toBeVisible();
  await expect(page.locator('#section-seen tr[data-site="c.example"]')).toHaveCount(0);
  await expect.poll(async () => (await siteDecisions(page))["c.example"].state).toBe("off");
});

test("switching modes shows paused origins and keeps per-site decisions", async ({ extension }) => {
  const { page } = await openSites(extension, {
    protection_mode: "per_site",
    site_decisions: { "a.example": decision("on") },
    site_evidence: { "a.example": probeEvidence({ ids: { x: 1 }, total: 25 }) },
    disabled_origins: {
      "https://paused-one.example": true,
      "https://paused-two.example": true,
    },
  });

  await expect(page.locator("#mode-per-site")).toBeChecked();
  await expect(page.locator("#section-on")).toBeVisible();
  await expect(page.locator("#section-paused")).toBeHidden();

  await page.check("#mode-always");
  await expect.poll(async () => (await readSettings(page)).protection_mode).toBe("always");
  await expect(page.locator("#mode-always")).toBeChecked();
  await expect(page.locator("#section-paused")).toBeVisible();
  await expect(page.locator("#section-on")).toBeHidden();
  await expect(page.locator("#section-off")).toBeHidden();
  await expect(page.locator("#section-seen")).toBeHidden();
  await expect(page.locator("#paused-note")).toContainText("Per-site decisions are kept");
  await expect(page.locator('#section-paused tr[data-state="paused"]')).toHaveCount(2);
  await expect(page.locator("#summary")).toContainText("2 sites paused");

  await page.check("#mode-per-site");
  await expect.poll(async () => (await readSettings(page)).protection_mode).toBe("per_site");
  await expect(page.locator("#section-on")).toBeVisible();
  await expect(page.locator("#section-paused")).toBeHidden();
  await expect(page.locator('#section-on tr[data-site="a.example"]')).toBeVisible();
  expect(await pausedOrigins(page)).toEqual({
    "https://paused-one.example": true,
    "https://paused-two.example": true,
  });
  expect((await siteDecisions(page))["a.example"].state).toBe("on");
});

test("paused origins can be enabled one at a time or all at once", async ({ extension }) => {
  const { page } = await openSites(extension, {
    protection_mode: "always",
    disabled_origins: {
      "https://paused-one.example": true,
      "https://paused-two.example": true,
    },
  });

  await expect(page.locator("#mode-always")).toBeChecked();
  await expect(page.locator("#section-on")).toBeHidden();
  await expect(page.locator("#section-paused")).toBeVisible();
  await expect(page.locator("#paused-note")).toBeVisible();
  await expect(page.locator("#footer-actions")).toBeVisible();
  await expect(page.locator('#section-paused tr[data-state="paused"]')).toHaveCount(2);
  await expect(page.locator("#reenable-all")).toBeEnabled();

  await page
    .locator('#section-paused tr[data-site="https://paused-one.example"] [data-action="enable"]')
    .click();
  await expect(
    page.locator('#section-paused tr[data-site="https://paused-one.example"]')
  ).toHaveCount(0);
  await expect(
    page.locator('#section-paused tr[data-site="https://paused-two.example"]')
  ).toBeVisible();
  await expect
    .poll(async () => await pausedOrigins(page))
    .toEqual({ "https://paused-two.example": true });

  await page.click("#reenable-all");
  await expect.poll(async () => await pausedOrigins(page)).toEqual({});
  await expect(page.locator("#empty-paused")).toBeVisible();
  await expect(page.locator("#empty-paused")).toContainText("No paused sites");
  await expect(page.locator("#table-paused")).toBeHidden();
  await expect(page.locator("#reenable-all")).toBeDisabled();
});

test("Forget undecided sites needs two clicks, times out, and clears only seen evidence", async ({
  extension,
}) => {
  const { page } = await openSites(extension, {
    protection_mode: "per_site",
    site_decisions: {
      "a.example": decision("on"),
      "b.example": decision("on"),
      "c.example": decision("off"),
      "d.example": decision("off"),
    },
    site_evidence: {
      "a.example": probeEvidence({ ids: { a: 1 }, total: 10 }),
      "b.example": probeEvidence({ ids: { b: 1 }, total: 10 }),
      "c.example": probeEvidence({ ids: { c: 1 }, total: 10 }),
      "d.example": probeEvidence({ ids: { d: 1 }, total: 10 }),
      "e.example": probeEvidence({ ids: { e: 1 }, total: 30 }),
      "f.example": probeEvidence({ ids: { f: 1 }, total: 40 }),
    },
  });

  await page.click("#clear-seen");
  await expect(page.locator("#clear-seen")).toHaveText("Click again to confirm");
  await page.waitForTimeout(3000);
  await expect(page.locator("#clear-seen")).toHaveText("Click again to confirm");
  await expect(page.locator("#clear-seen")).toHaveText("Forget undecided sites", {
    timeout: 3000,
  });
  await expect(page.locator("#section-on tbody tr")).toHaveCount(2);
  await expect(page.locator("#section-off tbody tr")).toHaveCount(2);
  await expect(page.locator("#section-seen tbody tr")).toHaveCount(2);
  expect(Object.keys(await siteEvidence(page)).sort()).toEqual([
    "a.example",
    "b.example",
    "c.example",
    "d.example",
    "e.example",
    "f.example",
  ]);

  await page.click("#clear-seen");
  await page.click("#clear-seen");
  await expect
    .poll(async () => Object.keys(await siteEvidence(page)).sort())
    .toEqual(["a.example", "b.example", "c.example", "d.example"]);
  await expect(page.locator("#section-on tbody tr")).toHaveCount(2);
  await expect(page.locator("#section-off tbody tr")).toHaveCount(2);
  await expect(page.locator("#section-seen tbody tr")).toHaveCount(0);
  await expect(page.locator("#empty-seen")).toBeVisible();
  expect(Object.keys(await siteDecisions(page)).sort()).toEqual([
    "a.example",
    "b.example",
    "c.example",
    "d.example",
  ]);
  await expect(page.locator("#clear-seen")).toHaveText("Forget undecided sites");
});

test("Clear all decisions needs two clicks and keeps evidence", async ({ extension }) => {
  const { page } = await openSites(extension, {
    protection_mode: "per_site",
    site_decisions: {
      "a.example": decision("on"),
      "b.example": decision("on"),
      "c.example": decision("off"),
      "d.example": decision("off"),
    },
    site_evidence: {
      "a.example": probeEvidence({ ids: { a: 1 }, total: 10 }),
      "b.example": probeEvidence({ ids: { b: 1 }, total: 10 }),
      "c.example": probeEvidence({ ids: { c: 1 }, total: 10 }),
      "d.example": probeEvidence({ ids: { d: 1 }, total: 10 }),
      "e.example": probeEvidence({ ids: { e: 1 }, total: 30 }),
      "f.example": probeEvidence({ ids: { f: 1 }, total: 40 }),
    },
  });

  await expect(page.locator("#summary")).toHaveText("2 sites protected · 2 left off · 2 seen");
  await page.click("#clear-all");
  await expect(page.locator("#clear-all")).toHaveText("Click again to confirm");
  await page.click("#clear-all");
  await expect.poll(async () => Object.keys(await siteDecisions(page)).sort()).toEqual([]);
  expect(Object.keys(await siteEvidence(page)).sort()).toEqual([
    "a.example",
    "b.example",
    "c.example",
    "d.example",
    "e.example",
    "f.example",
  ]);
  await expect(page.locator("#clear-all")).toHaveText("Clear all decisions", { timeout: 3000 });
  await expect(page.locator("#section-on tbody tr")).toHaveCount(0);
  await expect(page.locator("#section-off tbody tr")).toHaveCount(0);
  await expect(page.locator("#section-seen tbody tr")).toHaveCount(6);
  await expect(page.locator("#summary")).toHaveText("0 sites protected · 0 left off · 6 seen");
});

test("storage changes from another context re-render the open page", async ({ extension }) => {
  const { page } = await openSites(extension, {
    protection_mode: "per_site",
    site_decisions: { "a.example": decision("on") },
    site_evidence: { "a.example": probeEvidence({ ids: { x: 1 }, total: 12 }) },
  });

  await expect(page.locator('#section-on tr[data-site="a.example"]')).toBeVisible();

  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({
      site_decisions: {
        "reactive.example": { at: Date.now(), source: "popup", state: "on" },
      },
      site_evidence: {
        "reactive.example": {
          compat: {},
          device: {},
          firstSeen: Date.now() - 1000,
          lastSeen: Date.now(),
          pages: 1,
          probes: { ids: { beta: 1 }, pathKinds: {}, total: 7, vectors: { fetch: 1 } },
          replay: {},
          uaReads: 1,
          vendors: { fingerprintjs: 1 },
        },
      },
    })
  );

  await expect(page.locator('#section-on tr[data-site="reactive.example"]')).toBeVisible({
    timeout: 1000,
  });
  await expect(page.locator('#section-on tr[data-site="a.example"]')).toHaveCount(0);
  await expect(page.locator("#summary")).toContainText("1 site protected");
});

test("odd decisions, junk evidence and very long site names render without page errors", async ({
  extension,
}) => {
  const { errors, page } = await openSites(extension, {
    protection_mode: "per_site",
    site_decisions: {
      "a.example": { state: "on" },
      "b.example": { at: "not-a-number", state: "off" },
      "127.0.0.1": { at: -5, state: "on" },
      [LONG_SITE]: decision("on"),
    },
    site_evidence: {
      "a.example": {
        compatKeys: null,
        deviceKeys: {},
        lastSeen: "soon",
        probeIds: [1, 2, 3],
        probeTotal: "many",
        vendorKeys: "fingerprintjs",
      },
      "b.example": "junk",
      "c.example": {
        compatKeys: ["password_field", "unknown_kind"],
        deviceKeys: ["canvas", "canvas"],
        probeTotal: -10,
        probeIds: {},
        vendorKeys: [{}, 1],
      },
      "d.example": {
        lastSeen: NOW - 5000,
        probes: { ids: { x: 1, y: 2 }, pathKinds: {}, total: 7, vectors: {} },
      },
      "e.example": probeEvidence({ ids: { x: 1 }, total: 5 }),
      "127.0.0.1": null,
    },
    disabled_origins: { "not an origin": true },
  });

  await expectOverviewLoaded(page);
  await expect(page.locator("#error-card")).toBeHidden();
  await expect(page.locator(`tr[data-site="${LONG_SITE}"]`)).toBeVisible();
  await expect(page.locator(`tr[data-site="${LONG_SITE}"] .site-name`)).toHaveText(LONG_SITE);
  await expect(page.locator('tr[data-site="a.example"]')).toBeVisible();
  await expect(page.locator('tr[data-site="b.example"]')).toBeVisible();
  await expect(page.locator('tr[data-site="127.0.0.1"]')).toBeVisible();
  await expect(page.locator('#section-seen tr[data-site="e.example"]')).toBeVisible();
  await expect(page.locator("#section-seen .site-name")).not.toHaveCount(0);
  await expect(page.locator("#summary")).toContainText("protected");
  expect(errors).toEqual([]);
});

test("the sites page makes no external requests", async ({ extension }) => {
  await seedStorage(extension, {
    protection_mode: "per_site",
    site_decisions: { "a.example": decision("on") },
    site_evidence: { "a.example": probeEvidence({ ids: { x: 1 }, total: 3 }) },
  });
  const page = await extension.context.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(sitesUrl(extension));
  await expectOverviewLoaded(page);
  await page.fill("#search", "a.example");
  await page.fill("#search", "");

  expect(requests.length).toBeGreaterThan(0);
  for (const url of requests) {
    expect(url.startsWith(`chrome-extension://${extension.extensionId}/`), url).toBe(true);
  }
  expect(requests.some((url) => url.startsWith("http://"))).toBe(false);
  expect(requests.some((url) => url.startsWith("https://"))).toBe(false);
});
