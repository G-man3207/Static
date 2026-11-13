/* eslint-disable max-lines, max-lines-per-function -- static matrices and the mock-browser harness are clearer inline */
const { expect, test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const readJson = (filePath) => JSON.parse(fs.readFileSync(path.join(repoRoot, filePath), "utf8"));
const readText = (filePath) => fs.readFileSync(path.join(repoRoot, filePath), "utf8");
const latestChangelogReleaseVersion = () => {
  const match = readText("CHANGELOG.md").match(/^## \[(\d+\.\d+\.\d+)\]/m);
  expect(match, "CHANGELOG.md should contain a released version heading").toBeTruthy();
  return match[1];
};
const urlFiltersFor = (filePath) => {
  return readJson(filePath)
    .map((rule) => rule.condition && rule.condition.urlFilter)
    .filter(Boolean);
};

const loadServiceWorkerUtils = () => {
  const context = vm.createContext({ URL });
  vm.runInContext(readText("lists.js"), context);
  vm.runInContext(readText("service_worker_utils.js"), context);
  return context.__static_sw_utils__;
};

const loadBridgeHarness = () => {
  const messages = [];
  const portsByEvent = {};
  const timers = [];
  const runtimeListeners = [];
  const windowListeners = {};
  const documentListeners = {};
  const customEvents = [];
  let personaResponse = { ids: [], noiseEnabled: false, replayMode: "off" };
  let scoutDrainPayload = null;
  let lastCustomEvent = null;
  const addListener = (listeners, type, fn) => {
    (listeners[type] ||= []).push(fn);
  };
  const removeListener = (listeners, type, fn) => {
    listeners[type] = (listeners[type] || []).filter((listener) => listener !== fn);
  };
  const dispatchListeners = (listeners, type, event = { type }) => {
    for (const fn of listeners[type] || []) fn(event);
  };
  const makePort = () => ({
    onmessage: null,
    postMessage(message) {
      if (this.peer && typeof this.peer.onmessage === "function") {
        this.peer.onmessage({ data: message });
      }
    },
    start() {},
  });
  class MockMessageChannel {
    constructor() {
      this.port1 = makePort();
      this.port2 = makePort();
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  class MockMessageEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.ports = init.ports || [];
    }
  }
  class MockCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail || {};
    }
  }
  const context = vm.createContext({
    CustomEvent: MockCustomEvent,
    MessageChannel: MockMessageChannel,
    MessageEvent: MockMessageEvent,
    URL,
    addEventListener: (type, fn) => addListener(windowListeners, type, fn),
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            runtimeListeners.push(fn);
          },
        },
        sendMessage(message) {
          messages.push(message);
          if (message && message.type === "static_get_persona") {
            return Promise.resolve({ ...personaResponse });
          }
          return Promise.resolve({ ok: true });
        },
      },
      storage: {
        local: {
          get() {
            return Promise.resolve({});
          },
          set() {
            return Promise.resolve();
          },
        },
        onChanged: {
          addListener() {},
        },
      },
    },
    document: {
      visibilityState: "visible",
      addEventListener: (type, fn) => addListener(documentListeners, type, fn),
      dispatchEvent(event) {
        if (event && event.ports && event.ports[0]) portsByEvent[event.type] = event.ports[0];
        if (event && event.detail && event.type) {
          customEvents.push(event.type);
          if (event.type === "__static_scout_drain__") {
            lastCustomEvent = event;
            if (scoutDrainPayload != null) event.detail.payload = scoutDrainPayload;
          }
        }
        dispatchListeners(documentListeners, event.type, event);
        return true;
      },
      removeEventListener: (type, fn) => removeListener(documentListeners, type, fn),
    },
    clearTimeout(id) {
      timers[id - 1] = null;
    },
    setTimeout(fn) {
      timers.push(fn);
      return timers.length;
    },
    setInterval(fn) {
      timers.push(fn);
      return timers.length;
    },
    clearInterval(id) {
      timers[id - 1] = null;
    },
    queueMicrotask(fn) {
      timers.push(fn);
    },
    requestAnimationFrame(fn) {
      timers.push(() => fn(Date.now()));
      return timers.length;
    },
    cancelAnimationFrame(id) {
      timers[id - 1] = null;
    },
    performance: { now: () => Date.now() },
    console: { debug() {}, error() {}, log() {}, warn() {} },
    location: {
      href: "https://fixture.example/page?secret=token",
      hostname: "fixture.example",
      origin: "https://fixture.example",
    },
    navigator: { userAgent: "Mozilla/5.0 Fixture" },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  });
  vm.runInContext(readText("lists.js"), context);
  vm.runInContext(readText("bridge.js"), context);
  return {
    customEvents,
    lastCustomEvent: () => lastCustomEvent,
    messages,
    portsByEvent,
    setPersonaResponse(next) {
      personaResponse = { ...personaResponse, ...next };
    },
    setScoutDrainPayload(json) {
      scoutDrainPayload = json;
    },
    dispatchWindow: (type) => dispatchListeners(windowListeners, type),
    runTimers: () => timers.splice(0).forEach((fn) => fn && fn()),
    sendRuntimeMessage: (message) => {
      const responses = [];
      for (const listener of runtimeListeners) {
        listener(message, {}, (response) => responses.push(response));
      }
      return responses;
    },
  };
};

const loadBlockUtils = () => {
  const documentListeners = {};
  const addListener = (type, fn) => {
    (documentListeners[type] ||= []).push(fn);
  };
  const dispatchDocument = (type, event = { type, ports: [] }) => {
    for (const fn of documentListeners[type] || []) fn(event);
  };
  const context = vm.createContext({
    URL,
    globalThis: {},
    document: {
      addEventListener: addListener,
      removeEventListener(type, fn) {
        documentListeners[type] = (documentListeners[type] || []).filter(
          (listener) => listener !== fn
        );
      },
    },
    Object,
    Function,
    TextEncoder,
    TextDecoder,
    WeakMap,
    Set,
    Reflect,
  });
  vm.runInContext(readText("block_utils.js"), context);
  return { U: context.globalThis.__static_block_utils__, dispatchDocument };
};

const loadStaticConfig = () => {
  const context = vm.createContext({ URL });
  vm.runInContext(readText("lists.js"), context);
  return context.__static_config__;
};

const loadCatalog = () => {
  const context = vm.createContext({ URL });
  vm.runInContext(readText("lists.js"), context);
  vm.runInContext(readText("signals.js"), context);
  return { catalog: context.__static_signals__, helpers: context.__static_config__.helpers };
};

const loadSiteSignals = ({ catalog = true } = {}) => {
  const context = vm.createContext({ URL });
  vm.runInContext(readText("lists.js"), context);
  if (catalog) vm.runInContext(readText("signals.js"), context);
  vm.runInContext(readText("site_signals.js"), context);
  return {
    catalog: catalog ? context.__static_signals__ : undefined,
    engine: context.__static_site_signals__,
    helpers: context.__static_config__.helpers,
  };
};

const SITE_NOW = 1_700_000_000_000;
const KNOWN_EXT_ID = "nngceckbapebfimnlniiiahkandclblb";
const OTHER_EXT_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const probeUrlFor = (id = KNOWN_EXT_ID, probePath = "/manifest.json") =>
  `chrome-extension://${id}${probePath}`;
const CANONICAL_VECTORS = [
  "anchor",
  "area",
  "audio",
  "audio-ctor",
  "base",
  "beacon",
  "css-import",
  "css-url",
  "cssom-csstext",
  "cssom-insert",
  "cssom-replace",
  "cssom-setprop",
  "dom-observer",
  "embed",
  "event-source",
  "fetch",
  "form",
  "frame",
  "iframe",
  "image-ctor",
  "img",
  "img-srcset",
  "input",
  "link",
  "markup",
  "media",
  "object",
  "script",
  "shared-worker",
  "source",
  "style-attr",
  "style-text",
  "track",
  "unknown",
  "video-poster",
  "worker",
  "worklet",
  "xhr",
];

const blankEvidence = (overrides = {}) => ({
  compat: {},
  device: {},
  firstSeen: SITE_NOW - 1000,
  lastSeen: SITE_NOW,
  pages: 1,
  probes: { ids: {}, pathKinds: {}, total: 0, vectors: {} },
  replay: {},
  uaReads: 0,
  vendors: {},
  ...overrides,
});

const countEvidence = (count, prefix) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}${index}`, 1]));

const recommendationContext = (overrides = {}) => ({
  compatWarning: null,
  decision: "undecided",
  fingerprintMode: "off",
  mode: "per_site",
  now: SITE_NOW,
  pausedBefore: false,
  replayMode: "off",
  rulesetPrefs: { captcha_vendors: false, fingerprint_vendors: true },
  ...overrides,
});

const extensionIdFor = (index) => {
  const alphabet = "abcdefghijklmnop";
  let n = index;
  let id = "";
  for (let i = 0; i < 32; i++) {
    id += alphabet[n % alphabet.length];
    n = Math.floor(n / alphabet.length);
  }
  return id;
};

const countMap = (count, prefix = "k") =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${prefix}${String(index).padStart(4, "0")}`,
      index + 1,
    ])
  );

const expectedMainWorldScripts = [
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
];

// Content scripts are registered by the service worker, not the manifest.
const addContentScriptFiles = (referencedFiles) => {
  const utils = loadServiceWorkerUtils();
  for (const script of utils.MAIN_WORLD_SCRIPTS) referencedFiles.add(script.file);
  for (const file of utils.ISOLATED_WORLD_SCRIPTS) referencedFiles.add(file);
  for (const file of utils.SCOUT_MAIN_SCRIPTS) referencedFiles.add(file);
  for (const file of utils.SCOUT_ISOLATED_SCRIPTS) referencedFiles.add(file);
};

const addIconFiles = (icons, referencedFiles) => {
  for (const icon of Object.values(icons || {})) referencedFiles.add(icon);
};

const addRulesetFiles = (manifest, referencedFiles) => {
  for (const ruleset of manifest.declarative_net_request.rule_resources || []) {
    referencedFiles.add(ruleset.path);
  }
};

const addServiceWorkerFiles = (manifest, referencedFiles) => {
  const serviceWorker = manifest.background && manifest.background.service_worker;
  if (!serviceWorker) return;
  referencedFiles.add(serviceWorker);
  const source = fs.readFileSync(path.join(repoRoot, serviceWorker), "utf8");
  const importCall = source.match(/importScripts\(([^)]+)\)/);
  if (!importCall) return;
  for (const match of importCall[1].matchAll(/"([^"]+)"/g)) {
    referencedFiles.add(match[1]);
  }
};

const addHtmlScriptFiles = (filePath, referencedFiles) => {
  const source = readText(filePath);
  for (const match of source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const scriptPath = match[1];
    if (!/^[a-z]+:/i.test(scriptPath)) referencedFiles.add(scriptPath);
  }
};

const collectManifestFiles = (manifest) => {
  const referencedFiles = new Set();
  addContentScriptFiles(referencedFiles);
  addServiceWorkerFiles(manifest, referencedFiles);
  if (manifest.action && manifest.action.default_popup) {
    referencedFiles.add(manifest.action.default_popup);
  }
  addIconFiles(manifest.icons, referencedFiles);
  addIconFiles(manifest.action && manifest.action.default_icon, referencedFiles);
  addRulesetFiles(manifest, referencedFiles);
  return referencedFiles;
};

const collectExtensionPageFiles = () => {
  const referencedFiles = new Set(["sites.html", "log.html", "popup.html"]);
  for (const page of [...referencedFiles].filter((filePath) => filePath.endsWith(".html"))) {
    addHtmlScriptFiles(page, referencedFiles);
  }
  return referencedFiles;
};

const expectManifestFilesToExist = (manifest) => {
  for (const filePath of collectManifestFiles(manifest)) {
    expect(fs.existsSync(path.join(repoRoot, filePath)), filePath).toBe(true);
  }
};

const expectOnDemandContentScripts = (manifest) => {
  // The service worker registers content scripts (contentScriptRegistrationsFor),
  // so paused sites and switched-off features can be left out entirely.
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.minimum_chrome_version).toBe("119");
  const utils = loadServiceWorkerUtils();
  expect(utils.MAIN_WORLD_SCRIPTS.map((script) => script.file)).toEqual(expectedMainWorldScripts);
  expect([...utils.ISOLATED_WORLD_SCRIPTS]).toEqual(["lists.js", "bridge.js", "dom_scrubber.js"]);
};

test("manifest references existing files and leaves content scripts to the service worker", () => {
  const manifest = readJson("manifest.json");
  expectManifestFilesToExist(manifest);
  expectOnDemandContentScripts(manifest);
});

const plain = (value) => JSON.parse(JSON.stringify(value));
const coreMainWorldScripts = [
  "block_utils.js",
  "block_ua.js",
  "block.js",
  "block_vectors.js",
  "block_iframe_attrs.js",
  "block_style_vectors.js",
  "block_element_decoys.js",
  "block_globals.js",
];

const alwaysSettings = () => ({
  ...loadServiceWorkerUtils().CONTENT_SCRIPT_SETTINGS,
  protection_mode: "always",
});

test("content-script registrations load only switched-on page scripts", () => {
  const utils = loadServiceWorkerUtils();
  const defaults = plain(
    utils.contentScriptRegistrationsFor({
      ...utils.CONTENT_SCRIPT_SETTINGS,
      protection_mode: "always",
    })
  );
  expect(defaults.map((script) => [script.id, script.world])).toEqual([
    ["a-main", "MAIN"],
    ["b-isolated", "ISOLATED"],
  ]);
  expect(defaults[0].js).toEqual(coreMainWorldScripts);
  expect(defaults[1].js).toEqual(["lists.js", "bridge.js", "dom_scrubber.js"]);
  for (const script of defaults) {
    expect(script).toMatchObject({
      allFrames: true,
      excludeMatches: [],
      matchOriginAsFallback: true,
      matches: ["<all_urls>"],
      persistAcrossSessions: true,
      runAt: "document_start",
    });
  }

  const allOn = plain(
    utils.contentScriptRegistrationsFor({
      ...utils.CONTENT_SCRIPT_SETTINGS,
      protection_mode: "always",
      fingerprint_mode: "mask",
      replay_mode: "chaos",
      research_logging: true,
    })
  );
  expect(allOn[0].js).toEqual(expectedMainWorldScripts);

  const legacy = plain(
    utils.contentScriptRegistrationsFor({
      ...utils.CONTENT_SCRIPT_SETTINGS,
      protection_mode: "always",
      fingerprint_mode: "bogus",
      replay_mode: "bogus",
      research_logging: "yes",
    })
  );
  expect(legacy[0].js).toEqual(coreMainWorldScripts);
});

test("paused origins become port-free host patterns or keep the in-page pause", () => {
  const utils = loadServiceWorkerUtils();
  expect(utils.pausedOriginPattern("https://chatgpt.com")).toBe("https://chatgpt.com/*");
  expect(utils.pausedOriginPattern("http://localhost:3000")).toBe("http://localhost/*");
  expect(utils.pausedOriginPattern("https://bücher.example")).toBe(
    "https://xn--bcher-kva.example/*"
  );
  for (const origin of ["http://[::1]:8080", "null", "garbage", "file:///tmp/a.html", ""]) {
    expect(utils.pausedOriginPattern(origin), origin).toBeNull();
  }

  const [main, isolated] = plain(
    utils.contentScriptRegistrationsFor({
      protection_mode: "always",
      disabled_origins: {
        "http://[::1]:8080": true,
        "http://localhost:3000": true,
        "http://localhost:8080": true,
        "https://chatgpt.com": true,
        "https://resumed.example": false,
      },
    })
  );
  expect(main.excludeMatches).toEqual(["http://localhost/*", "https://chatgpt.com/*"]);
  expect(isolated.excludeMatches).toEqual(main.excludeMatches);
});

test("pause lookups treat the host as the unit and unpatternable origins as exact keys", () => {
  const utils = loadServiceWorkerUtils();
  const paused = {
    "http://localhost:3000": true,
    "http://[::1]:8080": true,
    "https://resumed.example": false,
  };
  expect(utils.isOriginPaused("http://localhost:5173", paused)).toBe(true);
  expect(utils.isOriginPaused("https://localhost", paused)).toBe(false);
  expect(utils.isOriginPaused("http://[::1]:8080", paused)).toBe(true);
  expect(utils.isOriginPaused("http://[::1]:9090", paused)).toBe(false);
  expect(utils.isOriginPaused("https://resumed.example", paused)).toBe(false);
  expect(utils.isOriginPaused(null, paused)).toBe(false);
  expect(plain(utils.pausedOriginsLike("http://localhost:8080", paused))).toEqual([
    "http://localhost:3000",
  ]);
});

test("content-script sync check ignores fields the browser leaves out", () => {
  const utils = loadServiceWorkerUtils();
  const desired = utils.contentScriptRegistrationsFor({
    ...utils.CONTENT_SCRIPT_SETTINGS,
    protection_mode: "always",
  });
  const asReported = plain(desired).map((script) => {
    const copy = { ...script, js: script.js.map((file) => `/${file}`) };
    delete copy.excludeMatches;
    return copy;
  });
  expect(utils.contentScriptsInSync(asReported, desired)).toBe(true);
  expect(utils.contentScriptsInSync([], desired)).toBe(false);
  expect(utils.contentScriptsInSync(asReported.slice(0, 1), desired)).toBe(false);
  const paused = utils.contentScriptRegistrationsFor({
    ...utils.CONTENT_SCRIPT_SETTINGS,
    protection_mode: "always",
    disabled_origins: { "https://a.example": true },
  });
  expect(utils.contentScriptsInSync(asReported, paused)).toBe(false);
});

test("release metadata versions match the latest changelog release", () => {
  const expectedVersion = latestChangelogReleaseVersion();
  const manifest = readJson("manifest.json");
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");

  expect(manifest.version).toBe(expectedVersion);
  expect(packageJson.version).toBe(expectedVersion);
  expect(packageLock.version).toBe(expectedVersion);
  expect(packageLock.packages[""].version).toBe(expectedVersion);
});

test("extension pages reference existing local scripts", () => {
  for (const filePath of collectExtensionPageFiles()) {
    expect(fs.existsSync(path.join(repoRoot, filePath)), filePath).toBe(true);
  }
});

