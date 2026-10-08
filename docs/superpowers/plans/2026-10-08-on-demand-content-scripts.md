# On-demand content scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register Static's content scripts from the service worker so paused sites get no Static code at all and switched-off features stay unloaded.

**Architecture:** Pure helpers in `service_worker_utils.js` turn four storage settings into two `chrome.scripting` registrations (`a-main`, `b-isolated`). `service_worker.js` runs a serialized `syncContentScripts()` on worker start, install/update, browser startup, relevant storage changes, and inside the setting handlers before they reply. The manifest drops `content_scripts`; tests wait for the sync after every service-worker evaluate.

**Tech Stack:** MV3 WebExtension (Chrome ≥ 119, Firefox ≥ 140), `chrome.scripting`, Playwright E2E (Chromium on Xvfb), Node `vm` static tests, ESLint, Prettier.

**Spec:** `docs/superpowers/specs/2026-10-08-on-demand-content-scripts-design.md`

## Global Constraints

- `manifest.json`: no `content_scripts`; `permissions` = `declarativeNetRequest`, `declarativeNetRequestWithHostAccess`, `scripting`, `storage`; `"minimum_chrome_version": "119"`. Firefox `strict_min_version` stays `140.0`.
- Registration IDs are exactly `a-main` (MAIN world) and `b-isolated` (ISOLATED world), both `matches: ["<all_urls>"]`, `runAt: "document_start"`, `allFrames: true`, `matchOriginAsFallback: true`, `persistAcrossSessions: true`, and `excludeMatches` always passed (empty list when nothing is paused).
- MAIN order is today's manifest order minus switched-off scripts: `block_utils.js` first, `block_globals.js` last.
- Gates: `block_adaptive.js` when `research_logging === true`; `block_fingerprint.js` when `fingerprint_mode === "mask"`; `block_replay.js` when `replay_mode` is `mask`, `noise` or `chaos`.
- Paused-site pattern: `${protocol}//${hostname}/*` for `http:`/`https:` origins whose hostname matches `/^[a-z0-9.-]+$/`; anything else gets no pattern (keeps the in-page pause).
- New storage key `research_logging` (default `false`), new message `static_set_research_logging` (`{ enabled }` → `{ enabled, ok: true }`), new details field `researchLogging`.
- Popup copy: "Applies when the page reloads." on Device signal poisoning, Replay poisoning and Research logging.
- Every commit passes `npm run format:check` and `npm run lint:strict` (the husky hook does not run in this worktree, so run them by hand).
- Work happens in `/root/Static-worktrees/on-demand-content-scripts` on `feat/on-demand-content-scripts`; never touch the uncommitted changes in `/root/Static`.
- Run browsers on `DISPLAY=:97` (`Xvfb :97 -screen 0 1280x1024x24 -nolisten tcp &`); `xvfb-run` is unavailable here.

## Review Focus

- **Upgrade from v2.5.1:** the first page loads after an update must get scripts. Pinned by the Task 2 test that wipes registrations and runs `syncContentScripts()`.
- **Many paused sites plus junk entries:** 300 paused origins and unpatternable ones (IPv6, garbage) must still register. Pinned by a Task 2 E2E test.
- **Local dev servers with ports:** pausing `http://localhost:3000` pauses every `localhost` port, by design. Pinned by a Task 1 unit test.
- **Legacy or invalid stored values** (`replay_mode: "bogus"`, `research_logging: "yes"`) must load nothing extra. Pinned by a Task 1 unit test.
- **Resuming the last paused site** must clear `excludeMatches` (`updateContentScripts` keeps omitted fields). Pinned by a Task 2 E2E test.

---

### Task 1: Registration helpers

**Files:**

- Modify: `service_worker_utils.js` (new section before `return {`, new exports)
- Test: `tests/static-validation.spec.js` (`loadServiceWorkerUtils` gets `URL`; three new tests)

**Interfaces:**

- Produces (on `globalThis.__static_sw_utils__`): `MAIN_WORLD_SCRIPTS: Array<{file: string, when?: (settings) => boolean}>`, `ISOLATED_WORLD_SCRIPTS: string[]`, `CONTENT_SCRIPT_SETTINGS: {disabled_origins: {}, fingerprint_mode: "off", replay_mode: "off", research_logging: false}`, `pausedOriginPattern(origin: string): string | null`, `contentScriptRegistrationsFor(settings): RegisteredContentScript[]`, `contentScriptsInSync(registered, desired): boolean`.

