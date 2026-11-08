/* global messageHandlers, writeChain */
const { chromium } = require("@playwright/test");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(__dirname, "..", "..");

// Every browser spec runs on a fixture origin (127.0.0.1) plus a fake host
// name so the same server can stand in for a second site. Fixture hosts are
// mapped to loopback at launch; virtual-host tests navigate to
// http://a.static-fixture.test:<port> and the fixture server answers because it
// only looks at the request path.
const DEFAULT_HOST_RESOLVER_RULES =
  "MAP *.static-fixture.test 127.0.0.1, MAP static-fixture.test 127.0.0.1";
const HOST_RESOLVER_ARG = "--host-resolver-rules=";

// Callers may pass their own mappings (e.g. the bot-frame specs map
// vendor.test); merge them instead of letting --host-resolver-rules win or
// lose the whole mapping list.
const withHostResolverRules = (args) => {
  const extraRules = args
    .filter((arg) => arg.startsWith(HOST_RESOLVER_ARG) && arg.length > HOST_RESOLVER_ARG.length)
    .map((arg) => arg.slice(HOST_RESOLVER_ARG.length));
  const rest = args.filter((arg) => !arg.startsWith(HOST_RESOLVER_ARG));
  return [
    ...rest,
    `${HOST_RESOLVER_ARG}${[DEFAULT_HOST_RESOLVER_RULES, ...extraRules].join(", ")}`,
  ];
};

// Pause-list and feature settings re-register Static's content scripts
// asynchronously (syncContentScripts in service_worker.js). Every
// service-worker evaluate waits for that, so a test can navigate right after
// changing a setting.
const waitForContentScripts = (evaluate) =>
  evaluate(async () => {
    const utils = globalThis.__static_sw_utils__;
    const deadline = Date.now() + 5000;
    for (;;) {
      const settings = await chrome.storage.local.get(utils.CONTENT_SCRIPT_SETTINGS);
      const registered = await chrome.scripting.getRegisteredContentScripts();
      if (utils.contentScriptsInSync(registered, utils.contentScriptRegistrationsFor(settings))) {
        return;
      }
      if (Date.now() > deadline) throw new Error("Static content scripts did not sync");
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  });

// The v2.8 default is per_site; the 27 pre-existing specs (and everything that
// does not opt into scout-only pages) keep the v2.7 full stack by seeding
// protection_mode=always once the worker is up. The wrapped evaluate above
// makes this wait for the matching content-script registration.
const seedAlwaysMode = async (serviceWorker) => {
  await serviceWorker.evaluate(() => chrome.storage.local.set({ protection_mode: "always" }));
  const ids = await serviceWorker.evaluate(async () =>
    (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id)
  );
  const missing = ["a-main", "b-isolated"].filter((id) => !ids.includes(id));
  if (missing.length > 0 || ids.includes("c-scout-main")) {
    throw new Error(
      `Static did not settle on always-mode content scripts: registered [${ids.join(", ")}]`
    );
  }
};

// Static script files on the stack of errors raised through APIs that Static
// wraps. Wrappers stay on the stack in pass-through mode, so only a page that
// never loaded Static's code comes back empty.
const staticPageTraces = (page) =>
  page.evaluate(async () => {
    const staticFilesIn = (fn) => {
      try {
        fn();
      } catch (error) {
        return [
          ...String(error.stack).matchAll(/chrome-extension:\/\/[a-p]{32}\/([\w.]+\.js)/g),
        ].map((match) => match[1]);
      }
      return [];
    };
    const thrower = {
      toString() {
        throw new Error("probe");
      },
    };
    let rtcWithoutNewThrows = false;
    try {
      RTCPeerConnection();
    } catch {
      rtcWithoutNewThrows = true;
    }
    const platformGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform").get;
    const timer = await new Promise((resolve) => {
      setTimeout(() => resolve(staticFilesIn(() => null.x)), 0);
    });
    return {
      dom: staticFilesIn(() => document.documentElement.setAttribute("data-probe", thrower)),
      platformGetter: staticFilesIn(() => platformGetter.call({})),
      rtcWithoutNewThrows,
      timer,
    };
  });

// ─── Storage helpers ───────────────────────────────────────────────────────
// All of these go through the wrapped evaluate, so the registrations (and the
// settings they encode) have been applied by the time the helper resolves.

const setStorage = (extension, values) =>
  extension.serviceWorker.evaluate((stored) => chrome.storage.local.set(stored), values);

const setProtectionMode = (extension, mode) => setStorage(extension, { protection_mode: mode });

const setSiteDecision = (extension, site, state) =>
  extension.serviceWorker.evaluate(
    async ({ siteKey, decisionState }) => {
      const { site_decisions = {} } = await chrome.storage.local.get({ site_decisions: {} });
      const decisions = { ...site_decisions };
      if (decisionState === "clear") {
        delete decisions[siteKey];
      } else {
        decisions[siteKey] = { at: Date.now(), source: "popup", state: decisionState };
      }
      await chrome.storage.local.set({ site_decisions: decisions });
    },
    { decisionState: state, siteKey: site }
  );

const siteEvidence = (extension, site) =>
  extension.serviceWorker.evaluate(
    async (siteKey) =>
      (await chrome.storage.local.get({ site_evidence: {} })).site_evidence[siteKey] || null,
    site
  );

// Fresh profile state for one test; mode falls back to the extension default.
const clearStorage = (extension) =>
  extension.serviceWorker.evaluate(() => chrome.storage.local.clear());

// The pre-v2.8 test baseline: everything cleared except "mask everywhere".
const resetStorage = async (extension) => {
  await extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ protection_mode: "always" });
  });
};