test("manifest keeps privacy-sensitive exposure and permissions minimal", () => {
  const manifest = readJson("manifest.json");
  expect(manifest.permissions.sort()).toEqual([
    "declarativeNetRequest",
    "declarativeNetRequestWithHostAccess",
    "scripting",
    "storage",
  ]);
  expect(manifest.host_permissions || []).toEqual(["*://*/*"]);
  expect(manifest.optional_host_permissions || []).toEqual([]);
  expect(manifest.web_accessible_resources || []).toEqual([]);
  expect(manifest.externally_connectable).toBeUndefined();
});

test("manifest declares Firefox gecko settings for AMO signing", () => {
  const manifest = readJson("manifest.json");
  const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
  expect(gecko, "browser_specific_settings.gecko is required for Firefox MV3").toBeTruthy();
  expect(typeof gecko.id).toBe("string");
  expect(gecko.id.length).toBeGreaterThan(3);
  // data_collection_permissions requires Firefox 140+; MAIN-world scripts need 128+.
  expect(gecko.strict_min_version).toBe("140.0");
  // Required for new AMO submissions (built-in data collection consent).
  expect(gecko.data_collection_permissions).toEqual({ required: ["none"] });
});

test("Firefox build strips unsupported DNR types and adds event-page scripts", () => {
  // Needs system zip/unzip; validate.yml already builds the Firefox package and
  // runs web-ext lint. Keep this transform assertion in CI only so husky and
  // local static runs do not require the zip CLI.
  test.skip(!process.env.CI, "Firefox package build is validated in GitHub Actions (validate.yml)");

  const { execFileSync } = require("child_process");
  const os = require("os");
  const zipPath = path.join(os.tmpdir(), `static-fx-static-test-${process.pid}.zip`);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-fx-static-extract-"));

  try {
    execFileSync(process.execPath, [path.join(repoRoot, "build-firefox.js"), zipPath], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    execFileSync("unzip", ["-q", zipPath, "-d", extractDir], { stdio: "pipe" });

    const fxManifest = JSON.parse(fs.readFileSync(path.join(extractDir, "manifest.json"), "utf8"));
    expect(fxManifest.background.service_worker).toBe("service_worker.js");
    expect(fxManifest.background.scripts).toEqual([
      "lists.js",
      "signals.js",
      "site_signals.js",
      "site_dnr.js",
      "service_worker_utils.js",
      "service_worker.js",
    ]);
    // The event-page fallback loads every dependency as a script tag, so each
    // listed file must be packaged beside the worker.
    for (const script of fxManifest.background.scripts) {
      expect(fs.existsSync(path.join(extractDir, script)), script).toBe(true);
    }
    for (const filePath of [
      "scout.js",
      "scout_probes.js",
      "scout_signals.js",
      "sites.html",
      "sites.js",
      "popup.html",
      "popup.js",
    ]) {
      expect(fs.existsSync(path.join(extractDir, filePath)), filePath).toBe(true);
    }
    expect(fs.existsSync(path.join(extractDir, "disabled.html"))).toBe(false);
    expect(fs.existsSync(path.join(extractDir, "disabled.js"))).toBe(false);
    expect(fxManifest.content_scripts).toBeUndefined();
    expect(fxManifest.browser_specific_settings.gecko.data_collection_permissions).toEqual({
      required: ["none"],
    });
    // Chrome-only key; Firefox warns about unknown manifest keys.
    expect(fxManifest.minimum_chrome_version).toBeUndefined();

    const unsupported = ["webtransport", "webbundle"];
    for (const rulesFile of ["fingerprint_vendors.json", "captcha_vendors.json"]) {
      const rules = JSON.parse(fs.readFileSync(path.join(extractDir, "rules", rulesFile), "utf8"));
      for (const rule of rules) {
        const types = (rule.condition && rule.condition.resourceTypes) || [];
        for (const banned of unsupported) {
          expect(types, `${rulesFile} rule ${rule.id}`).not.toContain(banned);
        }
      }
    }

    const swSource = fs.readFileSync(path.join(extractDir, "service_worker.js"), "utf8");
    for (const banned of unsupported) {
      expect(swSource, `service_worker.js must not reference ${banned}`).not.toMatch(
        new RegExp(`"${banned}"`)
      );
    }

    // Source tree must keep Chrome-only types; stripping is build-time only.
    const sourceSw = readText("service_worker.js");
    expect(sourceSw).toMatch(/"webtransport"/);
    expect(sourceSw).toMatch(/"webbundle"/);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    try {
      fs.unlinkSync(zipPath);
    } catch {}
  }
});

test("extension runtime code stays local-only", () => {
  const runtimeFiles = [
    ...collectManifestFiles(readJson("manifest.json")),
    ...collectExtensionPageFiles(),
    "sites.js",
    "log_diagnostics.js",
    "popup.js",
    "log.js",
  ].filter((filePath) => filePath.endsWith(".js") || filePath.endsWith(".html"));
  const uniqueFiles = [...new Set(runtimeFiles)];

  for (const filePath of uniqueFiles) {
    const source = readText(filePath);
    expect(source, `${filePath}: must not use synced storage`).not.toMatch(/chrome\.storage\.sync/);
    if (filePath.endsWith(".js")) {
      // Comments may cite spec/docs URLs; only executable code must stay local.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
      expect(code, `${filePath}: must not contain remote endpoints`).not.toMatch(
        /https?:\/\/(?!www\.w3\.org\/(2000\/svg|1999\/xhtml)|localhost\/|127\.0\.0\.1\/|\[::1\]\/)/
      );
    } else {
      expect(source, `${filePath}: must not load remote active content`).not.toMatch(
        /<(script|img|link|iframe|form)\b[^>]*(src|href|action)=["']https?:\/\//i
      );
    }
  }
});

test("service worker probe-log caps enforce local privacy bounds", () => {
  const { enforceCaps } = loadServiceWorkerUtils();
  const probeLog = {};
  for (let i = 0; i < 105; i++) {
    probeLog[`https://origin-${i}.test`] = {
      idCounts: countMap(2105, "id"),
      lastUpdated: i,
      playbook: {
        weeks: Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => [
            `2026-W${String(index + 1).padStart(2, "0")}`,
            {
              total: 100,
              vectorCounts: countMap(60, "v"),
              pathKindCounts: countMap(60, "p"),
              idCounts: countMap(1200, "w"),
              firstSeen: index,
              lastSeen: index,
            },
          ])
        ),
      },
    };
  }

  enforceCaps(probeLog);

  expect(Object.keys(probeLog)).toHaveLength(100);
  expect(probeLog["https://origin-0.test"]).toBeUndefined();
  expect(probeLog["https://origin-4.test"]).toBeUndefined();
  expect(probeLog["https://origin-104.test"]).toBeTruthy();
  const retained = probeLog["https://origin-104.test"];
  expect(Object.keys(retained.idCounts)).toHaveLength(2000);
  expect(Object.keys(retained.playbook.weeks)).toEqual([
    "2026-W03",
    "2026-W04",
    "2026-W05",
    "2026-W06",
    "2026-W07",
    "2026-W08",
    "2026-W09",
    "2026-W10",
    "2026-W11",
    "2026-W12",
  ]);
  const latestWeek = retained.playbook.weeks["2026-W12"];
  expect(Object.keys(latestWeek.vectorCounts)).toHaveLength(50);
  expect(Object.keys(latestWeek.pathKindCounts)).toHaveLength(50);
  expect(Object.keys(latestWeek.idCounts)).toHaveLength(1000);
});

test("service worker ID caps preserve known persona IDs under canary pressure", () => {
  const { enforceCaps } = loadServiceWorkerUtils();
  const knownId = "nngceckbapebfimnlniiiahkandclblb";
  const highCardinalityIds = {};
  const highCardinalityWeekIds = {};

  for (let index = 0; Object.keys(highCardinalityIds).length < 2000; index++) {
    const id = extensionIdFor(index);
    if (id !== knownId) highCardinalityIds[id] = 1000 + index;
  }
  for (let index = 3000; Object.keys(highCardinalityWeekIds).length < 1000; index++) {
    const id = extensionIdFor(index);
    if (id !== knownId) highCardinalityWeekIds[id] = 1000 + index;
  }

  const probeLog = {
    "https://canary-pressure.test": {
      idCounts: {
        ...highCardinalityIds,
        [knownId]: 2,
      },
      lastUpdated: Date.now(),
      playbook: {
        weeks: {
          "2026-W15": {
            total: 100,
            vectorCounts: { fetch: 100 },
            pathKindCounts: { manifest: 100 },
            idCounts: {
              ...highCardinalityWeekIds,
              [knownId]: 2,
            },
            firstSeen: 1,
            lastSeen: 2,
          },
        },
      },
    },
  };

  enforceCaps(probeLog);

  const retained = probeLog["https://canary-pressure.test"];
  const retainedWeek = retained.playbook.weeks["2026-W15"];
  expect(Object.keys(retained.idCounts)).toHaveLength(2000);
  expect(retained.idCounts[knownId]).toBe(2);
  expect(Object.keys(retainedWeek.idCounts)).toHaveLength(1000);
  expect(retainedWeek.idCounts[knownId]).toBe(2);
});

test("bridge caps high-cardinality probe ID maps before service-worker flush", () => {
  const knownId = "nngceckbapebfimnlniiiahkandclblb";
  const harness = loadBridgeHarness();
  const port = harness.portsByEvent.__perf_noise_bi__;
  expect(port).toBeTruthy();

  let sent = 0;
  for (let i = 0; sent < 2105; i++) {
    const id = extensionIdFor(i);
    if (id === knownId) continue;
    port.postMessage({
      type: "probe_blocked",
      url: `chrome-extension://${id}/manifest.json`,
      where: "fetch",
    });
    sent++;
  }
  for (let i = 0; i < 2; i++) {
    port.postMessage({
      type: "probe_blocked",
      url: `chrome-extension://${knownId}/manifest.json`,
      where: "fetch",
    });
  }

  harness.dispatchWindow("pagehide");
  harness.runTimers();
  const message = harness.messages.find((msg) => msg.type === "static_probe_blocked");

  expect(message.delta).toBe(2107);
  expect(Object.keys(message.idCounts)).toHaveLength(2000);
  expect(Object.keys(message.deltaIdCounts)).toHaveLength(2000);
  expect(message.idCounts[knownId]).toBe(2);
  expect(message.deltaIdCounts[knownId]).toBe(2);
});

test("bridge drops pending probe batches when log clear resets page state", () => {
  const harness = loadBridgeHarness();
  const port = harness.portsByEvent.__perf_noise_bi__;
  expect(port).toBeTruthy();

  port.postMessage({
    type: "probe_blocked",
    url: "chrome-extension://nngceckbapebfimnlniiiahkandclblb/manifest.json",
    where: "fetch",
  });
  harness.sendRuntimeMessage({ resetProbeState: true, type: "static_persona_update" });
  harness.dispatchWindow("pagehide");
  harness.runTimers();

  expect(harness.messages.filter((msg) => msg.type === "static_probe_blocked")).toEqual([]);
});

test("DNR rulesets are well-formed and synchronized with metadata and popup IDs", () => {
  const manifest = readJson("manifest.json");
  const meta = readJson("rules/META.json");
  const popupJs = fs.readFileSync(path.join(repoRoot, "popup.js"), "utf8");
  const popupIds = [...popupJs.matchAll(/id:\s*"([^"]+)"/g)].map((match) => match[1]);

  const manifestIds = manifest.declarative_net_request.rule_resources.map((ruleset) => ruleset.id);
  expect(new Set(popupIds)).toEqual(new Set(manifestIds));
  expect(new Set(Object.keys(meta.rulesets))).toEqual(new Set(manifestIds));

  const validResourceTypes = new Set([
    "main_frame",
    "sub_frame",
    "stylesheet",
    "script",
    "image",
    "font",
    "object",
    "xmlhttprequest",
    "ping",
    "csp_report",
    "media",
    "websocket",
    "webtransport",
    "webbundle",
    "other",
  ]);

  for (const ruleset of manifest.declarative_net_request.rule_resources) {
    const rules = readJson(ruleset.path);
    expect(Array.isArray(rules), ruleset.path).toBe(true);

    const ids = new Set();
    for (const rule of rules) {
      expect(Number.isInteger(rule.id), `${ruleset.path}: id`).toBe(true);
      expect(ids.has(rule.id), `${ruleset.path}: duplicate rule id ${rule.id}`).toBe(false);
      ids.add(rule.id);

      expect(Number.isInteger(rule.priority), `${ruleset.path}: priority`).toBe(true);
      expect(rule.action && rule.action.type, `${ruleset.path}: action.type`).toBe("block");
      expect(rule.condition, `${ruleset.path}: condition`).toBeTruthy();
      expect(
        typeof rule.condition.urlFilter === "string" ||
          typeof rule.condition.regexFilter === "string",
        `${ruleset.path}: urlFilter or regexFilter`
      ).toBe(true);
      expect(Array.isArray(rule.condition.resourceTypes), `${ruleset.path}: resourceTypes`).toBe(
        true
      );
      for (const resourceType of rule.condition.resourceTypes) {
        expect(validResourceTypes.has(resourceType), `${ruleset.path}: ${resourceType}`).toBe(true);
      }
    }
  }
});

test("fingerprint DNR lists cover current official client-side collection hosts", () => {
  const captchaFilters = new Set(urlFiltersFor("rules/captcha_vendors.json"));
  const fingerprintFilters = new Set(urlFiltersFor("rules/fingerprint_vendors.json"));

  expect(
    captchaFilters.has("||captcha-delivery.com^"),
    "captcha_vendors missing DataDome response pages"
  ).toBe(true);
  expect(
    captchaFilters.has("||challenges.cloudflare.com^"),
    "captcha_vendors missing Cloudflare Turnstile / Challenge Platform"
  ).toBe(true);
  expect(
    captchaFilters.has("||turnstile.cloudflare.com^"),
    "captcha_vendors missing Cloudflare Turnstile direct host"
  ).toBe(true);
  expect(captchaFilters.has("||hcaptcha.com^"), "captcha_vendors missing hCaptcha").toBe(true);
  expect(captchaFilters.has("||hcaptcha.net^"), "captcha_vendors missing hCaptcha net").toBe(true);

  for (const filter of [
    "||api.datadome.co^",
    "||api.fpjs.io^",
    "||api.fpjs.pro^",
    "||biocatch.com^",
    "||blackwall.ai^",
    "||botguard.net^",
    "||castle.io^",
    "||cheq.ai^",
    "||cheqzone.com^",
    "||clear.sale^",
    "||datadome.co^",
    "||datadome.io^",
    "||events.api.sift.com^",
    "||feedzai.com^",
    "||fingerprint.com^",
    "||fingerprintjs.com^",
    "||forter.com^",
    "||fpcdn.io^",
    "||fpjs.io^",
    "||fpjscdn.net^",
    "||fpnpmcdn.net^",
    "||fptls.com^",
    "||fptls2.com^",
    "||fptls3.com^",
    "||fptls4.com^",
    "||geetest.com^",
    "||humansecurity.com^",
    "||imperva.com^",
    "||incapsula.com^",
    "||ipqualityscore.com^",
    "||js.datadome.co^",
    "||kasada.io^",
    "||kasada.net^",
    "||kount.com^",
    "||kount.net^",
    "||nudatasecurity.com^",
    "||openfpcdn.io^",
    "||perimeterx.com^",
    "||perimeterx.net^",
    "||px-cdn.net^",
    "||px-cloud.net^",
    "||pxchk.net^",
    "||px-client.net^",
    "||riskified.com^",
    "||riskmetrix.net^",
    "||seon.io^",
    "||shapesecurity.com^",
    "||signifyd.com^",
    "||api.sift.com^",
    "||siftscience.com^",
    "||socure.com^",
    "||threatmetrix.net^",
    "||typingdna.com^",
    "||we-stats.com^",
    "||iesnare.com^",
    "||iesnare.co.uk^",
    "||iovation.co.uk^",
    "||sift.co^",
    "||distilnetworks.com^",
    "||fingerprintjs.io^",
    "||jscrambler.com^",
    "||netacea.com^",
    "||maxmind.com^",
    "||shieldsquare.com^",
    "||deviceatlas.com^",
    "||whiteops.com^",
    "||sift.com^",
    "||accertify.com^",
    "||group-ib.com^",
    "||lexisnexisrisk.com^",
    "||telemetry.stytch.com^",
    "||group-ib.ru^",
    "||ipfingerprint.com^",
    "||socure.io^",
    "||nethone.com^",
  ]) {
    expect(fingerprintFilters.has(filter), `fingerprint_vendors missing ${filter}`).toBe(true);
  }
});

test("fingerprint DNR connection rules include persistent transport and stealth resource types", () => {
  for (const filePath of ["rules/captcha_vendors.json", "rules/fingerprint_vendors.json"]) {
    for (const rule of readJson(filePath)) {
      const resourceTypes = rule.condition && rule.condition.resourceTypes;
      if (!Array.isArray(resourceTypes)) continue;
      if (!resourceTypes.includes("xmlhttprequest") && !resourceTypes.includes("ping")) continue;
      expect(resourceTypes, `${filePath}: rule ${rule.id} missing websocket/webtransport`).toEqual(
        expect.arrayContaining(["websocket", "webtransport"])
      );
    }
  }
  for (const rule of readJson("rules/fingerprint_vendors.json")) {
    const resourceTypes = rule.condition && rule.condition.resourceTypes;
    if (!Array.isArray(resourceTypes)) continue;
    expect(
      resourceTypes,
      `fingerprint_vendors rule ${rule.id} missing sub_frame/stylesheet`
    ).toEqual(expect.arrayContaining(["sub_frame", "stylesheet"]));
  }
});

test("conflictSlots cover key extension categories without cross-slot ID duplication", () => {
  const context = vm.createContext({});
  vm.runInContext(readText("lists.js"), context);
  const slots = context.__static_config__.conflictSlots;

  const requiredSlots = [
    "password_manager",
    "ad_blocker",
    "grammar",
    "web3_wallet",
    "react_devtools",
    "translator",
    "vpn_proxy",
    "dark_mode",
    "shopping",
    "userscript_manager",
    "privacy",
  ];
  for (const slot of requiredSlots) {
    expect(Array.isArray(slots[slot]), `conflictSlots.${slot} should be an array`).toBe(true);
    expect(slots[slot].length, `conflictSlots.${slot} should not be empty`).toBeGreaterThan(0);
    for (const id of slots[slot]) {
      expect(id, `conflictSlots.${slot} ID should be 32 lowercase a-p chars`).toMatch(
        /^[a-p]{32}$/
      );
    }
  }

  const allIds = requiredSlots.flatMap((slot) => slots[slot]);
  const uniqueIds = new Set(allIds);
  expect(uniqueIds.size, "no extension ID should appear in multiple slots").toBe(allIds.length);
});

