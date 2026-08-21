#!/usr/bin/env node
// tests/firefox-smoke.js — Selenium-based Firefox smoke test.
//
// Verifies the Firefox extension build loads without errors, content scripts
// inject into real HTTP pages, and the background responds via the popup.
//
// Run via:
//   xvfb-run -a node tests/firefox-smoke.js [path-to-firefox-zip]
//
// Requirements: geckodriver on PATH, Firefox installed, xvfb for headless.
// The script builds the Firefox zip if no path is provided.

const path = require("path");
const fs = require("fs");
const http = require("http");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

// --- Helpers ---

function log(msg) {
  // Flush so a timeout still shows progress.
  process.stdout.write(`[firefox-smoke] ${msg}\n`);
}

function fail(msg) {
  console.error(`[firefox-smoke] FAIL: ${msg}`);
  process.exit(1);
}

function buildFirefoxZip() {
  log("Building Firefox zip…");
  const zipPath = path.join(REPO_ROOT, "static-firefox-smoke.zip");
  execSync(`node "${path.join(REPO_ROOT, "build-firefox.js")}" "${zipPath}"`, {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  return zipPath;
}

function extractZip(zipPath) {
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "static-fxsmoke-"));
  execSync(`unzip -q "${zipPath}" -d "${tmpDir}"`, { stdio: "pipe" });
  return tmpDir;
}

