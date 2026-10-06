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
const os = require("os");
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
  // Blank any leftover quoted type names (comparisons, comments, retries)
  // so the packaged worker cannot mention types Firefox DNR rejects.
  for (const typeName of UNSUPPORTED_RESOURCE_TYPES) {
    content = content.split(`"${typeName}"`).join('""');
  }
  if (content !== before) {
    fs.writeFileSync(filePath, content);
    return true;
  }
  return false;
}

// --- Main ---
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "manifest.json"), "utf8"));
const version = manifest.version;
const zipName = process.argv[2] || `static-v${version}-firefox.zip`;

// AMO rejects packages without a gecko ID or the built-in data-consent keys.
const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
if (!gecko || !gecko.id) {
  console.error("FAIL: browser_specific_settings.gecko.id missing from manifest.json");
  process.exit(1);
}
const dataCollection = gecko.data_collection_permissions;
if (!dataCollection || !(dataCollection.required || []).includes("none")) {
  console.error(
    "FAIL: gecko.data_collection_permissions.required must include 'none' (AMO requirement)"
  );
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-fx-"));

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
console.log(`\nFirefox zip: ${absZip}`);