test("conflictSlots include KeePassXC-Browser in the password_manager slot", () => {
  const context = vm.createContext({});
  vm.runInContext(readText("lists.js"), context);
  const slots = context.__static_config__.conflictSlots;
  expect(slots.password_manager).toContain("oboonakemofpalcgghocfoadofidjkkk");
});

test("conflictSlots include Proton Pass in the password_manager slot", () => {
  const context = vm.createContext({});
  vm.runInContext(readText("lists.js"), context);
  const slots = context.__static_config__.conflictSlots;
  expect(slots.password_manager).toContain("cjnlpnbkjbnmdieljmighbdoljmgfibk");
});

test("conflictSlots include Dark Reader in the dark_mode slot", () => {
  const context = vm.createContext({});
  vm.runInContext(readText("lists.js"), context);
  const slots = context.__static_config__.conflictSlots;
  expect(slots.dark_mode).toContain("eimadpbcbfnmbkopoojfekhnkhdbieeh");
});

test("conflictSlots include Solflare in the web3_wallet slot", () => {
  const context = vm.createContext({});
  vm.runInContext(readText("lists.js"), context);
  const slots = context.__static_config__.conflictSlots;
  expect(slots.web3_wallet).toContain("bhhhlkgekbhbdjncpdbjkmjnnapolepf");
});

test("conflictSlots include DuckDuckGo Privacy Essentials in the privacy slot", () => {
  const context = vm.createContext({});
  vm.runInContext(readText("lists.js"), context);
  const slots = context.__static_config__.conflictSlots;
  expect(slots.privacy).toContain("bkdgflcldnnnapblkhphbgpggdiikppg");
});

test("conflictSlots include Tampermonkey in the userscript_manager slot", () => {
  const context = vm.createContext({});
  vm.runInContext(readText("lists.js"), context);
  const slots = context.__static_config__.conflictSlots;
  expect(slots.userscript_manager).toContain("dhdgffkkebhmkfjojejmpbldmpobfkfo");
});

test("conflictSlots include Honey in the shopping slot", () => {
  const context = vm.createContext({});
  vm.runInContext(readText("lists.js"), context);
  const slots = context.__static_config__.conflictSlots;
  expect(slots.shopping).toContain("bmnlcjabgnpnenekpadlanbbkooimhnj");
});

test("every conflictSlots ID has an ID-seeded Noise manifest name", () => {
  const context = vm.createContext({});
  vm.runInContext(readText("lists.js"), context);
  const slots = context.__static_config__.conflictSlots;
  const source = readText("block.js");
  const names = {};
  const block = source.match(/KNOWN_MANIFEST_NAMES = \{([\s\S]*?)\};/);
  expect(block, "KNOWN_MANIFEST_NAMES must exist in block.js").toBeTruthy();
  for (const match of block[1].matchAll(/([a-p]{32}):\s*"([^"]+)"/g)) {
    names[match[1]] = match[2];
  }
  for (const [slot, ids] of Object.entries(slots)) {
    for (const id of ids) {
      expect(names[id], `${slot} ID ${id} needs a KNOWN_MANIFEST_NAMES entry`).toBeTruthy();
    }
  }
});

// =========================================================================
// Shared block_utils.js utility tests
// =========================================================================

test("block_utils exposes shared decoy path constants as arrays of RegExp", () => {
  const { U } = loadBlockUtils();
  const isRegExp = (v) => Object.prototype.toString.call(v) === "[object RegExp]";
  expect(Array.isArray(U.IMAGE_DECOY_PATHS)).toBe(true);
  expect(U.IMAGE_DECOY_PATHS.length).toBeGreaterThan(0);
  for (const re of U.IMAGE_DECOY_PATHS) expect(isRegExp(re)).toBe(true);

  expect(Array.isArray(U.SCRIPT_DECOY_PATHS)).toBe(true);
  expect(U.SCRIPT_DECOY_PATHS.length).toBeGreaterThan(0);
  for (const re of U.SCRIPT_DECOY_PATHS) expect(isRegExp(re)).toBe(true);

  expect(Array.isArray(U.HTML_DECOY_PATHS)).toBe(true);
  expect(U.HTML_DECOY_PATHS.length).toBeGreaterThan(0);
  for (const re of U.HTML_DECOY_PATHS) expect(isRegExp(re)).toBe(true);

  expect(Array.isArray(U.STYLE_DECOY_PATHS)).toBe(true);
  expect(U.STYLE_DECOY_PATHS.length).toBeGreaterThan(0);
  for (const re of U.STYLE_DECOY_PATHS) expect(isRegExp(re)).toBe(true);
});

test("U.sanitizeCssText neutralizes only CSS tokens that load extension URLs", () => {
  const { U } = loadBlockUtils();
  const id = "nngceckbapebfimnlniiiahkandclblb";
  const probe = `chrome-extension://${id}/x.css`;
  const cases = [
    // [input, expected text, expected first URL]
    ["body{margin:0}", "body{margin:0}", ""],
    ['a{content:"\\201C"}', 'a{content:"\\201C"}', ""],
    [`/* ${probe} */ b{c:d}`, `/* ${probe} */ b{c:d}`, ""],
    [`@import url("${probe}"); b{c:d}`, '@import url("about:invalid"); b{c:d}', probe],
    [`@import "${probe}";`, '@import "about:invalid";', probe],
    [`b{c:url(  ${probe}  )}`, "b{c:url(about:invalid)}", probe],
    [`b{c:url("chrome\\-extension://${id}/x.css")}`, 'b{c:url("about:invalid")}', probe],
    [`b{c:url(\\63 hrome-extension://${id}/x.css)}`, "b{c:url(about:invalid)}", probe],
    [`b{c:\\75 rl(${probe})}`, "b{c:url(about:invalid)}", probe],
    [`b{c:url("chr\\9 ome-extension://${id}/x.css")}`, 'b{c:url("about:invalid")}', probe],
    [`b{c:image-set("${probe}" 1x)}`, 'b{c:image-set("about:invalid" 1x)}', probe],
    [`b{c:url('chrome-ext\\\nension://${id}/x.css')}`, 'b{c:url("about:invalid")}', probe],
    [`b{c:myurl(${probe})}`, `b{c:myurl(${probe})}`, ""],
    [
      `a{content:"\\"${probe}"} b{c:url(${probe})}`,
      `a{content:"\\"${probe}"} b{c:url(about:invalid)}`,
      probe,
    ],
  ];
  for (const [input, text, url] of cases) {
    expect(U.sanitizeCssText(input), input).toEqual({ text, url });
  }
});

test("U.sanitizeCssText rules out escape-heavy CSS quickly and remembers clean text", () => {
  const { U } = loadBlockUtils();
  // ~490 KB of Tailwind-style escaped class names and icon-font escapes.
  let css = "";
  for (let i = 0; css.length < 500_000; i++) {
    const glyph = (i % 256).toString(16).padStart(2, "0");
    css += `.md\\:flex-${i}{display:flex}.w-1\\/2-${i}{width:50%}.i-${i}:before{content:"\\f1${glyph}"}\n`;
  }
  const timed = () => {
    const started = performance.now();
    expect(U.sanitizeCssText(css)).toEqual({ text: css, url: "" });
    return performance.now() - started;
  };
  const first = timed();
  const again = timed();
  // Tokenizing all of it takes ~50 ms; ruling out an extension scheme first takes a few.
  expect(first).toBeLessThan(20);
  expect(again).toBeLessThan(first / 4);
});

test("U.firstBadUrlIn extracts extension URL from plain URL strings", () => {
  const { U } = loadBlockUtils();
  expect(U.firstBadUrlIn("chrome-extension://abcabcabcabcabcabcabcabcabcabcab/popup.js")).toBe(
    "chrome-extension://abcabcabcabcabcabcabcabcabcabcab/popup.js"
  );
  expect(U.firstBadUrlIn("https://example.com")).toBe("");
  expect(U.firstBadUrlIn("")).toBe("");
  expect(U.firstBadUrlIn(null)).toBe("");
});

test("U.firstBadUrlIn extracts extension URL embedded in larger strings", () => {
  const { U } = loadBlockUtils();
  const url = "chrome-extension://abcabcabcabcabcabcabcabcabcabcab/script.js";
  expect(U.firstBadUrlIn(`before ${url} after`)).toBe(url);
  expect(U.firstBadUrlIn(`url(${url})`)).toBe(url);
});

test("U.attrLocalName strips namespace prefix via colon-split", () => {
  const { U } = loadBlockUtils();
  expect(U.attrLocalName(null, "xlink:href")).toBe("href");
  expect(U.attrLocalName(null, "svg:src")).toBe("src");
  expect(U.attrLocalName(null, "href")).toBe("href");
  expect(U.attrLocalName(null, "SRC")).toBe("src");
  expect(U.attrLocalName(null, "")).toBe("");
  expect(U.attrLocalName(null)).toBe("");
  expect(U.attrLocalName(null, 123)).toBe("");
});

test("U.attrLocalName preserves data-* and style attribute names", () => {
  const { U } = loadBlockUtils();
  expect(U.attrLocalName(null, "data-foo")).toBe("data-foo");
  expect(U.attrLocalName(null, "DATA-bar")).toBe("data-bar");
  expect(U.attrLocalName(null, "style")).toBe("style");
  expect(U.attrLocalName(null, "class")).toBe("class");
});

test("U.pathFor extracts lowercased pathname from URL", () => {
  const { U } = loadBlockUtils();
  expect(U.pathFor("https://example.com/Path/Icon-48.png")).toBe("/path/icon-48.png");
  expect(U.pathFor("chrome-extension://abc/Manifest.json")).toBe("/manifest.json");
  expect(U.pathFor("")).toBe("");
  expect(U.pathFor("not-a-url")).toBe("");
});

test("U.matchesPathPattern checks pathname against regex array", () => {
  const { U } = loadBlockUtils();
  expect(U.matchesPathPattern("/icon-48.png", U.IMAGE_DECOY_PATHS)).toBe(true);
  expect(U.matchesPathPattern("/icons/logo.svg", U.IMAGE_DECOY_PATHS)).toBe(true);
  expect(U.matchesPathPattern("/main.js", U.IMAGE_DECOY_PATHS)).toBe(false);
  expect(U.matchesPathPattern("/content.js", U.SCRIPT_DECOY_PATHS)).toBe(true);
  expect(U.matchesPathPattern("/popup.html", U.HTML_DECOY_PATHS)).toBe(true);
  expect(U.matchesPathPattern("/styles/main.css", U.STYLE_DECOY_PATHS)).toBe(true);
});

test("setupBridge.post handles both payload and null-payload consistently", () => {
  const { U, dispatchDocument } = loadBlockUtils();
  let received = null;
  const bus = {
    postMessage(msg) {
      received = msg;
    },
    start() {},
  };
  // Create bridge first, then simulate connection
  const bridge = U.setupBridge("__test_post__", 100, () => {});
  dispatchDocument("__test_post__", { ports: [bus], type: "__test_post__" });
  bridge.post("test_type", null);
  expect(received).toEqual({ type: "test_type" });
  received = null;
  bridge.post("test_type", { key: "value" });
  expect(received).toEqual({ type: "test_type", key: "value" });
});

test("block_utils must load first — referenced from all block scripts via __static_block_utils__", () => {
  const mainScripts = loadServiceWorkerUtils().MAIN_WORLD_SCRIPTS.map((script) => script.file);
  expect(mainScripts[0]).toBe("block_utils.js");
  for (let i = 1; i < mainScripts.length; i++) {
    const content = readText(mainScripts[i]);
    expect(content).toContain("__static_block_utils__");
  }
});

// =========================================================================
// lists.js / block_adaptive.js DOM-marker pattern sync
// =========================================================================

test("block_element_decoys.js DOM_MARKER_ATTR_RE covers all domStripAttrs from lists.js", () => {
  const listsContext = vm.createContext({});
  vm.runInContext(readText("lists.js"), listsContext);
  const domStripAttrs = listsContext.__static_config__.domStripAttrs;

  const decoysSrc = readText("block_element_decoys.js");
  const attrMatch = decoysSrc.match(/DOM_MARKER_ATTR_RE\s*=\s*(\/[^/]+\/[a-z]*)/);
  expect(attrMatch, "DOM_MARKER_ATTR_RE must be found in block_element_decoys.js").toBeTruthy();
  const regexStr = attrMatch[1];
  const lastSlash = regexStr.lastIndexOf("/");
  const pattern = regexStr.slice(1, lastSlash);
  const flags = regexStr.slice(lastSlash + 1);
  const combinedRe = new RegExp(pattern, flags);

  // For each pattern in lists.js, generate a test string the pattern would
  // match, then verify the combined block_element_decoys.js regex also matches it.
  const testStringFor = (pattern) => {
    const src = String(pattern);
    if (src.includes("lp-(ignore") || src.includes("gr-c-s")) return null;
    if (src.includes("__lpform")) return "__lpform_test";
    if (src.includes("data-")) {
      const name = src.match(/data-([a-z]+(?:-[a-z]+)?)/);
      return name ? `data-${name[1]}-test-attr` : null;
    }
    return null;
  };

  for (const pattern of domStripAttrs) {
    const testStr = testStringFor(pattern);
    if (!testStr) continue;
    expect(combinedRe.test(testStr), `${String(pattern)} → "${testStr}" must match`).toBe(true);
  }
});

test("block_element_decoys.js DOM_MARKER_TAG_RE covers all domStripTags from lists.js", () => {
  const listsContext = vm.createContext({});
  vm.runInContext(readText("lists.js"), listsContext);
  const domStripTags = listsContext.__static_config__.domStripTags;

  const decoysSrc = readText("block_element_decoys.js");
  const tagMatch = decoysSrc.match(/DOM_MARKER_TAG_RE\s*=\s*(\/[^/]+\/[a-z]*)/);
  expect(tagMatch, "DOM_MARKER_TAG_RE must be found in block_element_decoys.js").toBeTruthy();
  const tagRegexStr = tagMatch[1];
  const tagLastSlash = tagRegexStr.lastIndexOf("/");
  const combinedRe = new RegExp(
    tagRegexStr.slice(1, tagLastSlash),
    tagRegexStr.slice(tagLastSlash + 1)
  );

  for (const pattern of domStripTags) {
    const src = String(pattern);
    const name = src.match(/\^([a-z]+-)/);
    if (!name) continue;
    const testTag = `${name[1]}el`;
    expect(combinedRe.test(testTag), `${src} → "${testTag}" must match`).toBe(true);
  }
});

test("block_element_decoys.js DOM_MARKER_CLASS_RE covers all domStripClasses from lists.js", () => {
  const listsContext = vm.createContext({});
  vm.runInContext(readText("lists.js"), listsContext);
  const domStripClasses = listsContext.__static_config__.domStripClasses;

  const decoysSrc = readText("block_element_decoys.js");
  const classMatch = decoysSrc.match(/DOM_MARKER_CLASS_RE\s*=\s*(\/[^/]+\/[a-z]*)/);
  expect(classMatch, "DOM_MARKER_CLASS_RE must be found in block_element_decoys.js").toBeTruthy();
  const classRegexStr = classMatch[1];
  const classLastSlash = classRegexStr.lastIndexOf("/");
  const combinedRe = new RegExp(
    classRegexStr.slice(1, classLastSlash),
    classRegexStr.slice(classLastSlash + 1)
  );

  const testClassFor = (pattern) => {
    const src = String(pattern);
    if (src.includes("__lpform")) return "__lpform";
    if (src.includes("lpform") && !src.includes("__lpform")) return "lpform-test";
    const name = src.match(/\^([a-z]+)/);
    return name ? `${name[1]}-test` : null;
  };

  for (const pattern of domStripClasses) {
    const testClass = testClassFor(pattern);
    if (!testClass) continue;
    expect(combinedRe.test(testClass), `${String(pattern)} → "${testClass}" must match`).toBe(true);
  }
});

const loadLogDiagnostics = () => {
  const context = vm.createContext({});
  vm.runInContext(readText("lists.js"), context);
  vm.runInContext(readText("log_diagnostics.js"), context);
  return context.__static_log_diagnostics__;
};

