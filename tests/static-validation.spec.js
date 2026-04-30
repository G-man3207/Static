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
  const context = vm.createContext({});
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
  const context = vm.createContext({
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
            return Promise.resolve({ ids: [], noiseEnabled: false, replayMode: "off" });
          }
          return Promise.resolve({ ok: true });
        },
      },
    },
    document: {
      visibilityState: "visible",
      addEventListener: (type, fn) => addListener(documentListeners, type, fn),
      dispatchEvent(event) {
        if (event && event.ports && event.ports[0]) portsByEvent[event.type] = event.ports[0];
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
  });
  vm.runInContext(readText("lists.js"), context);
  vm.runInContext(readText("bridge.js"), context);
  return {
    messages,
    portsByEvent,
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

const addContentScriptFiles = (manifest, referencedFiles) => {
  for (const script of manifest.content_scripts || []) {
    for (const js of script.js || []) referencedFiles.add(js);
  }
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
  addContentScriptFiles(manifest, referencedFiles);
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
  const referencedFiles = new Set(["log.html", "popup.html"]);
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

const expectContentScriptWorlds = (manifest) => {
  const mainWorld = manifest.content_scripts.find((script) => script.world === "MAIN");
  const isolatedWorld = manifest.content_scripts.find((script) => script.world === "ISOLATED");

  expect(mainWorld.js).toEqual(expectedMainWorldScripts);
  expect(isolatedWorld.js).toEqual(["lists.js", "bridge.js", "dom_scrubber.js"]);
  expect(mainWorld.run_at).toBe("document_start");
  expect(isolatedWorld.run_at).toBe("document_start");
  expect(mainWorld.all_frames).toBe(true);
  expect(isolatedWorld.all_frames).toBe(true);
};

test("manifest references existing files and keeps content-script worlds separated", () => {
  const manifest = readJson("manifest.json");
  expectManifestFilesToExist(manifest);
  expectContentScriptWorlds(manifest);
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
  expect(manifest.permissions.sort()).toEqual(["declarativeNetRequest", "storage"]);
  expect(manifest.host_permissions || []).toEqual([]);
  expect(manifest.optional_host_permissions || []).toEqual([]);
  expect(manifest.web_accessible_resources || []).toEqual([]);
  expect(manifest.externally_connectable).toBeUndefined();
});

test("extension runtime code stays local-only", () => {
  const runtimeFiles = [
    ...collectManifestFiles(readJson("manifest.json")),
    ...collectExtensionPageFiles(),
    "log_diagnostics.js",
    "popup.js",
    "log.js",
  ].filter((filePath) => filePath.endsWith(".js") || filePath.endsWith(".html"));
  const uniqueFiles = [...new Set(runtimeFiles)];

  for (const filePath of uniqueFiles) {
    const source = readText(filePath);
    expect(source, `${filePath}: must not use synced storage`).not.toMatch(/chrome\.storage\.sync/);
    if (filePath.endsWith(".js")) {
      expect(source, `${filePath}: must not contain remote endpoints`).not.toMatch(
        /https?:\/\/(?!www\.w3\.org\/2000\/svg)/
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
  const port = harness.portsByEvent.__static_noise_bridge_init__;
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
  const port = harness.portsByEvent.__static_noise_bridge_init__;
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

  for (const filter of [
    "||api.fpjs.io^",
    "||api.fpjs.pro^",
    "||botguard.net^",
    "||castle.io^",
    "||cheqzone.com^",
    "||datadome.co^",
    "||fpcdn.io^",
    "||fpjs.io^",
    "||fpjscdn.net^",
    "||fpnpmcdn.net^",
    "||fptls.com^",
    "||fptls2.com^",
    "||fptls3.com^",
    "||fptls4.com^",
    "||geetest.com^",
    "||openfpcdn.io^",
    "||perimeterx.net^",
    "||px-cdn.net^",
    "||px-cloud.net^",
    "||pxchk.net^",
    "||px-client.net^",
    "||cdn.sift.com^",
    "||api.sift.com^",
    "||siftscience.com^",
  ]) {
    expect(fingerprintFilters.has(filter), `fingerprint_vendors missing ${filter}`).toBe(true);
  }
});

test("fingerprint DNR connection rules include persistent transport resource types", () => {
  for (const filePath of ["rules/captcha_vendors.json", "rules/fingerprint_vendors.json"]) {
    for (const rule of readJson(filePath)) {
      const resourceTypes = rule.condition && rule.condition.resourceTypes;
      if (!Array.isArray(resourceTypes)) continue;
      if (!resourceTypes.includes("xmlhttprequest") && !resourceTypes.includes("ping")) continue;
      expect(resourceTypes, `${filePath}: rule ${rule.id}`).toEqual(
        expect.arrayContaining(["websocket", "webtransport"])
      );
    }
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
