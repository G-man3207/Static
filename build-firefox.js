#!/usr/bin/env node
// build-firefox.js — Build a Firefox-compatible extension zip.
//
// Firefox DNR does not support "webtransport" or "webbundle" resource types.
// This script copies the repo to a temp directory, strips those unsupported
// types from the DNR rule JSON files and the service worker's
// ALL_RESOURCE_TYPES array, then produces a zip ready for AMO submission.
//
// Usage:  node build-firefox.js [output.zip]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = __dirname;
const UNSUPPORTED_RESOURCE_TYPES = ["webtransport", "webbundle"];

// Files/dirs to exclude from the build (same as release.yml Chrome zip).
const EXCLUDE = new Set([
  ".git",
  ".github",
  ".husky",
  "_metadata",
  ".pi",
  "node_modules",
  "tests",
  "docs",
  "test-results",
  ".editorconfig",
  ".prettierrc",
  ".prettierignore",
  ".gitignore",
  ".markdownlint.json",
  "eslint.config.mjs",
  "playwright.config.js",
  "gate.sh",
  "package.json",
  "package-lock.json",
  "build-firefox.js",
  "IMPROVEMENTS.md",
]);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function stripUnsupportedTypes(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const rules = JSON.parse(content);
  let modified = false;
  for (const rule of rules) {
    if (rule.condition && Array.isArray(rule.condition.resourceTypes)) {
      const before = rule.condition.resourceTypes.length;
      rule.condition.resourceTypes = rule.condition.resourceTypes.filter(
        (t) => !UNSUPPORTED_RESOURCE_TYPES.includes(t)
      );
      if (rule.condition.resourceTypes.length !== before) modified = true;
    }
  }
  if (modified) {
    fs.writeFileSync(filePath, `${JSON.stringify(rules, null, 2)}\n`);
  }
  return modified;
}

function stripTypesFromServiceWorker(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  const before = content;
  for (const typeName of UNSUPPORTED_RESOURCE_TYPES) {
    // Remove lines like:  "webtransport",
    content = content.replace(new RegExp(`^\\s*"${typeName}",\\s*\\n`, "gm"), "");
  }
  if (content !== before) {
    fs.writeFileSync(filePath, content);
    return true;
  }
  return false;
}

// --- Main ---
const args = process.argv.slice(2);
const outputZip = args[0] || `static-${process.env.GITHUB_REF_NAME || "firefox"}.zip`;

// Read version from manifest to name the output consistently.
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "manifest.json"), "utf8"));
const version = manifest.version;
const zipName = outputZip.includes("static-") ? outputZip : `static-v${version}-firefox.zip`;

const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "static-fx-"));

console.log(`Building Firefox zip (v${version})…`);
console.log(`  Temp dir: ${tmpDir}`);

// 1. Copy repo to temp dir (excluding dev files).
copyDir(REPO_ROOT, tmpDir);

// 2. Strip unsupported resource types from DNR rule files.
const rulesDir = path.join(tmpDir, "rules");
for (const file of fs.readdirSync(rulesDir)) {
  if (file.endsWith(".json") && file !== "META.json") {
    const rulePath = path.join(rulesDir, file);
    const changed = stripUnsupportedTypes(rulePath);
    if (changed) console.log(`  Stripped types from rules/${file}`);
  }
}

// 3. Strip unsupported types from service_worker.js ALL_RESOURCE_TYPES.
const swPath = path.join(tmpDir, "service_worker.js");
if (stripTypesFromServiceWorker(swPath)) {
  console.log("  Stripped types from service_worker.js");
}

// 4. Add background.scripts fallback for Firefox event-page path.
//    When service workers are unavailable (ESR, pref disabled), Firefox
//    falls back to an event page that loads scripts sequentially as <script>
//    tags.  The deps must load BEFORE service_worker.js so the globals
//    (globalThis.__static_config__, globalThis.__static_sw_utils__) exist
//    when service_worker.js runs.  The importScripts guard in service_worker.js
//    handles the SW path; this handles the event-page path.
const manifestPath = path.join(tmpDir, "manifest.json");
const fxManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
fxManifest.background.scripts = ["lists.js", "service_worker_utils.js", "service_worker.js"];
fs.writeFileSync(manifestPath, `${JSON.stringify(fxManifest, null, 2)}\n`);
console.log("  Added background.scripts fallback to manifest");

// 5. Create zip.
const absZip = path.resolve(zipName);
execSync(
  `cd "${tmpDir}" && zip -r "${absZip}" . -x "*.diag" -x ".DS_Store" -x "Thumbs.db" -x "*.zip"`,
  { stdio: "inherit" }
);
// 6. Cleanup.
fs.rmSync(tmpDir, { recursive: true, force: true });
// 7. Quick self-check: re-read the zip and verify Firefox-critical fields.
console.log(`\nFirefox zip: ${absZip}`);

const checkDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "static-fxck-"));
execSync(`unzip -q "${absZip}" -d "${checkDir}"`, { stdio: "pipe" });
const checkManifest = JSON.parse(fs.readFileSync(path.join(checkDir, "manifest.json"), "utf8"));
const gecko = checkManifest.browser_specific_settings?.gecko;
if (!gecko?.id) {
  console.error("FAIL: browser_specific_settings.gecko.id missing from built manifest");
  process.exit(1);
}
if (!gecko.data_collection_permissions?.required?.includes("none")) {
  console.error(
    "FAIL: gecko.data_collection_permissions.required must include 'none' (AMO requirement)"
  );
  process.exit(1);
}
if (!Array.isArray(checkManifest.background?.scripts)) {
  console.error("FAIL: background.scripts missing from built manifest");
  process.exit(1);
}
const expectedScripts = ["lists.js", "service_worker_utils.js", "service_worker.js"];
if (JSON.stringify(checkManifest.background.scripts) !== JSON.stringify(expectedScripts)) {
  console.error(
    "FAIL: background.scripts must be",
    expectedScripts.join(", "),
    "got",
    checkManifest.background.scripts
  );
  process.exit(1);
}
// Firefox ignores background.service_worker; scripts is the real event-page path.
// Keep service_worker in the zip for dual-browser packaging documentation / tooling.
if (checkManifest.background.service_worker !== "service_worker.js") {
  console.error(
    "FAIL: background.service_worker should remain service_worker.js for Chrome parity"
  );
  process.exit(1);
}

for (const rulesFile of ["fingerprint_vendors.json", "captcha_vendors.json"]) {
  const checkRules = JSON.parse(fs.readFileSync(path.join(checkDir, "rules", rulesFile), "utf8"));
  const hasUnsupported = checkRules.some((r) =>
    r.condition?.resourceTypes?.some((t) => UNSUPPORTED_RESOURCE_TYPES.includes(t))
  );
  if (hasUnsupported) {
    console.error(`FAIL: unsupported resource types still present in built rules/${rulesFile}`);
    process.exit(1);
  }
}

const builtSw = fs.readFileSync(path.join(checkDir, "service_worker.js"), "utf8");
for (const typeName of UNSUPPORTED_RESOURCE_TYPES) {
  if (new RegExp(`"${typeName}"`).test(builtSw)) {
    console.error(`FAIL: service_worker.js still references unsupported type "${typeName}"`);
    process.exit(1);
  }
}
fs.rmSync(checkDir, { recursive: true, force: true });

console.log("Self-check passed.");