test("log_diagnostics noiseReadinessFor handles Chrome-style extension IDs", () => {
  const { noiseReadinessFor } = loadLogDiagnostics();
  const idCounts = {
    nngceckbapebfimnlniiiahkandclblb: 3,
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 1,
  };
  const result = noiseReadinessFor({ idCounts });
  expect(result.knownEligible).toBe(1);
  expect(result.unknownEligible).toBe(0);
  expect(result.eligibleIds).toContain("nngceckbapebfimnlniiiahkandclblb");
  expect(result.eligibleIds).not.toContain("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});

test("log_diagnostics noiseReadinessFor handles UUID-style extension IDs", () => {
  const { noiseReadinessFor } = loadLogDiagnostics();
  const uuidId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const chromeId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const idCounts = {
    [uuidId]: 25,
    [chromeId]: 25,
  };
  const result = noiseReadinessFor({ idCounts });
  expect(result.knownEligible).toBe(0);
  expect(result.unknownEligible).toBe(2);
  expect(result.eligibleIds).toContain(uuidId);
  expect(result.eligibleIds).toContain(chromeId);
});

test("log_diagnostics noiseReadinessFor rejects invalid IDs", () => {
  const { noiseReadinessFor } = loadLogDiagnostics();
  const idCounts = {
    "not-an-extension-id": 100,
    "": 100,
    "too-short": 100,
    zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz: 100,
  };
  const result = noiseReadinessFor({ idCounts });
  expect(result.eligibleIds).toHaveLength(0);
  expect(result.knownEligible).toBe(0);
  expect(result.unknownEligible).toBe(0);
});

test("log_diagnostics noiseReadinessFor respects unknown min count threshold for UUID IDs", () => {
  const { noiseReadinessFor } = loadLogDiagnostics();
  const uuidId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const idCounts = { [uuidId]: 19 };
  const result = noiseReadinessFor({ idCounts });
  expect(result.eligibleIds).toHaveLength(0);
  const highCounts = { [uuidId]: 20 };
  const resultHigh = noiseReadinessFor({ idCounts: highCounts });
  expect(resultHigh.eligibleIds).toContain(uuidId);
});

test("log_diagnostics noiseReadinessFor handles mixed Chrome and UUID ID pools", () => {
  const { noiseReadinessFor } = loadLogDiagnostics();
  const uuidId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const chromeKnown = "nngceckbapebfimnlniiiahkandclblb";
  const chromeUnknown = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const idCounts = {
    [uuidId]: 25,
    [chromeKnown]: 3,
    [chromeUnknown]: 25,
  };
  const result = noiseReadinessFor({ idCounts });
  expect(result.knownEligible).toBe(1);
  expect(result.unknownEligible).toBe(2);
  expect(result.eligibleIds).toContain(uuidId);
  expect(result.eligibleIds).toContain(chromeKnown);
  expect(result.eligibleIds).toContain(chromeUnknown);
  expect(result.eligibleIds).toHaveLength(3);
});

test("path helpers agree between lists.js and block_utils.js", () => {
  const listsContext = vm.createContext({ URL });
  vm.runInContext(readText("lists.js"), listsContext);
  const helpers = listsContext.__static_config__.helpers;
  const { U } = loadBlockUtils();
  const samples = [
    "/inpage.js",
    "/src/css/content.css",
    "/phishing.html",
    "/rules.json",
    "/icon.webp",
    "/../secret.js",
    "//inpage.js",
    "/in page.js",
    "/inpage.js?cache=1",
    "INPAGE.JS",
  ];
  for (const sample of samples) {
    expect(U.sanitizeExtensionPath(sample), sample).toBe(helpers.sanitizeExtensionPath(sample));
    expect(U.learnedDecoyKindForPath(sample), sample).toBe(helpers.learnedDecoyKindForPath(sample));
  }
  expect(helpers.sanitizeExtensionPath("/inpage.js?x=1#y")).toBe("/inpage.js");
  expect(helpers.learnedDecoyKindForPath("/inpage.js")).toBe("script");
  expect(helpers.learnedDecoyKindForPath("/icon.webp")).toBe(null);
  expect(helpers.eligiblePathsForId({ "/inpage.js": 2, "/canary.webp": 9, "/x.js": 1 })).toEqual([
    "/inpage.js",
  ]);
});

test("service worker path caps drop canary floods and evicted IDs", () => {
  const { enforceCaps } = loadServiceWorkerUtils();
  const knownId = "nngceckbapebfimnlniiiahkandclblb";
  const unknownId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const tooManyPaths = {};
  for (let i = 0; i < 12; i++) tooManyPaths[`/file-${i}.js`] = i + 1;
  const highCardinalityIds = {};
  for (let index = 0; Object.keys(highCardinalityIds).length < 2000; index++) {
    const id = extensionIdFor(index);
    if (id !== knownId) highCardinalityIds[id] = 1000 + index;
  }

  const probeLog = {
    "https://path-caps.test": {
      idCounts: {
        ...highCardinalityIds,
        [knownId]: 2,
      },
      idPaths: {
        [knownId]: tooManyPaths,
        [unknownId]: { "/gone.js": 9 },
      },
      lastUpdated: Date.now(),
    },
  };

  enforceCaps(probeLog);
  const retained = probeLog["https://path-caps.test"];
  expect(Object.keys(retained.idCounts)).toHaveLength(2000);
  expect(retained.idCounts[knownId]).toBe(2);
  expect(retained.idPaths[unknownId]).toBeUndefined();
  expect(Object.keys(retained.idPaths[knownId])).toHaveLength(8);
  expect(retained.idPaths[knownId]["/file-11.js"]).toBe(12);
  expect(retained.idPaths[knownId]["/file-0.js"]).toBeUndefined();
});

test("bridge flush includes sanitized learned WAR paths", () => {
  const harness = loadBridgeHarness();
  const port = harness.portsByEvent.__perf_noise_bi__;
  expect(port).toBeTruthy();
  const knownId = "nngceckbapebfimnlniiiahkandclblb";
  port.postMessage({
    type: "probe_blocked",
    url: `chrome-extension://${knownId}/inpage.js?secret=1`,
    where: "fetch",
  });
  port.postMessage({
    type: "probe_blocked",
    url: `chrome-extension://${knownId}/inpage.js#frag`,
    where: "fetch",
  });
  port.postMessage({
    type: "probe_blocked",
    url: `chrome-extension://${knownId}/../escape.js`,
    where: "fetch",
  });
  harness.dispatchWindow("pagehide");
  harness.runTimers();
  const message = harness.messages.find((msg) => msg.type === "static_probe_blocked");
  expect(message.deltaIdPaths[knownId]["/inpage.js"]).toBe(2);
  expect(message.deltaIdPaths[knownId]["/inpage.js?secret=1"]).toBeUndefined();
  expect(JSON.stringify(message.deltaIdPaths)).not.toContain("..");
});

// =========================================================================
// Site identity — the registrable-domain heuristic behind per-site decisions
// =========================================================================

test("siteKeyForHostname normalizes registrable domains and bare hosts", () => {
  const helpers = loadStaticConfig().helpers;
  const siteKeyForHostname = helpers.siteKeyForHostname.bind(helpers);
  const cases = [
    ["paypal.com", "paypal.com"],
    ["www.paypal.com", "paypal.com"],
    ["a.b.example.co.uk", "example.co.uk"],
    ["example.co.uk", "example.co.uk"],
    ["bbc.co.uk", "bbc.co.uk"],
    ["alice.github.io", "alice.github.io"],
    ["bob.github.io", "bob.github.io"],
    ["cdn.alice.github.io", "alice.github.io"],
    ["bucket.s3.amazonaws.com", "bucket.s3.amazonaws.com"],
    ["s3.amazonaws.com", "s3.amazonaws.com"],
    ["127.0.0.1", "127.0.0.1"],
    ["192.168.0.1", "192.168.0.1"],
    ["[::1]", "[::1]"],
    ["localhost", "localhost"],
    ["sub.localhost", "localhost"],
    ["app.localhost", "localhost"],
    ["docs.internal", "docs.internal"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["EXAMPLE.COM", "example.com"],
    ["www.example.com.", "example.com"],
    ["example.com:8443", "example.com"],
    ["my-site.example", "my-site.example"],
  ];
  for (const [host, expected] of cases) {
    expect(siteKeyForHostname(host), host).toBe(expected);
  }
  expect(siteKeyForHostname("")).toBeNull();
  expect(siteKeyForHostname(null)).toBeNull();
  expect(siteKeyForHostname(undefined)).toBeNull();
  expect(siteKeyForHostname("a".repeat(260))).not.toBeNull();
});

test("siteKeyForOrigin and siteKeyFor accept origins, URLs, hosts and ports", () => {
  const helpers = loadStaticConfig().helpers;
  const siteKeyFor = helpers.siteKeyFor.bind(helpers);
  const siteKeyForOrigin = helpers.siteKeyForOrigin.bind(helpers);
  const siteKeyForUrl = helpers.siteKeyForUrl.bind(helpers);
  const origins = [
    ["https://www.paypal.com/login?redirect=%2Fhome", "paypal.com"],
    ["http://a.b.example.co.uk:8080/path", "example.co.uk"],
    ["http://127.0.0.1:8642", "127.0.0.1"],
    ["http://localhost:3000", "localhost"],
    ["http://[::1]:8080", "[::1]"],
    ["http://docs.internal", "docs.internal"],
    ["http://bücher.example/", "xn--bcher-kva.example"],
    ["https://user:pass@www.example.com/", "example.com"],
    ["http://example.com./", "example.com"],
  ];
  for (const [origin, expected] of origins) {
    expect(siteKeyForOrigin(origin), origin).toBe(expected);
    expect(siteKeyForUrl(origin), origin).toBe(expected);
  }
  expect(siteKeyFor("www.paypal.com:443")).toBe("paypal.com");
  expect(siteKeyFor("localhost:3000")).toBe("localhost");
  expect(siteKeyFor("a.b.example.co.uk")).toBe("example.co.uk");
  expect(siteKeyFor("HTTPS://WWW.PAYPAL.COM/LOGIN")).toBe("paypal.com");
  expect(siteKeyForOrigin("file:///tmp/a.html")).toBeNull();
  expect(siteKeyForOrigin("")).toBeNull();
  expect(siteKeyForOrigin(null)).toBeNull();
});

test("siteKeyForHostname respects every documented public-suffix family", () => {
  const helpers = loadStaticConfig().helpers;
  const siteKeyForHostname = helpers.siteKeyForHostname.bind(helpers);
  const secondLevel = ["co.uk", "com.au", "co.jp", "com.br", "com.cn", "co.in", "com.mx", "com.tr"];
  for (const suffix of secondLevel) {
    expect(siteKeyForHostname(`shop.${suffix}`), suffix).toBe(`shop.${suffix}`);
    expect(siteKeyForHostname(`www.shop.${suffix}`), suffix).toBe(`shop.${suffix}`);
  }
  const tenants = [
    ["alice.github.io", "alice.github.io"],
    ["bob.netlify.app", "bob.netlify.app"],
    ["project.vercel.app", "project.vercel.app"],
    ["page.pages.dev", "page.pages.dev"],
    ["worker.workers.dev", "worker.workers.dev"],
    ["app.web.app", "app.web.app"],
    ["site.firebaseapp.com", "site.firebaseapp.com"],
    ["app.appspot.com", "app.appspot.com"],
    ["app.herokuapp.com", "app.herokuapp.com"],
    ["app.azurewebsites.net", "app.azurewebsites.net"],
    ["dist.cloudfront.net", "dist.cloudfront.net"],
    ["bucket.s3.amazonaws.com", "bucket.s3.amazonaws.com"],
    ["blog.blogspot.com", "blog.blogspot.com"],
    ["alice.notion.site", "alice.notion.site"],
    ["alice.repl.co", "alice.repl.co"],
    ["alice.glitch.me", "alice.glitch.me"],
    ["alice.onrender.com", "alice.onrender.com"],
    ["alice.fly.dev", "alice.fly.dev"],
    ["alice.railway.app", "alice.railway.app"],
    ["alice.surge.sh", "alice.surge.sh"],
    ["alice.neocities.org", "alice.neocities.org"],
    ["alice.wordpress.com", "alice.wordpress.com"],
    ["alice.weebly.com", "alice.weebly.com"],
    ["alice.squarespace.com", "alice.squarespace.com"],
  ];
  for (const [host, expected] of tenants) {
    expect(siteKeyForHostname(host), host).toBe(expected);
  }
  // Tenants of the same platform are distinct sites.
  expect(siteKeyForHostname("alice.github.io")).not.toBe(siteKeyForHostname("bob.github.io"));
  // Deep subdomains collapse onto the tenant, not the platform suffix.
  expect(siteKeyForHostname("cdn.alice.github.io")).toBe("alice.github.io");
  expect(siteKeyForHostname("x.y.team.pages.dev")).toBe("team.pages.dev");
});

test("sitePatternsFor emits match patterns for registrable sites only", () => {
  const helpers = loadStaticConfig().helpers;
  const sitePatternsFor = helpers.sitePatternsFor.bind(helpers);
  const cases = [
    ["paypal.com", ["*://paypal.com/*", "*://*.paypal.com/*"]],
    ["example.co.uk", ["*://example.co.uk/*", "*://*.example.co.uk/*"]],
    ["xn--bcher-kva.example", ["*://xn--bcher-kva.example/*", "*://*.xn--bcher-kva.example/*"]],
    ["127.0.0.1", ["*://127.0.0.1/*"]],
    ["localhost", ["*://localhost/*"]],
    ["docs.internal", ["*://docs.internal/*", "*://*.docs.internal/*"]],
    ["[::1]", null],
    ["::1", null],
    ["", null],
    ["   ", null],
    ["not a host", null],
    ["under_score.example", null],
    ["-leading.example", null],
    ["trailing-.example", null],
    ["a".repeat(254), null],
    [null, null],
  ];
  for (const [site, expected] of cases) {
    expect(sitePatternsFor(site), String(site)).toEqual(expected);
  }
  // Canonical list order: bare pattern first, then the wildcard subdomain.
  expect(sitePatternsFor("paypal.com")).toEqual(["*://paypal.com/*", "*://*.paypal.com/*"]);
  expect(sitePatternsFor("paypal.com")).toHaveLength(2);
  expect(sitePatternsFor("127.0.0.1")).toHaveLength(1);
  expect(sitePatternsFor("[::1]")).toBeNull();
});

test("originMatchesSiteKey accepts the site, its subdomains and its ports only", () => {
  const helpers = loadStaticConfig().helpers;
  const originMatchesSiteKey = helpers.originMatchesSiteKey.bind(helpers);
  expect(originMatchesSiteKey("https://www.paypal.com", "paypal.com")).toBe(true);
  expect(originMatchesSiteKey("https://paypal.com:8443", "paypal.com")).toBe(true);
  expect(originMatchesSiteKey("http://checkout.paypal.com/x", "paypal.com")).toBe(true);
  expect(originMatchesSiteKey("http://127.0.0.1:3000", "127.0.0.1")).toBe(true);
  expect(originMatchesSiteKey("http://localhost:3000", "localhost")).toBe(true);
  expect(originMatchesSiteKey("http://alice.github.io", "alice.github.io")).toBe(true);
  expect(originMatchesSiteKey("http://alice.github.io", "bob.github.io")).toBe(false);
  expect(originMatchesSiteKey("http://notpaypal.com", "paypal.com")).toBe(false);
  expect(originMatchesSiteKey("http://paypal.com.evil.example", "paypal.com")).toBe(false);
  expect(originMatchesSiteKey("http://a.b.example.co.uk", "example.co.uk")).toBe(true);
});

// =========================================================================
// Per-site content-script registrations (v2.8)
// =========================================================================

const perSiteSettings = (overrides = {}) => ({
  ...loadServiceWorkerUtils().CONTENT_SCRIPT_SETTINGS,
  ...alwaysSettings(),
  ...overrides,
  protection_mode: "per_site",
});

const registrationsFor = (settings) =>
  plain(loadServiceWorkerUtils().contentScriptRegistrationsFor(settings));

const registrationById = (registrations, id) => registrations.find((script) => script.id === id);

test("per_site registrations: no decision is the two-script scout pair", () => {
  const utils = loadServiceWorkerUtils();
  const registrations = registrationsFor(perSiteSettings());
  expect(registrations.map((script) => script.id)).toEqual(["c-scout-main", "d-scout-isolated"]);

  const [scoutMain, scoutIsolated] = registrations;
  expect(scoutMain).toEqual({
    allFrames: true,
    excludeMatches: [],
    id: "c-scout-main",
    js: [...utils.SCOUT_MAIN_SCRIPTS],
    matchOriginAsFallback: true,
    matches: ["<all_urls>"],
    persistAcrossSessions: true,
    runAt: "document_start",
    world: "MAIN",
  });
  expect(scoutIsolated).toMatchObject({
    allFrames: true,
    excludeMatches: [],
    id: "d-scout-isolated",
    js: [...utils.SCOUT_ISOLATED_SCRIPTS],
    matchOriginAsFallback: true,
    matches: ["<all_urls>"],
    persistAcrossSessions: true,
    runAt: "document_start",
    world: "ISOLATED",
  });
  expect(scoutMain.js).toEqual([
    "block_utils.js",
    "signals.js",
    "scout.js",
    "scout_probes.js",
    "scout_signals.js",
  ]);
  expect(scoutMain.js[0]).toBe(utils.MAIN_WORLD_SCRIPTS[0].file);
});

test("per_site registrations: decided-on sites get the full stack scoped to their patterns", () => {
  const sites = {
    "example.co.uk": { at: 2, source: "popup", state: "on" },
    "paypal.com": { at: 1, source: "site-page", state: "on" },
  };
  const registrations = registrationsFor(perSiteSettings({ site_decisions: sites }));
  expect(registrations.map((script) => script.id)).toEqual([
    "a-main",
    "b-isolated",
    "c-scout-main",
    "d-scout-isolated",
  ]);
  const patterns = [
    "*://*.example.co.uk/*",
    "*://*.paypal.com/*",
    "*://example.co.uk/*",
    "*://paypal.com/*",
  ];
  expect(registrationById(registrations, "a-main").matches).toEqual(patterns);
  expect(registrationById(registrations, "b-isolated").matches).toEqual(patterns);
  // The scout pair runs everywhere but where the full stack already runs.
  expect(registrationById(registrations, "c-scout-main").matches).toEqual(["<all_urls>"]);
  expect(registrationById(registrations, "c-scout-main").excludeMatches).toEqual(patterns);
  expect(registrationById(registrations, "d-scout-isolated").excludeMatches).toEqual(patterns);
  for (const script of registrations) {
    expect(script.excludeMatches).toEqual([...script.excludeMatches].sort());
    expect(script.allFrames).toBe(true);
    expect(script.runAt).toBe("document_start");
    expect(script.matchOriginAsFallback).toBe(true);
    expect(script.persistAcrossSessions).toBe(true);
    expect(script.excludeMatches).not.toContain("<all_urls>");
  }
});

test("per_site registrations: decided-off sites and pauses never reach the full stack", () => {
  const offOnly = registrationsFor(
    perSiteSettings({ site_decisions: { "left-off.example": { at: 1, state: "off" } } })
  );
  expect(offOnly.map((script) => script.id)).toEqual(["c-scout-main", "d-scout-isolated"]);
  expect(offOnly[0].excludeMatches).toEqual([]);

  const pausedAndOn = registrationsFor(
    perSiteSettings({
      disabled_origins: { "http://paused.example:8080": true },
      site_decisions: {
        "left-off.example": { at: 1, state: "off" },
        "on.example": { at: 2, state: "on" },
      },
    })
  );
  const main = registrationById(pausedAndOn, "a-main");
  expect(main.matches).toEqual(["*://*.on.example/*", "*://on.example/*"]);
  // spec: pause entries only affect always mode; they are not excludeMatches here.
  for (const script of pausedAndOn) {
    expect(script.excludeMatches).not.toContain("http://paused.example/*");
  }
});

test("per_site registrations: 250 sites stay sorted, unique and stable", () => {
  const utils = loadServiceWorkerUtils();
  const siteDecisions = {};
  for (let index = 0; index < 250; index += 1) {
    siteDecisions[`s${index}.example`] = { at: index, state: "on" };
  }
  const settings = perSiteSettings({ site_decisions: siteDecisions });
  const registrations = registrationsFor(settings);
  const main = registrationById(registrations, "a-main");
  const scout = registrationById(registrations, "c-scout-main");

  expect(main.matches).toHaveLength(500);
  expect(new Set(main.matches).size).toBe(500);
  expect(main.matches).toEqual([...main.matches].sort());
  expect(scout.excludeMatches).toEqual(main.matches);
  expect(main.matches).toEqual(expect.arrayContaining(["*://s0.example/*", "*://*.s0.example/*"]));
  // Every pattern is a valid match pattern under <all_urls>.
  for (const pattern of main.matches) {
    expect(pattern).toMatch(/^\*:\/\/[\w.*-]+\/\*$/);
    expect(pattern.endsWith("/*")).toBe(true);
  }

  // Same input twice -> identical registration keys; order in the map is irrelevant.
  const reordered = Object.fromEntries(Object.entries(siteDecisions).reverse());
  const second = registrationsFor(perSiteSettings({ site_decisions: reordered }));
  expect(utils.contentScriptsInSync(registrations, second)).toBe(true);
  expect(registrations.map((script) => JSON.stringify(script))).toEqual(
    second.map((script) => JSON.stringify(script))
  );
});

test("per_site registrations: invalid site keys are skipped without breaking the set", () => {
  const registrations = registrationsFor(
    perSiteSettings({
      site_decisions: {
        "bücher.example": { at: 1, state: "on" },
        "[::1]": { at: 2, state: "on" },
        "-bad.example": { at: 3, state: "on" },
        "under_score.example": { at: 4, state: "on" },
        "xn--bcher-kva.example": { at: 5, state: "on" },
        "good.example": { at: 6, state: "on" },
      },
    })
  );
  const main = registrationById(registrations, "a-main");
  // IDN decisions are normalized to punycode by the message layer; a raw
  // Unicode key that reaches storage can still pattern (browser URL parser
  // punycodes it), so "bücher.example" contributes either zero or punycode
  // patterns, never a literal Unicode match pattern.
  const allowed = [
    ["*://*.good.example/*", "*://good.example/*"],
    [
      "*://*.good.example/*",
      "*://*.xn--bcher-kva.example/*",
      "*://good.example/*",
      "*://xn--bcher-kva.example/*",
    ],
  ];
  expect(allowed).toContainEqual(main.matches);
  for (const pattern of main.matches) expect(pattern).not.toContain("bücher");
  expect(main.matches.some((pattern) => pattern.includes("[::1]"))).toBe(false);
});

test("registrations detect always <-> per_site transitions", () => {
  const utils = loadServiceWorkerUtils();
  const always = registrationsFor(alwaysSettings());
  const perSite = registrationsFor({ ...alwaysSettings(), protection_mode: "per_site" });
  expect(always.map((script) => script.id)).toEqual(["a-main", "b-isolated"]);
  expect(perSite.map((script) => script.id)).toEqual(["c-scout-main", "d-scout-isolated"]);
  expect(always[0].matches).toEqual(["<all_urls>"]);
  expect(utils.contentScriptsInSync(always, perSite)).toBe(false);
  expect(
    utils.contentScriptsInSync(
      perSite,
      registrationsFor({ ...alwaysSettings(), protection_mode: "bogus" })
    )
  ).toBe(true);
  expect(
    utils.contentScriptsInSync(
      always,
      plain(loadServiceWorkerUtils().contentScriptRegistrationsFor(alwaysSettings()))
    )
  ).toBe(true);
});

test("alwaysSettings fixture pins the pre-v2.8 registration shape", () => {
  const utils = loadServiceWorkerUtils();
  const settings = alwaysSettings();
  expect(settings.protection_mode).toBe("always");
  expect(settings.site_decisions).toEqual({});
  const registrations = registrationsFor(settings);
  expect(registrations.map((script) => script.id)).toEqual(["a-main", "b-isolated"]);
  expect(registrationById(registrations, "a-main").js).toEqual(
    utils.MAIN_WORLD_SCRIPTS.filter((script) => !script.when || script.when(settings)).map(
      (script) => script.file
    )
  );
});

// =========================================================================
// signals.js catalog integrity (spec: Appendix A)
// =========================================================================

const rulePatterns = () => {
  const patterns = [];
  for (const filePath of ["rules/fingerprint_vendors.json", "rules/captcha_vendors.json"]) {
    for (const filter of urlFiltersFor(filePath)) {
      const match = filter.match(/^\|\|((?:[^/^]+)(?:\/[^/^]*)?)\^?$/);
      if (match) patterns.push(match[1].toLowerCase());
    }
  }
  return patterns;
};

// A catalog domain is either a host (`fpjs.io`) or a host/path prefix
// (`google.com/recaptcha`). Rule filters carry the same shape.
const domainCoversPattern = (rulePattern, catalogDomain) => {
  if (catalogDomain.includes("/")) {
    return rulePattern === catalogDomain || rulePattern.startsWith(`${catalogDomain}/`);
  }
  const [ruleHost] = rulePattern.split("/");
  return ruleHost === catalogDomain || ruleHost.endsWith(`.${catalogDomain}`);
};

test("signals.js catalog covers every DNR rule domain exactly once", () => {
  const { catalog } = loadCatalog();
  expect(catalog.version).toBe(1);
  expect(Array.isArray(catalog.vendors)).toBe(true);

  const patterns = rulePatterns();
  expect(patterns.length).toBeGreaterThan(50);
  for (const rulePattern of patterns) {
    const owners = catalog.vendors.filter((vendor) =>
      vendor.domains.some((domain) => domainCoversPattern(rulePattern, domain))
    );
    expect(owners.length, `${rulePattern} is covered by no vendor row`).toBeGreaterThan(0);
    expect(
      owners.length,
      `${rulePattern} is covered by multiple vendor rows: ${owners.map((row) => row.id).join(", ")}`
    ).toBe(1);
  }
});

test("signals.js catalog rows have unique ids, labels and contract kinds", () => {
  const { catalog } = loadCatalog();
  const kinds = {
    compat: ["auth", "challenge", "flow", "payment", "policy"],
    device: ["strong", "weak"],
    vendor: ["bot", "captcha", "fingerprint", "payment"],
  };
  for (const [rowKind, kindList] of [
    ["vendors", kinds.vendor],
    ["device", kinds.device],
    ["replay", ["replay"]],
    ["compat", kinds.compat],
  ]) {
    const rows = catalog[rowKind];
    expect(Array.isArray(rows), rowKind).toBe(true);
    expect(rows.length, rowKind).toBeGreaterThan(0);
    const ids = new Set();
    for (const row of rows) {
      expect(typeof row.id, `${rowKind} id`).toBe("string");
      expect(row.id.length, `${rowKind} id ${row.id}`).toBeGreaterThan(1);
      expect(ids.has(row.id), `duplicate ${rowKind} id ${row.id}`).toBe(false);
      ids.add(row.id);
      expect(typeof row.label, `${rowKind} ${row.id} label`).toBe("string");
      expect(row.label.length, `${rowKind} ${row.id} label`).toBeGreaterThan(1);
      expect(row.label.trim()).toBe(row.label);
      if (rowKind === "compat") {
        expect(typeof row.risk, `${rowKind} ${row.id} risk`).toBe("number");
        expect(row.risk, `${rowKind} ${row.id} risk`).toBeGreaterThan(0);
        expect(kindList, `${rowKind} ${row.id}`).toContain(row.kind);
      } else {
        expect(typeof row.weight, `${rowKind} ${row.id} weight`).toBe("number");
        expect(row.weight, `${rowKind} ${row.id} weight`).toBeGreaterThan(0);
        if (rowKind === "vendors") expect(kindList, `${rowKind} ${row.id}`).toContain(row.kind);
        if (rowKind === "device") {
          expect(["strong", "weak"], `${rowKind} ${row.id}`).toContain(row.kind);
        }
      }
    }
  }

  const deviceStrong = catalog.device.filter((row) => row.kind === "strong");
  const deviceWeak = catalog.device.filter((row) => row.kind === "weak");
  expect(deviceStrong.map((row) => row.id).sort()).toEqual(["audio", "canvas", "fonts", "webgl"]);
  expect(deviceWeak.length).toBeGreaterThan(8);
  for (const row of deviceStrong) expect(row.weight).toBe(5);
  for (const row of deviceWeak) expect(row.weight).toBe(2);

  for (const row of catalog.vendors) {
    expect(Array.isArray(row.domains), `${row.id} domains`).toBe(true);
    expect(Array.isArray(row.globals), `${row.id} globals`).toBe(true);
    for (const domain of row.domains) {
      expect(domain, `${row.id} domain`).toMatch(/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)*$/);
      expect(domain).not.toMatch(/^https?:\/\//);
      expect(domain).not.toMatch(/^www\./);
      expect(domain).not.toMatch(/\/$/);
    }
  }
  for (const row of catalog.replay) {
    expect(Array.isArray(row.domains), `${row.id} replay domains`).toBe(true);
    expect(Array.isArray(row.globals), `${row.id} replay globals`).toBe(true);
  }
  // CAPTCHA vendors carry no fingerprint weight; their `kind` drives the copy.
  const captchaRows = catalog.vendors.filter((row) => row.kind === "captcha");
  expect(captchaRows.length).toBeGreaterThan(5);
});

test("signals.js compat risks match the Appendix risk table", () => {
  const { catalog } = loadCatalog();
  const risks = Object.fromEntries(catalog.compat.map((row) => [row.id, row.risk]));
  expect(risks).toEqual({
    bot_challenge: 12,
    captcha: 10,
    card_field: 16,
    checkout_path: 12,
    cross_origin_frame: 4,
    email_field: 6,
    login_path: 8,
    oauth_redirect: 10,
    password_field: 12,
    payment_request: 10,
    trusted_types: 4,
    webauthn: 10,
  });
  const kinds = Object.fromEntries(catalog.compat.map((row) => [row.id, row.kind]));
  expect(kinds.password_field).toBe("auth");
  expect(kinds.card_field).toBe("payment");
  expect(kinds.bot_challenge).toBe("challenge");
  expect(kinds.login_path).toBe("flow");
  expect(kinds.trusted_types).toBe("policy");
});

test("signals.js probe vectors cover the canonical scout list", () => {
  const { catalog } = loadCatalog();
  expect(new Set(catalog.vectors)).toEqual(new Set(CANONICAL_VECTORS));
  expect(catalog.vectors).toHaveLength(CANONICAL_VECTORS.length);
});

test("signals.js stays data-only (no DOM, chrome, fetch or timer references)", () => {
  const source = readText("signals.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const identifier of [
    "chrome.",
    "document.",
    "window.",
    "globalThis.document",
    "fetch(",
    "XMLHttpRequest",
    "setTimeout(",
    "setInterval(",
    "addEventListener(",
    "navigator.",
    "location.",
  ]) {
    expect(source.includes(identifier), `${identifier} in signals.js`).toBe(false);
  }
});

test("site_signals copy tables cover every catalog row present", () => {
  const { catalog } = loadCatalog();
  const { engine } = loadSiteSignals();
  expect(Object.keys(engine.COMPAT_COPY).sort()).toEqual(
    catalog.compat.map((row) => row.id).sort()
  );
  expect(engine.HEADLINES.neutral).toBe("No strong signal here");
  expect(engine.HEADLINES.protect).toEqual({
    high: "We suggest masking here",
    low: "Masking here is probably worth it",
    medium: "Masking here is worth it",
  });
  expect(engine.HEADLINES.skip).toEqual({
    high: "We suggest leaving masking off here",
    low: "Masking might get in the way here",
    medium: "Masking might get in the way here",
  });
  expect(engine.LIMITS).toMatchObject({
    maxCompatKeys: 24,
    maxDeviceKeys: 30,
    maxEvidenceSites: 200,
    maxProbeIds: 300,
    maxProbesPerMessage: 200,
    maxReplayKeys: 20,
    maxVectors: 24,
    maxVendorKeys: 40,
    staleAfterDays: 30,
  });
});

// =========================================================================
// site_signals.js — evidence sanitizer / merge engine
// =========================================================================

test("probePatchFor counts only well-formed extension URLs", () => {
  const { engine } = loadSiteSignals();
  const basic = engine.probePatchFor([{ count: 2, url: probeUrlFor(), where: "fetch" }], 0);
  expect(basic).toEqual({
    ids: { [KNOWN_EXT_ID]: 2 },
    pathKinds: { manifest: 2 },
    total: 2,
    vectors: { fetch: 2 },
  });

  // ids and vectors are normalized to lowercase.
  const upper = engine.probePatchFor(
    [{ count: 3, url: probeUrlFor(KNOWN_EXT_ID.toUpperCase()), where: "FETCH" }],
    0
  );
  expect(upper.ids).toEqual({ [KNOWN_EXT_ID]: 3 });
  expect(upper.vectors.fetch).toBe(3);

  // Non-extension URLs, junk ids and string counts never reach the patch.
  const junk = engine.probePatchFor(
    [
      { count: 1, url: "https://page.example/collect?secret=FORM_TEXT" },
      { count: 1, url: "chrome-extension://short/manifest.json" },
      { count: 1, url: probeUrlFor("z".repeat(32)) },
      { count: 1, url: probeUrlFor(), where: "not a vector!" },
      { count: 1, url: probeUrlFor(), where: 123 },
      { count: "3", url: probeUrlFor(), where: "fetch" },
      { count: 0, url: probeUrlFor(), where: "fetch" },
      { count: -4, url: probeUrlFor(), where: "fetch" },
      null,
      "junk",
    ],
    0
  );
  expect(junk.total).toBe(5);
  expect(junk.ids[KNOWN_EXT_ID]).toBe(5);
  expect(Object.keys(junk.ids)).toHaveLength(1);
  expect(junk.vectors).toEqual({ fetch: 3, unknown: 2 });
  const text = JSON.stringify(junk);
  expect(text).not.toContain("chrome-extension");
  expect(text).not.toContain("secret");
});

test("probePatchFor handles overflow, caps and missing paths", () => {
  const { engine } = loadSiteSignals();
  const withOverflow = engine.probePatchFor([{ count: 2, url: probeUrlFor(), where: "fetch" }], 5);
  expect(withOverflow.total).toBe(7);
  expect(withOverflow.ids[KNOWN_EXT_ID]).toBe(2);
  expect(withOverflow.vectors.fetch).toBe(2);

  const capped = engine.probePatchFor(
    Array.from({ length: 250 }, () => ({ count: 1, url: probeUrlFor(), where: "fetch" })),
    0
  );
  expect(capped.total).toBe(250);
  expect(capped.ids[KNOWN_EXT_ID]).toBe(200);
  expect(capped.vectors.fetch).toBe(200);

  const noPath = engine.probePatchFor(
    [{ count: 1, url: `chrome-extension://${KNOWN_EXT_ID}`, where: "fetch" }],
    0
  );
  expect(noPath.pathKinds).toEqual({ root: 1 });

  const css = engine.probePatchFor(
    [{ count: 2, url: probeUrlFor(OTHER_EXT_ID, "/style.css?v=1#x"), where: "link" }],
    0
  );
  expect(css.pathKinds).toEqual({ style: 2 });
  expect(css.vectors).toEqual({ link: 2 });
  expect(JSON.stringify(css)).not.toContain("v=1");
  expect(JSON.stringify(css)).not.toContain("#x");

  const overflowCap = engine.probePatchFor([], Number.POSITIVE_INFINITY);
  expect(overflowCap.total).toBe(0);

  expect(engine.probePatchFor(undefined, 0)).toEqual({
    ids: {},
    pathKinds: {},
    total: 0,
    vectors: {},
  });
  expect(engine.probePatchFor("junk", "junk")).toEqual({
    ids: {},
    pathKinds: {},
    total: 0,
    vectors: {},
  });
});

test("signalPatchFor whitelists catalog keys and clamps counts", () => {
  const { engine, catalog } = loadSiteSignals();
  const patch = engine.signalPatchFor({
    compat: { bot_challenge: 199, junk: 5, login_path: -2, password_field: 1.6 },
    device: { canvas: 3, junk: 4, webgl: -1 },
    replay: { logrocket: 2, unknown: 7 },
    uaReads: 1e9,
    vendors: { datadome: 2.4, fingerprintjs: -1, unknown: 9 },
  });
  expect(patch.uaReads).toBe(1_000_000);
  expect(patch.vendors).toEqual({ datadome: 2 });
  expect(patch.device).toEqual({ canvas: 3 });
  expect(patch.replay).toEqual({ logrocket: 2 });
  expect(patch.compat).toEqual({ bot_challenge: 100, password_field: 2 });
  expect(patch.compat.login_path).toBeUndefined();
  expect(patch.vendors.junk).toBeUndefined();
  expect(
    Object.keys(patch.vendors).every((id) => catalog.vendors.some((row) => row.id === id))
  ).toBe(true);
  expect(Object.keys(patch.device).every((id) => catalog.device.some((row) => row.id === id))).toBe(
    true
  );
  expect(Object.keys(patch.compat).every((id) => catalog.compat.some((row) => row.id === id))).toBe(
    true
  );

  for (const input of [undefined, null, "junk", 42, [], { uaReads: "x" }]) {
    expect(() => engine.signalPatchFor(input), JSON.stringify(input)).not.toThrow();
    expect(engine.signalPatchFor(input).uaReads).toBe(0);
  }
});

test("mergeEvidence is monotone, keeps firstSeen and stamps lastSeen", () => {
  const { engine } = loadSiteSignals();
  const patch = engine.probePatchFor([{ count: 2, url: probeUrlFor(), where: "fetch" }], 0);
  const first = engine.mergeEvidence(undefined, { page: true, probes: patch }, SITE_NOW);
  expect(first.firstSeen).toBe(SITE_NOW);
  expect(first.lastSeen).toBe(SITE_NOW);
  expect(first.pages).toBe(1);
  expect(first.probes.total).toBe(2);

  const second = engine.mergeEvidence(
    first,
    { page: true, probes: patch, uaReads: 3, vendors: { fingerprintjs: 1 } },
    SITE_NOW + 1000
  );
  expect(second.firstSeen).toBe(SITE_NOW);
  expect(second.lastSeen).toBe(SITE_NOW + 1000);
  expect(second.pages).toBe(2);
  expect(second.probes.total).toBe(first.probes.total + 2);
  expect(second.uaReads).toBe(3);
  expect(second.vendors.fingerprintjs).toBe(1);

  // Junk current evidence starts from a fresh base instead of throwing.
  const recovered = engine.mergeEvidence("junk", { probes: patch }, SITE_NOW + 2000);
  expect(recovered.firstSeen).toBe(SITE_NOW + 2000);
  expect(recovered.probes.total).toBe(2);

  for (const input of [null, undefined, 42, "x", [], { probes: "junk" }, { signals: null }]) {
    expect(() => engine.mergeEvidence(first, input, SITE_NOW + 3000)).not.toThrow();
  }

  const pageOnly = engine.mergeEvidence(undefined, { page: true }, SITE_NOW);
  expect(pageOnly.pages).toBe(1);
});

test("mergeEvidence enforces every evidence cap", () => {
  const { engine } = loadSiteSignals();
  const manyIds = Object.fromEntries(
    Array.from({ length: 350 }, (_, index) => [extensionIdFor(index), 1])
  );
  const manyVectors = countEvidence(30, "vector-");
  const manyKinds = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`kind${String(index).padStart(2, "0")}`, 1])
  );
  const manyVendors = countEvidence(45, "vendor-");
  const manyDevice = countEvidence(35, "device-");
  const manyReplay = countEvidence(25, "replay-");
  const manyCompat = countEvidence(30, "compat-");
  let merged = engine.mergeEvidence(
    undefined,
    {
      compat: manyCompat,
      device: manyDevice,
      probes: { ids: manyIds, pathKinds: manyKinds, total: 1e12, vectors: manyVectors },
      replay: manyReplay,
      uaReads: 1e12,
      vendors: manyVendors,
    },
    SITE_NOW
  );
  expect(Object.keys(merged.probes.ids)).toHaveLength(engine.LIMITS.maxProbeIds);
  expect(Object.keys(merged.probes.vectors)).toHaveLength(engine.LIMITS.maxVectors);
  expect(Object.keys(merged.probes.pathKinds)).toHaveLength(engine.LIMITS.maxPathKinds);
  const nearTotalCap = engine.sanitizeEvidence({
    probes: { total: engine.LIMITS.maxProbeTotal - 10 },
  });
  const totalCapped = engine.mergeEvidence(
    nearTotalCap,
    { probes: { ids: manyIds, total: 1_000_000 } },
    SITE_NOW
  );
  expect(totalCapped.probes.total).toBe(engine.LIMITS.maxProbeTotal);
  expect(Object.keys(merged.vendors)).toHaveLength(engine.LIMITS.maxVendorKeys);
  expect(Object.keys(merged.device)).toHaveLength(engine.LIMITS.maxDeviceKeys);
  expect(Object.keys(merged.replay)).toHaveLength(engine.LIMITS.maxReplayKeys);
  expect(Object.keys(merged.compat)).toHaveLength(engine.LIMITS.maxCompatKeys);
  expect(merged.uaReads).toBe(engine.LIMITS.maxUaReads);

  // Capped counters stay capped on further merges.
  merged = engine.mergeEvidence(
    merged,
    {
      probes: { ids: manyIds, pathKinds: manyKinds, total: 1e12, vectors: manyVectors },
      uaReads: 1e12,
    },
    SITE_NOW + 1
  );
  expect(Object.keys(merged.probes.ids)).toHaveLength(engine.LIMITS.maxProbeIds);
  expect(merged.uaReads).toBe(engine.LIMITS.maxUaReads);
  expect(merged.firstSeen).toBe(SITE_NOW);

  // pages is clamped at 1e6.
  const maxPages = engine.sanitizeEvidence({ pages: 1e9 });
  expect(maxPages.pages).toBe(engine.LIMITS.maxPages);
  const nearMax = engine.mergeEvidence(maxPages, { page: true }, SITE_NOW);
  expect(nearMax.pages).toBe(engine.LIMITS.maxPages);
});