- [ ] **Step 1: Write the failing tests** in `tests/static-validation.spec.js`. Change `loadServiceWorkerUtils` to `vm.createContext({ URL })`, then add:

```js
const plain = (value) => JSON.parse(JSON.stringify(value));
const coreMainWorldScripts = [
  "block_utils.js",
  "block.js",
  "block_vectors.js",
  "block_iframe_attrs.js",
  "block_style_vectors.js",
  "block_element_decoys.js",
  "block_globals.js",
];

test("content-script registrations load only switched-on page scripts", () => {
  const utils = loadServiceWorkerUtils();
  const defaults = plain(utils.contentScriptRegistrationsFor(utils.CONTENT_SCRIPT_SETTINGS));
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
      fingerprint_mode: "mask",
      replay_mode: "chaos",
      research_logging: true,
    })
  );
  expect(allOn[0].js).toEqual(expectedMainWorldScripts);

  const legacy = plain(
    utils.contentScriptRegistrationsFor({
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

test("content-script sync check ignores fields the browser leaves out", () => {
  const utils = loadServiceWorkerUtils();
  const desired = utils.contentScriptRegistrationsFor(utils.CONTENT_SCRIPT_SETTINGS);
  const asReported = plain(desired).map((script) => {
    const copy = { ...script, js: script.js.map((file) => `/${file}`) };
    delete copy.excludeMatches;
    return copy;
  });
  expect(utils.contentScriptsInSync(asReported, desired)).toBe(true);
  expect(utils.contentScriptsInSync([], desired)).toBe(false);
  expect(utils.contentScriptsInSync(asReported.slice(0, 1), desired)).toBe(false);
  const paused = utils.contentScriptRegistrationsFor({
    disabled_origins: { "https://a.example": true },
  });
  expect(utils.contentScriptsInSync(asReported, paused)).toBe(false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx playwright test tests/static-validation.spec.js -g "content-script|paused origins"`
Expected: FAIL with `utils.contentScriptRegistrationsFor is not a function`.

- [ ] **Step 3: Implement** in `service_worker_utils.js`, before `return {`:

```js
// ─── On-demand content scripts ───────────────────────────────────────────
// Page-world scripts in injection order. A script with `when` loads only
// while that feature is on. block_utils.js must stay first (it defines the
// shared utils global) and block_globals.js last (it deletes that global).
const MAIN_WORLD_SCRIPTS = [
  { file: "block_utils.js" },
  { file: "block_adaptive.js", when: (s) => s.research_logging === true },
  { file: "block.js" },
  { file: "block_vectors.js" },
  { file: "block_iframe_attrs.js" },
  { file: "block_style_vectors.js" },
  { file: "block_fingerprint.js", when: (s) => s.fingerprint_mode === "mask" },
  { file: "block_replay.js", when: (s) => ["mask", "noise", "chaos"].includes(s.replay_mode) },
  { file: "block_element_decoys.js" },
  { file: "block_globals.js" },
];
const ISOLATED_WORLD_SCRIPTS = ["lists.js", "bridge.js", "dom_scrubber.js"];
// Storage keys, with defaults, that decide what gets registered.
const CONTENT_SCRIPT_SETTINGS = {
  disabled_origins: {},
  fingerprint_mode: "off",
  replay_mode: "off",
  research_logging: false,
};
const PATTERN_HOST_RE = /^[a-z0-9.-]+$/;

// Firefox never matches patterns with ports, and one malformed pattern makes
// the browser reject the whole registration. Only plain http(s) hostnames
// become patterns; any other paused origin keeps the in-page pause.
const pausedOriginPattern = (origin) => {
  let url = null;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!PATTERN_HOST_RE.test(url.hostname)) return null;
  return `${url.protocol}//${url.hostname}/*`;
};

