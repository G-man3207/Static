const { expect, test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const readJson = (filePath) => JSON.parse(fs.readFileSync(path.join(repoRoot, filePath), "utf8"));

const expectedMainWorldScripts = [
  "block_adaptive.js",
  "block.js",
  "block_vectors.js",
  "block_replay.js",
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