test("sanitizeEvidence returns clean evidence for junk input", () => {
  const { engine } = loadSiteSignals();
  const validId = extensionIdFor(7);
  const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  for (const junk of [null, undefined, "x", 42, [], () => {}]) {
    expect(engine.sanitizeEvidence(junk)).toBeNull();
  }

  const clean = engine.sanitizeEvidence({
    compat: { bot_challenge: -2, captcha: Number.NaN, card_field: 2, junk: 3 },
    device: { canvas: "4", junk: -1 },
    firstSeen: -5,
    lastSeen: Number.POSITIVE_INFINITY,
    pages: Number.NaN,
    probes: {
      ids: { [validId.toUpperCase()]: 2, [uuid]: 1, short: 9, ["z".repeat(32)]: 4 },
      pathKinds: { manifest: 2, bad: -1 },
      total: "9",
      vectors: { fetch: -1, xhr: 2 },
    },
    replay: { logrocket: 2, junk: 0 },
    uaReads: -3,
    vendors: { fingerprintjs: "3", junk: -1 },
  });
  expect(clean.firstSeen).toBe(0);
  expect(clean.lastSeen).toBe(0);
  expect(clean.pages).toBe(0);
  expect(clean.uaReads).toBe(0);
  expect(clean.probes.total).toBe(9);
  expect(clean.probes.ids).toEqual({ [validId]: 2, [uuid]: 1 });
  expect(clean.probes.vectors).toEqual({ xhr: 2 });
  expect(clean.probes.pathKinds).toEqual({ manifest: 2 });
  expect(clean.vendors.fingerprintjs).toBe(3);
  expect(clean.compat.card_field).toBe(2);
  expect(clean.device.canvas).toBe(4);
  expect(clean.compat.bot_challenge).toBeUndefined();
  expect(clean.compat.captcha).toBeUndefined();

  // Missing lastSeen falls back to firstSeen so staleness math stays sane.
  const noLast = engine.sanitizeEvidence({ firstSeen: 1234, lastSeen: 0 });
  expect(noLast.lastSeen).toBe(1234);

  const { catalog } = loadSiteSignals();
  const catalogMap = (rows) => Object.fromEntries(rows.map((row) => [row.id, 1]));
  const capped = engine.sanitizeEvidence({
    compat: catalogMap(catalog.compat),
    device: catalogMap(catalog.device),
    pages: 1e12,
    probes: {
      ids: Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [extensionIdFor(index), 1])
      ),
      pathKinds: countEvidence(30, "k-"),
      total: 1e12,
      vectors: countEvidence(30, "v-"),
    },
    replay: catalogMap(catalog.replay),
    uaReads: 1e12,
    vendors: catalogMap(catalog.vendors),
  });
  expect(Object.keys(capped.compat)).toHaveLength(catalog.compat.length);
  expect(Object.keys(capped.device)).toHaveLength(catalog.device.length);
  expect(Object.keys(capped.probes.vectors)).toHaveLength(engine.LIMITS.maxVectors);
  expect(Object.keys(capped.probes.pathKinds)).toHaveLength(engine.LIMITS.maxPathKinds);
  expect(Object.keys(capped.replay)).toHaveLength(catalog.replay.length);
  expect(Object.keys(capped.vendors)).toHaveLength(engine.LIMITS.maxVendorKeys);
  expect(Object.keys(capped.probes.ids)).toHaveLength(engine.LIMITS.maxProbeIds);
  expect(capped.pages).toBe(engine.LIMITS.maxPages);
  expect(capped.uaReads).toBe(engine.LIMITS.maxUaReads);
  expect(capped.probes.total).toBe(engine.LIMITS.maxProbeTotal);
});

