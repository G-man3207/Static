const { chromium } = require("@playwright/test");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(__dirname, "..", "..");

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
      ...args,
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
  enableFingerprintMask,
  extensionPath,
  launchExtension,
  staticPageTraces,
};