const contentScriptRegistrationsFor = (settings) => {
  const disabled = settings.disabled_origins || {};
  const patterns = Object.keys(disabled)
    .filter((origin) => disabled[origin])
    .map(pausedOriginPattern)
    .filter(Boolean);
  const shared = {
    allFrames: true,
    excludeMatches: [...new Set(patterns)].sort(),
    matchOriginAsFallback: true,
    matches: ["<all_urls>"],
    persistAcrossSessions: true,
    runAt: "document_start",
  };
  return [
    {
      ...shared,
      id: "a-main",
      js: MAIN_WORLD_SCRIPTS.filter((s) => !s.when || s.when(settings)).map((s) => s.file),
      world: "MAIN",
    },
    { ...shared, id: "b-isolated", js: [...ISOLATED_WORLD_SCRIPTS], world: "ISOLATED" },
  ];
};

// getRegisteredContentScripts() can omit empty lists and default flags, so
// compare only the fields Static sets, normalized.
const registrationKey = (script) =>
  JSON.stringify([
    script.id,
    (script.js || []).map((file) => file.replace(/^\//, "")),
    script.matches || [],
    [...(script.excludeMatches || [])].sort(),
    script.runAt || "document_idle",
    !!script.allFrames,
    script.world || "ISOLATED",
    !!script.matchOriginAsFallback,
    script.persistAcrossSessions !== false,
  ]);

const contentScriptsInSync = (registered, desired) =>
  JSON.stringify((registered || []).map(registrationKey).sort()) ===
  JSON.stringify(desired.map(registrationKey).sort());
```

Add to the returned object: `CONTENT_SCRIPT_SETTINGS`, `ISOLATED_WORLD_SCRIPTS`, `MAIN_WORLD_SCRIPTS`, `contentScriptRegistrationsFor`, `contentScriptsInSync`, `pausedOriginPattern`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx playwright test tests/static-validation.spec.js`
Expected: all pass.

- [ ] **Step 5: Commit** (after `npm run format:check && npm run lint:strict`)

```bash
git add service_worker_utils.js tests/static-validation.spec.js
git commit -m "feat: compute content-script registrations from settings"
```

### Task 2: Register content scripts on demand

**Files:**

- Modify: `manifest.json`, `service_worker.js`, `build-firefox.js`, `gate.sh`, `tests/static-validation.spec.js`, `tests/helpers/extension.js`, `tests/e2e-specs.txt`
- Create: `tests/content-script-registration.spec.js`

**Interfaces:**

- Consumes: Task 1 exports.
- Produces: `syncContentScripts(): Promise<void>` (top-level `const` in `service_worker.js`, reachable from `serviceWorker.evaluate`), message `static_set_research_logging`, details field `researchLogging`, test helper `staticPageTraces(page)` exported from `tests/helpers/extension.js` returning `{ dom: string[], platformGetter: string[], rtcWithoutNewThrows: boolean, timer: string[] }` (each array lists the Static script files found in that error's stack).

- [ ] **Step 1: Write the failing tests.**

In `tests/static-validation.spec.js`:

- `addContentScriptFiles` takes only `referencedFiles` and adds every `MAIN_WORLD_SCRIPTS[].file` and `ISOLATED_WORLD_SCRIPTS` entry from `loadServiceWorkerUtils()`. `collectManifestFiles` calls it that way, which keeps the content scripts in the "runtime code stays local-only" scan.
- Replace `expectContentScriptWorlds` with:

```js
const expectOnDemandContentScripts = (manifest) => {
  // The service worker registers content scripts (contentScriptRegistrationsFor),
  // so paused sites and switched-off features can be left out entirely.
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.minimum_chrome_version).toBe("119");
  const utils = loadServiceWorkerUtils();
  expect(utils.MAIN_WORLD_SCRIPTS.map((script) => script.file)).toEqual(expectedMainWorldScripts);
  expect([...utils.ISOLATED_WORLD_SCRIPTS]).toEqual(["lists.js", "bridge.js", "dom_scrubber.js"]);
};
```

and rename the test to `"manifest references existing files and leaves content scripts to the service worker"`.

- The permissions test expects `["declarativeNetRequest", "declarativeNetRequestWithHostAccess", "scripting", "storage"]`.
- The CI-only Firefox build test also expects `fxManifest.minimum_chrome_version` to be `undefined`.

In `tests/helpers/extension.js`, add and export:

```js
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
```

and in `launchExtension()`, right after the service worker is found:

```js
const evaluate = serviceWorker.evaluate.bind(serviceWorker);
serviceWorker.evaluate = async (...args) => {
  const result = await evaluate(...args);
  await waitForContentScripts(evaluate);
  return result;
};
await waitForContentScripts(evaluate);
```

Create `tests/content-script-registration.spec.js`:

```js
/* global messageHandlers, syncContentScripts */
// Static — on-demand content-script registration (spec:
// docs/superpowers/specs/2026-10-08-on-demand-content-scripts-design.md).
const { expect, test } = require("./helpers/extension-fixture");
const { staticPageTraces } = require("./helpers/extension");

const registeredMain = (extension) =>
  extension.serviceWorker.evaluate(async () =>
    (await chrome.scripting.getRegisteredContentScripts()).find((script) => script.id === "a-main")
  );

test("default settings register only the core content scripts", async ({ extension, server }) => {
  const main = await registeredMain(extension);
  expect(main.js.map((file) => file.replace(/^\//, ""))).toEqual([
    "block_utils.js",
    "block.js",
    "block_vectors.js",
    "block_iframe_attrs.js",
    "block_style_vectors.js",
    "block_element_decoys.js",
    "block_globals.js",
  ]);

  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  const traces = await staticPageTraces(page);
  expect(traces.dom.length).toBeGreaterThan(0);
  expect(traces.platformGetter).not.toContain("block_fingerprint.js");
  expect(traces.rtcWithoutNewThrows).toBe(true);
  expect(traces.timer).toEqual([]);
});

test("switching poisoning and research logging on loads their scripts", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ fingerprint_mode: "mask", research_logging: true })
  );
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  const traces = await staticPageTraces(page);
  expect(traces.platformGetter).toContain("block_fingerprint.js");
  expect(traces.timer).toContain("block_adaptive.js");
});

test("a paused site gets no Static page code while other sites keep it", async ({
  extension,
  server,
}) => {
  await extension.serviceWorker.evaluate(
    (origin) =>
      chrome.storage.local.set({
        disabled_origins: { [origin]: true },
        fingerprint_mode: "mask",
        replay_mode: "mask",
        research_logging: true,
      }),
    server.origin
  );
  const paused = await extension.context.newPage();
  await paused.goto(server.url("/blank.html"));
  expect(await staticPageTraces(paused)).toEqual({
    dom: [],
    platformGetter: [],
    rtcWithoutNewThrows: true,
    timer: [],
  });

  // The same server under another hostname is a different, unpaused origin.
  const other = await extension.context.newPage();
  await other.goto(server.url("/blank.html").replace("127.0.0.1", "localhost"));
  const traces = await staticPageTraces(other);
  expect(traces.dom.length).toBeGreaterThan(0);
  expect(traces.timer).toContain("block_adaptive.js");
});

test("the sync restores registrations after the browser drops them", async ({ extension }) => {
  const ids = await extension.serviceWorker.evaluate(async () => {
    await chrome.scripting.unregisterContentScripts();
    await syncContentScripts();
    return (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id);
  });
  expect(ids.sort()).toEqual(["a-main", "b-isolated"]);
});

test("resuming the last paused site clears the exclusion", async ({ extension, server }) => {
  await extension.serviceWorker.evaluate(
    (origin) => chrome.storage.local.set({ disabled_origins: { [origin]: true } }),
    server.origin
  );
  expect((await registeredMain(extension)).excludeMatches).toEqual(["http://127.0.0.1/*"]);
  await extension.serviceWorker.evaluate(() => chrome.storage.local.set({ disabled_origins: {} }));
  expect((await registeredMain(extension)).excludeMatches || []).toEqual([]);
});

test("hundreds of paused sites and unpatternable entries still register", async ({ extension }) => {
  const disabled = { "http://[::1]:8080": true, garbage: true };
  for (let i = 0; i < 300; i += 1) disabled[`https://site${i}.example`] = true;
  await extension.serviceWorker.evaluate(
    (origins) => chrome.storage.local.set({ disabled_origins: origins }),
    disabled
  );
  const main = await registeredMain(extension);
  expect(main.excludeMatches).toHaveLength(300);
  expect(main.excludeMatches).toContain("https://site0.example/*");
});

test("research logging message saves the setting and loads the logger", async ({ extension }) => {
  // Calls the service worker's own handler, as the popup's message would.
  const saved = await extension.serviceWorker.evaluate(
    () =>
      new Promise((resolve) => {
        messageHandlers.static_set_research_logging({ enabled: true }, {}, resolve);
      })
  );
  expect(saved).toEqual({ enabled: true, ok: true });
  expect((await registeredMain(extension)).js).toContain("block_adaptive.js");
});
```

The file's first line becomes `/* global messageHandlers, syncContentScripts */`. Add `tests/content-script-registration.spec.js` to `tests/e2e-specs.txt` after `tests/extension-behavior.spec.js`.

- [ ] **Step 2: Run them and watch them fail**

Run: `DISPLAY=:97 npx playwright test tests/content-script-registration.spec.js tests/static-validation.spec.js --project=chromium`
Expected: FAIL (`chrome.scripting` is undefined; manifest still has `content_scripts`).

- [ ] **Step 3: Implement.**

`manifest.json`: delete the `content_scripts` block, add `"minimum_chrome_version": "119"` after `"description"`, and set `"permissions": ["declarativeNetRequest", "declarativeNetRequestWithHostAccess", "scripting", "storage"]`.

`service_worker.js`:

1. Add `CONTENT_SCRIPT_SETTINGS`, `contentScriptRegistrationsFor` and `contentScriptsInSync` to the destructuring of `globalThis.__static_sw_utils__`, and `static_set_research_logging` to the header comment's list of popup queries.
2. After the `serialize` helper, add:

```js
// ─── On-demand content scripts ────────────────────────────────────────────
// Registered here instead of in the manifest so paused sites get no Static
// code at all and switched-off features stay unloaded. Browsers drop these
// registrations on every extension update, so they are re-checked on worker
// start, install/update, browser startup, and relevant setting changes.
let contentScriptChain = Promise.resolve();

const applyContentScriptRegistrations = async () => {
  const settings = await chrome.storage.local.get(CONTENT_SCRIPT_SETTINGS);
  const desired = contentScriptRegistrationsFor(settings);
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (contentScriptsInSync(registered, desired)) return;
  const registeredIds = registered.map((script) => script.id);
  const sameIds =
    registeredIds.length === desired.length &&
    desired.every((script) => registeredIds.includes(script.id));
  if (sameIds) {
    await chrome.scripting.updateContentScripts(desired);
    return;
  }
  // Fresh install, update, or leftovers: register both in one call so Chrome
  // keeps ID order (page world first).
  if (registeredIds.length) await chrome.scripting.unregisterContentScripts();
  await chrome.scripting.registerContentScripts(desired);
};

// Overlapping register/update calls fail, so runs are queued. Each run
// re-reads storage and does nothing when the registrations already match.
const syncContentScripts = () => {
  contentScriptChain = contentScriptChain
    .then(applyContentScriptRegistrations)
    .catch((err) => safeLog(err, "content script sync"));
  return contentScriptChain;
};
```

3. `handleSetReplay` and `handleSetFingerprint`: `await syncContentScripts();` right after their `chrome.storage.local.set`. `handleSetSiteDisabled`: the same, right after `chrome.storage.local.set({ disabled_origins })`.
4. New handler, registered as `static_set_research_logging` in `messageHandlers` (between `static_set_replay` and `static_set_site_disabled`):

```js
const handleSetResearchLogging = (msg, _sender, sendResponse) => {
  (async () => {
    const enabled = !!msg.enabled;
    await chrome.storage.local.set({ research_logging: enabled });
    await syncContentScripts();
    sendResponse({ enabled, ok: true });
  })();
  return true;
};
```

5. `handleGetDetails` reads `research_logging: false` too, and `detailsResponseFor` returns `researchLogging: !!stored.research_logging` next to `diagnosticsMode`.
6. In the `chrome.storage.onChanged` listener: `if (Object.keys(CONTENT_SCRIPT_SETTINGS).some((key) => changes[key])) syncContentScripts();`
7. Next to the startup reconcile code:

```js
chrome.runtime.onInstalled.addListener(() => {
  syncContentScripts();
});
chrome.runtime.onStartup.addListener(() => {
  syncContentScripts();
});
syncContentScripts();
```

`build-firefox.js`, step 4: `delete fxManifest.minimum_chrome_version;` before writing the manifest (Chrome-only key; Firefox warns about it).

`gate.sh`: in the inline manifest check, replace the `content_scripts` requirement and file loop with:

```js
if (!(m.permissions || []).includes("scripting")) {
  console.log("manifest missing scripting permission");
  errors++;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `DISPLAY=:97 npx playwright test tests/content-script-registration.spec.js tests/static-validation.spec.js --project=chromium`
Expected: all pass.

- [ ] **Step 5: Commit** (after format and lint)

```bash
git add manifest.json service_worker.js build-firefox.js gate.sh tests/static-validation.spec.js tests/helpers/extension.js tests/content-script-registration.spec.js tests/e2e-specs.txt
git commit -m "feat: register content scripts on demand so paused sites get no Static code"
```

### Task 3: Popup controls

**Files:**

- Modify: `popup.html` (Research logging row after the QA diagnostics row; "Applies when the page reloads." appended to `#fingerprint-desc` and `#replay-desc`), `popup.js` (`renderResearchLoggingSection`, site toggle reload)
- Test: `tests/extension-behavior.spec.js` (popup toggle test)

**Interfaces:**

- Consumes: `static_set_research_logging`, `researchLogging` (Task 2), `staticPageTraces` (Task 2), `reloadOriginTab(origin)` (existing in `popup.js`).

- [ ] **Step 1: Write the failing tests.** In `"popup site toggle keeps its status line in sync"`, after the first toggle click and the `isPaused` poll, wait for the site tab's reload and assert the real pause, then do the same after resuming:

```js
await page.waitForLoadState("load");
await expect.poll(async () => (await staticPageTraces(page)).dom).toEqual([]);
```

and after the second click:

```js
await expect.poll(async () => (await staticPageTraces(page)).dom.length).toBeGreaterThan(0);
```

Add:

```js
test("popup research logging toggle loads the adaptive logger", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.bringToFront();
  const tabId = await activeHttpTabId(extension.serviceWorker);
  const popupPage = await openPopupForTab(extension, tabId);
  const toggle = popupPage.locator("#research-logging-toggle");

  await expect(toggle).not.toBeChecked();
  await expect(popupPage.locator("#research-desc")).toContainText("Applies when the page reloads.");
  await toggle.evaluate((input) => input.click());
  await expect
    .poll(() =>
      extension.serviceWorker.evaluate(async () =>
        (await chrome.scripting.getRegisteredContentScripts())
          .find((script) => script.id === "a-main")
          .js.includes("block_adaptive.js")
      )
    )
    .toBe(true);
  await expect(toggle).toBeChecked();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `DISPLAY=:97 npx playwright test tests/extension-behavior.spec.js -g "popup site toggle|research logging toggle" --project=chromium`
Expected: FAIL (no reload, so traces still show Static; `#research-logging-toggle` missing).

- [ ] **Step 3: Implement.**

`popup.html`, after the QA diagnostics row (same structure and classes):

```html
<div class="diagnostics-row">
  <div class="col">
    <div class="ttl" id="research-title">
      <span id="research-title-text">Research logging</span>
      <button
        class="help-tip"
        id="research-help"
        type="button"
        data-tip="Wraps page timers, promises, and listeners to attribute data collection to its source. Pages can detect the wrappers, so leave it off unless you are investigating a site."
        aria-label="Research logging details"
        aria-describedby="research-help-text"
      >
        ?
      </button>
      <span class="sr-only" id="research-help-text"
        >Wraps page timers, promises, and listeners to attribute data collection to its source.
        Pages can detect the wrappers, so leave it off unless you are investigating a site.</span
      >
    </div>
    <div class="desc" id="research-desc">
      Record how sites watch the page, for the adaptive signals in the probe log. Off by default: it
      slows heavy pages and lets sites detect Static. Applies when the page reloads.
    </div>
  </div>
  <label class="switch">
    <input
      type="checkbox"
      id="research-logging-toggle"
      aria-labelledby="research-title-text"
      aria-describedby="research-desc"
    />
    <span class="switch-bg"></span>
  </label>
</div>
```

`popup.js`:

```js
const renderResearchLoggingSection = (resp) => {
  const toggle = document.getElementById("research-logging-toggle");
  toggle.checked = !!(resp && resp.researchLogging);

  toggle.addEventListener("change", async () => {
    const desired = toggle.checked;
    try {
      const saved = await chrome.runtime.sendMessage({
        enabled: desired,
        type: "static_set_research_logging",
      });
      toggle.checked = !!(saved && saved.enabled);
    } catch (e) {
      console.error("[Static] research logging toggle failed", e);
      toggle.checked = !desired;
    }
  });
};
```

Call it next to `renderDiagnosticsSection(details)`. In the site toggle's `change` handler, replace `await pushConfigUpdateToActiveTab();` with:

```js
// A paused site has no Static code left to update, so both directions take
// effect on reload. The handler re-registered the scripts before replying.
await reloadOriginTab(resp.origin);
```

- [ ] **Step 4: Run the tests and watch them pass** (same command as Step 2).

- [ ] **Step 5: Commit** (after format and lint)

```bash
git add popup.html popup.js tests/extension-behavior.spec.js
git commit -m "feat: add Research logging toggle; site toggle reloads into a real pause"
```

### Task 4: Move existing tests onto the new defaults

**Files:** whichever E2E specs fail; expected `tests/extension-behavior.spec.js`, `tests/edge-privacy.spec.js`, replay and fingerprint specs.

- [ ] **Step 1: Run the full E2E suite**

Run: `DISPLAY=:97 npx playwright test $(grep -v '^#' tests/e2e-specs.txt | grep -v '^$') --project=chromium`
Expected: failures only in these categories.

- [ ] **Step 2: Fix each failure by category**

- **Adaptive logging tests** (names start with "Adaptive", plus `"adaptive logs redact high-entropy endpoint path segments"` and `"log viewer ranks origins by severity and explains adaptive reason tokens"` if they read live adaptive signals). Add as the first statement:

  ```js
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({ research_logging: true })
  );
  ```

- **Replay detection with Replay Off.** Detection now runs only while replay poisoning is on. Set `replay_mode: "mask"` before navigating when the test is about detection. Keep `"off"` when the test asserts that nothing is altered, and drop the detection expectation there.
- **Settings switched on for an already-open page.** Add `await page.reload();` after the setting change. Turning features off still applies live and needs no change.
- **Anything else:** read the failure and decide whether the test encodes old behavior (update it, and say why in the commit) or found a bug (fix the code).

- [ ] **Step 3: Rerun the full suite until it passes**, then commit:

```bash
git add tests
git commit -m "test: opt adaptive and replay tests into the features they exercise"
```

### Task 5: Docs, full gate, push

**Files:** `README.md`, `CHANGELOG.md`, the spec and this plan.

- [ ] **Step 1: README.** Per-site disable: after the reload, a paused site gets no Static code. Compatibility warning: pause removes Static's page scripts. Adaptive behavior log: off by default, "Research logging" in More. Replay poisoning **Off**: nothing is loaded and detection runs only while a mode is on. Install: Chrome 119+. Limitations: Chrome no longer covers `file://`. Mention the short unprotected window after updates.
- [ ] **Step 2: CHANGELOG.** Under `## [Unreleased]`, add the user-visible changes listed in the spec ("User-visible changes") to Added, Changed and Fixed.
- [ ] **Step 3: Full gate.** Format, lint, static, the Firefox package (with the `zip`/`unzip` shims from the e2e-sandbox-setup memory) plus `web-ext lint`, then the full E2E suite:

```bash
npm run format:check && npm run lint:strict
npx playwright test tests/static-validation.spec.js
node build-firefox.js /tmp/fx.zip && rm -rf /tmp/fxsrc && unzip -q /tmp/fx.zip -d /tmp/fxsrc && npx web-ext lint --source-dir /tmp/fxsrc
DISPLAY=:97 npx playwright test $(grep -v '^#' tests/e2e-specs.txt | grep -v '^$') --project=chromium
```

- [ ] **Step 4: Commit, push, open a PR** so CI runs the Firefox smoke test:

```bash
git add README.md CHANGELOG.md docs/superpowers
git commit -m "docs: document on-demand content scripts and Research logging"
git push -u origin feat/on-demand-content-scripts
gh pr create --title "Register content scripts on demand: real per-site pause, load only what's switched on" --body-file <prepared body>
```