test("sanitizeEvidence filters ids the catalog no longer knows", () => {
  const { engine } = loadSiteSignals();
  const clean = engine.sanitizeEvidence(
    blankEvidence({
      compat: { password_field: 1, retired_field: 2 },
      device: { canvas: 1, retired_surface: 3 },
      replay: { logrocket: 1, retired_sdk: 1 },
      vendors: { fingerprintjs: 1, retired_vendor: 4 },
    })
  );
  // spec: evidence keeps fixed catalog keys only.
  expect(clean.vendors).toEqual({ fingerprintjs: 1 });
  expect(clean.device).toEqual({ canvas: 1 });
  expect(clean.replay).toEqual({ logrocket: 1 });
  expect(clean.compat).toEqual({ password_field: 1 });
});

test("evidenceSummaryFor and summarizeEvidence stay compact and URL-free", () => {
  const { engine } = loadSiteSignals();
  const evidence = blankEvidence({
    compat: { password_field: 1 },
    device: { canvas: 2 },
    probes: {
      ids: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [extensionIdFor(index), 3])),
      pathKinds: { manifest: 5 },
      total: 1204,
      vectors: { fetch: 1204 },
    },
    vendors: { fingerprintjs: 1 },
  });
  const summary = engine.evidenceSummaryFor(evidence);
  expect(summary).toMatchObject({
    firstSeen: evidence.firstSeen,
    lastSeen: evidence.lastSeen,
    pages: evidence.pages,
    probeIds: 4,
    probeTotal: 1204,
    probeVectors: 1,
    uaReads: 0,
  });
  expect(typeof summary.probeIds).toBe("number");
  expect(typeof summary.probeTotal).toBe("number");
  expect(summary.vendorKeys).toEqual(["fingerprintjs"]);
  expect(summary.deviceKeys).toEqual(["canvas"]);
  expect(summary.compatKeys).toEqual(["password_field"]);
  expect(summary.labels.length).toBeLessThanOrEqual(3);
  expect(engine.summarizeEvidence(evidence)).toBe(
    "1,204 extension checks · FingerprintJS · a sign-in form"
  );
  expect(engine.summarizeEvidence(null)).toBe("");
  expect(engine.summarizeEvidence(blankEvidence())).toBe("");
  expect(
    engine.summarizeEvidence(
      blankEvidence({ probes: { total: 1, ids: {}, vectors: {}, pathKinds: {} } })
    )
  ).toBe("1 extension check");
  expect(engine.evidenceSummaryFor(null)).toBeNull();

  const text = [engine.summarizeEvidence(evidence), ...summary.labels].join(" ");
  expect(text).not.toContain("chrome-extension://");
  expect(text).not.toContain("http");
  expect(text).not.toContain(KNOWN_EXT_ID);
});

// =========================================================================
// site_signals.js — recommendation engine (verdicts, copy, overrides)
// =========================================================================

const recommend = (evidence, contextOverrides = {}) =>
  loadSiteSignals().engine.recommendationFor(evidence, recommendationContext(contextOverrides));

const withProbes = (count, { ids = 0, vectors = 0 } = {}) =>
  blankEvidence({
    probes: {
      ids: Object.fromEntries(
        Array.from({ length: ids }, (_, index) => [extensionIdFor(index), 1])
      ),
      pathKinds: {},
      total: count,
      vectors: Object.fromEntries(
        Array.from({ length: vectors }, (_, index) => [CANONICAL_VECTORS[index], 1])
      ),
    },
  });

test("recommendationFor: a page with no evidence is a quiet neutral", () => {
  const quiet = recommend(null);
  expect(quiet).toMatchObject({
    benefit: 0,
    benefits: [],
    benefitCount: 0,
    caution: false,
    confidence: "low",
    confidenceScore: 0,
    decisionHint: "Your call",
    headline: "No strong signal here",
    margin: 0,
    noteCount: 0,
    notes: [],
    observed: false,
    risk: 0,
    riskCount: 0,
    risks: [],
    stale: false,
    summary: "Static hasn't seen this page do anything it can mask.",
    verdict: "neutral",
  });
  // An empty evidence object is the same as no evidence at all.
  expect(recommend(blankEvidence())).toMatchObject({ observed: false, verdict: "neutral" });
});

test("recommendationFor: probe volume bands score as documented", () => {
  const cases = [
    [0, 0],
    [1, 6],
    [19, 6],
    [20, 12],
    [99, 12],
    [100, 18],
    [999, 18],
    [1000, 24],
    [4999, 24],
    [5000, 30],
  ];
  for (const [total, benefit] of cases) {
    const recommendation = recommend(withProbes(total));
    expect(recommendation.benefit, `probes=${total}`).toBe(benefit);
    expect(recommendation.observed, `probes=${total}`).toBe(total > 0);
  }
  expect(recommend(withProbes(1)).verdict).toBe("neutral");
  expect(recommend(withProbes(1)).risks).toEqual([]);
  expect(recommend(withProbes(20)).verdict).toBe("protect");
  expect(recommend(withProbes(20)).benefits[0]).toMatchObject({
    key: "extension_checks",
    text: "Checked whether 20 browser extensions are installed",
    weight: 12,
  });
  expect(recommend(withProbes(20)).benefits[0].detail).toBe("20 probes · 0 IDs · 0 request types");
});

test("recommendationFor: distinct ids and vectors add probe points", () => {
  expect(recommend(withProbes(1, { ids: 3 })).benefit).toBe(9);
  expect(recommend(withProbes(1, { ids: 10 })).benefit).toBe(12);
  expect(recommend(withProbes(1, { ids: 25 })).benefit).toBe(15);
  expect(recommend(withProbes(1, { vectors: 2 })).benefit).toBe(9);
  expect(recommend(withProbes(1, { vectors: 4 })).benefit).toBe(12);
  expect(recommend(withProbes(1, { ids: 25, vectors: 4 })).benefit).toBe(21);

  const vectors = recommend(withProbes(1, { vectors: 4 })).benefits.find(
    (row) => row.key === "probe_vectors"
  );
  expect(vectors).toMatchObject({
    key: "probe_vectors",
    text: "Tried 4 ways to detect extensions",
  });

  // 1 probe is singular; larger numbers are grouped with toLocaleString("en-US").
  expect(recommend(withProbes(1)).benefits[0].text).toBe(
    "Checked whether a browser extension is installed"
  );
  expect(recommend(withProbes(1204)).benefits[0].text).toBe(
    "Checked whether 1,204 browser extensions are installed"
  );
  expect(recommend(withProbes(1204)).summary).toBe(
    "This page ran 1,204 extension checks. Masking hides that."
  );
});

test("recommendationFor: vendor benefit rows use catalog weights and group caps", () => {
  const { catalog } = loadCatalog();
  const vendorsOfKind = (kind) =>
    Object.fromEntries(
      catalog.vendors.filter((row) => row.kind === kind).map((row) => [row.id, 1])
    );
  const prefs = (overrides = {}) => ({
    rulesetPrefs: {
      captcha_vendors: true,
      fingerprint_vendors: true,
      ...overrides,
    },
  });

  const fingerprint = recommend(blankEvidence({ vendors: vendorsOfKind("fingerprint") }), prefs());
  expect(fingerprint.benefits[0].text).toMatch(/device fingerprinting/);
  expect(fingerprint.benefit).toBeLessThanOrEqual(26);
  expect(fingerprint.benefit).toBeGreaterThan(0);

  const bot = recommend(blankEvidence({ vendors: vendorsOfKind("bot") }), prefs());
  expect(bot.benefit).toBeLessThanOrEqual(20);
  expect(bot.benefits.some((row) => /bot checks$/.test(row.text))).toBe(true);
  expect(bot.risks.some((row) => row.key === "bot_vendor")).toBe(true);

  const payment = recommend(blankEvidence({ vendors: vendorsOfKind("payment") }), prefs());
  expect(payment.benefit).toBeLessThanOrEqual(12);
  expect(payment.benefits.some((row) => /risk checks$/.test(row.text))).toBe(true);
  expect(payment.risks.some((row) => row.key === "payment_vendor")).toBe(true);

  const captcha = recommend(blankEvidence({ vendors: vendorsOfKind("captcha") }), prefs());
  expect(captcha.benefit).toBeLessThanOrEqual(10);
  expect(captcha.risk).toBeLessThanOrEqual(16);
  expect(captcha.benefits.some((row) => /challenge$/.test(row.text))).toBe(true);
  expect(captcha.risks.some((row) => row.key === "captcha_vendor")).toBe(true);

  // All vendor kinds are scored only while their network defence is on.
  const everythingOff = recommend(blankEvidence({ vendors: vendorsOfKind("fingerprint") }), {
    rulesetPrefs: { captcha_vendors: false, fingerprint_vendors: false },
  });
  expect(everythingOff.benefits).toEqual([]);
  expect(everythingOff.notes.map((note) => note.detail)).toContain(
    "Fingerprint network lists are off"
  );
});

test("recommendationFor: device, replay and risk rows respect their caps", () => {
  const { catalog } = loadCatalog();
  const strong = Object.fromEntries(
    catalog.device.filter((row) => row.kind === "strong").map((row) => [row.id, 1])
  );
  const weak = Object.fromEntries(
    catalog.device.filter((row) => row.kind === "weak").map((row) => [row.id, 1])
  );
  const replay = Object.fromEntries(catalog.replay.map((row) => [row.id, 1]));

  expect(recommend(blankEvidence({ device: strong }), { fingerprintMode: "mask" }).benefit).toBe(
    20
  ); // strong cap
  expect(recommend(blankEvidence({ device: weak }), { fingerprintMode: "mask" }).benefit).toBe(8); // weak cap
  expect(recommend(blankEvidence({ replay }), { replayMode: "mask" }).benefit).toBe(12); // replay cap
  expect(
    recommend(blankEvidence({ device: strong }), { fingerprintMode: "mask" }).benefits[0].text
  ).toMatch(/^Read your /);

  const ua8 = recommend(blankEvidence({ uaReads: 8 }));
  const ua40 = recommend(blankEvidence({ uaReads: 40 }));
  expect(ua8.risk).toBe(8);
  expect(ua40.risk).toBe(14);
  expect(ua40.risks[0]).toMatchObject({
    key: "ua_reads",
    text: "Reads your browser user agent 40 times",
  });

  expect(
    recommend(blankEvidence({ compat: { email_field: 1 } }), { pausedBefore: true }).risk
  ).toBe(24);
  expect(
    recommend(withProbes(100), {
      compatWarning: {
        kinds: [["unhandled_blocked_fetch", 1]],
        lastUpdated: SITE_NOW - 1000,
        total: 1,
      },
    }).risk
  ).toBe(25);

  // Every compat row is presence-only except the three repeated-frame kinds.
  for (const row of catalog.compat) {
    const one = recommend(blankEvidence({ compat: { [row.id]: 1 } })).risk;
    const many = recommend(blankEvidence({ compat: { [row.id]: 5 } })).risk;
    if (["captcha", "bot_challenge", "cross_origin_frame"].includes(row.id)) {
      expect(many, row.id).toBe(Math.min(100, row.risk * 3));
    } else {
      expect(one, row.id).toBe(row.risk);
      expect(many, row.id).toBe(row.risk);
    }
  }

  const overloaded = recommend(
    blankEvidence({
      compat: Object.fromEntries(catalog.compat.map((row) => [row.id, 9])),
      uaReads: 100,
    }),
    { compatWarning: { kinds: [["x", 1]], lastUpdated: SITE_NOW, total: 1 }, pausedBefore: true }
  );
  expect(overloaded.risk).toBe(100);
});