// ─── Service-worker inspection helpers ─────────────────────────────────────

const callMessageHandler = (extension, name, payload = {}, sender = {}) =>
  extension.serviceWorker.evaluate(
    ({ handlerName, message, messageSender }) =>
      new Promise((resolve, reject) => {
        const handler = messageHandlers[handlerName];
        if (typeof handler !== "function") {
          reject(new Error(`Unknown Static message handler: ${handlerName}`));
          return;
        }
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          if (!settled) reject(new Error(`Static message handler timed out: ${handlerName}`));
        }, 10_000);
        const result = handler({ ...message, type: handlerName }, messageSender, (value) =>
          finish(value)
        );
        if (result && typeof result.then === "function") {
          result.then(finish, (error) => {
            clearTimeout(timer);
            reject(error);
          });
          return;
        }
        if (result !== undefined && typeof result !== "boolean") {
          finish(result);
          return;
        }
        if (handler.length < 3) {
          // Fire-and-forget listener (no sendResponse): settle once the
          // serialized storage write chain it may have queued is idle.
          const chain = typeof writeChain === "undefined" ? Promise.resolve() : writeChain;
          Promise.resolve(chain).then(() => finish(undefined), reject);
        }
      }),
    { handlerName: name, message: payload, messageSender: sender }
  );

const getDetails = (extension, tabId) =>
  callMessageHandler(extension, "static_get_details", { tabId });

const registeredScripts = (extension) =>
  extension.serviceWorker.evaluate(async () =>
    (await chrome.scripting.getRegisteredContentScripts()).map((script) => ({
      allFrames: !!script.allFrames,
      excludeMatches: script.excludeMatches || [],
      id: script.id,
      js: (script.js || []).map((file) => file.replace(/^\//, "")),
      matches: script.matches || [],
      runAt: script.runAt || "document_idle",
      world: script.world || "ISOLATED",
    }))
  );

const tabIdForUrl = (extension, url) =>
  extension.serviceWorker.evaluate(
    async (targetUrl) => (await chrome.tabs.query({ url: targetUrl }))[0]?.id ?? null,
    url
  );

// Device signal poisoning loads its script on the next page load and gets its
// persona asynchronously. Reload, then ask every tab to refresh its persona:
// the bridge replies only after the page scripts have the new config.
const enableFingerprintMask = async (extension, page) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask" })
  );
  await page.reload();
  await extension.serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? null
          : chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {})
      )
    );
  });
};

async function launchExtension({ args = [] } = {}) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "static-profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-sandbox",
      ...withHostResolverRules(args),
    ],
  });

  let serviceWorker = context
    .serviceWorkers()
    .find((worker) => worker.url().endsWith("/service_worker.js"));
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", {
      predicate: (worker) => worker.url().endsWith("/service_worker.js"),
      timeout: 10_000,
    });
  }

  const evaluate = serviceWorker.evaluate.bind(serviceWorker);
  serviceWorker.evaluate = async (...args) => {
    const result = await evaluate(...args);
    await waitForContentScripts(evaluate);
    return result;
  };
  await waitForContentScripts(evaluate);
  await seedAlwaysMode(serviceWorker);

  const extensionId = new URL(serviceWorker.url()).host;

  return {
    context,
    extensionId,
    serviceWorker,
    async close() {
      await context.close();
      await fs.rm(userDataDir, { recursive: true, force: true });
    },
  };
}

module.exports = {
  callMessageHandler,
  clearStorage,
  enableFingerprintMask,
  extensionPath,
  getDetails,
  launchExtension,
  registeredScripts,
  resetStorage,
  setProtectionMode,
  setSiteDecision,
  setStorage,
  siteEvidence,
  staticPageTraces,
  tabIdForUrl,
};
