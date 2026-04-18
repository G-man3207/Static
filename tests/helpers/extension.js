const { chromium } = require("@playwright/test");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(__dirname, "..", "..");

async function launchExtension() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "static-profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-sandbox",
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
  extensionPath,
  launchExtension,
};