test("recommendationFor: documented decision matrix for protect bands", () => {
  const probes20 = recommend(withProbes(20));
  expect(probes20).toMatchObject({
    benefit: 12,
    confidence: "low",
    decisionHint: "Protect this site",
    headline: "Masking here is probably worth it",
    risk: 0,
    verdict: "protect",
  });

  const probes100 = recommend(withProbes(100));
  expect(probes100).toMatchObject({
    benefit: 18,
    confidence: "medium",
    headline: "Masking here is worth it",
    verdict: "protect",
  });

  // probes 5000 -> benefit 30, but high needs margin >=35 or benefit >=50.
  const probes5000 = recommend(withProbes(5000));
  expect(probes5000).toMatchObject({
    benefit: 30,
    confidence: "medium",
    headline: "Masking here is worth it",
    verdict: "protect",
  });

  const strong = recommend(withProbes(5000, { ids: 25, vectors: 4 }));
  expect(strong.benefit).toBeGreaterThanOrEqual(45);
  expect(strong).toMatchObject({
    confidence: "high",
    headline: "We suggest masking here",
    verdict: "protect",
  });

  // protect + risk >= 20 sets caution and a softer summary.
  const cautious = recommend(
    blankEvidence({
      compat: { card_field: 1, trusted_types: 1 },
      probes: { ids: {}, pathKinds: {}, total: 5000, vectors: { fetch: 1, xhr: 1 } },
    })
  );
  expect(cautious).toMatchObject({ benefit: 33, caution: true, risk: 20, verdict: "protect" });
  expect(cautious.summary).toContain("sign-in may need a second try");
  expect(cautious.summary).toContain("Masking hides it");

  // protect with decision "off" keeps the verdict for the "since you turned it off" UI.
  expect(recommend(withProbes(5000, { ids: 25, vectors: 4 }), { decision: "off" })).toMatchObject({
    decisionHint: "Protect this site",
    verdict: "protect",
  });
});

test("recommendationFor: documented decision matrix for skip bands", () => {
  // risk 10..14 with no benefit: skip low.
  const skipLow = recommend(blankEvidence({ compat: { password_field: 1 } }));
  expect(skipLow).toMatchObject({ benefit: 0, confidence: "low", risk: 12, verdict: "skip" });

  // risk >= 15, benefit-risk < 0, risk < 25: skip medium (risk 24).
  const skipMedium = recommend(blankEvidence({ compat: { card_field: 1, login_path: 1 } }));
  expect(skipMedium).toMatchObject({ risk: 24, verdict: "skip", confidence: "medium" });

  // risk >= 25 && benefit < risk * 1.5: skip; high once risk >= 45.
  const skipHigh = recommend(
    blankEvidence({ compat: { card_field: 1, checkout_path: 1, password_field: 1, login_path: 1 } })
  );
  expect(skipHigh).toMatchObject({ benefit: 0, risk: 48, verdict: "skip", confidence: "high" });

  // risk 26 benefit 24: skip, medium (high needs benefit < 19.5).
  const nearTie = recommend(
    blankEvidence({
      compat: { card_field: 1, email_field: 1, trusted_types: 1 },
      probes: { ids: {}, pathKinds: {}, total: 1000, vectors: {} },
    })
  );
  expect(nearTie).toMatchObject({ benefit: 24, risk: 26, verdict: "skip", confidence: "medium" });

  // benefit 12, risk 28: skip high because benefit < risk * 0.75.
  const lowBenefitHighRisk = recommend(
    blankEvidence({
      compat: { card_field: 1, checkout_path: 1 },
      probes: { ids: {}, pathKinds: {}, total: 20, vectors: {} },
    })
  );
  expect(lowBenefitHighRisk).toMatchObject({
    benefit: 12,
    risk: 28,
    verdict: "skip",
    confidence: "high",
  });

  // benefit 12, risk 6 -> protect low (benefit >= 12 && benefit - risk > 0).
  const protectTight = recommend(
    blankEvidence({
      compat: { email_field: 1 },
      probes: { ids: {}, pathKinds: {}, total: 20, vectors: {} },
    })
  );
  expect(protectTight).toMatchObject({
    benefit: 12,
    risk: 6,
    verdict: "protect",
    confidence: "low",
  });

  // No verdict ever protects a page with zero active benefit points.
  for (const riskOnly of [
    blankEvidence({ compat: { password_field: 1 } }),
    blankEvidence({ compat: { card_field: 1 } }),
    blankEvidence({ uaReads: 8 }),
    blankEvidence({ compat: { card_field: 1, checkout_path: 1, password_field: 1 } }),
  ]) {
    expect(recommend(riskOnly).verdict).not.toBe("protect");
  }

  // First-match matrix row 1: a page with neither signal is neutral.
  expect(recommend(blankEvidence({ compat: { email_field: 1 } }))).toMatchObject({
    risk: 6,
    verdict: "neutral",
    confidence: "low",
  });
});

test("recommendationFor: confidence follows the documented matrix", () => {
  // protect row 4: benefit >= 12 && benefit-risk > 0 -> low.
  expect(recommend(withProbes(20)).confidence).toBe("low");
  // protect row 3: benefit >= 18 && margin >= 12 -> medium unless margin >=35 / benefit >= 50.
  expect(recommend(withProbes(5000)).confidence).toBe("medium");
  // protect row 3 high: margin >= 35.
  expect(recommend(withProbes(5000, { ids: 25, vectors: 4 })).confidence).toBe("high");

  // skip row 5: risk >= 15 && benefit-risk < 0 -> medium (gap 24 < 25, risk 24 < 35).
  expect(recommend(blankEvidence({ compat: { card_field: 1, login_path: 1 } })).confidence).toBe(
    "medium"
  );
  // skip row 5 high: gap >= 25 (risk 48).
  expect(
    recommend(blankEvidence({ compat: { card_field: 1, checkout_path: 1, password_field: 1 } }))
      .confidence
  ).toBe("high");
  // skip row 2: risk >= 25 && benefit < risk * 1.5; high needs risk >= 45 or benefit < 0.75*risk.
  expect(
    recommend(
      blankEvidence({
        compat: { card_field: 1, email_field: 1, trusted_types: 1 },
        probes: { ids: {}, pathKinds: {}, total: 1000, vectors: {} },
      })
    ).confidence
  ).toBe("medium");
  // neutral is always low.
  expect(recommend(blankEvidence({ compat: { email_field: 1 } })).confidence).toBe("low");
});

test("recommendationFor: compat warning overrides every other signal", () => {
  const strong = withProbes(5000, { ids: 25, vectors: 4 });
  const baseline = recommend(strong);
  expect(baseline.verdict).toBe("protect");
  const warning = {
    kinds: [["unhandled_blocked_fetch", 2]],
    lastUpdated: SITE_NOW - 2000,
    total: 2,
  };
  const overridden = recommend(strong, { compatWarning: warning });
  expect(overridden).toMatchObject({
    caution: false,
    confidence: "high",
    decisionHint: "Leave it off",
    headline: "We suggest leaving masking off here",
    verdict: "skip",
  });
  expect(overridden.risks[0].key).toBe("compat_warning");
  expect(overridden.risks[0].text).toBe("Masking already interrupted a request here");
  expect(overridden.risks[0].detail).toContain("unhandled_blocked_fetch");
  expect(overridden.benefits.length).toBeGreaterThan(0);
});

test("recommendationFor: stale evidence caps confidence and neutralizes undecided", () => {
  const staleTime = SITE_NOW - 40 * 86_400_000;
  const stale = blankEvidence({
    firstSeen: staleTime - 1000,
    lastSeen: staleTime,
    probes: {
      ids: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [extensionIdFor(index), 1])),
      pathKinds: {},
      total: 1000,
      vectors: { fetch: 1, xhr: 1 },
    },
  });
  const undecided = recommend(stale);
  expect(undecided).toMatchObject({
    confidence: "low",
    decisionHint: "Your call",
    observed: true,
    stale: true,
    verdict: "neutral",
  });
  expect(undecided.summary).toBe(
    "Nothing seen here in the last month. A fresh visit will reassess."
  );

  expect(recommend(stale, { decision: "on" })).toMatchObject({
    confidence: "low",
    stale: true,
    verdict: "protect",
  });
  // Fresh evidence is not stale even if firstSeen is old.
  expect(recommend(blankEvidence({ firstSeen: staleTime }))).toMatchObject({ stale: false });
});

test("recommendationFor: defence-off honesty rule never claims a hidden benefit", () => {
  const everythingOff = blankEvidence({
    device: { canvas: 1 },
    replay: { logrocket: 1 },
    vendors: { fingerprintjs: 1 },
  });
  const recommendation = recommend(everythingOff, {
    fingerprintMode: "off",
    replayMode: "off",
    rulesetPrefs: { captcha_vendors: false, fingerprint_vendors: false },
  });
  expect(recommendation).toMatchObject({
    benefitCount: 0,
    benefits: [],
    caution: false,
    confidence: "low",
    decisionHint: "Your call",
    observed: true,
    verdict: "neutral",
  });
  expect(recommendation.notes.length).toBeGreaterThan(0);
  expect(recommendation.notes.length).toBeLessThanOrEqual(2);
  expect(recommendation.noteCount).toBeGreaterThanOrEqual(recommendation.notes.length);
  for (const note of recommendation.notes) {
    expect(note.text).toMatch(/FingerprintJS|LogRocket|canvas/);
    expect(note.detail).toMatch(/off$/);
    expect(typeof note.key).toBe("string");
    expect(note.key.length).toBeGreaterThan(0);
  }

  // Only device defence off: vendor claims still protect and the device note explains why.
  const deviceOff = recommend(
    blankEvidence({ device: { canvas: 1 }, vendors: { deviceatlas: 1, fingerprintjs: 1 } }),
    { fingerprintMode: "off" }
  );
  expect(deviceOff.verdict).toBe("protect");
  expect(deviceOff.benefits.every((row) => row.key.startsWith("vendor:"))).toBe(true);
  expect(deviceOff.notes.map((note) => note.detail)).toContain("Device signal poisoning is off");
  expect(deviceOff.summary).toContain("Masking hides that.");

  // Notes never masquerade as benefits when the corresponding defence is on.
  const allOn = recommend(blankEvidence({ device: { canvas: 1 }, vendors: { fingerprintjs: 1 } }), {
    fingerprintMode: "mask",
  });
  expect(allOn.notes).toEqual([]);
  expect(allOn.benefits.map((row) => row.key)).toEqual(
    expect.arrayContaining(["vendor:fingerprintjs", "device:canvas"])
  );
});

test("recommendationFor: copy templates, formatting and privacy are stable", () => {
  const { catalog, engine } = loadSiteSignals();
  const deviceLabel = (id) => catalog.device.find((row) => row.id === id).label;
  const cases = [
    [blankEvidence({ vendors: { fingerprintjs: 1 } }), { coverage: 1 }],
    [blankEvidence({ vendors: { datadome: 1 } }), { coverage: 1, pointer: "bot" }],
    [blankEvidence({ vendors: { forter: 1 } }), { coverage: 1, pointer: "payment" }],
    [blankEvidence({ vendors: { turnstile: 1 } }), { coverage: 1, pointer: "captcha" }],
    [
      blankEvidence({ device: { canvas: 1, webgl: 1, audio: 1, fonts: 1, hardware: 1 } }),
      { coverage: 1, device: true },
    ],
    [blankEvidence({ replay: { logrocket: 1 } }), { coverage: 1, replay: true }],
  ];
  const texts = [];
  for (const [evidence] of cases) {
    const recommendation = recommend(evidence, {
      fingerprintMode: "mask",
      replayMode: "mask",
      rulesetPrefs: { captcha_vendors: true, fingerprint_vendors: true },
    });
    texts.push(...recommendation.benefits.map((row) => row.text));
    expect(recommendation.summary).not.toMatch(/chrome-extension:\/\/|https?:\/\/|127\.0\.0\.1/);
    expect(recommendation.summary.length).toBeLessThanOrEqual(140);
    expect(recommendation.summary).not.toContain(KNOWN_EXT_ID);
  }
  expect(texts).toEqual(
    expect.arrayContaining([
      "Loads FingerprintJS (device fingerprinting)",
      "Runs DataDome bot checks",
      "Runs Forter risk checks",
      "Loads a Cloudflare Turnstile challenge",
      `Read your ${deviceLabel("canvas")}`,
      "LogRocket can record this page",
    ])
  );
  // benefits are capped at three, so a weak hardware read surfaces on its own.
  expect(
    recommend(blankEvidence({ device: { hardware: 1 } }), { fingerprintMode: "mask" }).benefits[0]
      .text
  ).toBe("Read your CPU and memory");

  // Risks use the fixed copy table.
  const riskEvidence = blankEvidence({
    compat: {
      bot_challenge: 1,
      captcha: 1,
      card_field: 1,
      checkout_path: 1,
      email_field: 1,
      login_path: 1,
      oauth_redirect: 1,
      password_field: 1,
      payment_request: 1,
      trusted_types: 1,
      webauthn: 1,
      cross_origin_frame: 1,
    },
    uaReads: 40,
  });
  const allRisks = recommend(riskEvidence).risks;
  expect(allRisks).toHaveLength(3);
  expect(allRisks.map((row) => row.weight)).toEqual([16, 14, 12]);
  expect(allRisks[0].text).toBe("Has a card or payment form");
  // Every catalog compat row has readable copy, and single-row evidence renders it verbatim.
  for (const row of catalog.compat) {
    const texts = recommend(blankEvidence({ compat: { [row.id]: 1 } })).risks.map(
      (risk) => risk.text
    );
    expect(texts, row.id).toContain(engine.COMPAT_COPY[row.id]);
  }
  expect(allRisks.map((row) => row.text)).toContain("Reads your browser user agent 40 times");
  expect(
    recommend(blankEvidence({ vendors: { datadome: 1 } })).risks.map((row) => row.text)
  ).toContain("A bot check guards this page (DataDome)");
  expect(
    recommend(blankEvidence({ vendors: { forter: 1 } })).risks.map((row) => row.text)
  ).toContain("A fraud check screens this page (Forter)");
  expect(
    recommend(blankEvidence({ compat: { email_field: 1 } }), { pausedBefore: true }).risks.map(
      (row) => row.text
    )
  ).toContain("You paused Static here before");
  expect(
    recommend(blankEvidence({ compat: { email_field: 1 } }), {
      compatWarning: {
        kinds: [["unhandled_blocked_fetch", 1]],
        lastUpdated: SITE_NOW - 1,
        total: 1,
      },
    }).risks.map((row) => row.text)
  ).toContain("Masking already interrupted a request here");

  // Decision hints and headlines are the fixed product strings.
  expect(engine.HEADLINES.neutral).toBe("No strong signal here");
  expect(recommend(withProbes(20)).decisionHint).toBe("Protect this site");
  expect(recommend(blankEvidence({ compat: { card_field: 1 } })).decisionHint).toBe("Leave it off");
  expect(recommend(withProbes(1)).decisionHint).toBe("Your call");

  const recommendation = recommend(withProbes(1204, { ids: 25, vectors: 4 }));
  expect(recommendation.confidenceScore).toBeGreaterThanOrEqual(0);
  expect(recommendation.confidenceScore).toBeLessThanOrEqual(100);
  expect(Number.isInteger(recommendation.confidenceScore)).toBe(true);
  expect(recommendation.margin).toBe(recommendation.benefit - recommendation.risk);
  const serialized = JSON.stringify(recommendation);
  expect(serialized).not.toContain("chrome-extension://");
  expect(serialized).not.toContain("https://");
  expect(serialized).not.toContain(KNOWN_EXT_ID);
  expect(recommendation.benefits.length).toBeLessThanOrEqual(3);
  expect(recommendation.risks.length).toBeLessThanOrEqual(3);
  expect(recommendation.notes.length).toBeLessThanOrEqual(2);
  const weights = recommendation.benefits.map((row) => row.weight);
  expect(weights).toEqual([...weights].sort((a, b) => b - a));
});

test("recommendationFor: context defaults are honest", () => {
  // Missing rulesetPrefs means the network lists are off: vendor evidence becomes notes.
  const vendor = blankEvidence({ vendors: { fingerprintjs: 1 } });
  const withoutPrefs = loadSiteSignals().engine.recommendationFor(vendor, { now: SITE_NOW });
  expect(withoutPrefs.benefits).toEqual([]);
  expect(withoutPrefs.notes.map((note) => note.detail)).toContain(
    "Fingerprint network lists are off"
  );
  expect(withoutPrefs.verdict).toBe("neutral");

  // Missing mode/decision defaults to per_site/undecided; missing fingerprint/replay to off.
  const defaults = recommend(blankEvidence({ device: { canvas: 1 }, replay: { logrocket: 1 } }));
  expect(defaults).toMatchObject({ benefits: [], observed: true });

  // Invalid context values are normalized instead of throwing.
  for (const context of [
    null,
    "junk",
    42,
    { mode: "bogus", decision: "bogus", fingerprintMode: "yes", replayMode: 7, rulesetPrefs: "x" },
  ]) {
    expect(() => loadSiteSignals().engine.recommendationFor(withProbes(20), context)).not.toThrow();
  }
  expect(loadSiteSignals().engine.sanitizePrefs()).toEqual({
    captcha_vendors: false,
    fingerprint_vendors: false,
  });
  expect(
    loadSiteSignals().engine.sanitizePrefs({ captcha_vendors: "yes", fingerprint_vendors: 1 })
  ).toEqual({ captcha_vendors: true, fingerprint_vendors: true });
});

test("recommendationFor: loads without the catalog and degrades safely", () => {
  const { engine } = loadSiteSignals({ catalog: false });
  const strong = withProbes(5000, { ids: 25, vectors: 4 });
  expect(engine.summarizeEvidence(strong)).toBe("5,000 extension checks");
  const recommendation = engine.recommendationFor(strong, recommendationContext());
  expect(recommendation).toMatchObject({ verdict: "protect", confidence: "high" });
  expect(recommendation.benefits[0].text).toContain("5,000 browser extensions");

  const vendorOnly = engine.recommendationFor(
    blankEvidence({ vendors: { fingerprintjs: 1 }, device: { canvas: 1 } }),
    recommendationContext()
  );
  // No catalog means those keys cannot be validated, so the defensive read drops them.
  expect(vendorOnly).toMatchObject({ observed: false, verdict: "neutral" });
  expect(vendorOnly.benefits).toEqual([]);

  // With no catalog loaded there is no key whitelist, so defensive reads drop them.
  expect(engine.evidenceSummaryFor(blankEvidence({ vendors: { fingerprintjs: 2 } }))).toMatchObject(
    {
      vendorKeys: [],
    }
  );
});