/** Locate a Firefox binary on this system. */
function findFirefoxBinary() {
  const candidates = [
    "/opt/firefox/firefox",
    "/usr/bin/firefox",
    "/usr/bin/firefox-esr",
    "/snap/bin/firefox",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try PATH.
  try {
    return execSync("which firefox", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Spin up a minimal HTTP server returning a page that the extension's
 *  content scripts will match (<all_urls> = http/https/file/ftp).
 *  Returns { server, url }. */
function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<!DOCTYPE html><html><head><title>Smoke</title></head>` +
          `<body><h1 id="target">Hello</h1></body></html>`
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

/**
 * Scrape the real moz-extension:// UUID for a temporary add-on from the
 * about:debugging page.  Temporary addons get a random internal UUID —
 * it does NOT match the manifest's gecko.id.
 *
 * Uses getPageSource() + Node-side regex because about:debugging is a
 * privileged parent-process context where executeScript is forbidden.
 */
async function scrapeExtensionUuid(driver, extensionName) {
  await driver.get("about:debugging#/runtime/this-firefox");
  // Wait for the extension list to populate.
  await driver.sleep(4000);

  // getPageSource works on privileged pages; executeScript does not.
  const html = await driver.getPageSource();

  // Find all moz-extension://UUID/ references in the page source.
  const allUuids = new Set();
  const re = /moz-extension:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//g;
  let m;
  while ((m = re.exec(html)) !== null) {
    allUuids.add(m[1]);
  }

  if (allUuids.size === 0) {
    log("WARNING: No moz-extension:// UUIDs found in about:debugging source");
    return null;
  }

  // If there's only one extension installed, it's ours.
  if (allUuids.size === 1) {
    return [...allUuids][0];
  }

  // Multiple extensions — try to narrow by looking for the name near a UUID.
  for (const uuid of allUuids) {
    // Check if the extension name appears near this UUID in the HTML.
    const idx = html.indexOf(uuid);
    const surrounding = html.substring(Math.max(0, idx - 500), idx + 100);
    if (surrounding.includes(extensionName)) {
      return uuid;
    }
  }

  // Fallback: return the first UUID (likely ours since we just installed).
  log("WARNING: Could not match UUID by name, returning first UUID found");
  return [...allUuids][0];
}

/**
 * Verify the extension background is alive by loading its popup page.
 * popup.js calls chrome.runtime.sendMessage internally — a dead background
 * (e.g. importScripts crash) surfaces as a popup that never renders content.
 */
async function verifyPopup(driver, extUuid) {
  log("Loading extension popup to verify background is alive…");
  const popupUrl = `moz-extension://${extUuid}/popup.html`;
  log(`Popup URL: ${popupUrl}`);
  await driver.get(popupUrl);
  await driver.sleep(3000);

  const popupTitle = await driver.executeScript("return document.title");
  const popupBody = await driver.executeScript(
    "return document.body ? document.body.innerText.slice(0, 500) : ''"
  );
  log(`Popup title: "${popupTitle}"`);
  log(`Popup body (first 200 chars): "${popupBody.slice(0, 200)}"`);

  if (!popupBody || popupBody.trim().length < 5) {
    fail("Popup body is empty — background may be dead (importScripts crash?)");
  }
  // popup.js fills the UI via chrome.runtime.sendMessage to the background.
  // A dead event page still serves popup.html static shell but leaves counters empty.
  if (!/probes blocked/i.test(popupBody)) {
    fail(
      "Popup did not render live status text — background messaging may have failed. " +
        `Body: ${popupBody.slice(0, 200)}`
    );
  }
  log("Popup rendered content — background is alive");
}

/**
 * Assert MAIN-world scripts injected (globals scrub + fetch probe block).
 *
 * Globals probe runs inside a classic <script> tag so it executes in the page's
 * true MAIN world. Firefox WebDriver's executeScript uses Xray wrappers that can
 * call the pristine Object.defineProperty and falsely look like a miss.
 */
async function verifyContentScripts(driver) {
  const globalsProbe = await driver.executeScript(`
    const script = document.createElement("script");
    script.textContent = [
      "(function () {",
      "  try {",
      '    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {',
      "      value: { __static_smoke: true },",
      "      configurable: true,",
      "      writable: true,",
      "      enumerable: false",
      "    });",
      '    window.__static_smoke_globals = {',
      "      ok: true,",
      "      typeofHook: typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__,",
      "      definePropertyLooksNative: Function.prototype.toString",
      "        .call(Object.defineProperty)",
      '        .indexOf("[native code]") !== -1',
      "    };",
      "  } catch (e) {",
      '    window.__static_smoke_globals = {',
      "      ok: false,",
      "      error: String(e && e.message ? e.message : e)",
      "    };",
      "  }",
      "})();",
    ].join("\\n");
    document.documentElement.appendChild(script);
    script.remove();
    const result = window.__static_smoke_globals;
    try {
      delete window.__static_smoke_globals;
    } catch (_) {}
    return result;
  `);
  log(`Globals probe: ${JSON.stringify(globalsProbe)}`);
  if (!globalsProbe || !globalsProbe.ok) {
    fail(`Content-script globals probe failed: ${JSON.stringify(globalsProbe)}`);
  }
  if (globalsProbe.typeofHook !== "undefined") {
    fail(
      "MAIN-world content scripts did not inject: " +
        `__REACT_DEVTOOLS_GLOBAL_HOOK__ is ${globalsProbe.typeofHook} (expected undefined). ` +
        "block_globals.js should have scrubbed the assignment."
    );
  }
  if (!globalsProbe.definePropertyLooksNative) {
    fail("Object.defineProperty toString lost native stealth appearance");
  }
  log("MAIN-world content scripts injected — OK");

  // fetch is looked up on the page global, so WebDriver sees Static's patch.
  const fetchProbe = await driver.executeScript(`
    return fetch("chrome-extension://nngceckbapebfimnlniiiahkandclblb/manifest.json").then(
      () => ({ status: "resolved" }),
      (e) => ({ status: "rejected", name: e && e.name, message: e && e.message })
    );
  `);
  log(`Fetch probe: ${JSON.stringify(fetchProbe)}`);
  if (fetchProbe.status !== "rejected") {
    fail(`Expected chrome-extension fetch to be rejected, got: ${JSON.stringify(fetchProbe)}`);
  }
  if (fetchProbe.name !== "TypeError") {
    fail(`Expected TypeError from blocked fetch, got ${fetchProbe.name}: ${fetchProbe.message}`);
  }
  if (!/failed to fetch/i.test(fetchProbe.message || "")) {
    fail(`Expected "Failed to fetch" message, got: ${fetchProbe.message}`);
  }
  log("Extension-scheme fetch probe blocked — OK");
}

function createFirefoxDriver() {
  let webdriver;
  let firefox;
  try {
    webdriver = require("selenium-webdriver");
    firefox = require("selenium-webdriver/firefox");
  } catch {
    fail("selenium-webdriver not installed. Run: npm install --save-dev selenium-webdriver");
  }

  const firefoxBinary = findFirefoxBinary();
  if (!firefoxBinary) {
    fail("Firefox binary not found. Install Firefox or set PATH.");
  }
  log(`Firefox binary: ${firefoxBinary}`);

  const options = new firefox.Options();
  options.setBinary(firefoxBinary);
  // Firefox 153+ restricts WebDriver navigation to http(s)/file/blob/about:blank
  // unless system access is enabled. about:debugging and moz-extension:// popup
  // checks need this flag (see Mozilla bug 1579790).
  options.addArguments("--remote-allow-system-access");
  // Extensions are unreliable in Firefox headless — CI wraps with xvfb-run.
  options.setPreference("extensions.autoDisableScopes", 0);
  options.setPreference("extensions.enabledScopes", 15);
  options.setPreference("browser.startup.homepage_override.mstone", "ignore");
  options.setPreference("browser.startup.page", 0);
  options.setPreference("browser.shell.checkDefaultBrowser", false);
  options.setPreference("browser.aboutwelcome.enabled", false);
  options.addArguments("--no-remote");

  const service = new firefox.ServiceBuilder().addArguments("--log", "debug");
  return new webdriver.Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();
}

async function runSmokeSession(driver, extDir) {
  log("Installing extension as temporary add-on…");
  await driver.installAddon(extDir, true);

  // Temporary addons get a random UUID — not the manifest gecko.id.
  log("Discovering extension UUID from about:debugging…");
  const extUuid = await scrapeExtensionUuid(driver, "Static");
  if (!extUuid) {
    fail("Could not find extension UUID in about:debugging. Extension may not have loaded.");
  }
  log(`Extension UUID: ${extUuid}`);

  const testServer = await startTestServer();
  log(`Test server at ${testServer.url}`);

  try {
    log("Navigating to HTTP test page (content script injection)…");
    await driver.get(testServer.url);
    await driver.sleep(2000);

    const pageTitle = await driver.getTitle();
    if (pageTitle !== "Smoke") {
      fail(`Expected page title "Smoke" after content script injection, got "${pageTitle}"`);
    }
    log("Page survived navigation — OK");

    await verifyContentScripts(driver);
    await verifyPopup(driver, extUuid);
    log("\nAll smoke checks passed.");
  } finally {
    testServer.server.close();
  }
}

// --- Main ---

async function main() {
  const zipPath = process.argv[2] || buildFirefoxZip();
  if (!fs.existsSync(zipPath)) {
    fail(`Zip not found: ${zipPath}`);
  }

  const extDir = extractZip(zipPath);
  log(`Extension dir: ${extDir}`);

  const driver = await createFirefoxDriver();
  let failures = 0;

  try {
    await runSmokeSession(driver, extDir);
  } catch (e) {
    failures++;
    console.error(e);
  } finally {
    await driver.quit();
    fs.rmSync(extDir, { recursive: true, force: true });
    if (!process.argv[2]) {
      try {
        fs.unlinkSync(zipPath);
      } catch {}
    }
  }

  if (failures > 0) {
    fail(`${failures} assertion(s) failed`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