// =========================================================================
// bridge.js — scout evidence relay (spec: Bridge additions)
// =========================================================================

test("bridge forwards site_evidence batches to the service worker unchanged", () => {
  const harness = loadBridgeHarness();
  const port = harness.portsByEvent.__perf_scout_bi__;
  expect(port, "bridge must create a port for __perf_scout_bi__").toBeTruthy();

  const probes = [
    { count: 2, url: probeUrlFor(), where: "fetch" },
    { count: 1, url: probeUrlFor(OTHER_EXT_ID, "/icon.png"), where: "img" },
  ];
  const signals = {
    compat: { password_field: 1 },
    device: { canvas: 2 },
    uaReads: 3,
    vendors: { fingerprintjs: 1 },
  };
  port.postMessage({ overflow: 4, probes, seq: 1, signals, type: "site_evidence" });

  const forwarded = harness.messages.filter((message) => message.type === "static_site_evidence");
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]).toEqual({ overflow: 4, probes, signals, type: "static_site_evidence" });
  expect(Object.prototype.hasOwnProperty.call(forwarded[0], "seq")).toBe(false);
});

test("bridge dedupes repeated scout sequences and ignores unknown port messages", () => {
  const harness = loadBridgeHarness();
  const port = harness.portsByEvent.__perf_scout_bi__;
  const batch = (seq) => ({
    overflow: 0,
    probes: [{ count: 1, url: probeUrlFor(), where: "fetch" }],
    seq,
    signals: {},
    type: "site_evidence",
  });

  port.postMessage(batch(1));
  port.postMessage(batch(1));
  port.postMessage(batch(2));
  port.postMessage(batch(1));
  port.postMessage(batch(3.5));
  port.postMessage(batch(3));
  port.postMessage(batch(4));
  port.postMessage({ type: "not_a_scout_message", seq: 99, probes: [] });
  port.postMessage({ type: "site_evidence", seq: 5 });
  port.postMessage("junk");

  let forwarded = harness.messages.filter((message) => message.type === "static_site_evidence");
  // 1, 2, 3.5, 4, and the missing-probes batch (seq 5) are forwarded.
  expect(forwarded).toHaveLength(5);
  expect(forwarded[4].probes).toEqual([]);

  // A later duplicate of an already-forwarded seq is dropped.
  port.postMessage(batch(4));
  forwarded = harness.messages.filter((message) => message.type === "static_site_evidence");
  expect(forwarded).toHaveLength(5);
});

test("bridge forwards scout evidence while the site is paused for masking", async () => {
  const harness = loadBridgeHarness();
  harness.setPersonaResponse({ disabled: true });
  harness.sendRuntimeMessage({ type: "static_persona_update" });
  harness.runTimers();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  harness.runTimers();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  const port = harness.portsByEvent.__perf_scout_bi__;
  port.postMessage({
    overflow: 2,
    probes: [{ count: 1, url: probeUrlFor(), where: "fetch" }],
    seq: 1,
    signals: { uaReads: 1 },
    type: "site_evidence",
  });
  expect(harness.messages.some((message) => message.type === "static_site_evidence")).toBe(true);

  // Masking probe batches are still muted while Static is off on the page.
  port.postMessage({ type: "probe_blocked", url: probeUrlFor(), where: "fetch" });
  harness.dispatchWindow("pagehide");
  harness.runTimers();
  expect(harness.messages.some((message) => message.type === "static_probe_blocked")).toBe(false);
});

test("bridge drains the scout synchronously on pagehide", () => {
  const harness = loadBridgeHarness();
  const port = harness.portsByEvent.__perf_scout_bi__;
  expect(port).toBeTruthy();

  harness.setScoutDrainPayload(
    JSON.stringify({
      overflow: 0,
      probes: [{ count: 2, url: probeUrlFor(), where: "img" }],
      seq: 7,
      signals: { vendors: { fingerprintjs: 1 } },
    })
  );
  harness.dispatchWindow("pagehide");
  harness.runTimers();

  const forwarded = harness.messages.filter((message) => message.type === "static_site_evidence");
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0].probes).toEqual([{ count: 2, url: probeUrlFor(), where: "img" }]);
  // The port copy of the same drained batch must not double any delta.
  port.postMessage({
    overflow: 0,
    probes: [{ count: 2, url: probeUrlFor(), where: "img" }],
    seq: 7,
    signals: { vendors: { fingerprintjs: 1 } },
  });
  expect(
    harness.messages.filter((message) => message.type === "static_site_evidence")
  ).toHaveLength(1);

  harness.setScoutDrainPayload("not json");
  harness.dispatchWindow("pagehide");
  harness.runTimers();
  expect(
    harness.messages.filter((message) => message.type === "static_site_evidence")
  ).toHaveLength(1);
});

test("bridge scout relay does not disturb the v2.7 probe pipeline", () => {
  const harness = loadBridgeHarness();
  expect(Object.keys(harness.portsByEvent).sort()).toEqual(
    [
      "__perf_adaptive_bi__",
      "__perf_decoy_bi__",
      "__perf_fingerprint_bi__",
      "__perf_globals_bi__",
      "__perf_iframe_bi__",
      "__perf_noise_bi__",
      "__perf_probe_bi__",
      "__perf_replay_bi__",
      "__perf_scout_bi__",
      "__perf_style_bi__",
      "__perf_ua_bi__",
    ].sort()
  );

  const noisePort = harness.portsByEvent.__perf_noise_bi__;
  noisePort.postMessage({ type: "probe_blocked", url: probeUrlFor(), where: "fetch" });
  noisePort.postMessage({ type: "site_evidence", probes: [], seq: 1 });
  harness.dispatchWindow("pagehide");
  harness.runTimers();
  const probeMessages = harness.messages.filter(
    (message) => message.type === "static_probe_blocked"
  );
  expect(probeMessages).toHaveLength(1);
  expect(probeMessages[0].delta).toBe(1);
  expect(probeMessages[0].deltaIdCounts[KNOWN_EXT_ID]).toBe(1);
});

// =========================================================================
// Packaging — import order, Firefox build, e2e list, extension pages
// =========================================================================

const serviceWorkerImportScripts = () => {
  const source = readText("service_worker.js");
  const match = source.match(/importScripts\(([\s\S]*?)\);/);
  expect(match, "service_worker.js must importScripts its dependencies").toBeTruthy();
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
};

test("service worker imports the shared modules in contract order", () => {
  expect(serviceWorkerImportScripts()).toEqual([
    "lists.js",
    "signals.js",
    "site_signals.js",
    "site_dnr.js",
    "service_worker_utils.js",
  ]);
});

test("Firefox build lists the new background scripts in the same order", () => {
  const source = readText("build-firefox.js");
  const match = source.match(/fxManifest\.background\.scripts\s*=\s*\[([\s\S]*?)\];/);
  expect(match, "build-firefox.js must set background.scripts").toBeTruthy();
  const scripts = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  expect(scripts).toEqual([
    "lists.js",
    "signals.js",
    "site_signals.js",
    "site_dnr.js",
    "service_worker_utils.js",
    "service_worker.js",
  ]);
  expect(scripts).toContain("service_worker.js");
});

test("site_dnr.js copies rule conditions instead of hardcoding Firefox-stripped types", () => {
  const source = readText("site_dnr.js");
  expect(source.includes("webtransport")).toBe(false);
  expect(source.includes("webbundle")).toBe(false);
  expect(source.includes("resourceTypes:")).toBe(false);
});

test("manifest, package metadata and the latest changelog release agree on 2.8.1", () => {
  const version = latestChangelogReleaseVersion();
  expect(version).toBe("2.8.1");
  expect(readJson("manifest.json").version).toBe(version);
  expect(readJson("package.json").version).toBe(version);
  expect(readJson("package-lock.json").version).toBe(version);
  expect(readJson("package-lock.json").packages[""].version).toBe(version);
});

test("tests/e2e-specs.txt lists every browser spec exactly once", () => {
  const listed = readText("tests/e2e-specs.txt")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  expect(new Set(listed).size).toBe(listed.length);
  for (const filePath of listed) {
    expect(fs.existsSync(path.join(repoRoot, filePath)), filePath).toBe(true);
  }
  const excluded = new Set(["tests/static-validation.spec.js", "tests/real-site-breakage.spec.js"]);
  const expected = fs
    .readdirSync(path.join(repoRoot, "tests"))
    .filter((file) => file.endsWith(".spec.js"))
    .map((file) => `tests/${file}`)
    .filter((filePath) => !excluded.has(filePath))
    .sort();
  expect([...listed].sort()).toEqual(expected);
  for (const required of [
    "tests/scout.spec.js",
    "tests/site-decisions.spec.js",
    "tests/popup-decisions.spec.js",
    "tests/sites-page.spec.js",
    "tests/ruleset-scoping.spec.js",
  ]) {
    expect(listed).toContain(required);
  }
});

test("the disabled page is fully renamed to the sites page", () => {
  expect(fs.existsSync(path.join(repoRoot, "sites.html"))).toBe(true);
  expect(fs.existsSync(path.join(repoRoot, "sites.js"))).toBe(true);
  expect(fs.existsSync(path.join(repoRoot, "disabled.html"))).toBe(false);
  expect(fs.existsSync(path.join(repoRoot, "disabled.js"))).toBe(false);

  const popupHtml = readText("popup.html");
  const popupJs = readText("popup.js");
  expect(popupHtml).not.toMatch(/\bid="view-disabled"/);
  expect(popupHtml).not.toMatch(/\bid="disabled-stats"/);
  expect(popupHtml).toMatch(/\bid="view-sites"/);
  expect(popupHtml).toMatch(/\bid="sites-stats"/);
  expect(popupHtml).not.toContain("View disabled sites");
  expect(popupHtml).toContain("Manage protected sites");
  expect(popupJs).toContain("sites.html");
  expect(popupJs).not.toContain("disabled.html");

  // Runtime code must not reference the removed page at all.
  for (const fileName of ["popup.html", "popup.js", "sites.html", "sites.js"]) {
    expect(readText(fileName), fileName).not.toMatch(/["'(]disabled\.(html|js)["')]/);
  }
  expect(readText("README.md")).not.toMatch(/disabled\.html/);
  expect(readText("README.md")).toContain("sites.html");
});

test("popup keeps the v2.7 always-mode surface and adds the per-site ids", () => {
  const popupHtml = readText("popup.html");
  const popupJs = readText("popup.js");
  for (const id of [
    // v2.7 always-mode controls and their existing copy/ids.
    "count",
    "cumulative",
    "site-control",
    "site-toggle",
    "site-title-text",
    "site-status-text",
    "recovery",
    "recovery-title",
    "recovery-detail",
    "recovery-action",
    "rulesets",
    "rulesets-paused-note",
    "noise-toggle",
    "fingerprint-mode",
    "replay-mode",
    "diagnostics-toggle",
    "research-logging-toggle",
    "view-log",
    "advanced-controls",
    // v2.8 additions.
    "count-label",
    "count-subtext",
    "site-decision",
    "site-decision-title",
    "site-state",
    "site-verdict",
    "site-headline",
    "site-summary",
    "site-summary-text",
    "site-caution",
    "site-reasons",
    "site-cta",
    "site-protect",
    "site-leave-off",
    "site-turn-off",
    "site-note",
    "mode-section",
    "mode-row",
    "mode-per-site",
    "mode-always",
    "mode-explainer",
    "mode-note",
    "onboarding",
    "onboarding-title",
    "onboarding-dismiss",
    "onboarding-always",
    "onboarding-note",
    "recovery-section",
    "view-sites",
    "sites-stats",
  ]) {
    expect(popupHtml, `popup.html#${id}`).toContain(`id="${id}"`);
  }
  expect(popupJs).toContain("static_set_site_decision");
  expect(popupJs).toContain("static_set_protection_mode");
  expect(popupJs).toContain("static_dismiss_onboarding");
  expect(popupHtml).toContain('id="mode-per-site"');
  expect(popupHtml).toContain('id="mode-always"');
  expect(popupHtml).toContain("Only sites I choose");
  expect(popupHtml).toContain("Every site");
});

test("sites page exposes the documented rows, actions and mode controls", () => {
  const sitesHtml = readText("sites.html");
  const sitesJs = readText("sites.js");
  for (const id of [
    "search",
    "summary",
    "section-on",
    "section-off",
    "section-seen",
    "section-paused",
    "clear-seen",
    "clear-all",
    "mode-per-site",
    "mode-always",
  ]) {
    expect(sitesHtml, `sites.html#${id}`).toContain(`id="${id}"`);
  }
  for (const action of ["protect", "unprotect", "leave-off", "enable"]) {
    expect(sitesJs).toContain(`"${action}"`);
  }
  for (const messageType of [
    "static_get_sites_overview",
    "static_set_site_decision",
    "static_set_protection_mode",
    "static_clear_site_decisions",
    "static_set_site_disabled",
  ]) {
    expect(sitesJs, messageType).toContain(messageType);
  }
  // Rows are built at runtime from the overview payload.
  expect(sitesJs).toContain("dataset.action");
  expect(sitesJs).toContain("dataset.site");
  expect(sitesJs).toContain("dataset.state");
  expect(sitesJs).toContain("data-armed");
  expect(sitesJs).toContain("storage.onChanged");
});

// =========================================================================
// Docs <-> engine contract (spec: Appendix A)
// =========================================================================

const docMarkdownLines = () => readText("docs/site-protection.md").split("\n");

const markdownTableAfter = (headingPrefix) => {
  const lines = docMarkdownLines();
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start < 0) throw new Error(`Missing doc heading: ${headingPrefix}`);
  const tableLines = [];
  let seenTable = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("|")) {
      tableLines.push(line);
      seenTable = true;
      continue;
    }
    if (seenTable) break;
  }
  expect(tableLines.length, headingPrefix).toBeGreaterThan(2);
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim().replace(/\\/g, "").replace(/^`|`$/g, ""));
  const header = cells(tableLines[0]);
  const rows = tableLines.slice(2).map((line) => {
    const values = cells(line);
    return Object.fromEntries(header.map((key, index) => [key, values[index]]));
  });
  return rows;
};

const docVendorRows = () =>
  [
    ["### vendors — device fingerprinting", "fingerprint"],
    ["### vendors — bot management", "bot"],
    ["### vendors — payment, identity", "payment"],
    ["### vendors — CAPTCHA", "captcha"],
  ].flatMap(([heading, kind]) =>
    markdownTableAfter(heading).map((row) => ({
      ...row,
      domains: row.domains === "—" ? [] : row.domains.split(",").map((domain) => domain.trim()),
      globals: row.globals === "—" ? [] : row.globals.split(",").map((name) => name.trim()),
      kind,
      risk: row.risk === "—" || !row.risk ? null : Number(row.risk),
      weight: Number(row.weight),
    }))
  );

test("Appendix A vendor table matches signals.js exactly", () => {
  const { catalog } = loadCatalog();
  const documented = docVendorRows().sort((a, b) => a.id.localeCompare(b.id));
  expect(documented).toHaveLength(56);
  const actual = catalog.vendors
    .map((row) => ({ ...row, risk: row.risk == null ? null : row.risk }))
    .sort((a, b) => a.id.localeCompare(b.id));
  expect(actual.map((row) => row.id)).toEqual(documented.map((row) => row.id));
  expect(actual.map((row) => row.kind)).toEqual(documented.map((row) => row.kind));
  expect(actual.map((row) => row.label)).toEqual(documented.map((row) => row.label));
  expect(actual.map((row) => row.weight)).toEqual(documented.map((row) => row.weight));
  expect(actual.map((row) => row.risk)).toEqual(documented.map((row) => row.risk));
  for (const row of actual) {
    const docRow = documented.find((candidate) => candidate.id === row.id);
    expect(row.domains, row.id).toEqual(docRow.domains);
    expect(row.globals, row.id).toEqual(docRow.globals);
  }
});

test("Appendix A device table matches signals.js exactly", () => {
  const { catalog } = loadCatalog();
  const documented = markdownTableAfter("### device").map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    weight: Number(row.weight),
  }));
  const actual = catalog.device.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    weight: row.weight,
  }));
  expect(documented).toHaveLength(17);
  expect(actual).toEqual(documented);
});

test("Appendix A replay table matches signals.js exactly", () => {
  const { catalog } = loadCatalog();
  const documented = markdownTableAfter("### replay").map((row) => ({
    domains: row.domains.split(",").map((domain) => domain.trim()),
    globals: row.globals.split(",").map((name) => name.trim()),
    id: row.id,
    label: row.label,
    weight: Number(row.weight),
  }));
  const actual = catalog.replay.map((row) => ({
    domains: row.domains,
    globals: row.globals,
    id: row.id,
    label: row.label,
    weight: row.weight,
  }));
  expect(documented).toHaveLength(18);
  expect(actual).toEqual(documented);
});

test("Appendix A compat risk table matches signals.js exactly", () => {
  const { catalog } = loadCatalog();
  const documented = markdownTableAfter("### compat").map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    risk: Number(row.risk),
  }));
  const actual = catalog.compat.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    risk: row.risk,
  }));
  expect(documented).toHaveLength(12);
  expect(actual).toEqual(documented);
});

test("Appendix A vector list matches the canonical signals.js vectors", () => {
  const source = readText("docs/site-protection.md");
  const heading = source.indexOf("### vectors");
  expect(heading).toBeGreaterThanOrEqual(0);
  const block = source.slice(heading).match(/```text\n([\s\S]*?)```/);
  expect(block, "vectors code block").toBeTruthy();
  const documented = block[1]
    .trim()
    .split(",")
    .map((vector) => vector.trim());
  const { catalog } = loadCatalog();
  expect(documented).toEqual(CANONICAL_VECTORS);
  expect(catalog.vectors).toEqual(CANONICAL_VECTORS);
});

test("README and the design doc agree with the shipped site-suffix list", () => {
  const readme = readText("README.md");
  const doc = readText("docs/site-protection.md");
  const lists = readText("lists.js");
  // site123.me was in the design sketch but not in the shipped heuristic.
  expect(`${readme}\n${doc}`.includes("site123.me")).toBe(lists.includes("site123.me"));
  expect(readme).toContain("sites.html");
  expect(doc).toContain("sites.html");
  expect(readme).not.toMatch(/disabled\.html/);
  expect(`${readme}\n${doc}`).toContain("per_site");
});
